// Testimoniales — detección de alumnos "antes / después" y preparación de sus
// clips, sobre `testimonial_candidates` (supabase-testimoniales-candidatos.sql).
// SOLO SERVIDOR.
//
// DOS PASOS:
//   1. Detección (sin IA, barata): el alumno entra si su tendencia es de mejora
//      (lib/testimonials planCandidate). Se crea su fila en 'detectado' con
//      ai_review_status 'pending' y una pareja provisional. La pestaña del admin
//      NO la enseña todavía.
//   2. Preparación (Haiku, ~3-5 céntimos), en tres comprobaciones (V3, 05/10/2026):
//      a) EVIDENCIA del transcript, sin IA: intervenciones en inglés más largas
//         en sus últimas clases (lib/testimonials evidenceImproves);
//      b) COMPARACIÓN A CIEGAS (lib/testimonialCompare): Haiku ve lo que dijo el
//         alumno en la clase antigua y en la reciente, en orden sorteado y sin
//         fechas, y tiene que elegir la reciente. Se hace una vez por pareja
//         (queda en ai_is_real);
//      c) los CLIPS (oct/2026): hasta 3 momentos cortos en que se traba en sus
//         primeras clases y hasta 3 en que habla con soltura en las últimas, con
//         las citas comprobadas, su segundo de inicio y de fin, y el resumen.
//         Van en la columna `clips` (supabase-testimoniales-clips.sql).
//      Si a) o b) no lo confirman, la pareja se descarta sola (discarded_by 'ia')
//      sin enseñarse nunca, y el alumno no vuelve hasta tener clases nuevas.
//      Si todo va bien pasa a 'ready' y aparece en "Por revisar".
//
// La detección corre tras cada nota de fluidez (lib/fluencyStore) y entera al
// abrir la pestaña (app/api/admin/testimonial-prepare). La preparación la pide
// la pestaña, de una en una, para que cada una quepa en los 60 s de Vercel.
//
// Una pareja activa sin `clips` (las preparadas antes de oct/2026, con un solo
// momento por lado) vuelve a la cola: se le generan los clips sin repetir las
// comprobaciones a) y b), que ya pasó.
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
  planCandidate, studentTrend, evidenceImproves, blindConfirms, clipsOverlap,
  type FluencyClass, type TestimonialCandidatePlan, type TestimonialClip, type TestimonialClips,
} from '@/lib/testimonials';
import {
  prepareFluency, formatTurnsForAi, locateExcerpt, excerptStartSeconds, excerptEndSeconds, excerptWordCount,
  formatSeconds, withFathomTimestamp, studentEnglishStats, studentOnlyText,
  type FluencyPrep, type EnglishStats,
} from '@/lib/fluency';
import { pickMoments, MAX_CLIPS, type MomentKind, type MomentIA } from '@/lib/testimonialClips';
import { compareBlind } from '@/lib/testimonialCompare';
import { TESTIMONIAL_RULES } from '@/lib/testimonialRules';

/** Caracteres de lo que dice el alumno por clase en la comparación a ciegas (~1.500 tokens). */
const BLIND_MAX_CHARS = 6_000;

type Row = Record<string, unknown>;

/** Tiempo mínimo que tiene que quedar para lanzar las dos llamadas de la preparación. */
export const PREPARE_MIN_MS = 40_000;
/** Una fila tocada hace menos de esto se considera "en preparación" en otro proceso. */
const LEASE_MS = 2 * 60_000;

export type DetectOutcome =
  | 'no_table'          // falta supabase-testimoniales-candidatos.sql
  | 'bloqueado_admin'   // el admin dijo "No sirve" a este alumno
  | 'ya_tiene'          // ya tiene una pareja activa
  | 'sin_pareja'        // no cumple la regla
  | 'creada';

/** 'descartada': la evidencia del transcript o la comparación a ciegas no confirmaron la mejora. */
export type PrepareOutcome = 'lista' | 'fallida' | 'descartada' | 'sin_tiempo' | 'ya_no_cumple' | 'nada';

const isMissingTable = (err: { code?: string } | null | undefined): boolean =>
  err?.code === '42P01' || err?.code === 'PGRST205';

const FLUENCY_COLS = 'student_group, analysis_id, student_class_number, class_day, teacher_id, fluency_score, fathom_url';

