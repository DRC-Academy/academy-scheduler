// Testimoniales — detección de la pareja "antes / después" de un alumno y su
// segunda revisión con IA, sobre `testimonial_candidates`
// (supabase-testimoniales-candidatos.sql). SOLO SERVIDOR.
//
// Se llama cada vez que un transcript recibe nota de fluidez (lib/fluencyStore)
// y al final de cada tanda de "Analizar clases pasadas" (lib/fluencyBackfill).
// No avisa a nadie: las parejas solo se ven en la pestaña Testimoniales.
//
// REGLAS DE LA TABLA (las decide Facundo, 30/09/2026):
//   · máximo una pareja ACTIVA por alumno (= cualquier estado menos descartado);
//     lo garantiza también un índice único en la base;
//   · si sale una mejor y la activa sigue en 'detectado', se reemplaza en el
//     sitio; si ya está en revisado o más allá, no se toca nunca;
//   · si el ADMIN descartó una pareja del alumno, el alumno no se vuelve a
//     proponer; si la descartó la IA, puede salir otra pareja, nunca la misma.

import 'server-only';

import { supabase } from '@/lib/supabase';
import { findBestPair, isBetterPair, pairKey, type FluencyClass, type TestimonialPair } from '@/lib/testimonials';
import { reviewTestimonial, type ReviewSide } from '@/lib/reviewTestimonial';

type Row = Record<string, unknown>;

/** Margen mínimo que tiene que quedar para lanzar la revisión con IA (20 s de tope + escrituras). */
export const REVIEW_MIN_MS = 23_000;

export type DetectOutcome =
  | 'no_table'          // falta supabase-testimoniales-candidatos.sql
  | 'bloqueado_admin'   // el admin descartó una pareja de este alumno
  | 'bloqueado_estado'  // la pareja activa ya está en revisado o más allá
  | 'sin_pareja'
  | 'sin_cambios'       // la activa sigue siendo la mejor
  | 'creada'
  | 'reemplazada';

export interface DetectResult {
  studentGroup: string;
  outcome: DetectOutcome;
  candidateId?: string;
  pair?: TestimonialPair;
  review?: ReviewOutcome;
}

export type ReviewOutcome = 'real' | 'descartada' | 'fallida' | 'sin_tiempo';

const isMissingTable = (err: { code?: string } | null | undefined): boolean =>
  err?.code === '42P01' || err?.code === 'PGRST205';

const FLUENCY_COLS =
  'analysis_id, student_class_number, class_day, teacher_id, fluency_score, ' +
  'best_excerpt, best_excerpt_at, best_excerpt_found, worst_excerpt, worst_excerpt_at, worst_excerpt_found, fathom_url';

function toClass(r: Row): FluencyClass {
  return {
    analysisId:   String(r.analysis_id),
    classNumber:  (r.student_class_number as number | null) ?? null,
    classDay:     String(r.class_day ?? ''),
    teacherId:    (r.teacher_id as string | null) ?? null,
    score:        Number(r.fluency_score),
    bestExcerpt:  (r.best_excerpt as string | null) ?? null,
    bestAt:       (r.best_excerpt_at as string | null) ?? null,
    bestFound:    (r.best_excerpt_found as boolean | null) ?? null,
    worstExcerpt: (r.worst_excerpt as string | null) ?? null,
    worstAt:      (r.worst_excerpt_at as string | null) ?? null,
    worstFound:   (r.worst_excerpt_found as boolean | null) ?? null,
    fathomUrl:    (r.fathom_url as string | null) ?? null,
  };
}

/** Los campos de la pareja tal como van a la tabla (foto del momento). */
function pairColumns(p: TestimonialPair): Row {
  return {
    before_analysis_id:  p.before.analysisId,
    before_teacher_id:   p.before.teacherId,
    before_class_number: p.before.classNumber,
    before_class_date:   p.before.classDay || null,
    before_score:        p.before.score,
    before_excerpt:      p.before.worstExcerpt,
    before_excerpt_at:   p.before.worstAt,
    before_fathom_url:   p.before.fathomUrl,
    after_analysis_id:   p.after.analysisId,
    after_teacher_id:    p.after.teacherId,
    after_class_number:  p.after.classNumber,
    after_class_date:    p.after.classDay || null,
    after_score:         p.after.score,
    after_excerpt:       p.after.bestExcerpt,
    after_excerpt_at:    p.after.bestAt,
    after_fathom_url:    p.after.fathomUrl,
    improvement:         p.improvement,
    // Pareja nueva o cambiada: la revisión de la anterior ya no vale.
    ai_review_status: 'pending', ai_is_real: null, ai_reason: null, ai_summary: null, ai_error: null,
  };
}

