// Análisis pedagógico de la transcripción de una clase (p. ej. exportada de
// Fathom). Devuelve el informe + la señal de riesgo de baja del alumno.

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import type { TranscriptIA } from '@/lib/aiTypes';

export type { TranscriptIA, NextClassGuide, RiskSignal } from '@/lib/aiTypes';

export interface TranscriptInput {
  transcript: string;
  studentName: string;
  teacherName: string;
  plan?: string | null;
  level?: string | null;
  classNumber?: number | null;
  studentProfile?: Record<string, unknown> | null;
  classHistory?: unknown[] | null;
}

export type TranscriptResult = AiResult<TranscriptIA>;

export const TRANSCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'classSummary', 'errorsDetected', 'progressNotes', 'topicsCovered',
    'riskSignal', 'riskExplanation', 'nextClassGuide',
  ],
  properties: {
    classSummary:    { type: 'string', description: 'Qué se trabajó y cómo fue.' },
    errorsDetected:  { type: 'string', description: 'Errores específicos y patrones.' },
    progressNotes:   { type: 'string', description: 'Mejoras respecto a clases anteriores.' },
    topicsCovered:   { type: 'string', description: 'Gramática, vocabulario y habilidades.' },
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

Basa el informe únicamente en lo que ocurre en la transcripción. La señal de riesgo es una valoración con consecuencias reales: no la infles por una clase floja aislada ni la rebajes si el alumno expresa que se plantea dejarlo.`;

function buildUserPrompt(input: TranscriptInput): string {
  const header = [
    `Alumno/a: ${input.studentName}`,
    input.classNumber != null ? `Número de clase: ${input.classNumber}` : '',
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

  return `Analiza la transcripción de esta clase.

${header}${profile}${history}

TRANSCRIPCIÓN:
${input.transcript}`;
}

export async function analyzeTranscript(input: TranscriptInput): Promise<TranscriptResult> {
  return askClaudeJson<TranscriptIA>({
    label: 'analyze-transcript',
    system: SYSTEM_PROMPT,
    prompt: buildUserPrompt(input),
    schema: TRANSCRIPT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 12000,
    effort: 'high',
    timeoutMs: 180_000,
  });
}
