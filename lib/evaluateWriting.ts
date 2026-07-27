// Evaluación IA de una respuesta de Writing del Test de Nivel.
// SOLO SERVIDOR (usa la API de Anthropic vía askClaudeJson). Best-effort: si no
// hay clave o falla, devuelve status !== 'ready' y quien llama sigue funcionando.
// Modelo: claude-haiku-4-5 (decisión del proyecto para este test — barato).

import { askClaudeJson } from '@/lib/anthropic';
import type { WritingEvaluation, Cefr } from '@/lib/levelTest/types';

const scoreFeedback = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'feedback'],
  properties: {
    score: { type: 'integer', description: '0-100' },
    feedback: { type: 'string', description: 'Feedback breve EN ESPAÑOL.' },
  },
} as const;

const WRITING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'score', 'cefr_level', 'grammar', 'vocabulary', 'coherence',
    'task_completion', 'overall_feedback', 'strengths', 'areas_for_improvement',
  ],
  properties: {
    score: { type: 'integer', description: 'Puntaje global 0-100 relativo al nivel esperado.' },
    cefr_level: { type: 'string', enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] },
    grammar: scoreFeedback,
    vocabulary: scoreFeedback,
    coherence: scoreFeedback,
    task_completion: scoreFeedback,
    overall_feedback: { type: 'string', description: 'Resumen EN ESPAÑOL.' },
    strengths: { type: 'array', items: { type: 'string' } },
    areas_for_improvement: { type: 'array', items: { type: 'string' } },
  },
} as const;

const SYSTEM = `You are an expert English language assessor for a language academy.
Evaluate the student's writing using the CEFR framework. Be fair but rigorous, and
score relative to the level that was expected. Judge grammar, vocabulary, coherence
and task completion.

IMPORTANT: write ALL feedback fields ("feedback", "overall_feedback", "strengths",
"areas_for_improvement") in SPANISH FROM SPAIN (español de España). Address the
student informally with "tú"/"tuteo". NEVER use Argentine "vos"/"voseo" or forms
like "tenés", "manejás", "podés", "acá". Use peninsular vocabulary and phrasing.
Return only the JSON that matches the schema.`;

export async function evaluateWriting(args: {
  cefrLevel: Cefr;
  writingPrompt: string;
  writtenResponse: string;
}): Promise<{ data: WritingEvaluation | null; status: 'ready' | 'skipped' | 'error' }> {
  const prompt = `The student was given this prompt at ${args.cefrLevel} level:
"${args.writingPrompt}"

Their response:
"${args.writtenResponse}"

Evaluate on a scale of 0-100.`;

  const res = await askClaudeJson<WritingEvaluation>({
    model: 'claude-haiku-4-5',
    system: SYSTEM,
    prompt,
    schema: WRITING_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1500,
    label: 'level-test-writing',
  });
  return { data: res.data, status: res.status };
}
