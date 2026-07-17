// Generación de una clase completa, lista para usar.
//
// Cubre los dos casos con el mismo flujo:
//   · Clase 1 → sin lastAnalysis ni historial (equivale a la "primera clase").
//   · Clase N → con el análisis de la clase anterior y el historial reciente.
//
// Y los dos MODOS del avatar:
//   · Metodología aplicada → fases input→práctica→producción (NextClassIA).
//   · Conversación guiada (B1+) → charla continua guiada (ConversacionGuiadaIA).

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import {
  resolveAvatar, buildAvatarBlock, METHODOLOGY_CORE, FORMAT_STANDARDS,
  COMMON_ERRORS, CONVERSACION_GUIADA_MECANICA, PROGRAM_PHASE,
} from '@/lib/drcMethodology';
import type {
  AvatarDomain, ClassType, FichaIA, GeneratedClassIA, NextClassIA,
  ConversacionGuiadaIA, TranscriptIA,
} from '@/lib/aiTypes';

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
  domain?: AvatarDomain | null;         // si no viene, se toma de la ficha o 'social'
  classType?: ClassType | null;         // tipo pedido; si no es viable, cae a metodología aplicada
}

export type NextClassResult = AiResult<GeneratedClassIA>;

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

// ── Schema modo metodología aplicada ──────────────────────────────────────────
export const NEXT_CLASS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'classType', 'classNumber', 'classTitle', 'duration', 'objectives',
    'warmUp', 'mainContent', 'practiceActivity', 'closing', 'challenge',
    'teacherNotes', 'connectionToPrevious',
  ],
  properties: {
    classType:        { type: 'string', enum: ['metodologia_aplicada'] },
    classNumber:      { type: 'integer' },
    classTitle:       { type: 'string', description: 'Título motivador con emoji.' },
    duration:         { type: 'string', description: 'p. ej. "60 minutos".' },
    objectives:       { type: 'array', items: { type: 'string' }, description: 'Objetivos de la clase.' },
    warmUp:           BLOCK_SCHEMA,
    mainContent:      BLOCK_SCHEMA,
    practiceActivity: BLOCK_SCHEMA,
    closing:          BLOCK_SCHEMA,
    challenge:        { type: 'string', description: 'Desafío para llevarse: UNA tarea real y concreta que el alumno hace ANTES de la próxima clase, en su vida/trabajo real, dirigida en segunda persona ("Esta semana, en tu próxima reunión, ..."). Aplica lo trabajado hoy en un uso auténtico — NO un ejercicio mecánico ni de relleno. Copy-paste ready para el alumno.' },
    teacherNotes:     { type: 'string', description: 'Máximo 3 notas breves para el profesor.' },
    connectionToPrevious: { type: 'string', description: 'Cómo conecta con la clase anterior. Si es la clase 1, explica el punto de partida.' },
  },
} as const;

// ── Schema modo conversación guiada ───────────────────────────────────────────
export const CONVERSACION_GUIADA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'classType', 'classNumber', 'classTitle', 'duration', 'skillObjective',
    'priorityAddressed', 'suggestedOpeners', 'guidingQuestions', 'correctionFocus',
    'challenge', 'teacherNotes', 'connectionToPrevious',
  ],
  properties: {
    classType:         { type: 'string', enum: ['conversacion_guiada'] },
    classNumber:       { type: 'integer' },
    classTitle:        { type: 'string', description: 'Título motivador con emoji.' },
    duration:          { type: 'string', description: 'p. ej. "60 minutos".' },
    skillObjective:    { type: 'string', description: 'La habilidad preparada de antemano que se sostiene pase lo que pase con el tópico (ej. "usar past simple para narrar experiencias sin trabarse").' },
    priorityAddressed: { type: 'string', description: 'Cuál de las prioridades del diagnóstico trabaja esta clase.' },
    suggestedOpeners:  { type: 'array', items: { type: 'string' }, description: 'Aperturas de tópico relevantes al alumno para arrancar. El tópico final lo elige el alumno.' },
    guidingQuestions:  { type: 'array', items: { type: 'string' }, description: 'Preguntas dirigidas para sostener y profundizar la charla mientras se trabaja la habilidad.' },
    correctionFocus:   { type: 'string', description: 'Qué errores/patrones corregir en vivo, sin cortar el flujo de la conversación.' },
    challenge:         { type: 'string', description: 'Desafío para llevarse: UNA tarea real de speaking/uso que el alumno hace ANTES de la próxima clase, en su vida/trabajo real, en segunda persona (ej. "Grabá un audio de 1 minuto contando... y traelo la próxima clase"). Aplica la habilidad trabajada en un uso auténtico, no un ejercicio mecánico.' },
    teacherNotes:      { type: 'string', description: 'Máximo 3 notas breves para el profesor.' },
    connectionToPrevious: { type: 'string', description: 'Cómo conecta con la clase anterior. Si es la clase 1, explica el punto de partida.' },
  },
} as const;

