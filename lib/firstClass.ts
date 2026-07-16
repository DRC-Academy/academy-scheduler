// Generación de la primera clase completa a partir de la ficha del alumno.
// Best-effort, igual que el resto del módulo de IA.

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import type { FichaIA, FirstClassIA } from '@/lib/aiTypes';

export type { FirstClassIA } from '@/lib/aiTypes';

export interface FirstClassInput {
  studentName: string;
  teacherName: string;
  plan?: string | null;
  level?: string | null;
  studentProfile: FichaIA | Record<string, unknown>;
}

export type FirstClassResult = AiResult<FirstClassIA>;

export const FIRST_CLASS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['classTitle', 'duration', 'warmUp', 'mainContent', 'practiceActivity', 'closingTask', 'teacherNotes'],
  properties: {
    classTitle:       { type: 'string', description: 'Título motivador con emoji.' },
    duration:         { type: 'string', description: 'Duración de la clase, p. ej. "60 minutos".' },
    warmUp:           { type: 'string', description: 'Actividad inicial personalizada (5-10 min).' },
    mainContent:      { type: 'string', description: 'Contenido principal de la clase.' },
    practiceActivity: { type: 'string', description: 'Actividad de práctica.' },
    closingTask:      { type: 'string', description: 'Cierre o tarea opcional.' },
    teacherNotes:     { type: 'string', description: 'Máximo 3 notas breves para el profesor.' },
  },
} as const;

const SYSTEM_PROMPT = `Eres un experto en didáctica del inglés que aplica la metodología DRC Academy. Operas en España y escribes en español de España.

PRINCIPIOS OPERATIVOS DRC:
1. Descubrimiento inductivo: muestras ejemplos en contexto y el alumno descubre el patrón. Sin explicaciones metalingüísticas extensas.
2. Centrado en el alumno: todos los ejercicios parten del contexto real del alumno (trabajo, objetivos).
3. Input a producción: primero comprensión, luego producción (speaking/writing).
4. Copywriting educativo: títulos motivadores con emojis, instrucciones en segunda persona directa, sin notas internas, sin respuestas incluidas.

ERRORES A EVITAR:
- Listas de vocabulario sueltas (el vocabulario siempre va en contexto).
- Respuestas dentro del material.
- Hablar del alumno en tercera persona.
- Warm-ups genéricos o infantiles.
- Explicaciones gramaticales extensas antes de los ejemplos.

El material lo lee el alumno durante la clase, salvo teacherNotes, que es lo único dirigido al profesor.`;

function buildUserPrompt(input: FirstClassInput): string {
  return `Genera la primera clase completa para el alumno ${input.studentName}${input.level ? `, nivel ${input.level}` : ''}${input.plan ? `, plan ${input.plan}` : ''}${input.teacherName ? `, con el profesor/a ${input.teacherName}` : ''}.

Ficha del alumno:
${JSON.stringify(input.studentProfile, null, 2)}

La clase debe estar completamente personalizada a este alumno concreto: usa su trabajo, su objetivo y su contexto real en los ejemplos y las actividades.`;
}

export async function generateFirstClass(input: FirstClassInput): Promise<FirstClassResult> {
  return askClaudeJson<FirstClassIA>({
    label: 'generate-first-class',
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    schema: FIRST_CLASS_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 16000,
    effort: 'high',
    timeoutMs: 180_000,
  });
}
