// Análisis pedagógico de la transcripción de una clase (p. ej. exportada de
// Fathom). Devuelve el informe, la puntuación de progreso y la señal de riesgo.

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import type { TranscriptIA } from '@/lib/aiTypes';
import type { ActiveIntervention } from '@/lib/interventions';

export type { TranscriptIA, NextClassGuide, RiskSignal } from '@/lib/aiTypes';

export interface TranscriptInput {
  transcript: string;
  studentName: string;
  teacherName: string;
  plan?: string | null;
  level?: string | null;
  classNumber?: number | null;
  classDate?: string | null;
  studentProfile?: Record<string, unknown> | null;
  classHistory?: unknown[] | null;
  /**
   * Intervención que quedó ABIERTA tras la clase anterior. Si viene, se le pide
   * a la IA una evaluación extra (interventionCheck): ¿hay señales de que el
   * profesor actuó? Ver Bloque 2 en supabase-interventions.sql.
   */
  activeIntervention?: ActiveIntervention | null;
}

export type TranscriptResult = AiResult<TranscriptIA>;

const INTERVENTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'steps', 'reconnectHook', 'escalateToSupport', 'channel'],
  properties: {
    action:            { type: 'string',  description: 'Acción concreta que el PROFESOR ejecuta, una sola, en español de España. Nunca "escala el caso a soporte" ni una advertencia de lo que no debe hacer: eso no le sirve durante la clase. Vacío si riskSignal es verde.' },
    // El tope (4) va en la DESCRIPCIÓN, no en el esquema: los structured outputs
    // de la API rechazan minItems/maxItems en los arrays y la petición falla con
    // 400 antes de procesarse. Ver el comentario de sanitizeSchemaForApi en
    // lib/anthropic.ts. El modelo respeta el rango si se lo pides en prosa.
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Array de 2 a 4 elementos, nunca más de 4 (vacío solo si riskSignal es verde). QUÉ HACE EL PROFESOR DURANTE ESTA CLASE, en 2 a 4 pasos ordenados, cada uno una frase corta que empieza por un verbo de acción. Se le muestran numerados justo antes de entrar. PROHIBIDO: pasos que solo digan lo que no hay que hacer ("no intentes retenerlo"), que deleguen en otro equipo ("deja que soporte lo gestione") o que sean una actitud sin conducta ("mantén un tono cercano"). Obligatorio también cuando escalateToSupport es true: ahí son de contención y acompañamiento. Array vacío solo si riskSignal es verde.',
    },
    reconnectHook:     { type: 'string',  description: 'Si el alumno está a 1 o 2 clases de un hito (15 o 30), cómo usar la evaluación de hito como excusa natural para reconectar. Vacío si no aplica.' },
    escalateToSupport: { type: 'boolean', description: 'true solo si el alumno dijo explícitamente que piensa cancelar o dejar las clases.' },
    channel:           { type: 'string',  enum: ['en_clase', 'mensaje_previo', 'escalar_soporte'] },
  },
} as const;

/**
 * Cada cosa detectada, con su acción al lado. Tope de 3 a propósito: es lo que
 * cabe en pantalla, y cada elemento extra alarga el análisis, que corre contra
 * un timeout ajustado (ver analyzeTranscript, más abajo).
 *
 * El tope vive en la DESCRIPCIÓN, no en maxItems: la API rechaza ese parámetro
 * en las respuestas estructuradas (ver sanitizeSchemaForApi en lib/anthropic.ts).
 */
