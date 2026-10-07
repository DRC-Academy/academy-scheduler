// Testimoniales — detección de alumnos "antes / después" y preparación de sus
// clips, sobre `testimonial_candidates` (supabase-testimoniales-candidatos.sql).
// SOLO SERVIDOR.
//
// DOS PASOS (V4, 07/10/2026; la historia está en lib/testimonialRules):
//   1. Detección (sin IA, barata): el alumno entra si tiene clases SUYAS
//      suficientes y separadas en el tiempo (lib/testimonials planCandidate).
//      Las clases que hablan otra persona se apartan antes de contar. Se crea su
//      fila en 'detectado' con ai_review_status 'pending' y una pareja
//      provisional. La pestaña del admin NO la enseña todavía.
//   2. Preparación (Haiku, ~3-5 céntimos):
//      a) dos llamadas EN PARALELO proponen hasta 3 clips malos (primeras
//         clases) y 3 buenos (últimas) (lib/testimonialClips);
//      b) el código tira los que no valen: cita que no aparece literal, turno
//         que no es del hablante del alumno, o pista de lectura / audio /
//         repetición justo antes (lib/fluency readingCue);
//      c) Haiku revisa cada clip con su contexto (lib/testimonialVerify): es el
//         alumno hablando por su cuenta, y con qué soltura (1-5);
//      d) se queda UN clip malo y UN bueno, a los días mínimos y con el bueno
//         por encima del malo (lib/testimonials pickPair). Van en `clips`.
//      Si no sale ninguna pareja, se descarta sola (discarded_by 'ia') sin
//      enseñarse nunca, y el alumno no vuelve hasta tener clases nuevas.
//      Si sale, pasa a 'ready' y aparece en "Por revisar".
//
// La detección corre tras cada nota de fluidez (lib/fluencyStore) y entera al
// abrir la pestaña (app/api/admin/testimonial-prepare). La preparación la pide
// la pestaña, unas pocas a la vez, para que cada una quepa en los 60 s de Vercel.
//
// REGLAS DE LA TABLA:
//   · máximo una pareja ACTIVA por alumno (= cualquier estado menos descartado),
//     también por un índice único en la base. Una vez creada no se reemplaza:
//     la tendencia del alumno cambia con cada clase y el admin necesita algo fijo
//     que revisar;
//   · si el ADMIN la marcó "No sirve", el alumno no se vuelve a proponer.

import 'server-only';

import { supabase } from '@/lib/supabase';
import {
  planCandidate, pickPair, clipsOverlap, speakerKey,
  type FluencyClass, type TestimonialCandidatePlan, type TestimonialClip, type TestimonialClips, type VerifiedClip,
} from '@/lib/testimonials';
import {
  prepareFluency, formatTurnsForAi, locateExcerpt, excerptStartSeconds, excerptEndSeconds, excerptWordCount,
  formatSeconds, withFathomTimestamp, readingCue,
  type FluencyPrep,
} from '@/lib/fluency';
import { pickMoments, MAX_CLIPS, type MomentKind, type MomentIA } from '@/lib/testimonialClips';
import { verifyClips, type ClipToVerify } from '@/lib/testimonialVerify';

type Row = Record<string, unknown>;

/** Tiempo mínimo que tiene que quedar para lanzar la preparación entera. */
export const PREPARE_MIN_MS = 40_000;
/** Lo que se reserva para la revisión de los clips (c) tras las dos llamadas en paralelo. */
const VERIFY_MS = 14_000;
/** Una fila tocada hace menos de esto se considera "en preparación" en otro proceso. */
const LEASE_MS = 2 * 60_000;

export type DetectOutcome =
  | 'no_table'          // falta supabase-testimoniales-candidatos.sql
  | 'bloqueado_admin'   // el admin dijo "No sirve" a este alumno
  | 'ya_tiene'          // ya tiene una pareja activa
  | 'sin_pareja'        // no cumple la regla
  | 'creada';

/** 'descartada': no salió ningún clip malo + bueno que valga. */
export type PrepareOutcome = 'lista' | 'fallida' | 'descartada' | 'sin_tiempo' | 'ya_no_cumple' | 'nada';

const isMissingTable = (err: { code?: string } | null | undefined): boolean =>
  err?.code === '42P01' || err?.code === 'PGRST205';