function toClass(r: Row): FluencyClass {
  return {
    analysisId:  String(r.analysis_id),
    classNumber: (r.student_class_number as number | null) ?? null,
    classDay:    String(r.class_day ?? ''),
    teacherId:   (r.teacher_id as string | null) ?? null,
    score:       Number(r.fluency_score),
    fathomUrl:   (r.fathom_url as string | null) ?? null,
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

async function allRows(table: string, cols: string, apply?: (q: any) => any): Promise<Row[]> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const page = () => {
      let q = supabase.from(table).select(cols);
      if (apply) q = apply(q);
      return q.order(table === 'testimonial_candidates' ? 'id' : 'analysis_id').range(from, from + 999);
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

/** Día ('YYYY-MM-DD') de la clase más reciente del alumno. */
const latestDay = (classes: FluencyClass[]): string =>
  classes.reduce((max, c) => (c.classDay > max ? c.classDay : max), '');

/**
 * Qué hacer con un alumno según sus filas de la tabla y su plan.
 *
 * Un descarte AUTOMÁTICO (discarded_by 'ia': la evidencia del transcript o la
 * comparación a ciegas no lo confirmaron) bloquea al alumno hasta que tenga una
 * clase posterior al descarte. Sin esto se volvería a crear y descartar la misma
 * pareja cada vez que se abre la pestaña.
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
async function insertCandidate(studentGroup: string, plan: TestimonialCandidatePlan): Promise<string | null> {
  // Nombre e id del alumno, de su clase más reciente.
  const { data: ca } = await supabase.from('class_analyses')
    .select('student_id, student_name').eq('id', plan.trend.last.at(-1)!.analysisId).maybeSingle();
  const now = new Date().toISOString();
  const id = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const { error } = await supabase.from('testimonial_candidates').insert({
    id, student_group: studentGroup,
    student_id: (ca?.student_id as string | null) ?? null,
    student_name: (ca?.student_name as string | null) ?? null,
    ...sideColumns('before', plan.before),
    ...sideColumns('after', plan.after),
    improvement: Math.round(plan.trend.improvement),
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
  const plan = planCandidate(classes);
  const outcome = decide((existing.data ?? []) as Row[], plan, latestDay(classes));
  if (outcome !== 'creada' || !plan || opts.dryRun) return { outcome, plan: plan ?? undefined };
  const id = await insertCandidate(studentGroup, plan);
  return id ? { outcome, candidateId: id, plan } : { outcome: 'ya_tiene' };
}

/** Detección de TODOS los alumnos de una vez (dos lecturas ligeras). Sin IA. */
export async function detectAll(opts: { dryRun?: boolean } = {}): Promise<{
  counts: Record<DetectOutcome, number>;
  created: Array<{ studentGroup: string; plan: TestimonialCandidatePlan }>;
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

  const created: Array<{ studentGroup: string; plan: TestimonialCandidatePlan }> = [];
  for (const [g, classes] of byGroup) {
    const plan = planCandidate(classes);
    let outcome = decide(rowsOf.get(g) ?? [], plan, latestDay(classes));
    if (outcome === 'creada' && plan) {
      if (!opts.dryRun && !(await insertCandidate(g, plan))) outcome = 'ya_tiene';
      else created.push({ studentGroup: g, plan });
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

/** Lee los transcripts de unas clases (una a una: nunca en listados) y los prepara para la IA. */
async function loadClasses(classes: FluencyClass[], studentName: string): Promise<LoadedClass[]> {
  const teacherNames = new Map<string, string | null>();
  const out: LoadedClass[] = [];
  for (const cls of classes) {
    const { data: ca } = await supabase.from('class_analyses')
      .select('transcript, teacher_id').eq('id', cls.analysisId).maybeSingle();
    if (!ca) continue;
    const tid = (ca.teacher_id as string | null) ?? null;
    if (tid && !teacherNames.has(tid)) {
      const { data: t } = await supabase.from('teachers').select('name').eq('id', tid).maybeSingle();
      teacherNames.set(tid, (t?.name as string | undefined) ?? null);
    }
    const prep = prepareFluency(String(ca.transcript ?? ''), { teacherName: tid ? teacherNames.get(tid) : null, studentName });
    if (prep.turns.length > 0) out.push({ cls, prep });
  }
  return out;
}

/** Una cita de la IA comprobada: o el clip, o por qué no vale. */
function checkClip(loaded: LoadedClass[], ai: MomentIA): { error: string } | { clip: TestimonialClip } {
  const chosen = loaded[ai.class_option - 1];
  const cita = `"${String(ai.excerpt ?? '').slice(0, 80)}"`;
  if (!chosen) return { error: `la clase ${ai.class_option} no existe.` };
  const words = excerptWordCount(ai.excerpt ?? '');
  if (words < 6) return { error: `la cita ${cita} es demasiado corta.` };
  const loc = locateExcerpt(chosen.prep.turns, ai.excerpt);
  if (!loc) return { error: `la cita ${cita} no aparece literal en un solo turno de la clase ${ai.class_option}.` };
  const speaker = chosen.prep.turns[loc.turnIndex].speaker;
  if (chosen.prep.teacherSpeaker && speaker === chosen.prep.teacherSpeaker) {
    return { error: `la cita ${cita} está en un turno del PROFE.` };
  }
  const start = excerptStartSeconds(chosen.prep.turns, loc);
  if (start == null) return { error: `el turno de la cita ${cita} no tiene minuto.` };
  const end = excerptEndSeconds(chosen.prep.turns, loc, words, start);
  return {
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
 * Una llamada para los clips de un tipo (y un reintento si NINGUNA cita vale y
 * queda tiempo). Las citas que no valen se tiran, y las que se pisan con otra
 * anterior también. `noTime`: no se llegó a llamar.
 */
async function chooseClips(
  kind: MomentKind, loaded: LoadedClass[], studentName: string, deadline: number,
  badMoments?: Array<{ date: string; excerpt: string }>,
): Promise<{ clips?: TestimonialClip[]; summary?: string; error?: string; noTime?: boolean }> {
  let retryNote: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    // La llamada nunca puede pasar del final de la función.
    const left = deadline - Date.now() - 2_000;
    if (left < 10_000) return retryNote ? { error: `Sin tiempo para reintentar. ${retryNote}` } : { noTime: true };
    const res = await pickMoments({
      kind, studentName, classes: formatForAi(loaded), badMoments, retryNote, timeoutMs: Math.min(25_000, left),
    });
    if (res.status !== 'ready' || !res.data) return { error: res.error ?? `La IA no respondió (${res.status}).` };
    const clips: TestimonialClip[] = [];
    const errors: string[] = [];
    for (const m of res.data.momentos ?? []) {
      const checked = checkClip(loaded, m);
      if ('error' in checked) { errors.push(checked.error); continue; }
      if (clips.some(c => clipsOverlap(c, checked.clip))) continue;
      clips.push(checked.clip);
      if (clips.length === MAX_CLIPS) break;
    }
    if (errors.length) console.log(`[testimonials] clips ${kind} descartados: ${errors.join(' | ')}`);
    if (clips.length > 0) return { clips, summary: res.data.summary?.trim() };
    retryNote = errors.length ? errors.join(' ') : 'no devolviste ningún momento.';
  }
  return { error: retryNote };
}

/**
 * Entre qué clases busca la IA: con la regla vigente, las primeras y las últimas
 * a los días mínimos (plan). Una pareja ya confirmada cuyo alumno ya no cumple
 * la regla (solo pasa al regenerar los clips) usa sus 3 primeras y sus 3
 * últimas, sin repetir ninguna.
 */
function clipWindows(plan: TestimonialCandidatePlan | null, classes: FluencyClass[]): { bad: FluencyClass[]; good: FluencyClass[] } | null {
  if (plan) return { bad: plan.badOptions, good: plan.goodOptions };
  const trend = studentTrend(classes);
  if (!trend) return null;
  const firstIds = new Set(trend.first.map(c => c.analysisId));
  return { bad: trend.first, good: trend.last.filter(c => !firstIds.has(c.analysisId)) };
}

/** Falta la columna `clips` (supabase-testimoniales-clips.sql sin correr). */
const isMissingColumn = (err: { code?: string; message?: string } | null | undefined): boolean =>
  err?.code === 'PGRST204' || err?.code === '42703' || (/clips/.test(err?.message ?? '') && /column/i.test(err?.message ?? ''));

export const MISSING_CLIPS_SQL = 'Falta correr supabase-testimoniales-clips.sql en Supabase.';

/**
 * Prepara los clips de una pareja activa. Si está en 'detectado' y aún no pasó
 * las comprobaciones de la V3, las pasa antes; si el alumno ya no cumple la regla
 * (nunca se enseñó, así que nadie la ha revisado), la pareja se borra.
 */
export async function prepareCandidate(id: string, deadline: number): Promise<PrepareOutcome> {
  const { data: c, error } = await supabase.from('testimonial_candidates')
    .select('id, student_group, student_name, status, ai_is_real, ai_reason').eq('id', id).maybeSingle();
  if (error || !c || c.status === 'descartado') return 'nada';
  // Ya pasó la comparación a ciegas: está en la pestaña (clips de antes de
  // oct/2026) o la preparación se cortó justo después.
  const confirmed = c.ai_is_real === true;

  const classes = await classesOf(String(c.student_group));
  const plan = planCandidate(classes);
  if (!plan && !confirmed) {
    await supabase.from('testimonial_candidates').delete().eq('id', id).eq('status', 'detectado').neq('ai_review_status', 'ready');
    return 'ya_no_cumple';
  }

  const fail = async (msg: string): Promise<PrepareOutcome> => {
    await supabase.from('testimonial_candidates').update({
      ai_review_status: 'failed', ai_error: msg.slice(0, 500), updated_at: new Date().toISOString(),
    }).eq('id', id).neq('status', 'descartado');
    return 'fallida';
  };

  // Las comprobaciones de la V3 dicen que la mejora no es real: la pareja se
  // descarta sola (sin enseñarse nunca) y el alumno no se vuelve a proponer
  // hasta que tenga clases nuevas (ver decide()).
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

  // ai_reason de las parejas antiguas acababa en " Malo: … Bueno: …" (el porqué
  // de su único clip): ahora el porqué va en cada clip.
  let checksReason = confirmed ? String(c.ai_reason ?? '').replace(/ Malo: [\s\S]*$/, '') : '';
  if (!confirmed && plan) {
    const firstLoaded = await loadClasses(plan.trend.first, studentName);
    const lastLoaded = await loadClasses(plan.trend.last, studentName);

    // 1. Evidencia del transcript (sin IA): intervenciones en inglés más largas.
    const statsOf = (l: LoadedClass[]) => l
      .map(x => studentEnglishStats(x.prep, { top: TESTIMONIAL_RULES.TURNOS_TOP, longWords: TESTIMONIAL_RULES.PALABRAS_TURNO_LARGO }))
      .filter((s): s is EnglishStats => s !== null);
    const evidence = evidenceImproves(statsOf(firstLoaded), statsOf(lastLoaded));
    if (!evidence.ok) return discard(evidence.reason);

    // 2. Comparación a ciegas (Haiku), una sola vez por pareja: si la preparación
    //    se corta después por tiempo, el siguiente intento no la repite.
    const older = firstLoaded.find(x => x.cls.analysisId === plan.before.analysisId);
    const newer = lastLoaded.find(x => x.cls.analysisId === plan.after.analysisId);
    if (!older || !newer) return fail('No se pudieron leer los transcripts de la clase antigua o de la reciente.');
    const left = deadline - Date.now() - 2_000;
    if (left < 10_000) return 'sin_tiempo';
    // El orden lo decide un sorteo: la IA no sabe cuál es la reciente.
    const laterIsA = Math.random() < 0.5;
    const olderText = studentOnlyText(older.prep, BLIND_MAX_CHARS);
    const newerText = studentOnlyText(newer.prep, BLIND_MAX_CHARS);
    const res = await compareBlind({
      a: laterIsA ? newerText : olderText,
      b: laterIsA ? olderText : newerText,
      timeoutMs: Math.min(15_000, left),
    });
    if (res.status !== 'ready' || !res.data) return fail(`Comparación a ciegas: ${res.error ?? 'la IA no respondió'}`);
    const { mas_soltura, confianza, motivo } = res.data;
    if (!blindConfirms(mas_soltura, confianza, laterIsA)) {
      const pick = mas_soltura === 'igual' ? 'no vio diferencia' : (mas_soltura === 'A') === laterIsA ? 'eligió la reciente' : 'eligió la ANTIGUA';
      return discard(`Comparación a ciegas: ${pick} (confianza ${confianza}). ${motivo}`);
    }
    checksReason = `Comparación a ciegas: eligió la reciente (confianza ${confianza}). ${motivo} ${evidence.reason}`;
    await supabase.from('testimonial_candidates').update({
      ai_is_real: true, ai_reason: checksReason.slice(0, 1000), updated_at: new Date().toISOString(),
    }).eq('id', id).eq('status', 'detectado');
  }

  // 3. Los clips (Haiku): hasta 3 malos de las primeras clases y hasta 3 buenos de las últimas.
  const windows = clipWindows(plan, classes);
  if (!windows) return fail('El alumno ya no tiene clases con nota suficientes.');
  const badLoaded = await loadClasses(windows.bad, studentName);
  if (badLoaded.length === 0) return fail('No se pudieron leer los transcripts de sus primeras clases.');
  const goodLoaded = await loadClasses(windows.good, studentName);
  if (goodLoaded.length === 0) return fail('No se pudieron leer los transcripts de sus últimas clases.');

  const bad = await chooseClips('malo', badLoaded, studentName, deadline);
  if (bad.noTime) return 'sin_tiempo';
  if (!bad.clips) return fail(`Momentos malos: ${bad.error}`);
  const good = await chooseClips('bueno', goodLoaded, studentName, deadline,
    bad.clips.map(x => ({ date: x.classDate, excerpt: x.excerpt })));
  if (good.noTime) return 'sin_tiempo';
  if (!good.clips) return fail(`Momentos buenos: ${good.error}`);

  const clips: TestimonialClips = { malos: bad.clips, buenos: good.clips };
  // before_*/after_*: el clip más claro de cada lado, para lo que aún lea esas columnas.
  const byId = new Map(classes.map(x => [x.analysisId, x]));
  const side = (pre: 'before' | 'after', clip: TestimonialClip): Row => sideColumns(pre, {
    analysisId: clip.analysisId, classNumber: byId.get(clip.analysisId)?.classNumber ?? null,
    classDay: clip.classDate, teacherId: clip.teacherId, score: byId.get(clip.analysisId)?.score ?? 0,
    fathomUrl: byId.get(clip.analysisId)?.fathomUrl ?? null,
  }, { excerpt: clip.excerpt, seconds: clip.start });
  const { error: upErr } = await supabase.from('testimonial_candidates').update({
    ...side('before', clips.malos[0]),
    ...side('after', clips.buenos[0]),
    clips,
    ...(plan ? { improvement: Math.round(plan.trend.improvement) } : {}),
    ai_review_status: 'ready',
    ai_summary: good.summary || null,
    ai_reason: checksReason.trim().slice(0, 1000) || null,
    ai_is_real: true, ai_error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', id).neq('status', 'descartado');
  if (isMissingColumn(upErr)) return fail(MISSING_CLIPS_SQL);
  if (upErr) return fail(`Guardando: ${upErr.message}`);
  return 'lista';
}

/**
 * Parejas activas que esperan clips: las nuevas ('pending') y las preparadas
 * antes de oct/2026, que están 'ready' pero sin `clips`.
 */
const NEEDS_CLIPS = 'ai_review_status.eq.pending,and(ai_review_status.eq.ready,clips.is.null)';

/** Cuántas parejas esperan preparación (las que la pestaña no enseña aún). */
export async function prepareQueue(): Promise<{ pending: number; failed: number }> {
  const count = async (apply: (q: any) => any) => {   // eslint-disable-line @typescript-eslint/no-explicit-any
    const { count: n, error } = await apply(supabase.from('testimonial_candidates').select('id', { count: 'exact' })
      .neq('status', 'descartado')).range(0, 0);
    if (isMissingColumn(error)) throw new Error(MISSING_CLIPS_SQL);
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
  const { data, error } = await q.order('id').limit(1);
  if (isMissingColumn(error)) throw new Error(MISSING_CLIPS_SQL);
  const id = data?.[0]?.id as string | undefined;
  if (!id) return 'nada';
  // Reserva: solo sigue si esta ejecución consiguió marcarla.
  const { data: mine } = await supabase.from('testimonial_candidates')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id).lt('updated_at', cutoff).select('id');
  if (!mine?.length) return 'sin_tiempo';
  return prepareCandidate(id, opts.deadline);
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
