// Testimoniales — segunda revisión con IA de una pareja "antes / después". SOLO SERVIDOR.
// Modelo: claude-haiku-4-5 (menos de medio céntimo por pareja).
//
// La detección es una cuenta: nota vieja ≤ 4, nota nueva ≥ 7. Esto mira los dos
// fragmentos y el porqué de cada nota y responde si la mejora parece real o si
// es un mal día en la clase vieja (o un buen día suelto en la nueva). Corre solo
// para cada pareja nueva o reemplazada, nunca por transcript.

import 'server-only';   // llega al SDK de Anthropic vía askClaudeJson

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import { FLUENCY_MODEL } from '@/lib/analyzeFluency';

export interface TestimonialReviewIA {
  is_real: boolean;
  reason: string;
  summary: string;
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_real', 'reason', 'summary'],
  properties: {
    is_real: { type: 'boolean', description: 'true si la mejora en la fluidez del alumno parece real y sostenida; false si parece un mal día en la clase vieja, un buen día suelto en la nueva, o los fragmentos no la demuestran.' },
    reason:  { type: 'string',  description: 'Una frase en español con el motivo de la decisión.' },
    summary: { type: 'string',  description: 'Exactamente DOS frases en español: la primera describe cómo hablaba el alumno antes y la segunda cómo habla ahora. Concretas, sin exagerar, aptas para que el equipo decida si pedir las grabaciones.' },
  },
} as const;

const SYSTEM_PROMPT = `Revisas posibles testimonios de alumnos adultos de inglés de una academia online. Un sistema automático ha encontrado dos clases del mismo alumno separadas por semanas: en la primera se trababa mucho hablando inglés y en la segunda habla con soltura. Antes de pedir esas grabaciones al profesor para usarlas en anuncios, decides si la mejora parece REAL.

Señales de mejora real: el fragmento nuevo tiene frases más largas y completas, menos dudas y menos español; el porqué de cada nota describe lo mismo; la diferencia es de soltura y no solo de tema.
Señales de que NO es real: la clase vieja parece un mal día puntual (cansancio, problemas técnicos, tema muy difícil) más que su nivel; el fragmento nuevo es una frase memorizada, leída o repetida del profesor; los dos fragmentos no muestran una diferencia clara; las explicaciones de las notas se contradicen con los fragmentos.
Ante la duda razonable, is_real: false. Un testimonio falso es peor que uno de menos.`;

export interface ReviewSide {
  date: string | null;
  classNumber: number | null;
  score: number | null;
  excerpt: string | null;
  at: string | null;
  evidence: string | null;
  hesitation: string | null;
  spanish: string | null;
}

const side = (label: string, s: ReviewSide) => [
  `${label}: clase nº ${s.classNumber ?? '?'} del alumno, ${s.date ?? 'fecha desconocida'}, nota de fluidez ${s.score ?? '?'}/10.`,
  `  Por qué esa nota: ${s.evidence ?? '(sin explicación)'}`,
  `  Dudas: ${s.hesitation ?? '?'} · Uso de español: ${s.spanish ?? '?'}`,
  `  Fragmento [${s.at ?? '?'}]: "${s.excerpt ?? ''}"`,
].join('\n');

export async function reviewTestimonial(input: { before: ReviewSide; after: ReviewSide }): Promise<AiResult<TestimonialReviewIA>> {
  return askClaudeJson<TestimonialReviewIA>({
    label: 'review-testimonial',
    model: FLUENCY_MODEL,
    system: SYSTEM_PROMPT,
    prompt: `${side('ANTES (se trababa)', input.before)}\n\n${side('DESPUÉS (habla con soltura)', input.after)}`,
    schema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 600,
    timeoutMs: 20_000,
    maxRetries: 0,
  });
}
