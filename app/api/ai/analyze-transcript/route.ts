// PASO 2 del registro de una clase: el INFORME pedagógico + la señal de riesgo.
//
// El transcript ya está guardado por /api/ai/save-transcript, así que si algo de
// acá falla la clase NO se pierde: queda con analysis_status 'failed' y el botón
// "Reintentar análisis" en la ficha del alumno.
//
// Modos (según el cuerpo):
//   · { analysisId, ... }            → analiza la fila ya guardada y le pega el
//                                      informe. Es el paso 2 y el reintento.
//   · { transcript, ... }            → solo analiza y devuelve el informe (el
//                                      profesor lo revisa/edita antes de guardar).
//   · { save: true, analysis, ... }  → guarda transcript + informe de una vez
//                                      (flujo "Registrar clase dada", donde el
//                                      profesor edita el informe antes de guardar).

import { supabase } from '@/lib/supabase';
import { analyzeTranscript } from '@/lib/analyzeTranscript';
import { isRiskCause, isRiskSignal, type TranscriptIA } from '@/lib/aiTypes';
import { computeTranscriptVerdict, decideTranscript, shouldRunAI, statusForDecision } from '@/lib/transcriptVerdict';
import { validateTranscriptStructure } from '@/lib/transcriptValidation';
import { verifyTranscriptAI } from '@/lib/verifyTranscriptAI';
import {
  persistTranscript, persistAnalysisFields, markAnalysisFailed, markForReview,
  ensureProfileId, updateProfileFromAnalysis,
  notifyAdminRisk, notifyAdminTranscript, verdictPayload,
} from '@/lib/transcriptStore';
import { normalizeSuggestion, normalizeCheck } from '@/lib/interventions';
import {
  loadInterventionContext, saveActiveIntervention, recordInterventionAudit,
  notifyTeacherIntervention, notifyAdminUnattended, type InterventionContext,
} from '@/lib/interventionStore';
import { fetchTeacher, sendInterventionEmail } from '@/lib/emailNotifications';

export const runtime = 'nodejs';
// El análisis con IA puede tardar. Sin esto, la plataforma corta la función a los
// pocos segundos y el profesor recibe un fallo genérico sin cuerpo JSON — la causa
// real de que la subida de transcripciones fallara.
export const maxDuration = 60;

interface Body {
  transcript?: string;
  studentProfile?: Record<string, unknown> | null;
  classHistory?: unknown[] | null;
  classNumber?: number | null;
  classDate?: string | null;
  studentName?: string;
  teacherName?: string;
  plan?: string;
  level?: string;
  // Paso 2 / reintento: fila ya guardada a la que pegarle el informe.
  analysisId?: string | null;
  // Guardado en un paso (informe ya revisado por el profesor).
  save?: boolean;
  analysis?: TranscriptIA;
  studentId?: string | null;
  teacherId?: string | null;
  profileId?: string | null;
  transcriptHash?: string | null;
  replaceId?: string | null;
  joinLogId?: string | null;
  /** 120 en una sesión de 2h (celdas contiguas). Por defecto, 60. */
  durationMinutes?: number | null;
}

export async function POST(request: Request): Promise<Response> {
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
  if (body.save)       return handleSaveWithAnalysis(body, studentName);
  return handleAnalyzeOnly(body, studentName);
}

