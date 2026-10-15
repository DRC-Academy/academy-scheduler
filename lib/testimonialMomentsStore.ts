// Testimoniales V5 — momentos de cada transcript y parejas por código. SOLO SERVIDOR.
//
// Tablas (supabase-testimoniales-v5.sql):
//   · testimonial_transcripts: una fila por transcript, con la etiqueta de Fathom
//     del alumno decidida por código, o por qué quedó fuera;
//   · testimonial_moments: hasta 2 momentos malos y 2 muy buenos por transcript;
//   · testimonial_candidates: la pareja de cada alumno con cada profe.
//
// FLUJO DE UN TRANSCRIPT (runMomentsFor):
//   1. lib/testimonialSpeaker resolveStudentLabel → si no se sabe con seguridad
//      quién es el alumno, 'excluded' y fuera;
//   2. Haiku ve SOLO sus intervenciones (lib/testimonialMoments);
//   3. lib/testimonialPairs validateMoment comprueba cada cita; se guardan las
//      mejores (keepBest);
//   4. se rehacen las parejas de ese alumno (syncPairs).
// Corre con cada transcript nuevo (after() en save-transcript y analyze-transcript)
// y, para lo antiguo, por tandas desde la pestaña (/api/admin/testimonial-prepare)
// o con `npm run testimonios`.
//
// RESERVA de las tandas: igual que lib/fluencyBackfill. Cada tanda marca sus filas
// tocando updated_at y solo coge las que llevan 2 minutos sin tocarse.

import 'server-only';

import { supabase } from '@/lib/supabase';
import { parseTurns, extractFathomUrl } from '@/lib/fluency';
import { resolveStudentKey } from '@/lib/fluencyStore';
import { spainTodayIso } from '@/lib/retention';
import {
  resolveStudentLabel, studentInterventions, formatInterventionsForAi, type LabelExclusion,
} from '@/lib/testimonialSpeaker';
import { pickClassMoments, MAX_PER_KIND } from '@/lib/testimonialMoments';
import {
  validateMoment, keepBest,
  type Moment, type MomentCandidate, type MomentClassContext,
} from '@/lib/testimonialPairs';
import { FLUENCY_MODEL } from '@/lib/analyzeFluency';
import { syncSegmentPairs } from '@/lib/testimonialSegmentsStore';

type Row = Record<string, unknown>;

/** Transcripts por tanda (en paralelo). */
export const BATCH_SIZE = 6;
/** Intentos de IA por transcript antes de dejarlo. */
export const MAX_ATTEMPTS = 3;
const LEASE_MS = 2 * 60_000;
const NEVER = '2000-01-01T00:00:00.000Z';

/** 'pending' solo con `reuseOnly`: no había nada que reaprovechar, falta la IA. */
export type MomentsRunStatus = 'ready' | 'excluded' | 'failed' | 'missing' | 'pending';

export interface MomentsRunResult {
  analysisId: string;
  status: MomentsRunStatus;
  studentGroup?: string;
  reason?: LabelExclusion;
  moments?: Moment[];
  rejected?: string[];
  error?: string;
}

// ── Un transcript ────────────────────────────────────────────────────────────

/** Fecha de la clase en España. */
function classDayOf(ca: Row): string {
  if (ca.class_date) return String(ca.class_date).slice(0, 10);
  return ca.analyzed_at ? spainTodayIso(new Date(String(ca.analyzed_at))) : '';
}

const newMomentId = (analysisId: string, i: number): string =>
  `tm_${analysisId}_${i}_${Math.random().toString(36).slice(2, 6)}`;

/**
 * Analiza un transcript: etiqueta del alumno, momentos con IA y comprobación.
 * Con `dryRun` no escribe nada (sí llama a la IA si el transcript es válido).
 */
/** `model` de los transcripts cuyos momentos salen del análisis de fluidez anterior. */
export const REUSED_MODEL = 'reutilizado-fluidez';

/**
 * Las citas mala y buena del análisis de fluidez de esta clase, comprobadas como
 * un momento nuevo. La puntuación sale de la nota de fluidez de la clase: el malo
 * de una clase de 3/10 vale 8; el bueno de una de 9/10 vale 9.
 */
