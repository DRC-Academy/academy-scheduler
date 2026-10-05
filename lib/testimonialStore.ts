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
//      c) los CLIPS: el peor momento entre sus primeras clases y el mejor entre
//         sus últimas, con las citas comprobadas, su segundo exacto y el resumen.
//      Si a) o b) no lo confirman, la pareja se descarta sola (discarded_by 'ia')
//      sin enseñarse nunca, y el alumno no vuelve hasta tener clases nuevas.
//      Si todo va bien pasa a 'ready' y aparece en "Por revisar".
//
// La detección corre tras cada nota de fluidez (lib/fluencyStore) y entera al
// abrir la pestaña (app/api/admin/testimonial-prepare). La preparación la pide
// la pestaña, de una en una, para que cada una quepa en los 60 s de Vercel.
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
  planCandidate, goodOptionsAfter, evidenceImproves, blindConfirms,
  type FluencyClass, type TestimonialCandidatePlan,
} from '@/lib/testimonials';
import {
  prepareFluency, formatTurnsForAi, locateExcerpt, excerptStartSeconds, formatSeconds, withFathomTimestamp,
  studentEnglishStats, studentOnlyText,
  type FluencyPrep, type EnglishStats,
} from '@/lib/fluency';
import { pickMoment, type MomentKind, type MomentIA } from '@/lib/testimonialClips';
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

interface Clip {
  cls: FluencyClass;
  excerpt: string;
  seconds: number;
  ai: MomentIA;
}

/** Por qué una cita de la IA no vale (null = vale), y su segundo si vale. */
function checkClip(loaded: LoadedClass[], ai: MomentIA): { error: string } | { clip: Clip } {
  const chosen = loaded[ai.class_option - 1];
  if (!chosen) return { error: `la clase ${ai.class_option} no existe.` };
  const loc = locateExcerpt(chosen.prep.turns, ai.excerpt);
  if (!loc) return { error: `la cita "${ai.excerpt.slice(0, 80)}" no aparece literal en un solo turno de la clase ${ai.class_option}.` };
  const speaker = chosen.prep.turns[loc.turnIndex].speaker;
  if (chosen.prep.teacherSpeaker && speaker === chosen.prep.teacherSpeaker) {
    return { error: `la cita "${ai.excerpt.slice(0, 80)}" está en un turno del PROFE.` };
  }
  const seconds = excerptStartSeconds(chosen.prep.turns, loc);
  if (seconds == null) return { error: 'el turno de la cita no tiene minuto.' };
  return { clip: { cls: chosen.cls, excerpt: ai.excerpt.trim(), seconds, ai } };
}

const formatForAi = (l: LoadedClass[]) =>
  l.map(x => ({ date: x.cls.classDay, turnsText: formatTurnsForAi(x.prep) }));

/** Una llamada (y un reintento si la cita no vale y queda tiempo). `noTime`: no se llegó a llamar. */
async function choose(
  kind: MomentKind, loaded: LoadedClass[], studentName: string, deadline: number,
  badMoment?: { date: string; excerpt: string },
): Promise<{ clip?: Clip; error?: string; noTime?: boolean }> {
  let retryNote: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    // La llamada nunca puede pasar del final de la función.
    const left = deadline - Date.now() - 2_000;
    if (left < 10_000) return retryNote ? { error: `Sin tiempo para reintentar. ${retryNote}` } : { noTime: true };
    const res = await pickMoment({
      kind, studentName, classes: formatForAi(loaded), badMoment, retryNote, timeoutMs: Math.min(25_000, left),
    });
    if (res.status !== 'ready' || !res.data) return { error: res.error ?? `La IA no respondió (${res.status}).` };
    const checked = checkClip(loaded, res.data);
    if ('clip' in checked) return { clip: checked.clip };
    retryNote = `La cita no valía: ${checked.error}`;
  }
  return { error: retryNote };
}

/**
 * Prepara los clips de una pareja en 'detectado'. Si el alumno ya no cumple la
 * regla (nunca se enseñó, así que nadie la ha revisado), la pareja se borra.
 */