const FLUENCY_COLS = 'student_group, analysis_id, student_class_number, class_day, teacher_id, fluency_score, fathom_url, student_speaker';

function toClass(r: Row): FluencyClass {
  return {
    analysisId:     String(r.analysis_id),
    classNumber:    (r.student_class_number as number | null) ?? null,
    classDay:       String(r.class_day ?? ''),
    teacherId:      (r.teacher_id as string | null) ?? null,
    score:          Number(r.fluency_score),
    fathomUrl:      (r.fathom_url as string | null) ?? null,
    studentSpeaker: (r.student_speaker as string | null) ?? null,
  };
}

/** Columnas de un lado de la pareja (foto del momento). */
function sideColumns(pre: 'before' | 'after', c: FluencyClass, clip?: { excerpt: string; seconds: number }): Row {
  return {
    [`${pre}_analysis_id`]:  c.analysisId,
    [`${pre}_teacher_id`]:   c.teacherId,
    [`${pre}_class_number`]: c.classNumber,
    [`${pre}_class_date`]:   c.classDay || null,
    [`${pre}_score`]:        c.score,
    [`${pre}_excerpt`]:      clip?.excerpt ?? null,
    // Segundo exacto donde empieza la cita, como "12:47".
    [`${pre}_excerpt_at`]:   clip ? formatSeconds(clip.seconds) : null,
    // El enlace ya abre la grabación en ese segundo.
    [`${pre}_fathom_url`]:   withFathomTimestamp(c.fathomUrl, clip?.seconds),
  };
}

const ORDER_COL: Record<string, string> = { testimonial_candidates: 'id', class_analyses: 'id' };