async function reuseFluencyMoments(ctx: MomentClassContext): Promise<{ moments: Array<Omit<Moment, 'id'>>; rejected: string[] }> {
  const { data: f } = await supabase.from('transcript_fluency')
    .select('status, fluency_score, best_excerpt, worst_excerpt')
    .eq('analysis_id', ctx.analysisId).maybeSingle();
  const out = { moments: [] as Array<Omit<Moment, 'id'>>, rejected: [] as string[] };
  const nota = Number(f?.fluency_score);
  if (!f || f.status !== 'ready' || !(nota >= 1 && nota <= 10)) return out;
  const candidatos: MomentCandidate[] = [];
  if (f.worst_excerpt) candidatos.push({
    tipo: 'malo', intervencion: 0, cita: String(f.worst_excerpt), puntuacion: 11 - nota,
    porque: `El momento más flojo de una clase con fluidez ${nota}/10.`,
  });
  if (f.best_excerpt) candidatos.push({
    tipo: 'bueno', intervencion: 0, cita: String(f.best_excerpt), puntuacion: nota,
    porque: `El momento más fluido de una clase con fluidez ${nota}/10.`,
  });
  for (const c of candidatos) {
    const r = validateMoment(ctx, c);
    if ('error' in r) out.rejected.push(`(reutilizada) ${r.error}`); else out.moments.push(r.moment);
  }
  return out;
}

export async function runMomentsFor(
  analysisId: string, opts: { dryRun?: boolean; timeoutMs?: number; skipPairs?: boolean; reuseOnly?: boolean } = {},
): Promise<MomentsRunResult> {
  // Lectura de UNA fila con su transcript: nunca en listados (ver has_transcript).
  const { data: ca } = await supabase.from('class_analyses')
    .select('id, transcript, student_id, student_name, teacher_id, class_date, analyzed_at')
    .eq('id', analysisId).maybeSingle();
  if (!ca) return { analysisId, status: 'missing' };
  const { data: prev } = await supabase.from('testimonial_transcripts')
    .select('student_group, attempts').eq('analysis_id', analysisId).maybeSingle();

  const transcript = String(ca.transcript ?? '');
  const studentName = (ca.student_name as string | null) ?? null;
  const studentGroup = (ca.student_id as string | null)
    ?? (prev?.student_group as string | null)
    ?? await resolveStudentKey(null, studentName);
  const teacherId = (ca.teacher_id as string | null) ?? null;
  const classDay = classDayOf(ca);
  const fathomUrl = extractFathomUrl(transcript);
  const now = new Date().toISOString();
  const base: Row = {
    analysis_id: analysisId, student_group: studentGroup, student_name: studentName,
    teacher_id: teacherId, class_day: classDay || null, fathom_url: fathomUrl, updated_at: now,
  };

  const save = async (row: Row, moments: Moment[] | null) => {
    if (opts.dryRun) return;
    if (moments) {
      // Los momentos de una clase se rehacen enteros.
      await supabase.from('testimonial_moments').delete().eq('analysis_id', analysisId);
      if (moments.length) {
        const { error } = await supabase.from('testimonial_moments').insert(moments.map(m => ({
          id: m.id, analysis_id: m.analysisId, student_group: m.studentGroup, teacher_id: m.teacherId,
          class_day: m.classDay || null, student_label: m.studentLabel, kind: m.kind,
          start_s: m.start, end_s: m.end, excerpt: m.excerpt, score: m.score, why: m.why || null,
          fathom_url: m.fathomUrl,
        })));
        if (error) throw new Error(`Guardando momentos: ${error.message}`);
      }
    }
    const { error } = await supabase.from('testimonial_transcripts').upsert({ ...base, ...row }, { onConflict: 'analysis_id' });
    if (error) throw new Error(`Guardando el transcript: ${error.message}`);
  };

  // 1. ¿Quién es el alumno? Por código; si no es seguro, fuera.
  const turns = parseTurns(transcript);
  const label = resolveStudentLabel(turns, studentName);
  if (!label.ok) {
    await save({
      status: 'excluded', exclusion_reason: label.reason, student_label: null, teacher_label: null,
      moments_count: 0, processed_at: now, last_error: null,
    }, []);
    if (!opts.skipPairs && !opts.dryRun) await syncPairs([studentGroup]);
    return { analysisId, status: 'excluded', studentGroup, reason: label.reason };
  }

  // 2. La IA, solo con las intervenciones del alumno.
  const interventions = studentInterventions(turns, label.studentLabel);
  const text = formatInterventionsForAi(interventions);
  const labels = { student_label: label.studentLabel, teacher_label: label.teacherLabel, exclusion_reason: null };
  let moments: Moment[] = [];
  const rejected: string[] = [];
  const ctx = { analysisId, studentGroup, teacherId, classDay, studentLabel: label.studentLabel, fathomUrl, turns, interventions };

  // 2a. Antes de gastar: las citas mala y buena que ya sacó el análisis de fluidez
  // (transcript_fluency, ~2.300 clases pagadas en sep/2026). Pasan por las MISMAS
  // comprobaciones que las de la IA nueva; si alguna vale, no se llama a la IA.
  const reused = await reuseFluencyMoments(ctx);
  rejected.push(...reused.rejected);
  if (reused.moments.length) {
    moments = reused.moments.map((m, i) => ({ ...m, id: newMomentId(analysisId, i) }));
    await save({ ...labels, status: 'ready', moments_count: moments.length, processed_at: now, last_error: null, model: REUSED_MODEL }, moments);
  } else if (opts.reuseOnly) {
    // Sin nada que reaprovechar: queda pendiente para la IA, sin momentos viejos.
    await save({ ...labels, status: 'pending', moments_count: 0, updated_at: NEVER }, []);
    return { analysisId, status: 'pending', studentGroup, rejected };
  } else if (text.trim()) {
    const res = await pickClassMoments({ studentName: studentName ?? label.studentLabel, interventionsText: text, timeoutMs: opts.timeoutMs });
    const attempts = Number(prev?.attempts ?? 0) + (res.status === 'skipped' ? 0 : 1);
    if (res.status !== 'ready' || !res.data) {
      const error = res.error ?? `La IA no respondió (${res.status}).`;
      await save({ ...labels, status: 'failed', attempts, last_error: error.slice(0, 500), model: FLUENCY_MODEL }, null);
      return { analysisId, status: 'failed', studentGroup, error };
    }
    // 3. Comprobación por código de cada cita.
    const valid: Array<Omit<Moment, 'id'>> = [];
    for (const ai of res.data.momentos ?? []) {
      const r = validateMoment(ctx, ai);
      if ('error' in r) rejected.push(r.error); else valid.push(r.moment);
    }
    moments = keepBest(valid, MAX_PER_KIND).map((m, i) => ({ ...m, id: newMomentId(analysisId, i) }));
    if (rejected.length) console.log(`[testimonios] ${analysisId}: citas rechazadas: ${rejected.join(' | ')}`);
    await save({ ...labels, status: 'ready', attempts, moments_count: moments.length, processed_at: now, last_error: null, model: FLUENCY_MODEL }, moments);
  } else {
    await save({ ...labels, status: 'ready', moments_count: 0, processed_at: now, last_error: null }, []);
  }

  // 4. Parejas de este alumno.
  if (!opts.skipPairs && !opts.dryRun) await syncPairs([studentGroup]);
  return { analysisId, status: 'ready', studentGroup, moments, rejected };
}