export async function prepareCandidate(id: string, deadline: number): Promise<PrepareOutcome> {
  const { data: c, error } = await supabase.from('testimonial_candidates')
    .select('id, student_group, student_name, status, ai_is_real, ai_reason').eq('id', id).maybeSingle();
  if (error || !c || c.status !== 'detectado') return 'nada';

  const plan = planCandidate(await classesOf(String(c.student_group)));
  if (!plan) {
    await supabase.from('testimonial_candidates').delete().eq('id', id).eq('status', 'detectado').neq('ai_review_status', 'ready');
    return 'ya_no_cumple';
  }

  const fail = async (msg: string): Promise<PrepareOutcome> => {
    await supabase.from('testimonial_candidates').update({
      ai_review_status: 'failed', ai_error: msg.slice(0, 500), updated_at: new Date().toISOString(),
    }).eq('id', id).eq('status', 'detectado');
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
  let blindReason = c.ai_is_real === true ? String(c.ai_reason ?? '') : '';
  if (c.ai_is_real !== true) {
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
    blindReason = `Comparación a ciegas: eligió la reciente (confianza ${confianza}). ${motivo}`;
    await supabase.from('testimonial_candidates').update({
      ai_is_real: true, ai_reason: blindReason.slice(0, 1000), updated_at: new Date().toISOString(),
    }).eq('id', id).eq('status', 'detectado');
  }

  // 3. Los clips (Haiku): el peor momento de las primeras clases y el mejor de las últimas.
  const badIds = new Set(plan.badOptions.map(x => x.analysisId));
  const badLoaded = firstLoaded.filter(x => badIds.has(x.cls.analysisId));
  if (badLoaded.length === 0) return fail('No se pudieron leer los transcripts de sus primeras clases.');
  const bad = await choose('malo', badLoaded, studentName, deadline);
  if (bad.noTime) return 'sin_tiempo';
  if (!bad.clip) return fail(`Momento malo: ${bad.error}`);

  // La buena, a los días mínimos de la mala que eligió la IA.
  const goodIds = new Set(goodOptionsAfter(bad.clip.cls, plan.goodOptions).map(x => x.analysisId));
  const goodLoaded = lastLoaded.filter(x => goodIds.has(x.cls.analysisId));
  if (goodLoaded.length === 0) return fail('No se pudieron leer los transcripts de sus últimas clases.');
  const good = await choose('bueno', goodLoaded, studentName, deadline,
    { date: bad.clip.cls.classDay, excerpt: bad.clip.excerpt });
  if (good.noTime) return 'sin_tiempo';
  if (!good.clip) return fail(`Momento bueno: ${good.error}`);

  const { error: upErr } = await supabase.from('testimonial_candidates').update({
    ...sideColumns('before', bad.clip.cls, bad.clip),
    ...sideColumns('after', good.clip.cls, good.clip),
    improvement: Math.round(plan.trend.improvement),
    ai_review_status: 'ready',
    ai_summary: good.clip.ai.summary?.trim() || null,
    ai_reason: `${blindReason} ${evidence.reason} Malo: ${bad.clip.ai.why} Bueno: ${good.clip.ai.why}`.trim().slice(0, 1000),
    ai_is_real: true, ai_error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'detectado');
  if (upErr) return fail(`Guardando: ${upErr.message}`);
  return 'lista';
}

/** Cuántas parejas esperan preparación (las que la pestaña no enseña aún). */
export async function prepareQueue(): Promise<{ pending: number; failed: number }> {
  const count = async (st: string) => {
    const { count: n } = await supabase.from('testimonial_candidates').select('id', { count: 'exact' })
      .eq('status', 'detectado').eq('ai_review_status', st).range(0, 0);
    return n ?? 0;
  };
  const [pending, failed] = await Promise.all([count('pending'), count('failed')]);
  return { pending, failed };
}

/**
 * Coge UNA pareja sin preparar (o fallida, con `retryFailed`) que nadie esté
 * preparando y la prepara. 'nada' = no queda ninguna libre.
 */
export async function prepareNext(opts: { deadline: number; retryFailed?: boolean }): Promise<PrepareOutcome> {
  const estado = opts.retryFailed ? 'failed' : 'pending';
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString();
  const { data } = await supabase.from('testimonial_candidates').select('id')
    .eq('status', 'detectado').eq('ai_review_status', estado).lt('updated_at', cutoff)
    .order('id').limit(1);
  const id = data?.[0]?.id as string | undefined;
  if (!id) return 'nada';
  // Reserva: solo sigue si esta ejecución consiguió marcarla.
  const { data: mine } = await supabase.from('testimonial_candidates')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id).eq('ai_review_status', estado).lt('updated_at', cutoff).select('id');
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