async function allRows(table: string, cols: string, apply?: (q: any) => any): Promise<Row[]> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const page = () => {
      let q = supabase.from(table).select(cols);
      if (apply) q = apply(q);
      return q.order(ORDER_COL[table] ?? 'analysis_id').range(from, from + 999);
    };
    let { data, error } = await page();
    // 57014: la vista de fluidez calcula el número de clase de todos los alumnos
    // y a veces roza el límite de tiempo de la clave anon. Un reintento basta.
    if (error?.code === '57014') ({ data, error } = await page());
    if (error) throw Object.assign(new Error(`${table}: ${error.message}`), { code: error.code });
    out.push(...((data ?? []) as unknown as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const scoredFilter = (q: any) => q.eq('status', 'ready').not('fluency_score', 'is', null);   // eslint-disable-line @typescript-eslint/no-explicit-any

/** Clases con nota de un alumno. */
async function classesOf(studentGroup: string): Promise<FluencyClass[]> {
  const rows = await allRows('transcript_fluency_numbered', FLUENCY_COLS, q => scoredFilter(q).eq('student_group', studentGroup));
  return rows.map(toClass);
}

/** El nombre más repetido entre los de sus clases (class_analyses.student_name), o null. */
function mostCommon(names: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const n of names) if (n && n.trim()) counts.set(n.trim(), (counts.get(n.trim()) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Nombre del alumno según sus clases. Solo columnas ligeras: nunca el transcript. */
async function studentNameOf(classes: FluencyClass[]): Promise<string | null> {
  if (classes.length === 0) return null;
  const { data } = await supabase.from('class_analyses')
    .select('student_name').in('id', classes.map(c => c.analysisId));
  return mostCommon(((data ?? []) as Row[]).map(r => r.student_name as string | null));
}

/** Día ('YYYY-MM-DD') de la clase más reciente del alumno. */
const latestDay = (classes: FluencyClass[]): string =>
  classes.reduce((max, c) => (c.classDay > max ? c.classDay : max), '');

/**
 * Qué hacer con un alumno según sus filas de la tabla y su plan.
 *
 * Un descarte AUTOMÁTICO (discarded_by 'ia': no salió ninguna pareja de clips
 * que valga) bloquea al alumno hasta que tenga una clase posterior al descarte.
 * Sin esto se volvería a crear y descartar la misma pareja cada vez que se abre
 * la pestaña.
 */
function decide(rows: Row[], plan: TestimonialCandidatePlan | null, lastClassDay: string): DetectOutcome {
  if (rows.some(r => r.status === 'descartado' && r.discarded_by === 'admin')) return 'bloqueado_admin';
  if (rows.some(r => r.status !== 'descartado')) return 'ya_tiene';
  const autoDiscardedSince = rows.some(r =>
    r.status === 'descartado' && r.discarded_by === 'ia'
    && String(r.status_changed_at ?? '').slice(0, 10) >= lastClassDay);
  if (autoDiscardedSince) return 'sin_pareja';
  return plan ? 'creada' : 'sin_pareja';
}

/** Crea la fila 'detectado' + 'pending' con la pareja provisional. Devuelve su id, o null si otra ejecución se adelantó. */
async function insertCandidate(studentGroup: string, studentName: string | null, plan: TestimonialCandidatePlan): Promise<string | null> {
  // Id del alumno, de su clase más reciente.
  const { data: ca } = await supabase.from('class_analyses')
    .select('student_id, student_name').eq('id', plan.own.at(-1)!.analysisId).maybeSingle();
  const now = new Date().toISOString();
  const id = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const { error } = await supabase.from('testimonial_candidates').insert({
    id, student_group: studentGroup,
    student_id: (ca?.student_id as string | null) ?? null,
    student_name: studentName ?? (ca?.student_name as string | null) ?? null,
    ...sideColumns('before', plan.before),
    ...sideColumns('after', plan.after),
    improvement: 0,
    ai_review_status: 'pending',
    status: 'detectado', status_changed_at: now,
    // Viejo: la preparación la puede coger ya, sin esperar al plazo de reserva.
    updated_at: '2000-01-01T00:00:00.000Z',
  });
  // 23505: otra ejecución creó la pareja activa a la vez (índice único). La suya vale.
  if (error?.code === '23505') return null;
  if (error) throw new Error(`Creando pareja: ${error.message}`);
  return id;
}

/** Detección de UN alumno (tras cada nota de fluidez). Sin IA. */
export async function detectForStudent(
  studentGroup: string, opts: { dryRun?: boolean } = {},
): Promise<{ outcome: DetectOutcome; candidateId?: string; plan?: TestimonialCandidatePlan }> {
  const existing = await supabase.from('testimonial_candidates')
    .select('id, status, discarded_by, status_changed_at').eq('student_group', studentGroup);
  if (isMissingTable(existing.error)) return { outcome: 'no_table' };
  if (existing.error) throw new Error(`testimonial_candidates: ${existing.error.message}`);

  const classes = await classesOf(studentGroup);
  const name = await studentNameOf(classes);
  const plan = planCandidate(classes, name);
  const outcome = decide((existing.data ?? []) as Row[], plan, latestDay(classes));
  if (outcome !== 'creada' || !plan || opts.dryRun) return { outcome, plan: plan ?? undefined };
  const id = await insertCandidate(studentGroup, name, plan);
  return id ? { outcome, candidateId: id, plan } : { outcome: 'ya_tiene' };
}

/** Detección de TODOS los alumnos de una vez (tres lecturas ligeras). Sin IA. */
export async function detectAll(opts: { dryRun?: boolean } = {}): Promise<{
  counts: Record<DetectOutcome, number>;
  created: Array<{ studentGroup: string; studentName: string | null; plan: TestimonialCandidatePlan }>;
}> {
  const counts: Record<DetectOutcome, number> = { no_table: 0, bloqueado_admin: 0, ya_tiene: 0, sin_pareja: 0, creada: 0 };
  let candidates: Row[];
  try {
    candidates = await allRows('testimonial_candidates', 'id, student_group, status, discarded_by, status_changed_at');
  } catch (err) {
    if (isMissingTable(err as { code?: string })) { counts.no_table = 1; return { counts, created: [] }; }
    throw err;
  }
  const rowsOf = new Map<string, Row[]>();
  for (const r of candidates) rowsOf.set(String(r.student_group), [...(rowsOf.get(String(r.student_group)) ?? []), r]);

  const byGroup = new Map<string, FluencyClass[]>();
  for (const r of await allRows('transcript_fluency_numbered', FLUENCY_COLS, scoredFilter)) {
    const g = String(r.student_group);
    byGroup.set(g, [...(byGroup.get(g) ?? []), toClass(r)]);
  }
  // Nombre de cada clase, para saber de quién es cada una (lib/testimonials ownClasses).
  const nameOf = new Map<string, string | null>();
  for (const r of await allRows('class_analyses', 'id, student_name')) nameOf.set(String(r.id), (r.student_name as string | null) ?? null);

  const created: Array<{ studentGroup: string; studentName: string | null; plan: TestimonialCandidatePlan }> = [];
  for (const [g, classes] of byGroup) {
    const name = mostCommon(classes.map(c => nameOf.get(c.analysisId)));
    const plan = planCandidate(classes, name);
    let outcome = decide(rowsOf.get(g) ?? [], plan, latestDay(classes));
    if (outcome === 'creada' && plan) {
      if (!opts.dryRun && !(await insertCandidate(g, name, plan))) outcome = 'ya_tiene';
      else created.push({ studentGroup: g, studentName: name, plan });
    }
    counts[outcome]++;
  }
  return { counts, created };
}

// ── Preparación de los clips (IA) ────────────────────────────────────────────

interface LoadedClass {
  cls: FluencyClass;
  prep: FluencyPrep;
}

/**
 * Lee los transcripts de unas clases (una a una: nunca en listados) y los prepara
 * para la IA. Solo se quedan las que tienen al alumno identificado y con la misma
 * etiqueta con que se apartó la clase como suya en la detección.
 */
async function loadClasses(classes: FluencyClass[], studentName: string): Promise<LoadedClass[]> {
  const teacherNames = new Map<string, string | null>();
  const out: LoadedClass[] = [];
  for (const cls of classes) {
    const { data: ca } = await supabase.from('class_analyses')
      .select('transcript, teacher_id, student_name').eq('id', cls.analysisId).maybeSingle();
    if (!ca) continue;
    const tid = (ca.teacher_id as string | null) ?? null;
    if (tid && !teacherNames.has(tid)) {
      const { data: t } = await supabase.from('teachers').select('name').eq('id', tid).maybeSingle();
      teacherNames.set(tid, (t?.name as string | undefined) ?? null);
    }
    const prep = prepareFluency(String(ca.transcript ?? ''), {
      teacherName: tid ? teacherNames.get(tid) : null,
      studentName: (ca.student_name as string | null) ?? studentName,
    });
    if (!prep.studentSpeaker || speakerKey(prep.studentSpeaker) !== speakerKey(cls.studentSpeaker)) continue;
    if (prep.turns.length > 0) out.push({ cls, prep });
  }
  return out;
}

/** Un clip candidato ya comprobado por el código, con lo que necesita la revisión. */
interface CheckedClip {
  clip: TestimonialClip;
  context: string;
}

/** Recorta un turno largo para el contexto de la revisión. */
const clipText = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Una cita de la IA comprobada: o el clip con su contexto, o por qué no vale. */
function checkClip(loaded: LoadedClass[], ai: MomentIA): { error: string } | CheckedClip {
  const chosen = loaded[ai.class_option - 1];
  const cita = `"${String(ai.excerpt ?? '').slice(0, 80)}"`;
  if (!chosen) return { error: `la clase ${ai.class_option} no existe.` };
  const words = excerptWordCount(ai.excerpt ?? '');
  if (words < 6) return { error: `la cita ${cita} es demasiado corta.` };
  const loc = locateExcerpt(chosen.prep.turns, ai.excerpt);
  if (!loc) return { error: `la cita ${cita} no aparece literal en un solo turno de la clase ${ai.class_option}.` };
  // SIEMPRE el alumno: un turno de cualquier otro hablante no vale, aunque no sea el profe.
  const speaker = chosen.prep.turns[loc.turnIndex].speaker;
  if (speaker !== chosen.prep.studentSpeaker) return { error: `la cita ${cita} no está en un turno del ALUMNO.` };
  const cue = readingCue(chosen.prep.turns, loc.turnIndex);
  if (cue) return { error: `la cita ${cita}: ${cue}.` };
  const start = excerptStartSeconds(chosen.prep.turns, loc);
  if (start == null) return { error: `el turno de la cita ${cita} no tiene minuto.` };
  const end = excerptEndSeconds(chosen.prep.turns, loc, words, start);

  // Contexto para la revisión: dos turnos antes, el del clip y uno después.
  const turns = chosen.prep.turns;
  const around = (from: number, to: number, max: number) => formatTurnsForAi({
    ...chosen.prep, turns: turns.slice(Math.max(0, from), to).map(t => ({ ...t, text: clipText(t.text, max) })),
  });
  const context = [
    around(loc.turnIndex - 2, loc.turnIndex, 500),
    around(loc.turnIndex, loc.turnIndex + 1, 1500),
    `CITA DEL CLIP: >>> ${ai.excerpt.trim()} <<<`,
    around(loc.turnIndex + 1, loc.turnIndex + 2, 500),
  ].filter(Boolean).join('\n');

  return {
    context,
    clip: {
      analysisId: chosen.cls.analysisId,
      classDate: chosen.cls.classDay,
      teacherId: chosen.cls.teacherId,
      start, end,
      excerpt: ai.excerpt.trim(),
      why: String(ai.why ?? '').trim(),
      // El enlace ya abre la grabación en el segundo de inicio.
      fathomUrl: withFathomTimestamp(chosen.cls.fathomUrl ?? chosen.prep.fathomUrl, start),
    },
  };
}

const formatForAi = (l: LoadedClass[]) =>
  l.map(x => ({ date: x.cls.classDay, turnsText: formatTurnsForAi(x.prep) }));

/**
 * Una llamada para los candidatos de un tipo (y un reintento si NINGUNO pasa las
 * comprobaciones y queda tiempo). Los que no valen se tiran, y los que se pisan
 * con otro anterior también. `noTime`: no se llegó a llamar. `rejected`: la IA
 * respondió pero ninguna cita valía (no es un fallo técnico).
 */
async function chooseClips(
  kind: MomentKind, loaded: LoadedClass[], studentName: string, deadline: number,
): Promise<{ clips?: CheckedClip[]; error?: string; rejected?: string; noTime?: boolean }> {
  let retryNote: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Siempre queda sitio para la revisión, y la llamada nunca pasa del final de la función.
    const left = deadline - Date.now() - VERIFY_MS - 2_000;
    if (left < 10_000) return retryNote ? { rejected: retryNote } : { noTime: true };
    const res = await pickMoments({
      kind, studentName, classes: formatForAi(loaded), retryNote, timeoutMs: Math.min(25_000, left),
    });
    if (res.status !== 'ready' || !res.data) return { error: res.error ?? `La IA no respondió (${res.status}).` };
    const clips: CheckedClip[] = [];
    const errors: string[] = [];
    for (const m of res.data.momentos ?? []) {
      const checked = checkClip(loaded, m);
      if ('error' in checked) { errors.push(checked.error); continue; }
      if (clips.some(c => clipsOverlap(c.clip, checked.clip))) continue;
      clips.push(checked);
      if (clips.length === MAX_CLIPS) break;
    }
    if (errors.length) console.log(`[testimonials] clips ${kind} descartados: ${errors.join(' | ')}`);
    if (clips.length > 0) return { clips };
    retryNote = errors.length ? errors.join(' ') : 'no devolviste ningún momento.';
  }
  return { rejected: retryNote };
}

/**
 * Prepara la pareja de clips de una fila activa. Si el alumno ya no cumple la
 * regla (nunca se enseñó, así que nadie la ha revisado), la fila se borra.
 */
export async function prepareCandidate(id: string, deadline: number): Promise<PrepareOutcome> {
  const { data: c, error } = await supabase.from('testimonial_candidates')
    .select('id, student_group, student_name, status').eq('id', id).maybeSingle();
  if (error || !c || c.status === 'descartado') return 'nada';

  const classes = await classesOf(String(c.student_group));
  const plan = planCandidate(classes, (c.student_name as string | null) ?? await studentNameOf(classes));
  if (!plan) {
    await supabase.from('testimonial_candidates').delete().eq('id', id).eq('status', 'detectado').neq('ai_review_status', 'ready');
    return 'ya_no_cumple';
  }

  const fail = async (msg: string): Promise<PrepareOutcome> => {
    await supabase.from('testimonial_candidates').update({
      ai_review_status: 'failed', ai_error: msg.slice(0, 500), updated_at: new Date().toISOString(),
    }).eq('id', id).neq('status', 'descartado');
    return 'fallida';
  };

  // No salió ninguna pareja que valga: se descarta sola (sin enseñarse nunca) y
  // el alumno no se vuelve a proponer hasta que tenga clases nuevas (ver decide()).
  const discard = async (reason: string): Promise<PrepareOutcome> => {
    const now = new Date().toISOString();
    console.log(`[testimonials] ${c.student_group}: descartada. ${reason}`);
    await supabase.from('testimonial_candidates').update({
      status: 'descartado', discarded_by: 'ia', status_changed_at: now,
      ai_review_status: 'ready', ai_is_real: false, ai_reason: reason.slice(0, 1000), ai_error: null,
      updated_at: now,
    }).eq('id', id).eq('status', 'detectado');
    return 'descartada';
  };

  const studentName = String(c.student_name ?? 'el alumno');
  const [badLoaded, goodLoaded] = await Promise.all([
    loadClasses(plan.badOptions, studentName),
    loadClasses(plan.goodOptions, studentName),
  ]);
  if (badLoaded.length === 0) return fail('No se pudieron leer los transcripts de sus primeras clases.');
  if (goodLoaded.length === 0) return fail('No se pudieron leer los transcripts de sus últimas clases.');

  // a) + b) Candidatos de los dos lados a la vez.
  const [bad, good] = await Promise.all([
    chooseClips('malo', badLoaded, studentName, deadline),
    chooseClips('bueno', goodLoaded, studentName, deadline),
  ]);
  if (bad.noTime || good.noTime) return 'sin_tiempo';
  if (bad.error) return fail(`Momentos malos: ${bad.error}`);
  if (good.error) return fail(`Momentos buenos: ${good.error}`);
  if (!bad.clips) return discard(`Ningún momento malo valía: ${bad.rejected}`);
  if (!good.clips) return discard(`Ningún momento bueno valía: ${good.rejected}`);

  // c) Revisión de cada clip con su contexto.
  const left = deadline - Date.now() - 1_000;
  if (left < 8_000) return 'sin_tiempo';
  const toVerify: ClipToVerify[] = [
    ...bad.clips.map((k, i) => ({ id: `m${i + 1}`, kind: 'malo' as const, context: k.context })),
    ...good.clips.map((k, i) => ({ id: `b${i + 1}`, kind: 'bueno' as const, context: k.context })),
  ];
  const res = await verifyClips({ studentName, clips: toVerify, timeoutMs: Math.min(VERIFY_MS, left) });
  if (res.status !== 'ready' || !res.data) return fail(`Revisión de los clips: ${res.error ?? 'la IA no respondió'}`);
  const verdict = new Map(res.data.clips.map(v => [v.id, v]));
  const notes: string[] = [];
  const verified = (list: CheckedClip[], prefix: 'm' | 'b'): VerifiedClip[] => list.flatMap((k, i) => {
    const v = verdict.get(`${prefix}${i + 1}`);
    if (!v) { notes.push(`${prefix}${i + 1}: sin revisar`); return []; }
    if (v.problema !== 'ninguno') { notes.push(`"${k.clip.excerpt.slice(0, 50)}…": ${v.problema} (${v.motivo})`); return []; }
    return [{ clip: k.clip, nivel: Number(v.nivel) }];
  });
  const malos = verified(bad.clips, 'm');
  const buenos = verified(good.clips, 'b');
  if (notes.length) console.log(`[testimonials] ${c.student_group}: clips tirados en la revisión: ${notes.join(' | ')}`);

  // d) La pareja: un malo y un bueno, a los días mínimos y con el bueno por encima.
  const pair = pickPair(malos, buenos);
  if (!pair) {
    const niveles = `malos ${malos.map(m => m.nivel).join('/') || 'ninguno válido'}, buenos ${buenos.map(b => b.nivel).join('/') || 'ninguno válido'}`;
    return discard(`No salió una pareja con mejora (niveles: ${niveles}). ${notes.join(' | ')}`);
  }

  const clips: TestimonialClips = { malos: [pair.malo.clip], buenos: [pair.bueno.clip] };
  // before_*/after_*: el mismo clip de cada lado, para lo que aún lea esas columnas.
  const byId = new Map(classes.map(x => [x.analysisId, x]));
  const side = (pre: 'before' | 'after', clip: TestimonialClip): Row => sideColumns(pre, {
    analysisId: clip.analysisId, classNumber: byId.get(clip.analysisId)?.classNumber ?? null,
    classDay: clip.classDate, teacherId: clip.teacherId, score: byId.get(clip.analysisId)?.score ?? 0,
    fathomUrl: byId.get(clip.analysisId)?.fathomUrl ?? null, studentSpeaker: null,
  }, { excerpt: clip.excerpt, seconds: clip.start });
  const reason = `Soltura en el clip: ${pair.malo.nivel} → ${pair.bueno.nivel} (de 5).`;
  const { error: upErr } = await supabase.from('testimonial_candidates').update({
    ...side('before', pair.malo.clip),
    ...side('after', pair.bueno.clip),
    clips,
    improvement: pair.bueno.nivel - pair.malo.nivel,
    ai_review_status: 'ready',
    ai_summary: res.data.summary?.trim() || null,
    ai_reason: reason,
    ai_is_real: true, ai_error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', id).neq('status', 'descartado');
  if (upErr) return fail(`Guardando: ${upErr.message}`);
  return 'lista';
}

/** Parejas activas que esperan clips: las nuevas ('pending') y las 'ready' sin `clips`. */
const NEEDS_CLIPS = 'ai_review_status.eq.pending,and(ai_review_status.eq.ready,clips.is.null)';

/** Cuántas parejas esperan preparación (las que la pestaña no enseña aún). */
export async function prepareQueue(): Promise<{ pending: number; failed: number }> {
  const count = async (apply: (q: any) => any) => {   // eslint-disable-line @typescript-eslint/no-explicit-any
    const { count: n, error } = await apply(supabase.from('testimonial_candidates').select('id', { count: 'exact' })
      .neq('status', 'descartado')).range(0, 0);
    if (error) throw new Error(error.message);
    return (n as number | null) ?? 0;
  };
  const [pending, failed] = await Promise.all([
    count(q => q.or(NEEDS_CLIPS)),
    count(q => q.eq('ai_review_status', 'failed')),
  ]);
  return { pending, failed };
}

/**
 * Coge UNA pareja sin clips (o fallida, con `retryFailed`) que nadie esté
 * preparando y la prepara. 'nada' = no queda ninguna libre.
 */
export async function prepareNext(opts: { deadline: number; retryFailed?: boolean }): Promise<PrepareOutcome> {
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString();
  let q = supabase.from('testimonial_candidates').select('id').neq('status', 'descartado').lt('updated_at', cutoff);
  q = opts.retryFailed ? q.eq('ai_review_status', 'failed') : q.or(NEEDS_CLIPS);
  // Varias peticiones a la vez (la pestaña prepara en paralelo): cada una prueba
  // entre las primeras libres, para no pelearse siempre por la misma.
  const { data, error } = await q.order('id').limit(5);
  if (error) throw new Error(error.message);
  const ids = ((data ?? []) as Row[]).map(r => String(r.id));
  if (ids.length === 0) return 'nada';
  for (const id of ids.sort(() => Math.random() - 0.5)) {
    // Reserva: solo sigue si esta ejecución consiguió marcarla.
    const { data: mine } = await supabase.from('testimonial_candidates')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id).lt('updated_at', cutoff).select('id');
    if (mine?.length) return prepareCandidate(id, opts.deadline);
  }
  return 'sin_tiempo';
}

/**
 * Para después de un análisis de fluidez: nunca lanza. Si el alumno entra y
 * queda tiempo antes de `deadline`, prepara sus clips en el momento; si no, los
 * prepara la pestaña del admin cuando se abra.
 */
export async function detectInBackground(studentGroup: string, deadline: number): Promise<void> {
  try {
    const r = await detectForStudent(studentGroup);
    if (r.outcome !== 'creada' || !r.candidateId) return;
    const prep = deadline - Date.now() >= PREPARE_MIN_MS ? await prepareCandidate(r.candidateId, deadline) : 'sin_tiempo';
    console.log(`[testimonials] ${studentGroup}: pareja creada (${r.candidateId}), clips: ${prep}.`);
  } catch (err) {
    console.error(`[testimonials] Detección fallida para ${studentGroup}:`, err);
  }
}
