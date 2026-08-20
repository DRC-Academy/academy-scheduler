// Evaluación IA de una respuesta de Writing del Test de Nivel.
// SOLO SERVIDOR (usa la API de Anthropic vía askClaudeJson). Best-effort: si no
// hay clave o falla, devuelve status !== 'ready' y quien llama sigue funcionando.
// Modelo: claude-haiku-4-5 (decisión del proyecto para este test — barato).
//
// ESCALA ABSOLUTA (corrección ago/2026). Antes la IA puntuaba "qué tan bien
// respondió a la consigna que le tocó" (relativo) y ese número se sumaba en
// overall = reading·0,6 + writing·0,4 como si fuera nivel absoluto. Como la
// consigna sale de la dificultad arrastrada del Reading, el alumno flojo recibía
// consigna fácil → nota alta, y el fuerte consigna difícil → nota baja: la nota de
// writing quedaba correlacionada NEGATIVAMENTE con el nivel real (r = −0,70 sobre
// los tests reales) e inflaba el resultado hasta 3 bandas.
// Ahora la IA asigna el nivel MCER que demuestra EL TEXTO EN SÍ, contra los
// descriptores absolutos, y el puntaje 0–100 lo calcula el código con `cefrToScore`
// a partir de ese nivel. Así writing y reading miden lo mismo para todos.

import { askClaudeJson } from '@/lib/anthropic';
import { CEFR_WRITING_DESCRIPTORS, cefrToScore } from '@/lib/levelTest/constants';
import type { WritingEvaluation, Cefr, CefrPosition } from '@/lib/levelTest/types';

const scoreFeedback = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'feedback'],
  properties: {
    score: { type: 'integer', description: '0-100' },
    feedback: { type: 'string', description: 'Feedback breve EN ESPAÑOL.' },
  },
} as const;

// OJO: la IA ya NO devuelve `score`. El puntaje global lo deriva el código desde
// cefr_level + within_level, para que no pueda salirse de la escala absoluta.
const WRITING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'is_valid_attempt',
    'cefr_level', 'within_level', 'evidence', 'grammar', 'vocabulary', 'coherence',
    'task_completion', 'overall_feedback', 'strengths', 'areas_for_improvement',
  ],
  properties: {
    is_valid_attempt: {
      type: 'boolean',
      description: 'false SOLO si el texto no es un intento real de la tarea (galimatías, relleno para llegar al mínimo de palabras, copia de la consigna, otro idioma). Un texto flojo, corto y con errores de un principiante real es true.',
    },
    cefr_level: {
      type: 'string',
      enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'],
      description: 'Nivel MCER ABSOLUTO que demuestra el texto en sí mismo, con independencia de la consigna.',
    },
    within_level: {
      type: 'string',
      enum: ['low', 'mid', 'high'],
      description: 'Dónde cae dentro de esa banda: apenas la alcanza (low), la cumple (mid), roza la siguiente (high).',
    },
    evidence: {
      type: 'string',
      description: 'EN INGLÉS: 1-2 frases citando rasgos concretos del texto (estructuras, léxico, errores) que justifican ese nivel.',
    },
    grammar: scoreFeedback,
    vocabulary: scoreFeedback,
    coherence: scoreFeedback,
    task_completion: scoreFeedback,
    overall_feedback: { type: 'string', description: 'Resumen EN ESPAÑOL.' },
    strengths: { type: 'array', items: { type: 'string' } },
    areas_for_improvement: { type: 'array', items: { type: 'string' } },
  },
} as const;

const DESCRIPTOR_BLOCK = (Object.keys(CEFR_WRITING_DESCRIPTORS) as Cefr[])
  .map(l => `${l}: ${CEFR_WRITING_DESCRIPTORS[l]}`)
  .join('\n');