// ── Modo 1: analizar una fila ya guardada (paso 2 y "Reintentar análisis") ────
async function handleAttach(body: Body, studentName: string, analysisId: string): Promise<Response> {
  // La fila manda: el transcript guardado es el bueno (en el reintento el cliente
  // ni siquiera lo envía).
  const read = (cols: string) =>
    supabase.from('class_analyses').select(cols).eq('id', analysisId).maybeSingle();

  let res = await read('id, transcript, class_number, class_date, teacher_id, student_id, validation_status');
  if (res.error && (res.error.code === '42703' || res.error.code === 'PGRST204')) {
    res = await read('id, transcript, class_number, class_date, teacher_id, student_id');
  }
  if (res.error) console.error('[analyze-transcript] Error al leer la fila a analizar:', res.error);
  const row = (res.data ?? null) as Record<string, unknown> | null;
  const transcript = String(row?.transcript ?? body.transcript ?? '').trim();
  if (!transcript) {
    return Response.json({ error: 'No encontramos la transcripción de esta clase.' }, { status: 404 });
  }

  const classNumber = body.classNumber ?? (row?.class_number as number | null) ?? null;
  const classDate   = body.classDate   ?? (row?.class_date as string | null)   ?? null;
  const studentId   = (row?.student_id as string | null) ?? body.studentId ?? null;

  // Alerta que el alumno traía abierta: si la hay, la IA evalúa además si el
  // profesor intervino (auditoría de seguimiento). `currentAnalysisId` evita
  // auditar esta clase contra la alerta que ella misma generó en un intento
  // anterior ("Reintentar análisis").
  const ctx = await loadInterventionContext({
    profileId: body.profileId, studentId, studentName, currentAnalysisId: analysisId,
  });

  const result = await analyzeTranscript({
    transcript,
    studentName,
    teacherName: body.teacherName?.trim() || '',
    plan: body.plan,
    level: body.level,
    classNumber,
    classDate,
    studentProfile: body.studentProfile,
    classHistory: body.classHistory,
    activeIntervention: ctx.active,
  });

  if (result.status !== 'ready' || !result.data) {
    const msg = result.error ?? 'No se pudo analizar la transcripción.';
    console.error(`[analyze-transcript] Análisis fallido para ${analysisId} (${studentName}): ${msg}`);
    await markAnalysisFailed(analysisId, msg);
    // 200 a propósito: la CLASE está guardada. El cliente distingue por `analyzed`.
    return Response.json({ analyzed: false, saved: true, analysisId, error: msg });
  }

  const saveErr = await persistAnalysisFields(analysisId, result.data);
  if (saveErr.error) {
    console.error(`[analyze-transcript] No se pudo guardar el informe de ${analysisId}:`, saveErr.error);
    return Response.json({ analyzed: false, saved: true, analysisId, error: saveErr.error });
  }

  await afterAnalysis({
    analysisId,
    analysis: result.data,
    transcript,
    studentName,
    classDate,
    classNumber,
    body,
    teacherId: (row?.teacher_id as string | null) ?? body.teacherId ?? null,
    studentId,
    validationStatus: (row?.validation_status as string | null) ?? 'ok',
    intervention: ctx,
  });

  return Response.json({ analyzed: true, saved: true, analysisId, analysis: result.data });
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
    level: body.level,
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
async function handleSaveWithAnalysis(body: Body, studentName: string): Promise<Response> {
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

/**
 * Después de guardar el informe: ficha del alumno, aviso de riesgo, sugerencia
 * de intervención, auditoría de seguimiento y CAPA 3 (autenticidad por IA).
 * Todo best-effort — acá ya no se puede perder la clase.
 */
async function afterAnalysis(args: {
  analysisId: string;
  analysis: TranscriptIA;
  transcript: string;
  studentName: string;
  classDate: string | null;
  classNumber: number | null;
  body: Body;
  teacherId: string | null;
  studentId: string | null;
  validationStatus: string;
  intervention: InterventionContext;
}): Promise<void> {
  const { analysis, studentName, body } = args;

  // La ficha se CREA si no existe: sin ella el riesgo se quedaba en
  // class_analyses y el panel del admin no tenía nada que mostrar.
  let profileId: string | null = args.intervention.profileId;
  try {
    profileId ??= await ensureProfileId({
      profileId: body.profileId, studentId: args.studentId, studentName,
      teacherId: args.teacherId,
    });
    if (profileId) {
      await updateProfileFromAnalysis({
        profileId, studentId: args.studentId, studentName,
        classDate: args.classDate, analysis,
      });
    } else {
      console.warn(`[analyze-transcript] ${studentName}: sin ficha y no se pudo crear; el riesgo queda solo en class_analyses.`);
    }
  } catch (err) {
    console.error('[analyze-transcript] No se pudo actualizar la ficha:', err);
  }

  const risk = isRiskSignal(analysis.riskSignal) ? analysis.riskSignal : 'verde';

  // AUDITORÍA primero, sugerencia después: si esta clase vuelve a salir en
  // riesgo, la intervención nueva tiene que sobrescribir a la que se cierre acá.
  try {
    await runInterventionAudit({ ...args, profileId });
  } catch (err) {
    console.error('[analyze-transcript] Auditoría de seguimiento no disponible:', err);
  }

  if (risk === 'amarillo' || risk === 'rojo') {
    try {
      await notifyAdminRisk(risk, studentName, {
        teacherName: body.teacherName, classNumber: args.classNumber,
      }, analysis);
    } catch (err) {
      console.error('[analyze-transcript] No se pudo avisar del riesgo:', err);
    }

    try {
      await openIntervention({ ...args, profileId, risk });
    } catch (err) {
      console.error('[analyze-transcript] No se pudo generar la intervención:', err);
    }
  }

  // CAPA 3 — solo si la clase iba a contar tal cual ('ok') y está en zona gris.
  // Como mucho la degrada a revisión; nunca borra ni descarta el registro.
  if (args.validationStatus !== 'ok') return;
  try {
    // Duración REAL de la clase: 120 en una sesión de 2h. La IA verificadora
    // recibe lo mismo, para no juzgar como sospechoso un transcript que dura el
    // doble simplemente porque la clase también duraba el doble.
    const durationMinutes = body.durationMinutes ?? 60;
    const structure = validateTranscriptStructure(args.transcript, { durationMinutes });
    if (!shouldRunAI(structure.score, 0)) return;

    const res = await verifyTranscriptAI({
      transcript: args.transcript,
      teacherName: body.teacherName?.trim() || '',
      studentName,
      level: body.level,
      durationMinutes,
    });
    const ai = res.data;
    if (!ai) return;

    const decision = decideTranscript({ score: structure.score, flags: structure.flags, ai });
    if (decision === 'ok') return;

    const flags = Array.from(new Set([...structure.flags, ...(ai.authentic ? [] : ['ia_no_autentico'])]));
    await markForReview(args.analysisId, ai as unknown as Record<string, unknown>, flags);
    await notifyAdminTranscript(
      {
        decision, structure, flags,
        cross: { flags: [], hasAccess: false, estimatedDurationMin: null, daysLate: 0, similarityPct: 0, similarMatch: null },
        ai, aiRan: true, teacherTitle: '', teacherBody: '',
      },
      studentName,
      { teacherName: body.teacherName, classDate: args.classDate },
    );
  } catch (err) {
    console.error('[analyze-transcript] Verificación de autenticidad no disponible:', err);
  }
}

/**
 * BLOQUE 1 — la clase salió en amarillo/rojo: se abre la intervención.
 *
 * Deja la sugerencia como alerta ABIERTA en la ficha y se la hace llegar al
 * profesor por los dos canales (campanita + email) con el mismo contenido.
 */
async function openIntervention(args: {
  analysis: TranscriptIA;
  studentName: string;
  classNumber: number | null;
  analysisId: string;
  teacherId: string | null;
  body: Body;
  profileId: string | null;
  risk: 'amarillo' | 'rojo';
}): Promise<void> {
  const suggestion = normalizeSuggestion(args.analysis.interventionSuggestion);
  if (!suggestion) {
    console.warn(`[analyze-transcript] ${args.studentName}: riesgo ${args.risk} sin sugerencia de intervención utilizable.`);
    return;
  }

  // Contexto que viaja CON la alerta: el razonamiento de la IA sobre esta clase.
  // Es lo que el pop-up de la clase siguiente enseña como "en la última clase…",
  // y lo que hace que los pasos lleguen con un motivo detrás en vez de sueltos.
  const context = (args.analysis.riskExplanation ?? '').trim()
    || (args.analysis.classSummary ?? '').trim();
  const cause = isRiskCause(args.analysis.riskCause) ? args.analysis.riskCause : null;

  // `afterAnalysis` ya garantiza la ficha (la crea si hace falta), así que acá
  // normalmente hay profileId. El guard queda por si la creación falló.
  if (args.profileId) {
    await saveActiveIntervention({
      profileId:   args.profileId,
      suggestion,
      risk:        args.risk,
      analysisId:  args.analysisId,
      classNumber: args.classNumber,
      context,
      cause,
    });
  } else {
    console.warn(`[analyze-transcript] ${args.studentName}: intervención sin ficha donde guardarla; solo se avisa al profesor.`);
  }

  if (!args.teacherId) return;   // sin profesor asignado no hay a quién avisar

  await notifyTeacherIntervention({
    teacherId: args.teacherId, studentName: args.studentName, suggestion, context, risk: args.risk,
  });

  // Email: es el único correo ligado a las señales de riesgo y sale solo cuando
  // hay una sugerencia concreta. Best-effort, como el resto de los avisos.
  try {
    const teacher = await fetchTeacher(args.teacherId);
    if (teacher) {
      await sendInterventionEmail(teacher, {
        studentName: args.studentName, suggestion, classNumber: args.classNumber, context,
        risk: args.risk,
      });
    }
  } catch (err) {
    console.error('[analyze-transcript] No se pudo enviar el email de intervención:', err);
  }
}

/**
 * BLOQUE 2 — el alumno traía una alerta abierta: se registra si hubo señales de
 * intervención y, tras 2 auditorías consecutivas sin ellas, se avisa al ADMIN.
 *
 * Nunca crea scoring_events ni notifica al profesor: detectar una intervención
 * sutil leyendo un transcript es impreciso y la decisión final es humana.
 */
async function runInterventionAudit(args: {
  analysis: TranscriptIA;
  studentName: string;
  studentId: string | null;
  teacherId: string | null;
  analysisId: string;
  body: Body;
  profileId: string | null;
  intervention: InterventionContext;
}): Promise<void> {
  const previous = args.intervention.active;
  if (!previous) return;

  const check = normalizeCheck(args.analysis.interventionCheck);
  if (!check) {
    console.warn(`[analyze-transcript] ${args.studentName}: había alerta abierta pero la IA no devolvió la auditoría.`);
    return;
  }

  const { counted, consecutive } = await recordInterventionAudit({
    profileId:        args.profileId,
    studentId:        args.studentId,
    studentName:      args.studentName,
    teacherId:        args.teacherId,
    teacherName:      args.body.teacherName?.trim() || null,
    previous,
    check,
    analysisId:       args.analysisId,
    unattendedBefore: args.intervention.unattended,
  });

  console.log(
    `[analyze-transcript] Auditoría de ${args.studentName}: ` +
    `señales=${check.signsOfIntervention} confianza=${check.confidence} ` +
    `(cuenta=${counted}, consecutivas=${consecutive}).`,
  );

  if (counted && consecutive >= 2) {
    await notifyAdminUnattended({
      studentName: args.studentName,
      teacherName: args.body.teacherName,
      classes:     consecutive,
    });
  }
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
