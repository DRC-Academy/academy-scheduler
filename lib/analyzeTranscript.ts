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
  required: ['action', 'reconnectHook', 'escalateToSupport', 'channel'],
  properties: {
    action:            { type: 'string',  description: 'Acción concreta y específica para el profesor, una sola, en español de España. Vacío si riskSignal es verde.' },
    reconnectHook:     { type: 'string',  description: 'Si el alumno está a 1 o 2 clases de un hito (15 o 30), cómo usar la evaluación de hito como excusa natural para reconectar. Vacío si no aplica.' },
    escalateToSupport: { type: 'boolean', description: 'true solo si el alumno dijo explícitamente que piensa cancelar o dejar las clases.' },
    channel:           { type: 'string',  enum: ['en_clase', 'mensaje_previo', 'escalar_soporte'] },
  },
} as const;

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['signsOfIntervention', 'evidence', 'confidence'],
  properties: {
    signsOfIntervention: { type: 'boolean', description: '¿Hay señales de que el profesor actuó sobre la alerta anterior?' },
    evidence:            { type: 'string',  description: 'Qué señales de intervención se observaron o su ausencia. Breve, en español.' },
    confidence:          { type: 'string',  enum: ['alta', 'media', 'baja'] },
  },
} as const;

export const TRANSCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'classTitle', 'classSummary', 'errorsDetected', 'progressNotes', 'topicsCovered',
    'progressScore', 'riskSignal', 'riskExplanation', 'nextClassGuide', 'interventionSuggestion',
  ],
  properties: {
    interventionSuggestion: INTERVENTION_SCHEMA,
    classTitle:      { type: 'string', description: 'Título breve y descriptivo de lo que se trabajó, p. ej. "Present Perfect en contexto laboral".' },
    classSummary:    { type: 'string', description: 'Qué se trabajó y cómo fue.' },
    errorsDetected:  { type: 'string', description: 'Errores específicos y patrones.' },
    progressNotes:   { type: 'string', description: 'Mejoras respecto a clases anteriores.' },
    topicsCovered:   { type: 'string', description: 'Gramática, vocabulario y habilidades.' },
    progressScore:   { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], description: 'Progreso general del alumno, de 1 (estancado) a 10 (excelente).' },
    riskSignal:      { type: 'string', enum: ['verde', 'amarillo', 'rojo'] },
    riskExplanation: { type: 'string', description: 'Por qué ese nivel de riesgo.' },
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

SUGERENCIA DE INTERVENCIÓN (interventionSuggestion):
Si riskSignal es amarillo o rojo, genera una sugerencia de intervención para el profesor. Si es verde, deja action y reconnectHook vacíos, escalateToSupport en false y channel en "en_clase".
Cuando generes la sugerencia de intervención:
- Basala en las señales CONCRETAS detectadas: número de cancelaciones y en qué plazo, caída del porcentaje de participación del alumno, clases previas en amarillo o rojo, días sin clase, y menciones textuales en el transcript (frustración, falta de progreso, intención de dejarlo).
- La acción debe ser práctica y específica, nunca un consejo genérico. Mal: "presta más atención al alumno". Bien: "al inicio de la próxima clase pregúntale cómo se siente con el progreso y recuérdale lo que ha avanzado desde que empezó".
- La intervención debe parecer NATURAL, nunca reactiva. El profesor nunca debe dar a entender al alumno que el sistema detectó un problema o que "algo ha fallado".
- Si el alumno mencionó EXPLÍCITAMENTE que piensa cancelar o dejar las clases: escalateToSupport = true, y la acción debe indicar escalar al equipo de soporte para activar el protocolo de gestión de bajas, NO que el profesor intente retenerlo solo.
- Si el alumno está a 1 o 2 clases de un hito (15, 30), aprovechá ese hito como motivo natural para reconectar en reconnectHook.
- Redacta en español de España, tono cercano y profesional, sin guiones como conectores.

AUDITORÍA DE SEGUIMIENTO (interventionCheck):
Solo cuando el mensaje incluya la sugerencia de intervención que recibió el profesor tras la clase anterior. Analiza si en ESTA clase hay señales de que el profesor actuó: preguntó por el progreso o cómo se siente el alumno, ajustó el enfoque, hubo más interacción, cambió el tono respecto a clases anteriores.
IMPORTANTE: una buena intervención es sutil y puede no ser evidente. Si no estás seguro, marca confidence "baja". No afirmes con confianza alta que no hubo intervención salvo que la clase sea claramente idéntica a las anteriores sin ningún cambio.`;

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
  const prev = input.activeIntervention;
  const alerta = prev
    ? `\n\nALERTA ABIERTA DE LA CLASE ANTERIOR (señal ${prev.risk}${prev.classNumber != null ? `, clase ${prev.classNumber}` : ''}).
Esto es lo que se le sugirió al profesor tras esa clase:
- Acción sugerida: ${prev.action}
${prev.reconnectHook ? `- Oportunidad de reconexión: ${prev.reconnectHook}\n` : ''}- Escalado a soporte: ${prev.escalateToSupport ? 'sí' : 'no'}
Devuelve también interventionCheck evaluando si en ESTA clase hay señales de que el profesor actuó.`
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
export async function analyzeTranscript(input: TranscriptInput): Promise<TranscriptResult> {
  return askClaudeJson<TranscriptIA>({
    label: 'analyze-transcript',
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    schema: schemaFor(!!input.activeIntervention),
    maxTokens: 12000,
    effort: 'medium',
    timeoutMs: 40_000,
    // `channel` y `confidence` son enums, no prosa: la limpieza de guiones no
    // debe tocarlos (hoy no los rompería, pero no dependemos de eso).
    skipCleanKeys: ['channel', 'confidence'],
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