const DETECTIONS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['finding', 'action'],
    properties: {
      finding: { type: 'string', description: 'Qué observaste, en una frase concreta y verificable en el transcript. Ej: "recurre al español cada vez que no encuentra una palabra".' },
      action:  { type: 'string', description: 'Qué hacer al respecto en la próxima clase, en una frase ejecutable. Ej: "haz los primeros cinco minutos solo en inglés, con apoyo visual". Nunca un consejo genérico.' },
    },
  },
  description: 'Array de 1 a 3 elementos, nunca más de 3: detecciones con su acción emparejada. Se rellena SIEMPRE, también cuando riskSignal es verde: son hallazgos pedagógicos, no señales de baja.',
} as const;

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['signsOfIntervention', 'evidence', 'confidence', 'stillOpenReason', 'cause'],
  properties: {
    signsOfIntervention: { type: 'boolean', description: '¿Hay señales de que el profesor actuó sobre la alerta anterior?' },
    evidence:            { type: 'string',  description: 'Qué señales de intervención se observaron o su ausencia. Breve, en español.' },
    confidence:          { type: 'string',  enum: ['alta', 'media', 'baja'] },
    stillOpenReason:     { type: 'string',  description: 'Por qué la alerta sigue abierta HOY, según ESTA clase, en una o dos frases. Es el motivo actualizado, no el de la clase que la abrió: si la situación cambió, dilo. Si no puedes determinar la causa, dilo explícitamente en vez de suponerla. Vacío solo si la alerta debería cerrarse.' },
    cause:               { type: 'string',  enum: ['externa_temporal', 'desmotivacion', 'dificultad_academica', 'sin_determinar', 'no_aplica'], description: 'Causa VIGENTE del riesgo según esta clase.' },
  },
} as const;

