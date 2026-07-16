// Generación de la "ficha inicial" del alumno a partir de las respuestas del
// formulario, usando Claude.
//
// Es BEST-EFFORT: si no hay ANTHROPIC_API_KEY configurada, o la llamada falla,
// devuelve un status distinto de 'ready' y el flujo del formulario sigue
// funcionando igual (las respuestas crudas quedan guardadas de todos modos).

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import type { FichaIA, AiStatus } from '@/lib/aiTypes';

export type { FichaIA } from '@/lib/aiTypes';

export interface FichaInput {
  studentName: string;
  teacherName: string;
  plan?: string | null;
  level?: string | null;
  responsesText: string;   // respuestas ya formateadas (formatResponsesForAI)
}

export type FichaStatus = AiStatus;
export type FichaResult = AiResult<FichaIA>;

export const FICHA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'initialDiagnosis', 'strongPoints', 'weakPoints', 'learningStyle',
    'personalObjective', 'occupation', 'recommendedFocus', 'firstClassSuggestion',
  ],
  properties: {
    initialDiagnosis:     { type: 'string', description: 'Párrafo de diagnóstico general del alumno.' },
    strongPoints:         { type: 'string', description: 'Qué hace bien el alumno.' },
    weakPoints:           { type: 'string', description: 'Qué le cuesta más.' },
    learningStyle:        { type: 'string', description: 'Cómo aprende mejor.' },
    personalObjective:    { type: 'string', description: 'Su objetivo real, en una frase.' },
    occupation:           { type: 'string', description: 'Su trabajo o contexto de vida.' },
    recommendedFocus:     { type: 'string', description: 'Qué priorizar en las primeras clases.' },
    firstClassSuggestion: { type: 'string', description: 'Idea concreta para la primera clase.' },
  },
} as const;

const SYSTEM_PROMPT = `Eres un asistente pedagógico de DRC Academy, una academia de inglés online que opera en España. Tu tarea es analizar las respuestas del formulario inicial de un alumno y generar una ficha de diagnóstico inicial en español de España.

METODOLOGÍA DRC:
- Enfoque comunicativo centrado en el alumno.
- El material se adapta al contexto real del alumno.
- Descubrimiento inductivo: el alumno descubre patrones, no se le explica la gramática de forma teórica.
- Las clases van de input a producción.
- Vocabulario siempre en contexto, nunca en listas.

Escribes para el profesor que va a dar la clase, no para el alumno: es una ficha de trabajo, concreta y accionable. No inventes datos que no estén en el formulario; si el alumno no respondió algo, dilo en lugar de suponerlo.`;

function buildUserPrompt(input: FichaInput): string {
  const meta = [
    `Alumno/a: ${input.studentName}`,
    input.level ? `Nivel: ${input.level}` : '',
    input.plan ? `Plan: ${input.plan}` : '',
    input.teacherName ? `Profesor/a: ${input.teacherName}` : '',
  ].filter(Boolean).join('\n');

  return `Analiza las siguientes respuestas del formulario inicial del alumno.

${meta}

Respuestas del formulario:

${input.responsesText}`;
}

export async function generateFicha(input: FichaInput): Promise<FichaResult> {
  return askClaudeJson<FichaIA>({
    label: 'analyze-form',
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    schema: FICHA_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 8000,
    effort: 'medium',   // el alumno espera este resultado al enviar el formulario
    timeoutMs: 90_000,
  });
}

// Re-exportamos el mapeo a columnas para que lo usen los endpoints que guardan.
export { fichaToColumns } from '@/lib/aiTypes';
