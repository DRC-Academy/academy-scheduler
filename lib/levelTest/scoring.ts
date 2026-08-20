// Cálculo de scores del test. Las DOS mitades están ancladas a la MISMA escala
// MCER absoluta, y por eso el promedio ponderado 60/40 tiene sentido.
//
// Historia, porque el error se repitió dos veces:
//   · ago/2026 — la ESCRITURA puntuaba "cuánto cumpliste la consigna que te tocó"
//     (relativo) y se sumaba como si fuera nivel absoluto. Corregido: la IA asigna
//     el nivel MCER del texto y el código deriva el puntaje con `cefrToScore`.
//   · El mismo error seguía vivo en la LECTURA, que pesa el 60%: devolvía el
//     porcentaje de acierto sobre las preguntas que le tocaron a cada alumno. Como
//     el adaptativo converge a ~50% de acierto para TODOS, casi todo el mundo
//     salía entre 40 y 50 fuera cual fuera su nivel: B2 y C1 daban exactamente el
//     mismo 50,00 y eran indistinguibles.
//
// Ahora la lectura también devuelve banda + posición y pasa por el mismo
// `cefrToScore`. Lo que mide el nivel es LA DIFICULTAD A LA QUE CONVERGE el
// alumno, no cuántas acertó.

import type { LTAnswerLite, Cefr, CefrPosition } from './types';
import { scoreToCefr, cefrToScore, DIFFICULTY_TO_CEFR } from './constants';

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Lectura ──────────────────────────────────────────────────────────────────

// El test SIEMPRE arranca en dificultad 3, así que las primeras respuestas miden
// el punto de partida (arbitrario), no al alumno. A mitad de camino el escalón
// ±1 ya convergió, así que solo cuenta la segunda mitad.
export const READING_WINDOW = 8;

// Fronteras de `within_level`, explícitas a propósito. Con 8 ítems la precisión
// solo puede valer 0 / 12,5 / 25 / 37,5 / 50 / 62,5 / 75 / 87,5 / 100, de modo
// que el 65 exacto no es alcanzable; se deja escrito igual para que la frontera
// no dependa de cuántos ítems tenga la ventana.
export const WITHIN_HIGH_MIN = 65;   // >= 65  → high
export const WITHIN_MID_MIN = 40;    // >= 40 y < 65 → mid; por debajo → low

export function readingWithinLevel(accuracyPct: number): CefrPosition {
  if (accuracyPct >= WITHIN_HIGH_MIN) return 'high';
  if (accuracyPct >= WITHIN_MID_MIN) return 'mid';
  return 'low';
}

// Redondeo al entero más cercano con el EMPATE HACIA ABAJO (3,5 → 3), por
// coherencia con la regla de empate de la escritura ("cuando la evidencia cae
// entre dos niveles, elegí el de abajo").
//
// No es un detalle de estilo: en equilibrio el alumno oscila entre su techo θ y
// θ+1, así que la media de la ventana es exactamente θ,5. Redondeando hacia
// abajo sale θ, su nivel real; hacia arriba saldrían los seis niveles inflados
// en uno. Math.round(-x) redondea el empate hacia +Infinito, de ahí el doble
// signo.
export function roundHalfDown(x: number): number {
  return -Math.round(-x);
}

export const clampDifficulty = (d: number) => Math.min(6, Math.max(1, d));

export interface ReadingAssessment {
  band: number;              // 1–6, la dificultad a la que convergió
  cefr_level: Cefr;
  within_level: CefrPosition;
  accuracy: number;          // % de acierto DENTRO de la ventana
  meanDifficulty: number;    // media sin redondear (para auditar)
  sampleSize: number;        // cuántas respuestas entraron
  score: number;             // cefrToScore(cefr_level, within_level)
}

/**
 * Nivel de lectura a partir de las últimas `READING_WINDOW` respuestas.
 *
 * CONTRATO: `answers` tiene que venir en ORDEN CRONOLÓGICO (por `answered_at`).
 * La función toma el final de la lista; si el orden está mal, la ventana también.
 *
 * Se ignoran la escritura y cualquier respuesta sin dificultad registrada. Con
 * menos de `READING_WINDOW` respuestas usa las que haya (sesiones anteriores a
 * la compuerta de las 17). Sin ninguna devuelve null: no es lo mismo "no hay
 * datos" que "sacó cero".
 */
export function assessReading(answers: LTAnswerLite[]): ReadingAssessment | null {
  const reading = answers.filter(a => a.section !== 'writing' && a.difficulty != null);
  if (reading.length === 0) return null;

  const window = reading.slice(-READING_WINDOW);

  const meanDifficulty = window.reduce((s, a) => s + a.difficulty, 0) / window.length;
  const band = clampDifficulty(roundHalfDown(meanDifficulty));
  const cefr = DIFFICULTY_TO_CEFR[band];

  const aciertos = window.filter(a => a.is_correct).length;
  const accuracy = round2((aciertos / window.length) * 100);
  const within = readingWithinLevel(accuracy);

  return {
    band,
    cefr_level: cefr,
    within_level: within,
    accuracy,
    meanDifficulty: round2(meanDifficulty),
    sampleSize: window.length,
    score: cefrToScore(cefr, within),
  };
}

/**
 * Fórmula ANTERIOR: porcentaje de acierto ponderado por dificultad, relativo a
 * las preguntas que le tocaron a cada alumno.
 *
 * NO se usa en producción. Se conserva exportada porque el script de recálculo
 * (`npm run recalc:reading`) compara antes/después sobre los tests reales, y esa
 * comparación tiene que correr contra la fórmula de verdad, no contra una copia.
 */
export function legacyReadingScore(answers: LTAnswerLite[]): number {
  const reading = answers.filter(a => a.section !== 'writing');
  const max = reading.reduce((s, a) => s + (a.difficulty || 0), 0);
  if (max === 0) return 0;
  const got = reading.reduce((s, a) => s + (a.is_correct ? (a.difficulty || 0) : 0), 0);
  return round2((got / max) * 100);
}

// ── Escritura ────────────────────────────────────────────────────────────────

// Promedio de los scores de IA de las respuestas de writing (0–100, escala MCER
// absoluta). Devuelve null si NINGUNA fue evaluada (IA caída o intento no
// válido): no es lo mismo "no evaluado" que "escribió fatal", y contarlo como 0
// le costaría 40 puntos al alumno.
export function calculateWritingScore(answers: LTAnswerLite[]): number | null {
  const writing = answers.filter(a => a.section === 'writing' && a.ai_score != null);
  if (writing.length === 0) return null;
  const avg = writing.reduce((s, a) => s + (a.ai_score || 0), 0) / writing.length;
  return round2(avg);
}

// ── Resultado ────────────────────────────────────────────────────────────────

// Las dos mitades ya están en la misma escala absoluta, así que el 60/40 es un
// promedio legítimo. Si falta una de las dos, manda la otra sola: no se penaliza
// al alumno por un hueco que no es suyo.
export function calculateOverall(readingScore: number | null, writingScore: number | null): number {
  if (readingScore == null && writingScore == null) return 0;
  if (writingScore == null) return round2(readingScore as number);
  if (readingScore == null) return round2(writingScore);
  return round2(readingScore * 0.6 + writingScore * 0.4);
}

export { scoreToCefr };