export const TRANSCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'classTitle', 'classSummary', 'errorsDetected', 'progressNotes', 'topicsCovered',
    'progressScore', 'riskSignal', 'riskExplanation', 'riskCause', 'detections',
    'nextClassGuide', 'interventionSuggestion',
  ],
  properties: {
    interventionSuggestion: INTERVENTION_SCHEMA,
    detections: DETECTIONS_SCHEMA,
    classTitle:      { type: 'string', description: 'Título breve y descriptivo de lo que se trabajó, p. ej. "Present Perfect en contexto laboral".' },
    classSummary:    { type: 'string', description: 'Qué se trabajó y cómo fue.' },
    errorsDetected:  { type: 'string', description: 'Errores específicos y patrones.' },
    progressNotes:   { type: 'string', description: 'Mejoras respecto a clases anteriores.' },
    topicsCovered:   { type: 'string', description: 'Gramática, vocabulario y habilidades.' },
    progressScore:   { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], description: 'Progreso general del alumno, de 1 (estancado) a 10 (excelente).' },
    riskSignal:      { type: 'string', enum: ['verde', 'amarillo', 'rojo'] },
    riskExplanation: { type: 'string', description: 'El RAZONAMIENTO, no una etiqueta: qué señales concretas viste (con la frase del alumno o el dato que las respalda) y por qué llevan a ese nivel. Entre 2 y 4 frases, máximo unas 60 palabras. Si el nivel es verde, di brevemente qué sostiene esa lectura.' },
    riskCause:       { type: 'string', enum: ['externa_temporal', 'desmotivacion', 'dificultad_academica', 'sin_determinar', 'no_aplica'], description: 'Causa del riesgo. "sin_determinar" cuando no hay información suficiente: es una respuesta válida y preferible a suponerla. "no_aplica" solo si riskSignal es verde.' },
    nextClassGuide: {
      type: 'object',
      additionalProperties: false,
      required: ['priority', 'warmUp', 'mainFocus', 'activity', 'notes'],
      properties: {
        priority:  { type: 'string', description: 'Qué priorizar en la siguiente clase.' },
        warmUp:    { type: 'string', description: 'Sugerencia de warm-up.' },
        mainFocus: { type: 'string', description: 'Tema o estructura a trabajar.' },
        activity:  { type: 'string', description: 'Actividad sugerida.' },
        notes:     { type: 'string', description: 'Notas específicas para el profesor.' },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `Eres el sistema de análisis pedagógico de DRC Academy. Analizas transcripciones de clases de inglés y generas informes en español de España.

SEÑAL DE RIESGO DE BAJA:
- verde: el alumno progresa y está comprometido.
- amarillo: señales de desmotivación, errores recurrentes sin mejora, o dificultades externas. Requiere atención del profesor.
- rojo: el alumno expresó dudas sobre continuar, frustración severa, o patrones de abandono. Requiere intervención del admin.

PUNTUACIÓN DE PROGRESO (progressScore, 1-10):
- 1-3: estancado o retrocediendo.
- 4-6: avance normal, dentro de lo esperado.
- 7-10: progreso claro y por encima de lo esperado.
Si hay clases anteriores, puntúa la evolución respecto a ellas, no el nivel absoluto del alumno.

Basa el informe únicamente en lo que ocurre en la transcripción. La señal de riesgo es una valoración con consecuencias reales: no la infles por una clase floja aislada ni la rebajes si el alumno expresa que se plantea dejarlo.

POR QUÉ ESE RIESGO (riskExplanation):
Es el RAZONAMIENTO que lee una persona para decidir qué hacer, no una etiqueta. Di qué señales concretas viste y por qué llevan a ese nivel: cítalas. Sirven las frases textuales del alumno, la caída de su participación respecto a clases anteriores, las cancelaciones y en qué plazo, los días sin clase y las clases previas en amarillo o rojo. Mal: "el alumno muestra desmotivación". Bien: "dijo dos veces que no ve para qué le sirve el inglés y participó bastante menos que en las tres clases anteriores". Entre 2 y 4 frases.

CAUSA DEL RIESGO (riskCause):
El color dice cuánto preocupa; la causa dice qué hacer, y dos amarillos con causas distintas piden intervenciones opuestas.
- externa_temporal: el alumno explicó un motivo puntual (vacaciones, viaje, carga de trabajo). No hay desenganche que revertir.
- desmotivacion: señales de desenganche, aburrimiento o dudas sobre continuar.
- dificultad_academica: se atasca, no ve progreso o el nivel no le encaja.
- sin_determinar: hay señales de riesgo pero NO puedes saber a qué se deben. Úsalo sin miedo: es una respuesta correcta y es mucho mejor que inventar una causa sobre la que el profesor va a actuar. Dilo también en riskExplanation, con estas palabras o parecidas: "no hay información suficiente para saber si la ausencia es temporal o una señal de desenganche".
- no_aplica: solo cuando riskSignal es verde.
Cuando la causa sea externa_temporal, la intervención NO debe ser de retención: no hay nada que reenganchar en un alumno que avisó de que se iba de viaje.

DETECCIONES CON SU ACCIÓN (detections):
De 1 a 3, SIEMPRE, sea cual sea la señal de riesgo. Cada una es una pareja: qué observaste y qué hacer al respecto. Un diagnóstico sin acción no le sirve de nada al profesor, así que nunca dejes un finding sin su action.
- Mal: finding "el alumno depende del español". Bien: finding "recurre al español cada vez que no encuentra una palabra"; action "haz los primeros cinco minutos solo en inglés, con apoyo visual, y dale sinónimos antes de que traduzca".
- Mal: finding "ritmo lento". Bien: finding "tarda en arrancar y se queda en blanco en los ejercicios largos"; action "propón ejercicios más cortos y dinámicos, de dos o tres minutos, con un cambio de actividad entre medias".
- El finding tiene que ser verificable en la transcripción y la action tiene que poder ejecutarse en una clase. Nada de "mejorar la motivación" ni "prestar más atención".
- Las detecciones son PEDAGÓGICAS y van aparte de la señal de riesgo: un alumno en verde con dependencia del español también las lleva.

SUGERENCIA DE INTERVENCIÓN (interventionSuggestion):
Si riskSignal es amarillo o rojo, genera una sugerencia de intervención para el profesor. Si es verde, deja action y reconnectHook vacíos, steps como array vacío, escalateToSupport en false y channel en "en_clase".
Cuando generes la sugerencia de intervención:
- PASOS (steps): son QUÉ HACER DURANTE ESA CLASE, en 2 a 4 pasos ordenados. Al profesor se le muestran numerados justo antes de entrar, así que cada paso tiene que ser algo que pueda ejecutar dentro de la clase, en una frase corta y en imperativo. Mal: "mejorar la motivación". Bien: "en los primeros minutos pregúntale qué tal le está yendo con el inglés fuera de clase". Los pasos concretan la acción, no la repiten ni la contradicen.
- Basala en las señales CONCRETAS detectadas: número de cancelaciones y en qué plazo, caída del porcentaje de participación del alumno, clases previas en amarillo o rojo, días sin clase, y menciones textuales en el transcript (frustración, falta de progreso, intención de dejarlo).
- La acción debe ser práctica y específica, nunca un consejo genérico. Mal: "presta más atención al alumno". Bien: "al inicio de la próxima clase pregúntale cómo se siente con el progreso y recuérdale lo que ha avanzado desde que empezó".
- Ajusta la intervención a riskCause. Si es externa_temporal, la acción es acompañar y retomar el ritmo, no retener. Si es dificultad_academica, es ajustar el nivel o el enfoque. Si es sin_determinar, el primer paso es AVERIGUAR la causa con una pregunta natural, no actuar a ciegas.
- La intervención debe parecer NATURAL, nunca reactiva. El profesor nunca debe dar a entender al alumno que el sistema detectó un problema o que "algo ha fallado".
- CADA PASO ES ALGO QUE EL PROFESOR HACE. Empieza por un verbo de acción y describe una conducta ejecutable dentro de la clase. Está PROHIBIDO que un paso:
  · diga solo lo que NO hay que hacer ("no intentes retenerlo tú solo", "no le presiones"). Eso es una advertencia, no un paso, y ya se le muestra aparte.
  · delegue en otro equipo ("deja que soporte active el protocolo", "escala el caso"). El profesor no puede ejecutar eso durante su clase.
  · sea una actitud sin conducta ("mantén un tono cercano", "sé empático"). Convierte la actitud en algo observable: "salúdalo por su nombre y pregúntale por el finde antes de abrir el material".
  Si te quedas sin pasos afirmativos que proponer, propón los básicos de una buena clase con ese alumno, pero NUNCA devuelvas una lista de advertencias.
- ESCALADO A SOPORTE (escalateToSupport). Es una MARCA PARA EL EQUIPO, no un mensaje para el profesor: ponla en true si el alumno dijo explícitamente que piensa cancelar o dejar las clases, y no la menciones en action ni en steps.
  Al profesor le toca dar esa clase igual, durante una hora, y lo que necesita es saber qué hacer en ella. Así que con escalateToSupport en true, action y steps describen QUÉ HACER EN LA CLASE, con más motivo que nunca: contención y acompañamiento. Nada de "avisa a soporte" ni "no hagas nada".
  Piensa en transmitir calma, bajar el ritmo si lo ves agobiado, y que el alumno salga habiendo pasado una buena hora.
  Ejemplo de steps válidos en un caso escalado: "recíbelo con normalidad y arranca con algo que ya domine"; "si lo notas tenso, baja el ritmo y proponle una pausa"; "pregúntale cómo lleva el inglés últimamente y escúchalo sin rebatirle"; "cierra recordándole algo concreto que ha mejorado".
  Ejemplo de steps INVÁLIDOS, que es justo lo que se generaba antes: "no intentes retenerlo tú solo en la clase"; "deja que el equipo de soporte active el protocolo de bajas".
- Si el alumno está a 1 o 2 clases de un hito (15, 30), aprovechá ese hito como motivo natural para reconectar en reconnectHook.
- Redacta en español de España, tono cercano y profesional, sin guiones como conectores.

AUDITORÍA DE SEGUIMIENTO (interventionCheck):
Solo cuando el mensaje incluya el protocolo que recibió el profesor tras la clase anterior. Evalúa si en ESTA clase hay señales de que el profesor lo siguió.
- Audita contra los PASOS CONCRETOS que se le mostraron, uno por uno, no contra una idea general de "intervenir". Si el mensaje dice que el protocolo se le mostró al empezar la clase, es el que tenía delante al entrar.
- Señales válidas: preguntó por el progreso o por cómo se siente el alumno, ajustó el enfoque, hubo más interacción, cambió el tono respecto a clases anteriores, o cualquier otra cosa que se corresponda con los pasos.
- En evidence, di qué paso viste cumplido y con qué frase del transcript, o cuál no aparece.
- POR QUÉ SIGUE ABIERTA (stillOpenReason): si la alerta no se cierra, explica en una o dos frases por qué sigue abierta HOY, a la vista de ESTA clase. Es el motivo actualizado y sustituye al de la clase que la abrió, así que dilo si la situación cambió: puede seguir abierta por lo mismo, por algo distinto, o porque no hay información nueva. Y si no puedes determinar la causa, dilo con todas las letras ("no hay información suficiente para saber si la ausencia es temporal o una señal de desenganche") en vez de repetir la suposición anterior. Devuelve además la causa vigente según esta clase en el campo cause, que puede no ser la de la alerta original.
IMPORTANTE: una buena intervención es sutil y puede no ser evidente. Si no estás seguro, marca confidence "baja". No afirmes con confianza alta que no hubo intervención salvo que la clase sea claramente idéntica a las anteriores sin ningún cambio. Cumplir el espíritu del protocolo cuenta como cumplirlo: no exijas las palabras exactas de cada paso.`;

function buildUserPrompt(input: TranscriptInput): string {
  const header = [
    `Alumno/a: ${input.studentName}`,
    input.classNumber != null ? `Número de clase: ${input.classNumber}` : '',
    input.classDate ? `Fecha de la clase: ${input.classDate}` : '',
    input.level ? `Nivel: ${input.level}` : '',
    input.plan ? `Plan: ${input.plan}` : '',
    input.teacherName ? `Profesor/a: ${input.teacherName}` : '',
  ].filter(Boolean).join('\n');

  const profile = input.studentProfile
    ? `\n\nFicha del alumno:\n${JSON.stringify(input.studentProfile, null, 2)}`
    : '';
  const history = input.classHistory?.length
    ? `\n\nHistorial de las últimas clases:\n${JSON.stringify(input.classHistory, null, 2)}`
    : '\n\nHistorial de las últimas clases: (no hay clases anteriores analizadas)';

  // Alerta abierta de la clase anterior: activa la auditoría de seguimiento.
  //
  // Se le pasan los PASOS EXACTOS que el profesor tuvo delante al pulsar
  // "Ingresar a clase" (y cuándo los vio), para que la auditoría compare contra
  // eso y no contra una idea genérica de intervención.
  const prev = input.activeIntervention;
  const pasos = prev?.steps?.length
    ? `- Protocolo que se le mostró, paso a paso:\n${prev.steps.map((s, i) => `   ${i + 1}) ${s}`).join('\n')}\n`
    : '';
  const visto = prev?.shownAt
    ? `- El profesor vio este protocolo en pantalla al entrar a esta clase (${prev.shownAt}).\n`
    : '- No consta que se le mostrara el protocolo en pantalla al entrar; puede haberlo recibido solo por aviso.\n';
  // El motivo VIGENTE de la alerta (el actualizado si ya sobrevivió a alguna
  // clase). Va en el prompt para que la reevaluación parta de lo último que se
  // sabe y no del diagnóstico original, que puede tener varias clases de antigüedad.
  const motivo = prev
    ? [
        prev.contextSummary ? `- Qué se detectó entonces: ${prev.contextSummary}` : '',
        prev.stillOpenReason ? `- Por qué seguía abierta tras la última revisión: ${prev.stillOpenReason}` : '',
        prev.cause ? `- Causa registrada hasta ahora: ${prev.cause}` : '',
      ].filter(Boolean).join('\n') + '\n'
    : '';

  const alerta = prev
    ? `\n\nALERTA ABIERTA DE LA CLASE ANTERIOR (señal ${prev.risk}${prev.classNumber != null ? `, clase ${prev.classNumber}` : ''}).
${motivo}Esto es lo que se le indicó al profesor tras esa clase:
- Acción sugerida: ${prev.action}
${pasos}${prev.reconnectHook ? `- Oportunidad de reconexión: ${prev.reconnectHook}\n` : ''}- Escalado a soporte: ${prev.escalateToSupport ? 'sí' : 'no'}
${visto}Devuelve también interventionCheck evaluando si en ESTA clase hay señales de que el profesor siguió ese protocolo, y con qué motivo y causa sigue abierta la alerta a día de hoy.`
    : '';

  return `Analiza la transcripción de esta clase.

${header}${profile}${history}${alerta}

TRANSCRIPCIÓN:
${input.transcript}`;
}

// El timeout tiene que caber DENTRO del límite de la función serverless
// (maxDuration = 60 s en app/api/ai/analyze-transcript, que además corre después
// la verificación de autenticidad). Antes eran 180 s: la llamada seguía viva pero
// Vercel ya había matado la función, así que el profesor recibía un fallo genérico
// sin cuerpo JSON. Con 40 s el error llega limpio y,
// como el transcript YA está guardado, la clase no se pierde: queda el botón
// "Reintentar análisis".
//
// effort 'medium' (antes 'high'): con 'high' un transcript de 60 min se iba por
// encima del minuto y el análisis fallaba casi siempre. 'medium' entra holgado y
// el informe mantiene la calidad (el esquema estructurado hace el trabajo duro).
//
// PRESUPUESTO DE SALIDA. Los campos que se añadieron después (riskCause,
// detections, stillOpenReason) llevan tope —3 detecciones, riskExplanation de
// unas 60 palabras— justo por esto: el análisis corre contra un timeout ajustado
// y romperlo es peor que cualquier campo que se gane. Si en algún momento hay que
// recortar, lo primero que se quita son las `detections` (bajar el número en su
// `description`), nunca el effort ni el timeout.
//
// OJO: el tope se pide en prosa, en las `description`, NO con maxItems/minItems.
// La API los rechaza en las respuestas estructuradas y la petición entera falla
// con 400: fue exactamente el bug que dejó 370 análisis en 'failed' entre el
// 04/08/2026 y el 17/08/2026. Ver sanitizeSchemaForApi en lib/anthropic.ts.
export async function analyzeTranscript(input: TranscriptInput): Promise<TranscriptResult> {
  return askClaudeJson<TranscriptIA>({
    label: 'analyze-transcript',
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    schema: schemaFor(!!input.activeIntervention),
    maxTokens: 12000,
    effort: 'medium',
    timeoutMs: 40_000,
    // `channel`, `confidence`, `riskCause` y `cause` son enums, no prosa: la
    // limpieza de guiones no debe tocarlos (hoy no los rompería, pero no
    // dependemos de eso). 'externa_temporal' lleva guion bajo, no guion.
    skipCleanKeys: ['channel', 'confidence', 'riskCause', 'cause'],
  });
}

/**
 * El esquema pide interventionCheck SOLO cuando hay una alerta abierta.
 * Con structured outputs todo lo declarado es obligatorio, así que un esquema
 * fijo forzaría a la IA a inventarse la auditoría en cada clase.
 */
function schemaFor(withCheck: boolean): Record<string, unknown> {
  const base = TRANSCRIPT_SCHEMA as unknown as {
    required: readonly string[]; properties: Record<string, unknown>;
  };
  if (!withCheck) return TRANSCRIPT_SCHEMA as unknown as Record<string, unknown>;
  return {
    ...(TRANSCRIPT_SCHEMA as unknown as Record<string, unknown>),
    required:   [...base.required, 'interventionCheck'],
    properties: { ...base.properties, interventionCheck: CHECK_SCHEMA },
  };
}
