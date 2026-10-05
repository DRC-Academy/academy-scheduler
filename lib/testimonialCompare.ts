// Testimoniales — comparación A CIEGAS de dos clases del alumno. SOLO SERVIDOR.
// Modelo: claude-haiku-4-5 (menos de 1 céntimo por alumno).
//
// Por qué existe (V3, 05/10/2026): la nota de fluidez que Haiku pone a cada
// clase POR SEPARADO tiene mucho ruido; depende de si la clase fue de gramática
// o de conversación. Comparar dos clases entre sí es mucho más fiable que dos
// notas absolutas. Para que la comparación no se deje llevar por lo que espera
// encontrar ("la reciente será la buena"):
//   · solo ve lo que dice el ALUMNO (lib/fluency studentOnlyText), sin el profe,
//     sin fechas, sin minutos y sin el número de clase;
//   · el orden A/B lo decide un sorteo (lib/testimonialStore), y la IA no sabe
//     que una es antigua y otra reciente.
// La regla de qué cuenta como confirmación vive en lib/testimonials blindConfirms.

import 'server-only';   // llega al SDK de Anthropic vía askClaudeJson

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import { FLUENCY_MODEL } from '@/lib/analyzeFluency';
import type { BlindChoice, BlindConfidence } from '@/lib/testimonials';

export interface BlindCompareIA {
  mas_soltura: BlindChoice;
  confianza: BlindConfidence;
  motivo: string;
}

const SYSTEM = `Eres evaluador de inglés hablado en una academia online para adultos hispanohablantes. Recibes lo que dijo UN MISMO alumno en dos clases distintas (A y B), sacado de transcripciones automáticas. Solo aparecen sus intervenciones, sin las del profesor.

Decide en cuál de las dos habla inglés con MÁS SOLTURA: frases más largas y completas, ideas encadenadas, menos dudas y muletillas, menos saltos al español, menos frases abandonadas.

REGLAS:
- Juzga la soltura hablando, no el tema ni la dificultad de la clase.
- No premies la lectura en voz alta ni repetir frases: si una clase es casi toda lectura o ejercicios, eso no es soltura.
- La transcripción automática tiene errores: no castigues palabras mal transcritas.
- "igual" si no hay una diferencia clara. "confianza" es "alta" solo si la diferencia se oiría sin esfuerzo en un vídeo de pocos segundos.
- "motivo": una o dos frases en español con lo concreto que lo decide.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mas_soltura', 'confianza', 'motivo'],
  properties: {
    mas_soltura: { type: 'string', enum: ['A', 'B', 'igual'], description: 'La clase donde habla inglés con más soltura, o "igual".' },
    confianza: { type: 'string', enum: ['alta', 'media', 'baja'], description: 'Qué tan clara es la diferencia.' },
    motivo: { type: 'string', description: 'Una o dos frases en español con lo concreto que lo decide.' },
  },
};

export async function compareBlind(input: {
  a: string;
  b: string;
  /** Tope de la llamada (por defecto 15 s). */
  timeoutMs?: number;
}): Promise<AiResult<BlindCompareIA>> {
  return askClaudeJson<BlindCompareIA>({
    label: 'testimonial-ciegas',
    model: FLUENCY_MODEL,
    system: SYSTEM,
    prompt: `=== CLASE A ===\n${input.a}\n\n=== CLASE B ===\n${input.b}`,
    schema: SCHEMA,
    maxTokens: 400,
    // Va antes de las dos llamadas de los clips, en la misma función de 60 s.
    timeoutMs: input.timeoutMs ?? 15_000,
    maxRetries: 0,
    skipCleanKeys: ['mas_soltura', 'confianza'],
  });
}
