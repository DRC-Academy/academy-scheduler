// Generación de la "ficha inicial" del alumno a partir de las respuestas del
// formulario, usando Claude.
//
// Es BEST-EFFORT: si no hay ANTHROPIC_API_KEY configurada, o la llamada falla,
// devuelve un status distinto de 'ready' y el flujo del formulario sigue
// funcionando igual (las respuestas crudas quedan guardadas de todos modos).

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import { METHODOLOGY_CORE } from '@/lib/drcMethodology';
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
    'domain', 'priorities',
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
    domain: {
      type: 'string',
      enum: ['social', 'laboral', 'educacional'],
      description: 'Dominio del alumno según su contexto: "laboral" si aprende sobre todo para el trabajo; "educacional" SOLO si es menor de edad en contexto escolar; "social" en cualquier otro caso (inglés general para la vida). Ante la duda, "social".',
    },
    priorities: {
      type: 'array',
      items: { type: 'string' },
      description: 'Lista de puntos a trabajar con el alumno, ORDENADOS de más a menos importante. Cada uno es una habilidad o foco concreto (ej. "fluidez al hablar de su trabajo", "past simple vs present perfect"). Es la base para elegir el objetivo de cada clase, sobre todo en conversación guiada.',
    },
  },
} as const;

const SYSTEM_PROMPT = `Eres un asistente pedagógico de una academia de inglés general online que opera en España. Tu tarea es analizar las respuestas del formulario inicial de un alumno y generar una ficha de diagnóstico inicial en español de España.

${METHODOLOGY_CORE}

Además de la ficha descriptiva, tenés que:
- Clasificar el DOMINIO del alumno (social / laboral / educacional) según su contexto real.
- Armar la lista de PRIORIDADES: los puntos a trabajar, ordenados de más a menos importante. Esta lista es la que el profesor consulta clase a clase (sobre todo en conversación guiada) para elegir el objetivo del día.

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
    // Por debajo del maxDuration (60 s) de las rutas que lo llaman: si no, la
    // plataforma corta la función antes y el error llega sin cuerpo JSON.
    timeoutMs: 45_000,
  });
}

// Re-exportamos el mapeo a columnas para que lo usen los endpoints que guardan.
export { fichaToColumns } from '@/lib/aiTypes';
