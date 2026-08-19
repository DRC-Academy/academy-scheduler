// Cálculo de scores del test. Reading ponderado por dificultad; overall combina
// reading (60%) y writing (40%). El mapeo a CEFR vive en constants.scoreToCefr.
//
// Las DOS partes están en la misma escala absoluta 0–100 → el promedio ponderado
// tiene sentido. El writing lo garantiza lib/evaluateWriting, que deriva el ai_score
// del nivel MCER del texto con constants.cefrToScore (ago/2026; antes era relativo a
// la consigna y por eso el resultado salía inflado).

import type { LTAnswerLite } from './types';
import { scoreToCefr } from './constants';

const round2 = (n: number) => Math.round(n * 100) / 100;

// Cada acierto vale `difficulty` puntos (A1=1 … C2=6): premia acertar preguntas
// más difíciles. Score = puntos obtenidos / puntos máximos posibles · 100.
export function calculateReadingScore(answers: LTAnswerLite[]): number {
  const reading = answers.filter(a => a.section !== 'writing');
  const max = reading.reduce((s, a) => s + (a.difficulty || 0), 0);
  if (max === 0) return 0;
  const got = reading.reduce((s, a) => s + (a.is_correct ? (a.difficulty || 0) : 0), 0);
  return round2((got / max) * 100);
}

// Promedio de los scores de IA de las respuestas de writing (0–100, escala MCER
// absoluta). Devuelve null si NINGUNA fue evaluada (IA caída): no es lo mismo "no
// evaluado" que "escribió fatal", y contarlo como 0 le costaría 40 puntos al alumno.
export function calculateWritingScore(answers: LTAnswerLite[]): number | null {
  const writing = answers.filter(a => a.section === 'writing' && a.ai_score != null);
  if (writing.length === 0) return null;
  const avg = writing.reduce((s, a) => s + (a.ai_score || 0), 0) / writing.length;
  return round2(avg);
}

// Si no hay writing evaluado, el resultado es SOLO el reading (no se penaliza al
// alumno por un fallo de la IA). Con writing, 60/40.
export function calculateOverall(readingScore: number, writingScore: number | null): number {
  if (writingScore == null) return round2(readingScore);
  return round2(readingScore * 0.6 + writingScore * 0.4);
}

export { scoreToCefr };
