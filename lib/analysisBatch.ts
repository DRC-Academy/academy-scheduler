// Análisis de transcripts en LOTE (Message Batches API: mitad de precio). SOLO SERVIDOR.
//
// Por qué existe: en oct/2026 el análisis de cada transcript era el 80 % del
// gasto de la clave de la plataforma (~70 por día laborable) y el presupuesto es
// de 100 €/mes. Casi todos esos análisis los dispara el registro normal de una
// clase (Añadir clase, Seguimiento, Revisiones), donde el profesor NO espera el
// informe: la clase ya está guardada y validada sin él. Esos van en lote.
// Lo que sigue siendo inmediato: "Reintentar análisis" y los flujos donde el
// profesor lee el informe antes de guardar (Próxima clase, Registrar clase dada).
//
// CICLO (lo corre el cron /api/cron/analisis-lote varias veces al día):
//   1. RECOGER: lotes terminados → cada informe se procesa con finishAttach, lo
//      mismo que la llamada inmediata (lib/transcriptAnalysis).
//   2. ENVIAR: lo encolado desde la última vez sale en UN lote nuevo.
//
// La cola es la tabla `ai_analysis_queue` (supabase-analysis-batch.sql), una fila
// por clase con el cuerpo de la petición SIN el transcript (se relee de la fila,
// como en el reintento). Sin la tabla, enqueueAnalysis devuelve false y la ruta
// analiza al momento como antes: nada se rompe si el SQL no se corrió.
//
// IDEMPOTENTE: cada fila de la cola lleva su estado (queued → submitted → done |
// failed), así que un ciclo cortado por el tiempo se retoma en el siguiente sin
// procesar dos veces el mismo informe. Si entre medias alguien pulsó "Reintentar
// análisis" (la fila ya está 'ready'), el resultado del lote se descarta.
//
// RED: si el lote devuelve un error para una clase, esa se analiza al momento
// (precio completo, con la red de askClaudeJson). Si la API rechaza el lote
// entero, se reintenta una vez con el modelo por defecto.

import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '@/lib/supabase';
import {
  anthropic, hasAnthropicKey, buildClaudeRequest, readClaudeJson, describeError, AI_MODEL,
  type AskClaudeJsonOptions,
} from '@/lib/anthropic';
import { analyzeTranscript, transcriptRequestOptions } from '@/lib/analyzeTranscript';
import { prepareAttach, finishAttach, type AnalysisBody, type AttachPrep } from '@/lib/transcriptAnalysis';
import { markAnalysisFailed } from '@/lib/transcriptStore';
import { isCreditExhaustedError, notifyAiCreditExhausted } from '@/lib/aiCreditAlert';
import type { TranscriptIA } from '@/lib/aiTypes';

const TABLE = 'ai_analysis_queue';

// El custom_id de la Batch API solo admite [a-zA-Z0-9_-], hasta 64. Los ids de
// class_analyses son `ca_<ms>_<rand>`; uno que no encaje se analiza al momento.
const CUSTOM_ID_OK = /^[a-zA-Z0-9_-]{1,64}$/;

// Tope por lote: un día laborable trae ~70. Lo que no entre sale en el siguiente ciclo.
const MAX_PER_BATCH = 300;

// Clases procesadas a la vez al recoger (cada una escribe en la base y puede
// mandar avisos): bajo, para no saturar Supabase ni Resend.
const CONCURRENCY = 4;

type QueueStatus = 'queued' | 'submitted' | 'done' | 'failed';

interface QueueRow {
  analysis_id: string;
  body: AnalysisBody;
  status: QueueStatus;
  batch_id: string | null;
  attempts: number;
}

function missingTable(code: string | undefined): boolean {
  return code === '42P01' || code === 'PGRST205';
}

/**
 * Encola el análisis de una clase ya guardada. `false` = no se pudo encolar
 * (falta la tabla, no hay clave de IA, id no válido para la Batch API): quien
 * llama analiza al momento.
 */
export async function enqueueAnalysis(analysisId: string, body: AnalysisBody): Promise<boolean> {
  if (!hasAnthropicKey() || !CUSTOM_ID_OK.test(analysisId)) return false;

  // Sin el transcript (se relee de la fila) ni el informe: solo el contexto.
  const rest: AnalysisBody = { ...body };
  delete rest.transcript;
  delete rest.analysis;
  delete rest.defer;
  const now = new Date().toISOString();
  const { error } = await supabase.from(TABLE).upsert({
    analysis_id: analysisId,
    body: rest,
    status: 'queued',
    batch_id: null,
    error: null,
    updated_at: now,
  }, { onConflict: 'analysis_id' });
  if (error) {
    if (missingTable(error.code)) {
      console.warn('[analysis-batch] Falta la tabla ai_analysis_queue (supabase-analysis-batch.sql): se analiza al momento.');
    } else {
      console.error('[analysis-batch] No se pudo encolar; se analiza al momento:', error.message);
    }
    return false;
  }

  // La ficha del alumno lo enseña como "en cola", no como "falta el análisis".
  const upd = await supabase.from('class_analyses')
    .update({ analysis_status: 'queued', analysis_error: null, analysis_updated_at: now })
    .eq('id', analysisId);
  if (upd.error) console.warn('[analysis-batch] No se pudo marcar la fila como en cola:', upd.error.message);
  return true;
}