/**
 * Busca la mejor pareja del alumno y la crea o reemplaza según las reglas de
 * arriba. Si queda tiempo antes de `deadline` (epoch ms), lanza la revisión con
 * IA de la pareja nueva; si no, queda 'pending' para la siguiente pasada.
 */
export async function detectForStudent(
  studentGroup: string, opts: { deadline?: number; dryRun?: boolean } = {},
): Promise<DetectResult> {
  const base = { studentGroup };

  const existing = await supabase
    .from('testimonial_candidates')
    .select('id, status, discarded_by, before_analysis_id, after_analysis_id, improvement, before_class_date, after_class_date, ai_review_status')
    .eq('student_group', studentGroup);
  if (isMissingTable(existing.error)) return { ...base, outcome: 'no_table' };
  if (existing.error) throw new Error(`testimonial_candidates: ${existing.error.message}`);
  const rows = (existing.data ?? []) as Row[];

  if (rows.some(r => r.status === 'descartado' && r.discarded_by === 'admin')) return { ...base, outcome: 'bloqueado_admin' };
  const active = rows.find(r => r.status !== 'descartado') ?? null;
  if (active && active.status !== 'detectado') return { ...base, outcome: 'bloqueado_estado', candidateId: String(active.id) };

  // Clases con nota del alumno. Solo columnas ligeras: la vista nunca trae transcript.
  const cls = await supabase
    .from('transcript_fluency_numbered')
    .select(FLUENCY_COLS)
    .eq('student_group', studentGroup)
    .eq('status', 'ready')
    .not('fluency_score', 'is', null);
  if (cls.error) throw new Error(`transcript_fluency_numbered: ${cls.error.message}`);

  const excluded = new Set(rows.filter(r => r.status === 'descartado')
    .map(r => pairKey(String(r.before_analysis_id), String(r.after_analysis_id))));
  const pair = findBestPair(((cls.data ?? []) as unknown as Row[]).map(toClass), undefined, excluded);

  // Si la activa sigue siendo la mejor (o igual de buena), solo se completa su
  // revisión si quedó pendiente.
  if (active) {
    const same = pair && pair.before.analysisId === active.before_analysis_id && pair.after.analysisId === active.after_analysis_id;
    const activeScore = {
      improvement: Number(active.improvement),
      afterDay: String(active.after_class_date ?? ''),
      daysApart: 0,
    };
    if (!pair || same || !isBetterPair({ ...pair, afterDay: pair.after.classDay, daysApart: 0 }, activeScore)) {
      const review = !opts.dryRun && active.ai_review_status !== 'ready'
        ? await reviewIfTime(String(active.id), opts.deadline) : undefined;
      return { ...base, outcome: pair || same ? 'sin_cambios' : 'sin_pareja', candidateId: String(active.id), review };
    }
  } else if (!pair) {
    return { ...base, outcome: 'sin_pareja' };
  }

  const p = pair as TestimonialPair;
  if (opts.dryRun) return { ...base, outcome: active ? 'reemplazada' : 'creada', pair: p, candidateId: active ? String(active.id) : undefined };

  // Nombre e id del alumno, de la clase "después" (la más reciente).
  const { data: ca } = await supabase.from('class_analyses')
    .select('student_id, student_name').eq('id', p.after.analysisId).maybeSingle();
  const now = new Date().toISOString();
  const cols: Row = {
    ...pairColumns(p),
    student_id: (ca?.student_id as string | null) ?? null,
    student_name: (ca?.student_name as string | null) ?? null,
    updated_at: now,
  };

  let id: string;
  if (active) {
    id = String(active.id);
    // El .eq('status') evita pisar una pareja que el admin movió mientras tanto.
    const { error } = await supabase.from('testimonial_candidates').update(cols).eq('id', id).eq('status', 'detectado');
    if (error) throw new Error(`Reemplazando pareja ${id}: ${error.message}`);
  } else {
    id = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { error } = await supabase.from('testimonial_candidates').insert({
      id, student_group: studentGroup, status: 'detectado', status_changed_at: now, ...cols,
    });
    // 23505: otra ejecución creó la pareja activa a la vez (índice único). La suya vale.
    if (error?.code === '23505') return { ...base, outcome: 'sin_cambios' };
    if (error) throw new Error(`Creando pareja: ${error.message}`);
  }

  const review = await reviewIfTime(id, opts.deadline);
  return { ...base, outcome: active ? 'reemplazada' : 'creada', candidateId: id, pair: p, review };
}

