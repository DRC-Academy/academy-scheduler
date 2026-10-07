// Testimoniales — "Analizar clases pasadas": nota de fluidez de los transcripts
// que no la tienen, por tandas pequeñas. SOLO SERVIDOR.
//
// Se pide tanda a tanda a /api/admin/fluency-backfill (el panel que lo hacía se
// quitó de la pestaña el 02/10/2026, con el relleno ya terminado; el script
// `npm run fluidez` hace lo mismo). Cada tanda cabe en los 60 s de Vercel. El estado
// vive en la base (transcript_fluency.status), no en el navegador: si se cierra
// la pestaña, al volver a pulsar sigue con lo que quede en 'pending'.
//
// RESERVA. Cada tanda marca sus filas tocando `updated_at` y solo coge filas que
// lleven 2 minutos sin tocarse. Así dos pestañas abiertas, o una subida nueva que
// se está analizando en ese momento (after() de save-transcript), no se pisan.
// En el peor caso una fila se analiza dos veces: un céntimo.
//
// Desde la V5 de testimoniales (07/10/2026) la nota de fluidez ya no alimenta los
// testimoniales (lib/testimonialMomentsStore) ni corre sola al subir un transcript.

import 'server-only';

import { supabase } from '@/lib/supabase';
import { runFluencyFor, resolveStudentKey, type FluencyRunStatus } from '@/lib/fluencyStore';

/** Transcripts analizados a la vez en cada tanda. */
export const BATCH_SIZE = 5;
/** Intentos de IA por transcript antes de dejarlo para revisar a mano. */
export const MAX_ATTEMPTS = 3;
/** Una fila tocada hace menos de esto se considera "en curso" en otro proceso. */
const LEASE_MS = 2 * 60_000;
/** updated_at de las filas recién preparadas: viejo, para que se puedan coger ya. */
const NEVER = '2000-01-01T00:00:00.000Z';

export interface BackfillStatus {
  /** Transcripts que existen (class_analyses). */
  total: number;
  ready: number;
  skipped: number;
  failed: number;
  /** Fallidos que todavía se pueden reintentar (< MAX_ATTEMPTS). */
  failedRetryable: number;
  pending: number;
  /** Transcripts sin fila todavía (los prepara la acción 'preparar'). */
  missing: number;
}

async function count(table: string, filter?: (q: any) => any): Promise<number | null> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  // Sin `head: true` a propósito: una petición HEAD no trae cuerpo, así que una
  // tabla que no existe devolvía 0 en vez de error. Se pide una fila como mucho.
  let q = supabase.from(table).select('*', { count: 'exact' });
  if (filter) q = filter(q);
  const { count: n, error } = await q.range(0, 0);
  return error ? null : (n ?? 0);
}

export async function backfillStatus(): Promise<BackfillStatus> {
  const [total, ready, skipped, failed, failedRetryable, pending] = await Promise.all([
    count('class_analyses'),
    count('transcript_fluency', q => q.eq('status', 'ready')),
    count('transcript_fluency', q => q.eq('status', 'skipped')),
    count('transcript_fluency', q => q.eq('status', 'failed')),
    count('transcript_fluency', q => q.eq('status', 'failed').lt('attempts', MAX_ATTEMPTS)),
    count('transcript_fluency', q => q.eq('status', 'pending')),
  ]);
  const t = total ?? 0;
  const have = (ready ?? 0) + (skipped ?? 0) + (failed ?? 0) + (pending ?? 0);
  return {
    total: t, ready: ready ?? 0, skipped: skipped ?? 0, failed: failed ?? 0,
    failedRetryable: failedRetryable ?? 0, pending: pending ?? 0,
    missing: Math.max(0, t - have),
  };
}

/** Ids de una tabla, paginando (Supabase devuelve como mucho 1000 filas). */
async function allIds<T>(table: string, cols: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(cols).order(order).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/**
 * Crea en 'pending' la fila de cada transcript que no tenga. Sin IA y sin leer
 * transcripts: solo ids y nombres. Devuelve cuántas creó.
 */
export async function prepareBackfill(): Promise<number> {
  const clases = await allIds<{ id: string; student_id: string | null; student_name: string | null }>(
    'class_analyses', 'id, student_id, student_name', 'id');
  const hechas = new Set((await allIds<{ analysis_id: string }>('transcript_fluency', 'analysis_id', 'analysis_id')).map(r => r.analysis_id));
  const faltan = clases.filter(c => !hechas.has(c.id));
  if (faltan.length === 0) return 0;

  const filas = [];
  for (const c of faltan) {
    filas.push({
      analysis_id: c.id, student_key: await resolveStudentKey(c.student_id, c.student_name),
      status: 'pending', updated_at: NEVER,
    });
  }
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await supabase.from('transcript_fluency')
      .upsert(filas.slice(i, i + 500), { onConflict: 'analysis_id', ignoreDuplicates: true });
    if (error) throw new Error(`Preparando filas: ${error.message}`);
  }
  return filas.length;
}

export interface BatchResult {
  /** Filas que esta tanda cogió. 0 = no queda nada libre que hacer. */
  claimed: number;
  outcomes: Partial<Record<FluencyRunStatus, number>>;
  status: BackfillStatus;
}

/** Una tanda: hasta BATCH_SIZE transcripts en paralelo. */
export async function runBatch(opts: { retryFailed?: boolean; deadline: number }): Promise<BatchResult> {
  const estado = opts.retryFailed ? 'failed' : 'pending';
  const cutoff = new Date(Date.now() - LEASE_MS).toISOString();

  let q = supabase.from('transcript_fluency').select('analysis_id')
    .eq('status', estado).lt('updated_at', cutoff).order('analysis_id').limit(BATCH_SIZE);
  if (opts.retryFailed) q = q.lt('attempts', MAX_ATTEMPTS);
  const { data: libres, error } = await q;
  if (error) throw new Error(`Buscando pendientes: ${error.message}`);

  const ids = (libres ?? []).map(r => String(r.analysis_id));
  const outcomes: BatchResult['outcomes'] = {};

  if (ids.length > 0) {
    // Reserva: solo cuenta lo que esta tanda consiguió marcar.
    const { data: reservadas } = await supabase.from('transcript_fluency')
      .update({ updated_at: new Date().toISOString() })
      .in('analysis_id', ids).eq('status', estado).lt('updated_at', cutoff)
      .select('analysis_id');
    const mias = (reservadas ?? []).map(r => String(r.analysis_id));

    const results = await Promise.all(mias.map(id => runFluencyFor(id).catch(err => ({
      analysisId: id, status: 'failed' as const, error: err instanceof Error ? err.message : String(err),
      studentGroup: undefined, row: undefined,
    }))));
    for (const r of results) outcomes[r.status] = (outcomes[r.status] ?? 0) + 1;

    return { claimed: mias.length, outcomes, status: await backfillStatus() };
  }

  return { claimed: 0, outcomes, status: await backfillStatus() };
}
