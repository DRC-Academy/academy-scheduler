// Tipos compartidos por TODAS las variantes del formulario inicial.
// Cada variante (general, B1 Preliminary, …) es un array de FormQuestion.

export type QuestionType = 'short' | 'long' | 'radio' | 'checkbox' | 'matrix';

export interface FormQuestion {
  id: string;             // ÚNICO en todo el proyecto, no solo dentro de su formulario
  section: string;        // encabezado de sección (con emoji)
  title: string;
  hint?: string;
  type: QuestionType;
  options?: string[];     // radio / checkbox
  rows?: string[];        // matrix (una pregunta radio por fila)
  cols?: string[];        // matrix (opciones compartidas)
  required: boolean;
}

// Escala compartida de la matriz de autoevaluación por destreza. La usan todas
// las variantes y lib/studentViz para dibujar el gráfico de destrezas, así que
// los textos deben coincidir EXACTAMENTE con los `cols` de la matriz.
export const SKILL_LEVELS = ['Muy bajo', 'Básico', 'Intermedio', 'Bueno', 'Muy bueno'] as const;

export type FormResponses = Record<string, unknown>;
