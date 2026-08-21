// Generación de una clase completa, lista para usar.
//
// Cubre los dos casos con el mismo flujo:
//   · Clase 1 → sin lastAnalysis ni historial (equivale a la "primera clase").
//   · Clase N → con el análisis de la clase anterior y el historial reciente.
//
// Y los dos ORÍGENES del perfil:
//   · Con ficha → la ficha del alumno manda (diagnóstico + prioridades).
//   · Sin ficha (clase genérica) → el profesor elige nivel/dominio/tipo y, si
//     quiere, tema y contexto. La IA personaliza por AVATAR, no por biografía.
//
// Y los dos MODOS del avatar:
//   · Metodología aplicada → fases input→práctica→producción (NextClassIA).
//   · Conversación guiada (B1+) → charla continua guiada (ConversacionGuiadaIA).

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import {
  resolveAvatar, buildAvatarBlock, METHODOLOGY_CORE, FORMAT_STANDARDS,
  COMMON_ERRORS, CONVERSACION_GUIADA_MECANICA, PROGRAM_PHASE,
  type ResolvedAvatar,
} from '@/lib/drcMethodology';
import type {
  AvatarDomain, CEFRLevel, ClassType, FichaIA, GeneratedClassIA, GenericClassBrief,
  NextClassIA, ConversacionGuiadaIA, TranscriptIA,
} from '@/lib/aiTypes';

export type { NextClassIA, ClassBlock } from '@/lib/aiTypes';

export interface NextClassInput {
  studentName: string;
  teacherName: string;
  plan?: string | null;
  level?: string | null;
  classNumber: number;
  /** La ficha del alumno. Sin ella hay que mandar `generic` (clase genérica). */
  studentProfile?: FichaIA | Record<string, unknown> | null;
  /** Modo genérico: se activa por su PRESENCIA, aunque venga vacío. */
  generic?: GenericClassBrief | null;
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
    title:    { type: 'string', description: 'Título del bloque, en inglés.' },
    duration: { type: 'string' },
    content:  { type: 'string', description: 'Actividad completa EN INGLÉS, lista para usar sin modificaciones. La lee el alumno.' },
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
    classTitle:       { type: 'string', description: 'Título motivador con emoji, EN INGLÉS.' },
    duration:         { type: 'string', description: 'p. ej. "60 minutos".' },
    objectives:       { type: 'array', items: { type: 'string' }, description: 'Objetivos de la clase EN INGLÉS, redactados como metas del alumno en segunda persona (ej. "By the end of this class, you will be able to...").' },
    warmUp:           BLOCK_SCHEMA,
    mainContent:      BLOCK_SCHEMA,
    practiceActivity: BLOCK_SCHEMA,
    closing:          BLOCK_SCHEMA,
    challenge:        { type: 'string', description: 'Desafío para llevarse, EN INGLÉS: UNA tarea real y concreta que el alumno hace ANTES de la próxima clase, en su vida/trabajo real, dirigida en segunda persona ("This week, in your next meeting, ..."). Aplica lo trabajado hoy en un uso auténtico, NO un ejercicio mecánico ni de relleno. Copy-paste ready para el alumno.' },
    teacherNotes:     { type: 'string', description: 'Máximo 3 notas breves para el profesor, EN ESPAÑOL.' },
    connectionToPrevious: { type: 'string', description: 'EN ESPAÑOL, para el profesor: cómo conecta con la clase anterior. Si es la clase 1, explica el punto de partida.' },
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
    classTitle:        { type: 'string', description: 'Título motivador con emoji, EN INGLÉS.' },
    duration:          { type: 'string', description: 'p. ej. "60 minutos".' },
    skillObjective:    { type: 'string', description: 'EN ESPAÑOL, para el profesor: la habilidad preparada de antemano que se sostiene pase lo que pase con el tópico (ej. "usar past simple para narrar experiencias sin trabarse").' },
    priorityAddressed: { type: 'string', description: 'EN ESPAÑOL, para el profesor: cuál de las prioridades del diagnóstico trabaja esta clase.' },
    suggestedOpeners:  { type: 'array', items: { type: 'string' }, description: 'EN INGLÉS: aperturas de tópico relevantes al alumno, tal cual las dice el profesor en voz alta. El tópico final lo elige el alumno.' },
    guidingQuestions:  { type: 'array', items: { type: 'string' }, description: 'EN INGLÉS: preguntas dirigidas, tal cual se le formulan al alumno, para sostener y profundizar la charla mientras se trabaja la habilidad.' },
    correctionFocus:   { type: 'string', description: 'EN ESPAÑOL, para el profesor: qué errores/patrones corregir en vivo, sin cortar el flujo de la conversación.' },
    challenge:         { type: 'string', description: 'Desafío para llevarse, EN INGLÉS: UNA tarea real de speaking/uso que el alumno hace ANTES de la próxima clase, en su vida/trabajo real, en segunda persona (ej. "Record a 1-minute audio telling... and bring it to our next class"). Aplica la habilidad trabajada en un uso auténtico, no un ejercicio mecánico.' },
    teacherNotes:      { type: 'string', description: 'Máximo 3 notas breves para el profesor, EN ESPAÑOL.' },
    connectionToPrevious: { type: 'string', description: 'EN ESPAÑOL, para el profesor: cómo conecta con la clase anterior. Si es la clase 1, explica el punto de partida.' },
  },
} as const;