export interface BatchCycleReport {
  collected: number;
  failed: number;
  skipped: number;
  submitted: number;
  batchId: string | null;
  pendingBatches: number;
  errors: string[];
}

/** Un ciclo completo: recoger lo terminado y mandar lo encolado. Nunca lanza. */
export async function runAnalysisBatchCycle(deadline: number): Promise<BatchCycleReport> {
  const report: BatchCycleReport = {
    collected: 0, failed: 0, skipped: 0, submitted: 0, batchId: null, pendingBatches: 0, errors: [],
  };
  if (!hasAnthropicKey()) {
    report.errors.push('Falta ANTHROPIC_API_KEY');
    return report;
  }
  try {
    await collect(deadline, report);
  } catch (err) {
    report.errors.push(`recoger: ${describeError(err)}`);
  }
  // Mandar es rápido (una sola petición); se intenta aunque recoger se haya cortado.
  try {
    await submit(report);
  } catch (err) {
    report.errors.push(`enviar: ${describeError(err)}`);
  }
  // Un lote de unas decenas de análisis suele terminar en pocos minutos: se
  // espera lo que quede de función para recogerlo en esta misma pasada. Si no
  // terminó, lo recoge el ciclo siguiente.
  if (report.batchId) {
    try {
      if (await waitForBatch(report.batchId, deadline - COLLECT_RESERVE_MS)) {
        report.pendingBatches = 0;
        await collect(deadline, report);
      }
    } catch (err) {
      report.errors.push(`esperar lote: ${describeError(err)}`);
    }
  }
  return report;
}

// Tiempo que se deja libre al final para procesar los informes recogidos.
const COLLECT_RESERVE_MS = 90_000;
const POLL_MS = 15_000;

async function waitForBatch(batchId: string, until: number): Promise<boolean> {
  while (Date.now() + POLL_MS < until) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const b = await anthropic.messages.batches.retrieve(batchId);
    if (b.processing_status === 'ended') return true;
  }
  return false;
}

// ── 1. Recoger ───────────────────────────────────────────────────────────────

