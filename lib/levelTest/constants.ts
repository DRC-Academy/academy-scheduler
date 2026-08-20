// Constantes del Test de Nivel: mapeos CEFR, orden y tamaño de secciones.

import type { LTSection, Cefr, CefrPosition } from './types';

export const DIFFICULTY_TO_CEFR: Record<number, Cefr> = {
  1: 'A1', 2: 'A2', 3: 'B1', 4: 'B2', 5: 'C1', 6: 'C2',
};
export const CEFR_TO_DIFFICULTY: Record<Cefr, number> = {
  A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6,
};

// Orden y cantidad de preguntas por sección (adaptativas dentro de cada una).
export const SECTION_ORDER: LTSection[] = ['reading_completion', 'reading_passage', 'reading_email', 'writing'];
export const SECTION_COUNT: Record<LTSection, number> = {
  reading_completion: 6,
  reading_passage: 5,
  reading_email: 5,
  writing: 1,
};
export const GRAND_TOTAL = SECTION_ORDER.reduce((s, sec) => s + SECTION_COUNT[sec], 0);

export const SECTION_LABEL: Record<LTSection, string> = {
  reading_completion: 'Completar oraciones',
  reading_passage: 'Comprensión de textos',
  reading_email: 'Comprensión de emails',
  writing: 'Escritura',
};

export const START_DIFFICULTY = 3;   // arranca en B1
export const EXPIRES_DEFAULT_DAYS = 7;

// ÚNICA fuente de verdad de los umbrales: `scoreToCefr` y `cefrToScore` derivan de
// aquí, así la escala del writing, la del reading y la del resultado final NUNCA
// se desalinean. Cada banda es (min, max]; A1 incluye el 0.
//
// SEXTOS IGUALES (ago/2026). Antes A1 y C2 abarcaban 30 puntos cada uno y las
// cuatro bandas centrales solo 10: en la zona donde vive casi todo el alumnado,
// dos puntos cambiaban el nivel, y en los extremos hacían falta treinta.
//
// El reparto dejó de ser una decisión sobre datos en cuanto las DOS mitades del
// test quedaron ancladas a estas mismas bandas: la lectura entra por
// `cefrToScore(banda, posición)` igual que la escritura, así que el 0–100 no es
// una medida con significado propio que haya que calibrar, es solo el vehículo
// para promediar 60/40 dos niveles MCER. Y si el eje solo transporta niveles, los
// seis tienen que ocupar lo mismo: cualquier otro reparto le da a una banda más
// peso en el promedio que a otra sin ninguna razón.
//
// Se construyen a partir de SIXTH para que la igualdad sea estructural y no seis
// números a mano que alguien pueda desnivelar sin darse cuenta.
const SIXTH = 100 / 6;

export const CEFR_BANDS: Array<{ level: Cefr; min: number; max: number }> = [
  { level: 'A1', min: 0,         max: SIXTH },
  { level: 'A2', min: SIXTH,     max: 2 * SIXTH },
  { level: 'B1', min: 2 * SIXTH, max: 3 * SIXTH },
  { level: 'B2', min: 3 * SIXTH, max: 4 * SIXTH },
  { level: 'C1', min: 4 * SIXTH, max: 5 * SIXTH },
  { level: 'C2', min: 5 * SIXTH, max: 100 },
];

export function scoreToCefr(score: number): Cefr {
  for (const b of CEFR_BANDS) if (score <= b.max) return b.level;
  return 'C2';
}

const POSITION_FRACTION: Record<CefrPosition, number> = { low: 0.25, mid: 0.5, high: 0.75 };

// Inversa de scoreToCefr: convierte un nivel MCER absoluto (+ dónde cae dentro de la
// banda) al puntaje 0–100 que representa ese nivel. Se cumple siempre
// scoreToCefr(cefrToScore(L)) === L, sean cuales sean los umbrales de CEFR_BANDS.
// Es lo que pone la nota de writing en la MISMA escala absoluta que el reading.
export function cefrToScore(level: Cefr, position: CefrPosition = 'mid'): number {
  const b = CEFR_BANDS.find(x => x.level === level) ?? CEFR_BANDS[0];
  const raw = b.min + POSITION_FRACTION[position] * (b.max - b.min);
  return Math.round(raw * 100) / 100;
}

// Descriptores MCER de EXPRESIÓN ESCRITA (en inglés: son la referencia contra la que
// la IA puntúa el texto, ver lib/evaluateWriting). Distintos de CEFR_DESC, que es la
// descripción general en español que ve el alumno en la pantalla de resultados.
export const CEFR_WRITING_DESCRIPTORS: Record<Cefr, string> = {
  A1: 'Isolated words and memorised phrases. Very simple present-tense sentences, often incomplete. Connectors limited to "and"/"but". Errors are frequent and often block understanding.',
  A2: 'Short, simple sentences on familiar topics. Simple past and future attempted with a narrow range of structures. Connectors: and, but, because, then. Errors are frequent but meaning usually gets through.',
  B1: 'Connected text on familiar topics. Reasonable control of common tenses; errors appear as soon as structures get complex. Vocabulary adequate but repetitive and high-frequency. Linkers such as however, although, so.',
  B2: 'Clear, detailed text. Good control of a range of structures: subordination, passives, conditionals, relative clauses. Errors do not cause misunderstanding. Varied vocabulary with occasional collocation slips. Clear cohesion and a structured argument.',
  C1: 'Well-structured, fluent text on complex subjects. Consistently high grammatical accuracy. Wide, precise vocabulary including less common and idiomatic items. Controlled register and sophisticated cohesive devices.',
  C2: 'Near-native. Complex ideas expressed precisely and naturally. Virtually error-free, with subtle nuance and effortless idiomatic and stylistic control.',
};

export const CEFR_DESC: Record<Cefr, string> = {
  A1: 'Principiante: frases básicas y situaciones cotidianas muy simples.',
  A2: 'Elemental: intercambios sencillos sobre temas conocidos.',
  B1: 'Intermedio: te desenvuelves en la mayoría de situaciones del día a día.',
  B2: 'Intermedio alto: fluidez y precisión en contextos variados, incluido el laboral.',
  C1: 'Avanzado: uso flexible y eficaz del idioma en contextos complejos.',
  C2: 'Maestría: comprensión y expresión prácticamente como un nativo.',
};

export const CEFR_COLOR: Record<Cefr, string> = {
  A1: '#dc2626', A2: '#ea580c', B1: '#b45309', B2: '#1E9E3A', C1: '#0f766e', C2: '#2563eb',
};
