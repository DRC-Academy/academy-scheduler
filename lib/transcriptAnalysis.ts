// Análisis de una clase YA GUARDADA: lo que hay antes y después de la llamada a
// la IA. SOLO SERVIDOR.
//
// Vive acá, y no dentro de /api/ai/analyze-transcript, porque desde oct/2026 hay
// DOS caminos que lo usan y tienen que hacer exactamente lo mismo:
//   · la llamada inmediata (reintento, o cuando alguien espera el informe), en
//     /api/ai/analyze-transcript;
//   · el análisis en LOTE (Batch API, mitad de precio) del registro normal de
//     clases, que cobra el cron /api/cron/analisis-lote (ver lib/analysisBatch).
// Si cada camino tuviera su copia de la ficha, el riesgo, la intervención y la
// autenticidad, el informe en lote acabaría haciendo menos que el inmediato.

import 'server-only';

import { supabase } from '@/lib/supabase';
import type { AiResult } from '@/lib/anthropic';
import type { TranscriptInput } from '@/lib/analyzeTranscript';
import { isRiskCause, isRiskSignal, type TranscriptIA } from '@/lib/aiTypes';
import { decideTranscript, shouldRunAI } from '@/lib/transcriptVerdict';
import { validateTranscriptStructure } from '@/lib/transcriptValidation';
import { verifyTranscriptAI } from '@/lib/verifyTranscriptAI';
import {
  persistAnalysisFields, markAnalysisFailed, recordLateAuthenticityCheck,
  ensureProfileId, updateProfileFromAnalysis, notifyAdminRisk, notifyAdminTranscript,
} from '@/lib/transcriptStore';
import { normalizeSuggestion, normalizeCheck } from '@/lib/interventions';
import {
  loadInterventionContext, saveActiveIntervention, recordInterventionAudit,
  notifyTeacherIntervention, notifyAdminUnattended, type InterventionContext,
} from '@/lib/interventionStore';
import { aiLevelOf, type ProfileLevelFields } from '@/lib/effectiveLevel';
import { fetchTeacher, sendInterventionEmail } from '@/lib/emailNotifications';

