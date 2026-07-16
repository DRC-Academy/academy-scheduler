// Generación de una clase completa, lista para usar.
//
// Cubre los dos casos con el mismo prompt:
//   · Clase 1 → sin lastAnalysis ni historial (equivale a la "primera clase").
//   · Clase N → con el análisis de la clase anterior y el historial reciente.

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import type { FichaIA, NextClassIA, TranscriptIA } from '@/lib/aiTypes';

export type { NextClassIA, ClassBlock } from '@/lib/aiTypes';

export interface NextClassInput {
  studentName: string;
  teacherName: string;
  plan?: string | null;
  level?: string | null;
  classNumber: number;
  studentProfile: FichaIA | Record<string, unknown>;
  lastAnalysis?: TranscriptIA | Record<string, unknown> | null;
  classHistory?: unknown[] | null;
}

export type NextClassResult = AiResult<NextClassIA>;

const BLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'duration', 'content'],
  properties: {
    title:    { type: 'string' },
    duration: { type: 'string' },
    content:  { type: 'string', description: 'Actividad completa, lista para usar sin modificaciones.' },
  },
} as const;

export const NEXT_CLASS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'classNumber', 'classTitle', 'duration', 'objectives',
    'warmUp', 'mainContent', 'practiceActivity', 'closing',
    'teacherNotes', 'connectionToPrevious',
  ],
  properties: {
    classNumber:      { type: 'integer' },
    classTitle:       { type: 'string', description: 'Título motivador con emoji.' },
    duration:         { type: 'string', description: 'p. ej. "60 minutos".' },
    objectives:       { type: 'array', items: { type: 'string' }, description: 'Objetivos de la clase.' },
    warmUp:           BLOCK_SCHEMA,
    mainContent:      BLOCK_SCHEMA,
    practiceActivity: BLOCK_SCHEMA,
    closing:          BLOCK_SCHEMA,
    teacherNotes:     { type: 'string', description: 'Máximo 3 notas breves para el profesor.' },
    connectionToPrevious: { type: 'string', description: 'Cómo conecta con la clase anterior. Si es la clase 1, explica el punto de partida.' },
  },
} as const;

const SYSTEM_PROMPT = `Eres un experto en didáctica del inglés que aplica la metodología DRC Academy. Operas en España y escribes en español de España.

METODOLOGÍA DRC:
- Descubrimiento inductivo: muestras ejemplos en contexto y el alumno descubre el patrón.
- Centrado en el alumno y su contexto real (trabajo, objetivos).
- Input → producción: primero comprensión, luego speaking/writing.
- Copywriting educativo: títulos con emojis, instrucciones en segunda persona directa, sin notas internas ni respuestas incluidas.

ERRORES A EVITAR:
- Listas de vocabulario sueltas (siempre en contexto).
- Respuestas dentro del material.
- Hablar del alumno en tercera persona.
- Warm-ups genéricos o infantiles.
- Explicaciones gramaticales extensas antes de los ejemplos.

CONTEXTO:
Tienes acceso al análisis de la última clase, el historial del alumno y su perfil completo.
Tu objetivo es generar una clase completamente personalizada que:
1. Retome los puntos débiles de la clase anterior.
2. Progrese lógicamente en el programa.
3. Use el contexto real del alumno.
4. Esté lista para usar sin modificaciones.

El contenido de cada bloque lo lee el alumno durante la clase: escríbelo listo para copiar y pegar. Lo único dirigido al profesor son teacherNotes y connectionToPrevious.`;

function buildUserPrompt(input: NextClassInput): string {
  const last = input.lastAnalysis
    ? `\n\nANÁLISIS DE LA ÚLTIMA CLASE:\n${JSON.stringify(input.lastAnalysis, null, 2)}`
    : '\n\nANÁLISIS DE LA ÚLTIMA CLASE: (no hay: esta es la primera clase del alumno)';
  const history = input.classHistory?.length
    ? `\n\nHISTORIAL RECIENTE:\n${JSON.stringify(input.classHistory, null, 2)}`
    : '';

  return `Genera la clase ${input.classNumber} para ${input.studentName}${input.level ? `, nivel ${input.level}` : ''}${input.plan ? `, plan ${input.plan}` : ''}.

PERFIL DEL ALUMNO:
${JSON.stringify(input.studentProfile, null, 2)}${last}${history}

Asegúrate de abordar los errores detectados en la última clase y continuar la progresión del programa. Devuelve classNumber = ${input.classNumber}.`;
}

export async function generateNextClass(input: NextClassInput): Promise<NextClassResult> {
  return askClaudeJson<NextClassIA>({
    label: 'generate-next-class',
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    schema: NEXT_CLASS_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 16000,
    effort: 'high',
    timeoutMs: 180_000,
  });
}
