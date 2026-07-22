// Algoritmo adaptativo (simplificado): la dificultad sube al acertar y baja al
// fallar, acotada a 1–6. La próxima pregunta se elige del nivel objetivo (o el más
// cercano disponible) dentro de la sección, evitando las ya respondidas.

import type { LTSection } from './types';

export function getNextDifficulty(current: number, wasCorrect: boolean): number {
  return wasCorrect ? Math.min(current + 1, 6) : Math.max(current - 1, 1);
}

interface QuestionRow { id: string; section: string; difficulty: number }

export function selectNextQuestion<T extends QuestionRow>(
  pool: T[],
  section: LTSection,
  targetDifficulty: number,
  answeredIds: string[],
): T | null {
  const answered = new Set(answeredIds);
  const available = pool.filter(q => q.section === section && !answered.has(q.id));
  if (available.length === 0) return null;

  // Preferí el nivel exacto; si no hay, el más cercano. Entre empatados, al azar
  // (así dos candidatos no reciben siempre la misma pregunta).
  let bestDist = Infinity;
  for (const q of available) {
    const d = Math.abs(q.difficulty - targetDifficulty);
    if (d < bestDist) bestDist = d;
  }
  const tied = available.filter(q => Math.abs(q.difficulty - targetDifficulty) === bestDist);
  return tied[Math.floor(Math.random() * tied.length)];
}
