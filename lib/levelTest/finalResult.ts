// Resultado FINAL de una prueba de nivel a partir de sus respuestas. PURO: sin
// red ni base.
//
// Vive aparte porque lo usan dos sitios que tienen que decir exactamente lo
// mismo:
//   · app/api/level-test/[token]/submit — el cierre normal de la prueba;
//   · lib/levelTest/reevaluate — la reevaluación de las redacciones que la IA
//     no pudo evaluar (saldo agotado del 14–16/09/2026).
// Si cada uno calculara por su cuenta, un alumno reevaluado podría acabar con un
// nivel que la prueba normal nunca le habría dado.
//
// Las reglas (lectura 60 % + escritura 40 %, provisional sin escritura,
// compuerta de C1/C2) están explicadas en lib/levelTest/scoring.

import {
  assessReading, calculateWritingScore, calculateOverall, autoCefrLevel, type AutoLevel,
} from './scoring';
import type { LTAnswerLite, LTSection, Cefr } from './types';

export interface FinalAnswerRow {
  section: string;
  difficulty: number;
  is_correct: boolean | null;
  ai_score: number | null;
  ai_feedback: unknown;
  invalid_reason?: string | null;
}

export interface FinalResult {
  readingScore: number | null;
  writingScore: number | null;
  overall: number;
  cefr: Cefr;
  auto: AutoLevel;
  /** La escritura no aportó (no válida o IA caída): nivel solo con lectura. */
  provisional: boolean;
  provisionalReason: string | null;
  /** Feedback que se enseña al alumno: solo si la escritura se puntuó de verdad. */
  aiEvaluation: unknown;
}

/** `rows` en ORDEN CRONOLÓGICO: assessReading mide la ventana final del test. */
export function computeFinalResult(rows: FinalAnswerRow[]): FinalResult {
  const lite: LTAnswerLite[] = rows.map(a => ({
    section: a.section as LTSection, difficulty: a.difficulty, is_correct: a.is_correct, ai_score: a.ai_score,
  }));

  const reading = assessReading(lite);
  const readingScore = reading?.score ?? null;
  const writingScore = calculateWritingScore(lite);
  const overall = calculateOverall(readingScore, writingScore);

  // Provisional = la escritura no aportó. Da igual por qué: el 40% del criterio
  // no está y el nivel no es definitivo.
  const writingRow = rows.find(a => a.section === 'writing');
  const provisional = writingScore == null;
  const provisionalReason = provisional
    ? (writingRow?.invalid_reason ?? (writingRow ? 'ai_unavailable' : null))
    : null;

  // El puntaje decide la banda y encima va la compuerta de C1/C2 (sin escritura
  // que los respalde no se certifican). overall_score se guarda SIN tocar.
  const writingEval = (writingRow?.ai_feedback ?? null) as { cefr_level?: string } | null;
  const writingLevel = !provisional && writingEval?.cefr_level ? (writingEval.cefr_level as Cefr) : null;
  const auto = autoCefrLevel(overall, writingLevel);

  return {
    readingScore, writingScore, overall, cefr: auto.level, auto,
    provisional, provisionalReason,
    aiEvaluation: !provisional ? (writingRow?.ai_feedback ?? null) : null,
  };
}
