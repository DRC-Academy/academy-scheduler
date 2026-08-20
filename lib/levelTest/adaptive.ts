// Algoritmo adaptativo (simplificado): la dificultad sube al acertar y baja al
// fallar, acotada a 1–6. La próxima pregunta se elige del nivel objetivo (o el más
// cercano disponible) dentro de la sección, evitando las ya respondidas.
//
// ── POLÍTICA DE FALLBACK (decidida, no accidental) ───────────────────────────
// Cuando no quedan preguntas SIN USAR en la dificultad objetivo se sirve la más
// cercana disponible, y la dificultad REALMENTE servida queda registrada en
// level_test_answers.difficulty (la pedida, en target_difficulty). Se descartaron:
//
//   · Repetir una pregunta ya respondida — el alumno ya sabe la respuesta, así que
//     infla la precisión; y hoy está roto de todos modos: la guarda de idempotencia
//     de answer/route no reinserta una pregunta ya respondida, el contador nunca
//     llegaría a 17 y el test acabaría en la pantalla de "no podemos continuar".
//   · Acortar el bloque — chocaría con la compuerta de las 17 respuestas (habría
//     que hacer el total dinámico por sesión) y con la ventana de 8 de
//     assessReading, que se quedaría sin muestra.
//
// CONSECUENCIA QUE HAY QUE TENER PRESENTE: el fallback sesga la medición HACIA
// ABAJO justo en el techo. Un C2 al que se le acaban las preguntas de dificultad 6
// recibe dificultad 5, y como assessReading mide la dificultad a la que converge,
// sale C1. No es un fallo del algoritmo: es un banco corto. Se vigila con
// `npm run check:bank`, que exige tantas preguntas por (sección, dificultad) como
// preguntas tenga el bloque — en las dificultades 1 y 6 el clamp deja al alumno
// clavado y puede consumir el bloque entero en un solo nivel.
//
// Entre varias candidatas a la misma distancia se elige al azar, a propósito: no
// sesga ni hacia arriba ni hacia abajo, y evita que dos candidatos reciban siempre
// la misma pregunta.

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
