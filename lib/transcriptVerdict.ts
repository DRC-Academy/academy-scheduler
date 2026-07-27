// Orquestador del Bloque 1: corre las 3 capas de verificación sobre un transcript
// y devuelve un veredicto (ok / review / blocked) + todo el detalle para guardar y
// para el panel del admin. SOLO SERVIDOR (la capa 2 y 3 tocan base/IA).
//
// FLUJO:
//   1. Capa 1 — validación estructural (score 0-100). PURA, instantánea.
//   2. Capa 2 — verificación cruzada (accesos, duración, ventana, similitud). Base.
//   3. Capa 3 — IA semántica, SOLO si score ∈ [15,70] o hay algún flag de la capa 2.
//   4. Decisión final.
//
// EL VEREDICTO NUNCA CANCELA EL GUARDADO (cambio del 27/07/2026).
// Antes, decision === 'blocked' hacía que el transcript no se persistiera y el
// profesor perdía la clase. Ahora la decisión solo determina el `validation_status`
// de la fila:
//   · 'ok'      → validation_status 'ok'      → cuenta para el pago
//   · 'review'  → validation_status 'review'  → pendiente de validación del equipo
//   · 'blocked' → validation_status 'review'  → igual que review, pero el aviso al
//                 admin sale con severidad máxima (score < 15).
//
// La capa 3 (IA) se corre FUERA del guardado: al guardar solo van las capas 1 y 2
// (rápidas), y la IA se ejecuta junto con el análisis pedagógico, donde como mucho
// puede DEGRADAR la clase a revisión. Así una llamada lenta a la IA no puede hacer
// que el profesor pierda su registro de clase.

import {
  validateTranscriptStructure, SCORE_SEVERE, SCORE_CLEAN,
  type ValidationResult,
} from '@/lib/transcriptValidation';
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

const OK_MSG = {
  title: 'Clase registrada',
  body: 'La clase se ha registrado correctamente y cuenta para tu resumen de pago.',
};
const REVIEW_MSG = {
  title: 'Clase registrada — pendiente de validación',
  body: 'Esta clase se ha registrado correctamente y está pendiente de validación por el equipo. Aparecerá en tu resumen de pago una vez validada.',
};

/** Estado que se guarda en class_analyses.validation_status para cada decisión. */
export function statusForDecision(d: TranscriptDecision): 'ok' | 'review' {
  return d === 'ok' ? 'ok' : 'review';
}

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
  /** true en el guardado: no se llama a la IA (capa 3), que corre luego aparte. */
  skipAI?: boolean;
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
  let ai: TranscriptAuthenticity | null = null;
  let aiRan = false;
  if (!input.skipAI && shouldRunAI(structure.score, cross.flags.length)) {
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

  const decision = decideTranscript({ score: structure.score, flags, ai });
  const msg = decision === 'ok' ? OK_MSG : REVIEW_MSG;

  return {
    decision, structure, cross, ai, aiRan, flags,
    teacherTitle: msg.title,
    teacherBody: msg.body,
  };
}

/** ¿Vale la pena gastar la IA? Zona gris de la capa 1 o flags de la capa 2. */
export function shouldRunAI(score: number, crossFlagCount: number): boolean {
  return (score >= SCORE_SEVERE && score <= 70) || crossFlagCount > 0;
}

/**
 * Decisión final. Ninguna rama impide guardar: 'blocked' es solo la severidad
 * máxima (score < 15) para el aviso al admin.
 */
export function decideTranscript(args: {
  score: number;
  flags: string[];
  ai: TranscriptAuthenticity | null;
}): TranscriptDecision {
  const { score, flags, ai } = args;
  const aiDoubts = !!ai && ai.authentic === false && ai.confidence >= 40;

  if (score < SCORE_SEVERE) return 'blocked';
  if (score < SCORE_CLEAN || flags.length > 0 || aiDoubts) return 'review';
  return 'ok';
}
