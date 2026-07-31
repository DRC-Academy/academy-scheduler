// PASO 1 del registro de una clase: GUARDAR el transcript.
//
// Esta ruta NO llama a la IA. Es deliberado: es la que no puede fallar. Corre las
// capas 1 y 2 de validación (texto puro + comprobaciones contra la base, ambas
// rápidas), escribe la fila en class_analyses y devuelve su id. A partir de ese
// momento la clase ya cuenta para finanzas, aunque el análisis pedagógico falle.
//
// El informe se genera después con /api/ai/analyze-transcript (paso 2), que puede
// reintentarse sin volver a pegar el texto.

import { computeTranscriptVerdict } from '@/lib/transcriptVerdict';
import {
  persistTranscript, notifyAdminTranscript, verdictPayload,
} from '@/lib/transcriptStore';

export const runtime = 'nodejs';
// Sin IA de por medio esto son 2-3 consultas a Supabase; 30 s es margen de sobra.
export const maxDuration = 30;

interface Body {
  transcript?: string;
  studentName?: string;
  studentId?: string | null;
  teacherId?: string | null;
  teacherName?: string;
  classNumber?: number | null;
  classDate?: string | null;
  level?: string;
  transcriptHash?: string | null;
  joinLogId?: string | null;
  replaceId?: string | null;
  /** 120 en una sesión de 2h (celdas contiguas). Por defecto, 60. */
  durationMinutes?: number | null;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch (err) {
    console.error('[save-transcript] JSON inválido en el cuerpo:', err);
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const studentName = body.studentName?.trim();
  const transcript = body.transcript?.trim();
  if (!studentName) return Response.json({ error: 'Falta studentName.' }, { status: 400 });
  if (!transcript)  return Response.json({ error: 'Falta la transcripción.' }, { status: 400 });

  const classDate = body.classDate || new Date().toISOString().slice(0, 10);

  // Capas 1 y 2. skipAI: la capa 3 corre en el paso 2 (análisis), donde como mucho
  // puede degradar la clase a revisión — nunca impedir que se guarde.
  let verdict;
  try {
    verdict = await computeTranscriptVerdict({
      teacherId:   body.teacherId || '',
      teacherName: body.teacherName?.trim() || '',
      studentName,
      classDate,
      transcript,
      level:       body.level,
      excludeId:   body.replaceId,
      skipAI:      true,
      // Sesión de 2h: el transcript cubre 120 minutos y los umbrales de duración
      // se calibran con eso, no con una clase de 60 que nunca existió.
      durationMinutes: body.durationMinutes ?? undefined,
    });
  } catch (err) {
    // La validación NUNCA debe impedir guardar la clase: si se cae, se guarda
    // igual y se manda a revisión del equipo.
    console.error('[save-transcript] Error al validar; se guarda sin veredicto:', err);
    verdict = null;
  }

  const saved = await persistTranscript({
    transcript,
    studentName,
    studentId:      body.studentId,
    teacherId:      body.teacherId,
    classNumber:    body.classNumber,
    classDate,
    transcriptHash: body.transcriptHash,
    joinLogId:      body.joinLogId,
    replaceId:      body.replaceId,
  }, verdict ?? FALLBACK_VERDICT);

  if (saved.error || !saved.id) {
    console.error('[save-transcript] No se pudo guardar el transcript:', saved.error);
    return Response.json({ error: saved.error ?? 'No se pudo guardar la transcripción.' }, { status: 500 });
  }

  if (verdict && verdict.decision !== 'ok') {
    await notifyAdminTranscript(verdict, studentName, {
      teacherName: body.teacherName, classDate,
    });
  }

  return Response.json({
    saved: true,
    analysisId: saved.id,
    replaced: !!body.replaceId,
    validation: verdict ? verdictPayload(verdict) : null,
  });
}

// Veredicto neutro para cuando la validación se cae: la clase se guarda y queda
// pendiente de revisión del equipo (nunca se pierde).
const FALLBACK_VERDICT = {
  decision: 'review' as const,
  structure: { valid: false, score: 0, flags: [], reason: 'Validación no disponible.', lastTimestampMinutes: null, timestampCount: 0 },
  cross: { flags: [], hasAccess: false, estimatedDurationMin: null, daysLate: 0, similarityPct: 0, similarMatch: null },
  ai: null,
  aiRan: false,
  flags: [],
  teacherTitle: 'Clase registrada — pendiente de validación',
  teacherBody: 'Esta clase se ha registrado correctamente y está pendiente de validación por el equipo.',
};
