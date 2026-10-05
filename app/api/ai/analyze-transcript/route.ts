// PASO 2 del registro de una clase: el INFORME pedagógico + la señal de riesgo.
//
// El transcript ya está guardado por /api/ai/save-transcript, así que si algo de
// acá falla la clase NO se pierde: queda con analysis_status 'failed' y el botón
// "Reintentar análisis" en la ficha del alumno.
//
// Modos (según el cuerpo):
//   · { analysisId, defer: true }    → el paso 2 del registro normal: la fila se
//                                      ENCOLA para la Batch API (mitad de precio)
//                                      y el informe llega en unas horas. Ver
//                                      lib/analysisBatch.
//   · { analysisId, ... }            → analiza la fila ya guardada y le pega el
//                                      informe al momento. Es el reintento.
//   · { transcript, ... }            → solo analiza y devuelve el informe (el
//                                      profesor lo revisa/edita antes de guardar).
//   · { save: true, analysis, ... }  → guarda transcript + informe de una vez
//                                      (flujo "Registrar clase dada", donde el
//                                      profesor edita el informe antes de guardar).
//
// Lo que pasa antes y después de la IA (ficha, riesgo, intervención,
// autenticidad) vive en lib/transcriptAnalysis, compartido con el lote.

import { analyzeTranscript } from '@/lib/analyzeTranscript';
import { computeTranscriptVerdict, statusForDecision } from '@/lib/transcriptVerdict';
import {
  persistTranscript, persistAnalysisFields, markAnalysisFailed,
  notifyAdminTranscript, verdictPayload,
} from '@/lib/transcriptStore';
import { loadInterventionContext } from '@/lib/interventionStore';
import {
  prepareAttach, finishAttach, resolveAiLevel, afterAnalysis, type AnalysisBody,
} from '@/lib/transcriptAnalysis';
import { enqueueAnalysis } from '@/lib/analysisBatch';
import { after } from 'next/server';
import { runFluencyInBackground } from '@/lib/fluencyStore';

export const runtime = 'nodejs';
// El análisis con IA puede tardar. Sin esto, la plataforma corta la función a los
// pocos segundos y el profesor recibe un fallo genérico sin cuerpo JSON — la causa
// real de que la subida de transcripciones fallara.
export const maxDuration = 60;

type Body = AnalysisBody;