function buildSystemPrompt(classType: ClassType, avatarBlock: string): string {
  const common = `Eres un experto en didáctica del inglés general que opera en España y escribe en español de España.

${METHODOLOGY_CORE}

${avatarBlock}

${PROGRAM_PHASE}

${FORMAT_STANDARDS}

${COMMON_ERRORS}

Tenés acceso al análisis de la última clase, el historial del alumno y su perfil completo. Generá una clase personalizada que retome los puntos débiles de la clase anterior, progrese lógicamente en el programa según la fase, y use el contexto real del alumno.

Incluí SIEMPRE un "challenge" (desafío para llevarse): una única tarea real y concreta que el alumno hace entre esta clase y la próxima, aplicando lo trabajado hoy en su vida/trabajo real (Principio de tareas y proyectos reales). En segunda persona y accionable; nunca un ejercicio mecánico de relleno.`;

  if (classType === 'conversacion_guiada') {
    return `${common}

${CONVERSACION_GUIADA_MECANICA}

Para esta clase de conversación guiada: elegí el objetivo de habilidad de la lista de PRIORIDADES del diagnóstico del alumno (empezá por lo más importante que aún no esté resuelto). No generes fases de input/práctica/producción: entregá la habilidad preparada, aperturas de tópico, preguntas dirigidas y el foco de corrección. teacherNotes y connectionToPrevious son lo único dirigido al profesor.`;
  }

  return `${common}

El contenido de cada bloque lo lee el alumno durante la clase: escribilo listo para copiar y pegar, respetando el balance de secuencia del nivel indicado arriba. Lo único dirigido al profesor son teacherNotes y connectionToPrevious.`;
}

function buildUserPrompt(input: NextClassInput, classType: ClassType): string {
  const last = input.lastAnalysis
    ? `\n\nANÁLISIS DE LA ÚLTIMA CLASE:\n${JSON.stringify(input.lastAnalysis, null, 2)}`
    : '\n\nANÁLISIS DE LA ÚLTIMA CLASE: (no hay: esta es la primera clase del alumno)';
  const history = input.classHistory?.length
    ? `\n\nHISTORIAL RECIENTE:\n${JSON.stringify(input.classHistory, null, 2)}`
    : '';
  const cierre = classType === 'conversacion_guiada'
    ? `Devolvé classType = "conversacion_guiada" y classNumber = ${input.classNumber}.`
    : `Asegurate de abordar los errores detectados en la última clase y continuar la progresión del programa. Devolvé classType = "metodologia_aplicada" y classNumber = ${input.classNumber}.`;

  return `Generá la clase ${input.classNumber} para ${input.studentName}${input.level ? `, nivel ${input.level}` : ''}${input.plan ? `, plan ${input.plan}` : ''}.

PERFIL DEL ALUMNO (incluye la lista de prioridades del diagnóstico):
${JSON.stringify(input.studentProfile, null, 2)}${last}${history}

${cierre}`;
}

export async function generateNextClass(input: NextClassInput): Promise<NextClassResult> {
  // Dominio: el pedido, si no el de la ficha, si no 'social'.
  const fichaDomain = (input.studentProfile as Partial<FichaIA>)?.domain ?? null;
  const avatar = resolveAvatar({
    level: input.level,
    domain: input.domain ?? fichaDomain,
    requestedClassType: input.classType,
  });

  const isConversacion = avatar.classType === 'conversacion_guiada';
  const schema = isConversacion ? CONVERSACION_GUIADA_SCHEMA : NEXT_CLASS_SCHEMA;

  return askClaudeJson<GeneratedClassIA>({
    label: isConversacion ? 'generate-next-class:conversacion' : 'generate-next-class',
    system: buildSystemPrompt(avatar.classType, buildAvatarBlock(avatar)),
    prompt: buildUserPrompt(input, avatar.classType),
    schema: schema as unknown as Record<string, unknown>,
    maxTokens: 16000,
    effort: 'high',
    timeoutMs: 180_000,
  });
}

// Re-exports de tipos por si algún consumidor los necesita del mismo módulo.
export type { GeneratedClassIA, ConversacionGuiadaIA };