const SYSTEM = `You are an expert English language assessor for a language academy.

YOUR TASK: judge the CEFR level of English that this text ITSELF demonstrates.
Look at grammar, vocabulary, complexity of structures, cohesion and accuracy, and
assign the CEFR level the text evidences — INDEPENDENTLY OF THE TASK PROMPT.

This is an ABSOLUTE scale, not a relative one. A text that demonstrates B1 must be
scored B1 whether the task asked for something simpler or something harder. Do NOT
reward a student for comfortably meeting an easy prompt, and do NOT punish one for
falling short of a hard prompt. "Did they do what was asked?" is a SEPARATE question
that belongs only in task_completion and must NOT move cefr_level.

CEFR WRITING DESCRIPTORS — score against these:
${DESCRIPTOR_BLOCK}

Rules:
- Award a level only if the text actually EVIDENCES it. Absence of errors in simple
  sentences is not evidence of a high level: a short, safe, error-free text that never
  attempts complex structures is B1, not C1.
- Length is not level. A long text is not automatically higher; a brief text is judged
  on what it demonstrates.
- If the text is filler, off-topic, copied from the prompt, or in another language,
  say so in "evidence" and assign the level the actual English (if any) demonstrates.
- SEPARATELY from the level, set "is_valid_attempt" to false when the text is not a
  genuine attempt at the task: gibberish, padding written only to reach the word count,
  a copy of the prompt, or text in another language. A short, weak, error-ridden text
  from a real beginner IS a genuine attempt — that is true, not false. When in doubt,
  true: a wrong false costs a real student their whole writing score.
- Be strict. Assessors drift upwards; when the evidence sits between two levels, pick
  the lower one and mark within_level as "high".
- grammar / vocabulary / coherence are 0-100 diagnostic sub-scores on the SAME absolute
  scale (roughly: A1 ~15, A2 ~35, B1 ~45, B2 ~55, C1 ~65, C2 ~85). task_completion is
  the ONLY field judged against the prompt, and it does not affect the level.

IMPORTANT: write ALL feedback fields ("feedback", "overall_feedback", "strengths",
"areas_for_improvement") in SPANISH FROM SPAIN (español de España). Address the
student informally with "tú"/"tuteo". NEVER use Argentine "vos"/"voseo" or forms
like "tenés", "manejás", "podés", "acá". Use peninsular vocabulary and phrasing.
"evidence" is the exception: write it in ENGLISH, it is for internal review.
Return only the JSON that matches the schema.`;

export async function evaluateWriting(args: {
  cefrLevel: Cefr;          // nivel de la consigna: SOLO contexto para task_completion
  writingPrompt: string;
  writtenResponse: string;
}): Promise<{ data: WritingEvaluation | null; status: 'ready' | 'skipped' | 'error' }> {
  const prompt = `TASK PROMPT the student was given (context for task_completion ONLY — it must not influence the CEFR level you assign):
"${args.writingPrompt}"

STUDENT'S TEXT — judge this against the absolute CEFR descriptors:
"""
${args.writtenResponse}
"""

What CEFR level does this text demonstrate?`;

  const res = await askClaudeJson<WritingEvaluation>({
    model: 'claude-haiku-4-5',
    system: SYSTEM,
    prompt,
    schema: WRITING_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1500,
    label: 'level-test-writing',
  });

  if (!res.data) return { data: null, status: res.status };

  // El puntaje global lo fija el código, no la IA: mismo eje 0–100 que el reading.
  const level = res.data.cefr_level;
  const position = (res.data.within_level ?? 'mid') as CefrPosition;
  // Si el campo falta (el modelo no cumplió el schema), se asume VÁLIDO. El
  // sesgo va a favor del alumno: descartar por omisión le costaría su nota de
  // escritura entera por un fallo que no es suyo.
  const isValid = res.data.is_valid_attempt !== false;
  return {
    data: { ...res.data, is_valid_attempt: isValid, score: cefrToScore(level, position) },
    status: res.status,
  };
}