// Regla de idioma. Va PRIMERA en el system prompt: todo el material que el alumno
// lee o escucha va en inglés; lo único en español son las notas del profesor.
function buildLanguageRule(level: CEFRLevel, classType: ClassType): string {
  const studentFields = classType === 'conversacion_guiada'
    ? `- classTitle
- suggestedOpeners (todo lo que el profesor le dice al alumno)
- guidingQuestions
- challenge`
    : `- classTitle
- objectives (redactados como metas del alumno)
- warmUp.content (consignas y actividades)
- mainContent.content (todos los ejercicios, textos y ejemplos)
- practiceActivity.content
- closing.content
- challenge`;

  const teacherFields = classType === 'conversacion_guiada'
    ? `- skillObjective
- priorityAddressed
- correctionFocus
- teacherNotes
- connectionToPrevious`
    : `- teacherNotes
- connectionToPrevious`;

  return `REGLA DE IDIOMA, CRÍTICA, POR ENCIMA DE CUALQUIER OTRA INSTRUCCIÓN:

Todo el contenido que el alumno ve, lee o escucha va EN INGLÉS, sin excepción:
${studentFields}

El nivel del alumno es ${level}: calibrá la complejidad del inglés a ese nivel (vocabulario, longitud de frase, tiempos verbales). Las consignas tienen que entenderse sin ayuda.

Los ÚNICOS campos en español son los dirigidos al profesor:
${teacherFields}

Las consignas se dirigen al alumno en SEGUNDA persona ("you"), nunca en tercera.
Correcto: "Read the following text and underline every verb in the past."
Incorrecto: "The student should read the text..." / "El alumno deberá leer..."

Esta regla no admite mezcla: nada de consignas en español con ejemplos en inglés.`;
}

function buildSystemPrompt(
  classType: ClassType, avatarBlock: string, level: CEFRLevel, generic: boolean,
): string {
  // Sin ficha no hay "perfil completo" ni "contexto real" que usar: prometérselo
  // al modelo es justo lo que lo empuja a inventarse uno.
  const fuentes = generic
    ? `Para esta clase NO hay ficha del alumno: el profesor te da nivel, dominio y, como mucho, un tema y algo de contexto. Generá una clase sólida y bien calibrada a ese avatar, sin atribuirle al alumno ningún dato que no te hayan dado. Si hay análisis de clases anteriores, ESO sí es información real: usalo como fuente principal.`
    : `Tenés acceso al análisis de la última clase, el historial del alumno y su perfil completo. Generá una clase personalizada que retome los puntos débiles de la clase anterior, progrese lógicamente en el programa según la fase, y use el contexto real del alumno.`;

  const common = `Eres un experto en didáctica del inglés general que opera en España. Redactás el MATERIAL DE CLASE en inglés y las notas para el profesor en español de España.

${buildLanguageRule(level, classType)}

${METHODOLOGY_CORE}

${avatarBlock}

${PROGRAM_PHASE}

${FORMAT_STANDARDS}

${COMMON_ERRORS}

${fuentes}

Incluí SIEMPRE un "challenge" (desafío para llevarse): una única tarea real y concreta que el alumno hace entre esta clase y la próxima, aplicando lo trabajado hoy en su vida/trabajo real (Principio de tareas y proyectos reales). En segunda persona y accionable; nunca un ejercicio mecánico de relleno.`;

  if (classType === 'conversacion_guiada') {
    return `${common}

${CONVERSACION_GUIADA_MECANICA}

Para esta clase de conversación guiada: elegí el objetivo de habilidad ${generic
  ? 'a partir del tema pedido por el profesor y de lo que sea típicamente más urgente en este nivel y dominio (no hay lista de prioridades: no la inventes como si existiera, y en priorityAddressed decí que no hay diagnóstico y por qué elegiste esa habilidad)'
  : 'de la lista de PRIORIDADES del diagnóstico del alumno (empezá por lo más importante que aún no esté resuelto)'}. No generes fases de input/práctica/producción: entregá la habilidad preparada, aperturas de tópico, preguntas dirigidas y el foco de corrección. suggestedOpeners y guidingQuestions son frases que el profesor le dice al alumno: van en inglés, listas para leer en voz alta.`;
  }

  return `${common}

El contenido de cada bloque lo lee el alumno durante la clase: escribilo EN INGLÉS y listo para copiar y pegar, respetando el balance de secuencia del nivel indicado arriba.`;
}

const DOMAIN_NAME: Record<AvatarDomain, string> = {
  social: 'Social', laboral: 'Laboral', educacional: 'Educacional (menores)',
};