async function reviewIfTime(id: string, deadline?: number): Promise<ReviewOutcome> {
  if (deadline != null && deadline - Date.now() < REVIEW_MIN_MS) return 'sin_tiempo';
  return reviewCandidate(id);
}

/**
 * Segunda revisión con Haiku de una pareja. Si la IA no la ve real, la pareja
 * pasa a 'descartado' (por: IA) con el motivo. Si la IA falla, queda 'failed'
 * en `ai_review_status` y sigue en 'detectado' para reintentarla.
 */
export async function reviewCandidate(id: string): Promise<ReviewOutcome> {
  const { data: c, error } = await supabase.from('testimonial_candidates').select('*').eq('id', id).maybeSingle();
  if (error || !c || c.status !== 'detectado') return 'fallida';

  const { data: fl } = await supabase.from('transcript_fluency')
    .select('analysis_id, fluency_evidence, hesitation_level, spanish_usage')
    .in('analysis_id', [c.before_analysis_id, c.after_analysis_id]);
  const extra = (aid: unknown) => ((fl ?? []) as Row[]).find(r => r.analysis_id === aid) ?? {};

  const sideOf = (pre: 'before' | 'after'): ReviewSide => {
    const e = extra(c[`${pre}_analysis_id`]);
    return {
      date: c[`${pre}_class_date`], classNumber: c[`${pre}_class_number`], score: c[`${pre}_score`],
      excerpt: c[`${pre}_excerpt`], at: c[`${pre}_excerpt_at`],
      evidence: (e.fluency_evidence as string | null) ?? null,
      hesitation: (e.hesitation_level as string | null) ?? null,
      spanish: (e.spanish_usage as string | null) ?? null,
    };
  };

  const res = await reviewTestimonial({ before: sideOf('before'), after: sideOf('after') });
  const now = new Date().toISOString();

  if (res.status !== 'ready' || !res.data) {
    await supabase.from('testimonial_candidates').update({
      ai_review_status: 'failed', ai_error: (res.error ?? 'La IA no respondió.').slice(0, 500), updated_at: now,
    }).eq('id', id);
    return 'fallida';
  }

  const real = res.data.is_real;
  await supabase.from('testimonial_candidates').update({
    ai_review_status: 'ready', ai_is_real: real, ai_reason: res.data.reason, ai_summary: res.data.summary, ai_error: null,
    updated_at: now,
    ...(real ? {} : { status: 'descartado', discarded_by: 'ia', status_changed_at: now }),
  }).eq('id', id).eq('status', 'detectado');
  return real ? 'real' : 'descartada';
}

/** Revisiones pendientes o fallidas de parejas en 'detectado', mientras haya tiempo. */
export async function reviewPending(opts: { limit: number; deadline?: number }): Promise<Record<ReviewOutcome, number>> {
  const out: Record<ReviewOutcome, number> = { real: 0, descartada: 0, fallida: 0, sin_tiempo: 0 };
  const { data, error } = await supabase.from('testimonial_candidates')
    .select('id').eq('status', 'detectado').in('ai_review_status', ['pending', 'failed']).limit(opts.limit);
  if (error) return out;
  for (const r of data ?? []) {
    const o = await reviewIfTime(String(r.id), opts.deadline);
    out[o]++;
    if (o === 'sin_tiempo') break;
  }
  return out;
}

/** Para después de un análisis de fluidez: nunca lanza. */
export async function detectInBackground(studentGroup: string, deadline: number): Promise<void> {
  try {
    const r = await detectForStudent(studentGroup, { deadline });
    if (r.outcome === 'creada' || r.outcome === 'reemplazada') {
      console.log(`[testimonials] ${studentGroup}: pareja ${r.outcome} (${r.candidateId}), revisión ${r.review}.`);
    }
  } catch (err) {
    console.error(`[testimonials] Detección fallida para ${studentGroup}:`, err);
  }
}
