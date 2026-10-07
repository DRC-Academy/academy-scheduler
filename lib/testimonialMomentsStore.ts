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
  validateMoment, keepBest, bestPairs, pairKey, type Moment, type MomentPair,
} from '@/lib/testimonialPairs';
import { FLUENCY_MODEL } from '@/lib/analyzeFluency';
import type { TestimonialClip, TestimonialClips } from '@/lib/testimonials';

type Row = Record<string, unknown>;

/** Transcripts por tanda (en paralelo). */
export const BATCH_SIZE = 6;
/** Intentos de IA por transcript antes de dejarlo. */
export const MAX_ATTEMPTS = 3;
const LEASE_MS = 2 * 60_000;
const NEVER = '2000-01-01T00:00:00.000Z';
/** Estados de una pareja que el admin ya marcó "Sirve": nunca se tocan. */
const SIRVEN = ['listo', 'revisado', 'permiso_alumno'];

export type MomentsRunStatus = 'ready' | 'excluded' | 'failed' | 'missing';

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
export async function runMomentsFor(
  analysisId: string, opts: { dryRun?: boolean; timeoutMs?: number; skipPairs?: boolean } = {},
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
  if (text.trim()) {
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
      const r = validateMoment({
        analysisId, studentGroup, teacherId, classDay, studentLabel: label.studentLabel, fathomUrl, turns, interventions,
      }, ai);
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

// ── Parejas (sin IA) ─────────────────────────────────────────────────────────

const toMoment = (r: Row): Moment => ({
  id: String(r.id), analysisId: String(r.analysis_id), studentGroup: String(r.student_group),
  teacherId: (r.teacher_id as string | null) ?? null, classDay: String(r.class_day ?? ''),
  studentLabel: String(r.student_label ?? ''), kind: r.kind as Moment['kind'],
  start: Number(r.start_s), end: Number(r.end_s), excerpt: String(r.excerpt ?? ''),
  score: Number(r.score), why: String(r.why ?? ''), fathomUrl: (r.fathom_url as string | null) ?? null,
});

const toClip = (m: Moment): TestimonialClip => ({
  analysisId: m.analysisId, classDate: m.classDay, teacherId: m.teacherId,
  start: m.start, end: m.end, excerpt: m.excerpt, why: m.why, fathomUrl: m.fathomUrl,
  speakerLabel: m.studentLabel,
});

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

/** Columnas de un lado de la pareja (before = malo, after = bueno). */
function sideColumns(pre: 'before' | 'after', m: Moment): Row {
  const at = `${Math.floor(m.start / 60)}:${String(m.start % 60).padStart(2, '0')}`;
  return {
    [`${pre}_analysis_id`]: m.analysisId, [`${pre}_teacher_id`]: m.teacherId,
    [`${pre}_class_number`]: null, [`${pre}_class_date`]: m.classDay || null, [`${pre}_score`]: m.score,
    [`${pre}_excerpt`]: m.excerpt, [`${pre}_excerpt_at`]: at, [`${pre}_fathom_url`]: m.fathomUrl,
    [`${pre}_moment_id`]: m.id,
  };
}

function pairColumns(p: MomentPair, studentName: string | null): Row {
  const clips: TestimonialClips = { malos: [toClip(p.malo)], buenos: [toClip(p.bueno)] };
  return {
    student_group: p.studentGroup,
    student_id: p.studentGroup.startsWith('name:') ? null : p.studentGroup,
    student_name: studentName,
    pair_teacher_id: p.teacherId,
    student_label: p.bueno.studentLabel,
    reverse_order: p.reverse,
    ...sideColumns('before', p.malo),
    ...sideColumns('after', p.bueno),
    clips,
    improvement: p.bueno.score,
    ai_review_status: 'ready', ai_is_real: true, ai_error: null, ai_summary: null,
    ai_reason: `Malo ${p.malo.score}/10 · bueno ${p.bueno.score}/10.`,
  };
}

/**
 * Rehace las parejas (de unos alumnos, o de todos sin `groups`). Nunca toca lo
 * que el admin marcó "Sirve", ni vuelve a proponer una combinación alumno + profe
 * que marcó "No sirve". Las de "Por revisar" se actualizan si cambia la mejor
 * combinación y se borran si ya no hay ninguna.
 */
export async function syncPairs(groups?: string[]): Promise<{ created: number; updated: number; deleted: number }> {
  const filter = (q: any) => (groups ? q.in('student_group', groups) : q);   // eslint-disable-line @typescript-eslint/no-explicit-any
  const momentRows = groups?.length === 0 ? [] : await pagedRows('testimonial_moments',
    'id, analysis_id, student_group, teacher_id, class_day, student_label, kind, start_s, end_s, excerpt, score, why, fathom_url', 'id', filter);
  const pairs = bestPairs(momentRows.map(toMoment));
  const existing = await pagedRows('testimonial_candidates',
    'id, student_group, pair_teacher_id, status, discarded_by, before_moment_id, after_moment_id', 'id', filter);
  const names = new Map<string, string | null>();
  for (const r of await pagedRows('testimonial_transcripts', 'student_group, student_name', 'analysis_id', filter)) {
    if (r.student_name) names.set(String(r.student_group), String(r.student_name));
  }

  const byKey = new Map<string, Row[]>();
  for (const r of existing) {
    if (!r.pair_teacher_id) continue;
    const k = pairKey(String(r.student_group), String(r.pair_teacher_id));
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }

  let created = 0, updated = 0, deleted = 0;
  const now = new Date().toISOString();
  const wanted = new Set<string>();
  for (const p of pairs) {
    const k = pairKey(p.studentGroup, p.teacherId);
    wanted.add(k);
    const rows = byKey.get(k) ?? [];
    if (rows.some(r => SIRVEN.includes(String(r.status)))) continue;
    if (rows.some(r => r.status === 'descartado' && r.discarded_by === 'admin')) continue;
    const open = rows.find(r => r.status === 'detectado');
    const cols = pairColumns(p, names.get(p.studentGroup) ?? null);
    if (open) {
      if (open.before_moment_id === p.malo.id && open.after_moment_id === p.bueno.id) continue;
      const { error } = await supabase.from('testimonial_candidates').update({ ...cols, updated_at: now }).eq('id', open.id).eq('status', 'detectado');
      if (error) throw new Error(`Actualizando pareja: ${error.message}`);
      updated++;
    } else {
      const { error } = await supabase.from('testimonial_candidates').insert({
        id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...cols,
        status: 'detectado', status_changed_at: now, updated_at: now,
      });
      // 23505: otra ejecución la creó a la vez (índice único). La suya vale.
      if (error && error.code !== '23505') throw new Error(`Creando pareja: ${error.message}`);
      if (!error) created++;
    }
  }
  // "Por revisar" que ya no tiene pareja (p. ej. se reanalizó una clase).
  const stale = existing.filter(r => r.status === 'detectado' && r.pair_teacher_id
    && !wanted.has(pairKey(String(r.student_group), String(r.pair_teacher_id))));
  for (const r of stale) {
    await supabase.from('testimonial_candidates').delete().eq('id', r.id).eq('status', 'detectado');
    deleted++;
  }
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
