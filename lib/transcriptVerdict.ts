// Orquestador del Bloque 1: corre las 3 capas de verificación sobre un transcript
// y devuelve un veredicto (ok / review / blocked) + todo el detalle para guardar y
// para el panel del admin. SOLO SERVIDOR (la capa 2 y 3 tocan base/IA).
//
// FLUJO:
//   1. Capa 1 — validación estructural (score 0-100).
//   2. Capa 2 — verificación cruzada (accesos, duración, ventana, similitud).
//   3. Capa 3 — IA semántica, SOLO si score ∈ [35,70] o hay algún flag de la capa 2.
//   4. Decisión final.

import { validateTranscriptStructure, type ValidationResult } from '@/lib/transcriptValidation';
import { runTranscriptCrossChecks, type CrossCheckResult } from '@/lib/transcriptCrossCheck';
import { verifyTranscriptAI, type TranscriptAuthenticity } from '@/lib/verifyTranscriptAI';

export type TranscriptDecision = 'ok' | 'review' | 'blocked';

export interface TranscriptVerdict {
  decision: TranscriptDecision;
  structure: ValidationResult;
  cross: CrossCheckResult;
  ai: TranscriptAuthenticity | null;
  aiRan: boolean;
  flags: string[];               // unión de capa 1 + capa 2 (+ ia_no_autentico)
  // Mensaje neutro para el profesor (nunca acusatorio).
  teacherTitle: string;
  teacherBody: string;
}

const BLOCK_MSG = {
  title: 'No hemos podido validar esta transcripción',
  body: 'El formato del texto no coincide con una transcripción de Fathom. Asegúrate de copiar el texto completo desde Fathom, incluyendo las marcas de tiempo y los nombres de los participantes. Si el problema persiste, contacta con el equipo.',
};
const REVIEW_MSG = {
  title: 'Clase registrada — pendiente de validación',
  body: 'Esta clase se ha registrado correctamente y está pendiente de validación por el equipo. Aparecerá en tu resumen de pago una vez validada.',
};

export interface VerdictInput {
  teacherId: string;
  teacherName: string;
  studentName: string;
  classDate: string;
  transcript: string;
  level?: string | null;
  durationMinutes?: number;
  uploadedAtIso?: string;
  excludeId?: string | null;
}

export async function computeTranscriptVerdict(input: VerdictInput): Promise<TranscriptVerdict> {
  const durationMinutes = input.durationMinutes ?? 60;

  // ── Capa 1 ──
  const structure = validateTranscriptStructure(input.transcript, { durationMinutes });

  // ── Capa 2 ──
  const cross = await runTranscriptCrossChecks({
    teacherId: input.teacherId,
    studentName: input.studentName,
    classDate: input.classDate,
    transcript: input.transcript,
    durationMinutes,
    lastTimestampMinutes: structure.lastTimestampMinutes,
    uploadedAtIso: input.uploadedAtIso,
    excludeId: input.excludeId,
  });

  const flags = Array.from(new Set([...structure.flags, ...cross.flags]));

  // ── Capa 3 — solo en zona gris o si hay flags de capa 2 ──
  // Si el score < 35 ya es bloqueo seguro: la IA no puede cambiarlo → no se gasta.
  const grayZone = structure.score >= 35 && structure.score <= 70;
  const shouldRunAI = structure.score >= 35 && (grayZone || cross.flags.length > 0);
  let ai: TranscriptAuthenticity | null = null;
  let aiRan = false;
  if (shouldRunAI) {
    const res = await verifyTranscriptAI({
      transcript: input.transcript,
      teacherName: input.teacherName,
      studentName: input.studentName,
      level: input.level,
      durationMinutes,
    });
    aiRan = res.status === 'ready';
    ai = res.data;
  }
  if (ai && !ai.authentic && !flags.includes('ia_no_autentico')) flags.push('ia_no_autentico');

  // ── Decisión final ──
  let decision: TranscriptDecision;
  const aiBlocks  = !!ai && ai.authentic === false && ai.confidence > 70;
  const aiReviews = !!ai && ai.authentic === false && ai.confidence >= 40 && ai.confidence <= 70;

  if (structure.score < 35 || aiBlocks) {
    decision = 'blocked';
  } else if (structure.score < 60 || flags.length > 0 || aiReviews) {
    decision = 'review';
  } else {
    decision = 'ok';
  }

  const msg = decision === 'blocked' ? BLOCK_MSG : REVIEW_MSG;

  return {
    decision, structure, cross, ai, aiRan, flags,
    teacherTitle: msg.title,
    teacherBody: msg.body,
  };
}