export async function POST(request: Request): Promise<Response> {
  // Reloj de la función: after() vive dentro del mismo maxDuration.
  const startedAt = Date.now();
  let body: Body;
  try {
    body = await request.json();
  } catch (err) {
    console.error('[analyze-transcript] JSON inválido en el cuerpo:', err);
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const studentName = body.studentName?.trim();
  if (!studentName) return Response.json({ error: 'Falta studentName.' }, { status: 400 });

  if (body.analysisId) return handleAttach(body, studentName, body.analysisId);
  if (body.save)       return handleSaveWithAnalysis(body, studentName, startedAt);
  return handleAnalyzeOnly(body, studentName);
}

// ── Modo 1: analizar una fila ya guardada (paso 2 y "Reintentar análisis") ────
async function handleAttach(body: Body, studentName: string, analysisId: string): Promise<Response> {
  // Paso 2 del registro normal: nadie espera el informe, va en lote. Si la cola
  // no está disponible (falta el SQL), se analiza al momento como siempre.
  if (body.defer) {
    const queued = await enqueueAnalysis(analysisId, body);
    if (queued) return Response.json({ analyzed: false, queued: true, saved: true, analysisId });
  }

  const prep = await prepareAttach(body, studentName, analysisId);
  if (!prep) {
    return Response.json({ error: 'No encontramos la transcripción de esta clase.' }, { status: 404 });
  }

  const done = await finishAttach(prep, await analyzeTranscript(prep.input));
  // 200 también en el fallo, a propósito: la CLASE está guardada. El cliente
  // distingue por `analyzed`.
  return Response.json({ ...done, saved: true, analysisId });
}

// ── Modo 2: solo analizar, sin guardar ───────────────────────────────────────
async function handleAnalyzeOnly(body: Body, studentName: string): Promise<Response> {
  const transcript = body.transcript?.trim();
  if (!transcript) return Response.json({ error: 'Falta la transcripción.' }, { status: 400 });

  // El informe que se devuelve ya lleva la sugerencia y, si el alumno tenía una
  // alerta abierta, la auditoría: al guardarlo (modo 3) se procesan sin volver
  // a llamar a la IA.
  const ctx = await loadInterventionContext({
    profileId: body.profileId, studentId: body.studentId, studentName,
    currentAnalysisId: body.replaceId,
  });

  const result = await analyzeTranscript({
    transcript,
    studentName,
    teacherName: body.teacherName?.trim() || '',
    plan: body.plan,
    level: await resolveAiLevel({ profileId: body.profileId, studentId: body.studentId, studentName, level: body.level }),
    classNumber: body.classNumber,
    classDate: body.classDate,
    studentProfile: body.studentProfile,
    classHistory: body.classHistory,
    activeIntervention: ctx.active,
  });

  if (result.status !== 'ready' || !result.data) {
    const msg = result.error ?? 'No se pudo analizar la transcripción.';
    console.error(`[analyze-transcript] Análisis (sin guardar) fallido para ${studentName}: ${msg}`);
    return Response.json({ error: msg, status: result.status }, { status: 502 });
  }
  return Response.json({ analysis: result.data, status: result.status });
}

// ── Modo 3: guardar transcript + informe ya revisado, en un paso ─────────────
async function handleSaveWithAnalysis(body: Body, studentName: string, startedAt: number): Promise<Response> {
  if (!body.analysis || !body.transcript?.trim()) {
    return Response.json({ error: 'Faltan datos (analysis, transcript).' }, { status: 400 });
  }
  const transcript = body.transcript.trim();
  const classDate = body.classDate || new Date().toISOString().slice(0, 10);

  // La alerta abierta se lee ANTES de guardar: el informe que llega del cliente
  // ya trae la auditoría (se generó en el modo "solo analizar").
  const ctx = await loadInterventionContext({
    profileId: body.profileId, studentId: body.studentId, studentName,
    currentAnalysisId: body.replaceId,
  });

  // Capas 1 y 2 (sin IA: la 3 corre abajo, ya con la clase guardada).
  let verdict = null;
  try {
    verdict = await computeTranscriptVerdict({
      teacherId:   body.teacherId || '',
      teacherName: body.teacherName?.trim() || '',
      studentName,
      classDate,
      transcript,
      level:       body.level,
      excludeId:   body.replaceId,
      joinLogId:   body.joinLogId,
      skipAI:      true,
    });
  } catch (err) {
    console.error('[analyze-transcript] Error al validar; se guarda igual:', err);
  }

  const saved = await persistTranscript({
    transcript, studentName,
    studentId:      body.studentId,
    teacherId:      body.teacherId,
    classNumber:    body.classNumber,
    classDate,
    transcriptHash: body.transcriptHash,
    joinLogId:      body.joinLogId,
    replaceId:      body.replaceId,
    durationMinutes: body.durationMinutes,
  }, verdict ?? NEUTRAL_VERDICT);

  if (saved.error || !saved.id) {
    return Response.json({ error: saved.error ?? 'No se pudo guardar la clase.' }, { status: 500 });
  }

  // Testimoniales: fluidez del alumno, después de responder. En este modo la
  // llamada a Opus ya se hizo en una petición anterior ("solo analizar"), así que
  // no comparte reloj con ella. Nunca lanza.
  const savedId = saved.id;
  after(() => runFluencyInBackground(savedId, startedAt + 56_000));

  const fieldsErr = await persistAnalysisFields(saved.id, body.analysis);
  if (fieldsErr.error) {
    // El transcript SÍ quedó guardado; solo falló el informe.
    await markAnalysisFailed(saved.id, fieldsErr.error);
    return Response.json({
      saved: true, analyzed: false, analysisId: saved.id,
      validation: verdict ? verdictPayload(verdict) : null,
      error: fieldsErr.error,
    });
  }

  if (verdict && verdict.decision !== 'ok') {
    await notifyAdminTranscript(verdict, studentName, { teacherName: body.teacherName, classDate });
  }

  await afterAnalysis({
    analysisId: saved.id,
    analysis: body.analysis,
    transcript,
    studentName,
    classDate,
    classNumber: body.classNumber ?? null,
    body,
    teacherId: body.teacherId ?? null,
    studentId: body.studentId ?? null,
    // Mismo criterio que el guardado: los umbrales viven solo en transcriptVerdict.
    validationStatus: verdict ? statusForDecision(verdict.decision, verdict.structure.score) : 'review',
    intervention: ctx,
  });

  return Response.json({
    saved: true, analyzed: true,
    analysisId: saved.id, replaced: !!body.replaceId,
    validation: verdict ? verdictPayload(verdict) : null,
  });
}

// Veredicto neutro si la validación se cae: la clase se guarda y va a revisión.
const NEUTRAL_VERDICT = {
  decision: 'review' as const,
  structure: { valid: false, score: 0, flags: [], reason: 'Validación no disponible.', lastTimestampMinutes: null, timestampCount: 0 },
  cross: { flags: [], hasAccess: false, estimatedDurationMin: null, daysLate: 0, similarityPct: 0, similarMatch: null },
  ai: null,
  aiRan: false,
  flags: [],
  teacherTitle: 'Clase registrada — pendiente de validación',
  teacherBody: 'Esta clase se ha registrado correctamente y está pendiente de validación por el equipo.',
};
