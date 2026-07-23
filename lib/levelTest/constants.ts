// Constantes del Test de Nivel: mapeos CEFR, orden y tamaño de secciones.

import type { LTSection, Cefr } from './types';

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

// 0–30 A1 · 31–40 A2 · 41–50 B1 · 51–60 B2 · 61–70 C1 · 71–100 C2
export function scoreToCefr(score: number): Cefr {
  if (score <= 30) return 'A1';
  if (score <= 40) return 'A2';
  if (score <= 50) return 'B1';
  if (score <= 60) return 'B2';
  if (score <= 70) return 'C1';
  return 'C2';
}

export const CEFR_DESC: Record<Cefr, string> = {
  A1: 'Principiante — frases básicas y situaciones cotidianas muy simples.',
  A2: 'Elemental — intercambios sencillos sobre temas conocidos.',
  B1: 'Intermedio — te desenvuelves en la mayoría de situaciones del día a día.',
  B2: 'Intermedio alto — fluidez y precisión en contextos variados, incluido el laboral.',
  C1: 'Avanzado — uso flexible y eficaz del idioma en contextos complejos.',
  C2: 'Maestría — comprensión y expresión prácticamente como un nativo.',
};

export const CEFR_COLOR: Record<Cefr, string> = {
  A1: '#dc2626', A2: '#ea580c', B1: '#b45309', B2: '#1E9E3A', C1: '#0f766e', C2: '#2563eb',
};