/** Para `after()` al subir un transcript: nunca lanza. */
export async function runMomentsInBackground(analysisId: string, deadline: number): Promise<void> {
  try {
    const left = deadline - Date.now() - 3_000;
    if (left < 15_000) { console.log(`[testimonios] ${analysisId}: sin tiempo, queda para la tanda.`); return; }
    const r = await runMomentsFor(analysisId, { timeoutMs: Math.min(40_000, left) });
    console.log(`[testimonios] ${analysisId}: ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.moments ? ` · ${r.moments.length} momentos` : ''}${r.error ? `: ${r.error}` : ''}`);
  } catch (err) {
    console.error(`[testimonios] Error inesperado con ${analysisId}:`, err);
  }
}

// ── Parejas ──────────────────────────────────────────────────────────────────
//
// Desde la V6 (15/10/2026) las parejas las elige SOLO el código a partir de los
// recortes de lib/testimonialSegmentsStore (una por alumno). Los momentos de IA
// de esta V5 ya no se emparejan: este flujo queda para el script y, si se usa,
// rehace las parejas con la regla V6 para no pisarlas con la vieja.

async function pagedRows(table: string, cols: string, order: string, apply?: (q: any) => any): Promise<Row[]> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(cols);
    if (apply) q = apply(q);
    const { data, error } = await q.order(order).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** Rehace las parejas con la regla V6 (ver lib/testimonialSegmentsStore). */
export async function syncPairs(groups?: string[]): Promise<{ created: number; updated: number; deleted: number }> {
  const { created, updated, deleted } = await syncSegmentPairs(groups);
  return { created, updated, deleted };
}

// ── Tandas (lo antiguo) ──────────────────────────────────────────────────────

async function count(table: string, filter?: (q: any) => any): Promise<number> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  // Sin `head: true`: una tabla que no existe devolvería 0 en vez de error.
  let q = supabase.from(table).select('*', { count: 'exact' });
  if (filter) q = filter(q);
  const { count: n, error } = await q.range(0, 0);
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
}