async function collect(deadline: number, report: BatchCycleReport): Promise<void> {
  const { data, error } = await supabase.from(TABLE)
    .select('analysis_id, body, status, batch_id, attempts')
    .eq('status', 'submitted')
    .limit(2000);
  if (error) {
    if (!missingTable(error.code)) report.errors.push(`leer cola: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as QueueRow[];
  const byBatch = new Map<string, QueueRow[]>();
  for (const r of rows) {
    if (!r.batch_id) continue;
    byBatch.set(r.batch_id, [...(byBatch.get(r.batch_id) ?? []), r]);
  }

  for (const [batchId, batchRows] of byBatch) {
    if (Date.now() > deadline) return;
    const batch = await anthropic.messages.batches.retrieve(batchId);
    if (batch.processing_status !== 'ended') {
      report.pendingBatches++;
      continue;
    }

    const pending = new Map(batchRows.map(r => [r.analysis_id, r]));
    const jobs: Array<() => Promise<void>> = [];
    for await (const entry of await anthropic.messages.batches.results(batchId)) {
      const row = pending.get(entry.custom_id);
      if (!row) continue;               // ya procesada en un ciclo anterior
      pending.delete(entry.custom_id);
      jobs.push(() => processResult(row, entry.result, report));
    }
    // Filas del lote sin resultado (no debería pasar): se analizan al momento.
    for (const row of pending.values()) {
      jobs.push(() => processResult(row, null, report));
    }
    await runPool(jobs, deadline);
  }
}

async function processResult(
  row: QueueRow,
  result: Anthropic.Messages.MessageBatchResult | null,
  report: BatchCycleReport,
): Promise<void> {
  const id = row.analysis_id;
  const studentName = row.body.studentName?.trim() || '';
  try {
    const prep = studentName ? await prepareAttach(row.body, studentName, id) : null;
    if (!prep) {
      await setQueue(id, 'failed', 'Sin transcript o sin alumno.');
      report.failed++;
      return;
    }
    // Alguien pulsó "Reintentar análisis" mientras tanto: ese informe manda.
    if (prep.analysisStatus === 'ready') {
      await setQueue(id, 'done', 'Ya analizada por otra vía.');
      report.skipped++;
      return;
    }

    let done: { analyzed: boolean; error?: string };
    if (result?.type === 'succeeded') {
      done = await finishAttach(prep, readClaudeJson<TranscriptIA>(result.message, transcriptRequestOptions(prep.input)));
    } else {
      // errored / expired / canceled / sin resultado → al momento, con la red de askClaudeJson.
      const why = result?.type === 'errored' ? result.error.error.message : (result?.type ?? 'sin resultado');
      console.warn(`[analysis-batch] ${id}: el lote no lo resolvió (${why}); se analiza al momento.`);
      if (result?.type === 'errored' && isCreditExhaustedError(why)) {
        await notifyAiCreditExhausted({ label: 'analyze-transcript (lote)', error: why });
      }
      done = await finishAttach(prep, await analyzeTranscript(prep.input));
    }

    await setQueue(id, done.analyzed ? 'done' : 'failed', done.error ?? null);
    if (done.analyzed) report.collected++; else report.failed++;
  } catch (err) {
    const msg = describeError(err);
    console.error(`[analysis-batch] ${id}: fallo al procesar el resultado:`, msg);
    await markAnalysisFailed(id, msg);
    await setQueue(id, 'failed', msg);
    report.failed++;
  }
}

// ── 2. Enviar ────────────────────────────────────────────────────────────────

async function submit(report: BatchCycleReport): Promise<void> {
  const { data, error } = await supabase.from(TABLE)
    .select('analysis_id, body, status, batch_id, attempts')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(MAX_PER_BATCH);
  if (error) {
    if (!missingTable(error.code)) report.errors.push(`leer cola: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as QueueRow[];
  if (rows.length === 0) return;

  const ready: Array<{ row: QueueRow; prep: AttachPrep; opts: AskClaudeJsonOptions }> = [];
  for (const row of rows) {
    const studentName = row.body.studentName?.trim() || '';
    const prep = studentName ? await prepareAttach(row.body, studentName, row.analysis_id) : null;
    if (!prep) {
      await markAnalysisFailed(row.analysis_id, 'No encontramos la transcripción de esta clase.');
      await setQueue(row.analysis_id, 'failed', 'Sin transcript o sin alumno.');
      report.failed++;
      continue;
    }
    if (prep.analysisStatus === 'ready') {
      await setQueue(row.analysis_id, 'done', 'Ya analizada por otra vía.');
      report.skipped++;
      continue;
    }
    ready.push({ row, prep, opts: transcriptRequestOptions(prep.input) });
  }
  if (ready.length === 0) return;

  const requests = (useDefaultModel: boolean) => ready.map(r => ({
    custom_id: r.row.analysis_id,
    params: buildClaudeRequest(useDefaultModel ? { ...r.opts, model: AI_MODEL, thinking: undefined } : r.opts),
  }));

  let batch: Anthropic.Messages.MessageBatch;
  try {
    batch = await anthropic.messages.batches.create({ requests: requests(false) });
  } catch (err) {
    const msg = describeError(err);
    if (isCreditExhaustedError(msg)) {
      await notifyAiCreditExhausted({ label: 'analyze-transcript (lote)', error: msg });
      throw err;
    }
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    // La misma red que askClaudeJson: el modelo económico o un parámetro suyo no
    // se aceptó → el lote sale con el modelo por defecto (sigue a mitad de precio).
    console.error(`[analysis-batch] La API rechazó el lote (${msg}). Se repite con ${AI_MODEL}.`);
    batch = await anthropic.messages.batches.create({ requests: requests(true) });
  }

  const ids = ready.map(r => r.row.analysis_id);
  const { error: upErr } = await supabase.from(TABLE)
    .update({ status: 'submitted', batch_id: batch.id, error: null, updated_at: new Date().toISOString() })
    .in('analysis_id', ids);
  if (upErr) report.errors.push(`marcar enviadas: ${upErr.message}`);
  // attempts: cuántas veces salió en un lote (solo diagnóstico).
  for (const r of ready) {
    await supabase.from(TABLE).update({ attempts: (r.row.attempts ?? 0) + 1 }).eq('analysis_id', r.row.analysis_id);
  }

  report.submitted = ready.length;
  report.batchId = batch.id;
  console.log(`[analysis-batch] Lote ${batch.id} enviado con ${ready.length} análisis.`);
}

// ── Utilidades ───────────────────────────────────────────────────────────────

async function setQueue(analysisId: string, status: QueueStatus, error: string | null): Promise<void> {
  const { error: err } = await supabase.from(TABLE)
    .update({ status, error, updated_at: new Date().toISOString() })
    .eq('analysis_id', analysisId);
  if (err) console.error(`[analysis-batch] No se pudo actualizar la cola de ${analysisId}:`, err.message);
}

/** Corre los trabajos de a CONCURRENCY y deja de arrancar nuevos al pasar `deadline`. */
async function runPool(jobs: Array<() => Promise<void>>, deadline: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && Date.now() < deadline) {
      const job = jobs[next++];
      await job();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
}