/**
 * Bloque de perfil cuando NO hay ficha.
 *
 * Lo que evita este texto: que la IA rellene el hueco con una biografía
 * inventada. Sin ficha, "personalizar" sólo puede significar calibrar por nivel y
 * dominio; cualquier dato del alumno que no esté acá abajo es una invención que
 * el profesor tendría que desmentir en voz alta delante del alumno.
 */
function buildGenericBlock(brief: GenericClassBrief, avatar: ResolvedAvatar): string {
  const focus = brief.focus?.trim();
  const context = brief.context?.trim();

  return `NO HAY FICHA DE ESTE ALUMNO: es una CLASE GENÉRICA. No dispones de diagnóstico, ni de prioridades, ni de historial verificado.

LO ÚNICO QUE SABES:
- Nivel: ${avatar.level}
- Dominio: ${DOMAIN_NAME[avatar.domain]}
- Tema o foco pedido por el profesor: ${focus || '(ninguno: elegí vos uno adecuado al nivel y a la fase del programa)'}
- Contexto que aporta el profesor: ${context || '(no aportó ninguno)'}

REGLAS DE LA CLASE GENÉRICA (obligatorias):
- NO inventes datos del alumno: nada de profesión, empresa, ciudad, familia, aficiones ni objetivos concretos que no estén escritos arriba. Si no lo sabes, no existe.
- Personalizá por NIVEL y DOMINIO, no por biografía: las situaciones tienen que servirle a cualquier alumno de ese perfil.
- Cuando una actividad necesite un dato personal, pedíselo al alumno DENTRO de la consigna ("Think about your own job and...") en vez de darlo por supuesto.
- Sigue estando prohibido el warm-up genérico o infantil: preguntas adultas y relevantes, aunque no conozcas al alumno.
- En connectionToPrevious explicá que es una clase genérica y desde qué punto de partida arranca.`;
}

function buildUserPrompt(input: NextClassInput, avatar: ResolvedAvatar): string {
  const classType = avatar.classType;
  const last = input.lastAnalysis
    ? `\n\nANÁLISIS DE LA ÚLTIMA CLASE:\n${JSON.stringify(input.lastAnalysis, null, 2)}`
    : '\n\nANÁLISIS DE LA ÚLTIMA CLASE: (no hay: esta es la primera clase del alumno)';
  const history = input.classHistory?.length
    ? `\n\nHISTORIAL RECIENTE:\n${JSON.stringify(input.classHistory, null, 2)}`
    : '';
  const idioma = `RECORDATORIO DE IDIOMA: todo el contenido dirigido al alumno va en inglés, calibrado a su nivel${input.level ? ` (${input.level})` : ''}. Solo las notas del profesor van en español.`;

  const cierre = classType === 'conversacion_guiada'
    ? `${idioma}\n\nDevolvé classType = "conversacion_guiada" y classNumber = ${input.classNumber}.`
    : `${idioma}\n\nAsegurate de abordar los errores detectados en la última clase y continuar la progresión del programa. Devolvé classType = "metodologia_aplicada" y classNumber = ${input.classNumber}.`;

  const perfil = input.generic
    ? buildGenericBlock(input.generic, avatar)
    : `PERFIL DEL ALUMNO (incluye la lista de prioridades del diagnóstico):\n${JSON.stringify(input.studentProfile, null, 2)}`;

  return `Generá la clase ${input.classNumber} para ${input.studentName}${input.level ? `, nivel ${input.level}` : ''}${input.plan ? `, plan ${input.plan}` : ''}.

${perfil}${last}${history}

${cierre}`;
}

export async function generateNextClass(input: NextClassInput): Promise<NextClassResult> {
  // Dominio: el pedido, si no el de la ficha, si no 'social'. En modo genérico no
  // hay ficha, así que el dominio lo eligió el profesor y llega en `domain`.
  const fichaDomain = (input.studentProfile as Partial<FichaIA> | null | undefined)?.domain ?? null;
  const avatar = resolveAvatar({
    level: input.level,
    domain: input.domain ?? fichaDomain,
    requestedClassType: input.classType,
  });

  const isConversacion = avatar.classType === 'conversacion_guiada';
  const isGeneric = !!input.generic;
  const schema = isConversacion ? CONVERSACION_GUIADA_SCHEMA : NEXT_CLASS_SCHEMA;
  const label = `generate-next-class${isConversacion ? ':conversacion' : ''}${isGeneric ? ':generica' : ''}`;

  return askClaudeJson<GeneratedClassIA>({
    label,
    system: buildSystemPrompt(avatar.classType, buildAvatarBlock(avatar), avatar.level, isGeneric),
    prompt: buildUserPrompt(input, avatar),
    schema: schema as unknown as Record<string, unknown>,
    maxTokens: 16000,
    effort: 'high',
    // Por debajo del maxDuration (60 s) de /api/ai/generate-next-class. Con 180 s
    // la plataforma mataba la función antes de que venciera el timeout del SDK y
    // el profesor recibía un fallo sin explicación.
    timeoutMs: 50_000,
  });
}

// Re-exports de tipos por si algún consumidor los necesita del mismo módulo.
export type { GeneratedClassIA, ConversacionGuiadaIA };