export interface MomentsStatus {
  total: number;
  pending: number;
  ready: number;
  excluded: number;
  failed: number;
  failedRetryable: number;
  /** Transcripts con al menos un momento guardado. */
  withMoments: number;
  /** Parejas por revisar. */
  pairs: number;
}

export async function momentsStatus(): Promise<MomentsStatus> {
  const [total, pending, ready, excluded, failed, failedRetryable, withMoments, pairs] = await Promise.all([
    count('testimonial_transcripts'),
    count('testimonial_transcripts', q => q.eq('status', 'pending')),
    count('testimonial_transcripts', q => q.eq('status', 'ready')),
    count('testimonial_transcripts', q => q.eq('status', 'excluded')),
    count('testimonial_transcripts', q => q.eq('status', 'failed')),
    count('testimonial_transcripts', q => q.eq('status', 'failed').lt('attempts', MAX_ATTEMPTS)),
    count('testimonial_transcripts', q => q.gt('moments_count', 0)),
    count('testimonial_candidates', q => q.eq('status', 'detectado').not('pair_teacher_id', 'is', null)),
  ]);
  return { total, pending, ready, excluded, failed, failedRetryable, withMoments, pairs };
}

/** Crea en 'pending' la fila de los transcripts que no la tengan (sin IA). */
export async function ensureMomentRows(): Promise<number> {
  const clases = await pagedRows('class_analyses', 'id', 'id', q => q.eq('has_transcript', true));
  const hechas = new Set((await pagedRows('testimonial_transcripts', 'analysis_id', 'analysis_id')).map(r => String(r.analysis_id)));
  const faltan = clases.map(r => String(r.id)).filter(id => !hechas.has(id));
  for (let i = 0; i < faltan.length; i += 500) {
    const { error } = await supabase.from('testimonial_transcripts').upsert(
      faltan.slice(i, i + 500).map(id => ({ analysis_id: id, status: 'pending', updated_at: NEVER })),
      { onConflict: 'analysis_id', ignoreDuplicates: true });
    if (error) throw new Error(`Preparando filas: ${error.message}`);
  }
  return faltan.length;
}

export interface MomentsBatchResult {
  /** Transcripts que cogió esta tanda. 0 = no queda nada libre. */
  claimed: number;
  outcomes: Partial<Record<MomentsRunStatus, number>>;
  status: MomentsStatus;
}

/** Una tanda: hasta BATCH_SIZE transcripts en paralelo y luego sus parejas. */
export async function runMomentsBatch(opts: { deadline: number; retryFailed?: boolean }): Promise<MomentsBatchResult> {
  const estado = opts.retryFailed ? 'failed' : 'pending';
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString();
  let q = supabase.from('testimonial_transcripts').select('analysis_id')
    .eq('status', estado).lt('updated_at', cutoff).order('analysis_id').limit(BATCH_SIZE * 3);
  if (opts.retryFailed) q = q.lt('attempts', MAX_ATTEMPTS);
  const { data: libres, error } = await q;
  if (error) throw new Error(`Buscando pendientes: ${error.message}`);
  // Varias tandas a la vez (la pestaña lanza 3): cada una prueba con un trozo distinto.
  const ids = ((libres ?? []) as Row[]).map(r => String(r.analysis_id)).sort(() => Math.random() - 0.5).slice(0, BATCH_SIZE);
  const outcomes: MomentsBatchResult['outcomes'] = {};
  if (ids.length === 0) return { claimed: 0, outcomes, status: await momentsStatus() };

  const { data: mias } = await supabase.from('testimonial_transcripts')
    .update({ updated_at: new Date().toISOString() })
    .in('analysis_id', ids).eq('status', estado).lt('updated_at', cutoff).select('analysis_id');
  const mine = ((mias ?? []) as Row[]).map(r => String(r.analysis_id));
  const timeoutMs = Math.max(10_000, Math.min(40_000, opts.deadline - Date.now() - 8_000));
  const results = await Promise.all(mine.map(id => runMomentsFor(id, { timeoutMs, skipPairs: true }).catch(err => ({
    analysisId: id, status: 'failed' as const, error: err instanceof Error ? err.message : String(err), studentGroup: undefined,
  }))));
  for (const r of results) outcomes[r.status] = (outcomes[r.status] ?? 0) + 1;
  const groups = [...new Set(results.map(r => r.studentGroup).filter((g): g is string => !!g))];
  if (groups.length) await syncPairs(groups);
  return { claimed: mine.length, outcomes, status: await momentsStatus() };
}