/** Cuerpo de /api/ai/analyze-transcript. En el lote se guarda tal cual, sin el transcript. */
export interface AnalysisBody {
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
  /**
   * Paso 2 del registro normal: nadie espera el informe en pantalla, así que va
   * en LOTE (mitad de precio) y llega en unas horas. El reintento manual no lo
   * manda: quien pulsa "Reintentar análisis" quiere verlo ya.
   */
  defer?: boolean;
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

/** Todo lo que hace falta para analizar una fila guardada y procesar su informe. */
export interface AttachPrep {
  analysisId: string;
  studentName: string;
  body: AnalysisBody;
  transcript: string;
  classNumber: number | null;
  classDate: string | null;
  studentId: string | null;
  teacherId: string | null;
  validationStatus: string;
  /** Estado del informe al leer la fila ('pending' | 'queued' | 'ready' | 'failed'). */
  analysisStatus: string | null;
  intervention: InterventionContext;
  /** La entrada de la IA, lista para analyzeTranscript o para el lote. */
  input: TranscriptInput;
}

/**
 * Lee la fila guardada y arma la entrada de la IA. `null` = no hay transcript.
 *
 * La fila manda: el transcript guardado es el bueno (en el reintento y en el lote
 * el cliente ni siquiera lo envía).
 */
export async function prepareAttach(
  body: AnalysisBody, studentName: string, analysisId: string,
): Promise<AttachPrep | null> {
  const read = (cols: string) =>
    supabase.from('class_analyses').select(cols).eq('id', analysisId).maybeSingle();

  let res = await read('id, transcript, class_number, class_date, teacher_id, student_id, validation_status, analysis_status');
  if (res.error && (res.error.code === '42703' || res.error.code === 'PGRST204')) {
    res = await read('id, transcript, class_number, class_date, teacher_id, student_id');
  }
  if (res.error) console.error('[analyze-transcript] Error al leer la fila a analizar:', res.error);
  const row = (res.data ?? null) as Record<string, unknown> | null;
  const transcript = String(row?.transcript ?? body.transcript ?? '').trim();
  if (!transcript) return null;

  const classNumber = body.classNumber ?? (row?.class_number as number | null) ?? null;
  const classDate   = body.classDate   ?? (row?.class_date as string | null)   ?? null;
  const studentId   = (row?.student_id as string | null) ?? body.studentId ?? null;

  // Alerta que el alumno traía abierta: si la hay, la IA evalúa además si el
  // profesor intervino (auditoría de seguimiento). `currentAnalysisId` evita
  // auditar esta clase contra la alerta que ella misma generó en un intento
  // anterior ("Reintentar análisis").
  const intervention = await loadInterventionContext({
    profileId: body.profileId, studentId, studentName, currentAnalysisId: analysisId,
  });

  return {
    analysisId,
    studentName,
    body,
    transcript,
    classNumber,
    classDate,
    studentId,
    teacherId: (row?.teacher_id as string | null) ?? body.teacherId ?? null,
    validationStatus: (row?.validation_status as string | null) ?? 'ok',
    analysisStatus: (row?.analysis_status as string | null) ?? null,
    intervention,
    input: {
      transcript,
      studentName,
      teacherName: body.teacherName?.trim() || '',
      plan: body.plan,
      level: await resolveAiLevel({ profileId: body.profileId, studentId, studentName, level: body.level }),
      classNumber,
      classDate,
      studentProfile: body.studentProfile,
      classHistory: body.classHistory,
      activeIntervention: intervention.active,
    },
  };
}

/**
 * Pega el informe sobre la fila y corre todo lo que cuelga de él. Si la IA
 * falló, deja la fila en 'failed' (botón "Reintentar análisis"). Nunca lanza
 * por la IA: la clase ya está guardada.
 */
export async function finishAttach(
  prep: AttachPrep, result: AiResult<TranscriptIA>,
): Promise<{ analyzed: boolean; error?: string; analysis?: TranscriptIA }> {
  const { analysisId, studentName } = prep;
  if (result.status !== 'ready' || !result.data) {
    const msg = result.error ?? 'No se pudo analizar la transcripción.';
    console.error(`[analyze-transcript] Análisis fallido para ${analysisId} (${studentName}): ${msg}`);
    await markAnalysisFailed(analysisId, msg);
    return { analyzed: false, error: msg };
  }

  const saveErr = await persistAnalysisFields(analysisId, result.data);
  if (saveErr.error) {
    console.error(`[analyze-transcript] No se pudo guardar el informe de ${analysisId}:`, saveErr.error);
    return { analyzed: false, error: saveErr.error };
  }

  await afterAnalysis({
    analysisId,
    analysis: result.data,
    transcript: prep.transcript,
    studentName,
    classDate: prep.classDate,
    classNumber: prep.classNumber,
    body: prep.body,
    teacherId: prep.teacherId,
    studentId: prep.studentId,
    validationStatus: prep.validationStatus,
    intervention: prep.intervention,
  });
  return { analyzed: true, analysis: result.data };
}

/**
 * EL NIVEL QUE VA AL PROMPT.
 *
 * El cuerpo trae `assignment.student_level`, o sea el CURSO CONTRATADO, que es
 * la última fuente de la prioridad. Si el alumno tiene ficha mandan, por ese
 * orden, el visto bueno del profesor y el resultado de la prueba de nivel.
 *
 * Se resuelve acá, en el servidor, y no en cada pantalla: /revisiones y
 * /mis-clases registran clases sin cargar la ficha, así que le mandaban a la IA
 * el nivel del curso aunque el profesor hubiera corregido al alumno. Regla
 * única en lib/effectiveLevel.
 */
export async function resolveAiLevel(args: {
  profileId?: string | null; studentId?: string | null; studentName: string; level?: string;
}): Promise<string | undefined> {
  const read = (cols: string) => {
    const base = supabase.from('student_profiles').select(cols);
    const q = args.profileId  ? base.eq('id', args.profileId)
            : args.studentId  ? base.eq('student_id', args.studentId)
            :                   base.eq('student_name', args.studentName);
    return q.limit(1).maybeSingle();
  };

  // `teacher_confirmed_level` llega con supabase-teacher-level.sql. Si todavía
  // no se corrió, pedirla haría fallar la consulta ENTERA (42703) y el nivel se
  // perdería en silencio: mismo reintento por grupos que el resto del archivo.
  let res = await read('teacher_confirmed_level, current_level, level_test_cefr');
  if (res.error?.code === '42703' || res.error?.code === 'PGRST204') {
    res = await read('current_level, level_test_cefr');
  }
  if (res.error) console.warn('[analyze-transcript] Sin ficha para resolver el nivel; va el del curso:', res.error.message);

  // Sin ficha, `aiLevelOf` devuelve el nivel del cuerpo: el comportamiento de
  // siempre para los alumnos que no completaron el formulario.
  const profile = (res.data ?? null) as ProfileLevelFields | null;
  return aiLevelOf(profile, args.level) ?? undefined;
}

/**
 * Después de guardar el informe: ficha del alumno, aviso de riesgo, sugerencia
 * de intervención, auditoría de seguimiento y CAPA 3 (autenticidad por IA).
 * Todo best-effort — acá ya no se puede perder la clase.
 */
export async function afterAnalysis(args: {
  analysisId: string;
  analysis: TranscriptIA;
  transcript: string;
  studentName: string;
  classDate: string | null;
  classNumber: number | null;
  body: AnalysisBody;
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

  // Solo el ROJO avisa. El amarillo se retiró entero: era una señal débil que
  // generaba alerta e incomodaba sin decir nada accionable.
  if (risk === 'rojo') {
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
  //
  // NO PUEDE DESPAGAR LA CLASE. Deja constancia del hallazgo y avisa al admin,
  // pero el `validation_status` no baja: la clase ya se le prometió pagada al
  // profesor, y quitársela minutos después sin decirle nada era peor que el
  // problema que esto intenta detectar. Sacarla de 'ok' es decisión de una
  // persona, con el botón "Reabrir" del panel de Validación.
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
    await recordLateAuthenticityCheck(args.analysisId, ai as unknown as Record<string, unknown>, flags);
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
 * BLOQUE 1 — la clase salió en ROJO: se abre la intervención.
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
  body: AnalysisBody;
  profileId: string | null;
  risk: 'rojo';
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
    teacherId: args.teacherId, studentName: args.studentName, suggestion, context,
  });

  // Email: es el único correo ligado a las señales de riesgo y sale solo cuando
  // hay una sugerencia concreta. Best-effort, como el resto de los avisos.
  try {
    const teacher = await fetchTeacher(args.teacherId);
    if (teacher) {
      await sendInterventionEmail(teacher, {
        studentName: args.studentName, suggestion, classNumber: args.classNumber, context,
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
  body: AnalysisBody;
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
