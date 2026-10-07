// Testimoniales — Haiku REVISA los clips candidatos antes de enseñarlos. SOLO SERVIDOR.
// Modelo: claude-haiku-4-5 (menos de 1 céntimo: solo los clips con su contexto).
//
// Por qué existe (V4, 07/10/2026): quien elige los clips (lib/testimonialClips)
// lee clases enteras y se equivocaba de persona y de tipo de habla. Salieron
// como "momento bueno" un podcast, el audio de un ejercicio, un ensayo leído y
// frases del profe. Aquí cada clip se juzga SOLO, con los dos turnos de antes y
// el de después, que es donde se ve si alguien dijo "vamos a escuchar…" o "lee
// el párrafo", o si el texto es demasiado perfecto para el alumno.
//
// También pone a cada clip un nivel de soltura (1-5): la pareja final
// (lib/testimonials pickPair) exige que el bueno esté por encima del malo.

import 'server-only';   // llega al SDK de Anthropic vía askClaudeJson

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import { FLUENCY_MODEL } from '@/lib/analyzeFluency';

export const CLIP_PROBLEMS = [
  'ninguno', 'otra_persona', 'habla_el_profe', 'lectura', 'audio_o_video', 'repite', 'memorizado', 'espanol', 'no_se_entiende',
] as const;
export type ClipProblem = typeof CLIP_PROBLEMS[number];

export interface ClipToVerify {
  id: string;
  kind: 'malo' | 'bueno';
  /** Los turnos de alrededor ya formateados con su rol, la cita marcada con >>> <<<. */
  context: string;
}

export interface ClipVerdictIA {
  id: string;
  problema: ClipProblem;
  /** Soltura del alumno EN ESE CLIP: 1 = se traba mucho, 5 = habla con total soltura. */
  nivel: number;
  motivo: string;
}

export interface VerifyIA {
  clips: ClipVerdictIA[];
  summary: string;
}

const SYSTEM = `Revisas clips cortos para un anuncio de una academia de inglés online para adultos hispanohablantes. El anuncio enseña a UN alumno hablando mal al principio (clips "malo") y hablando bien semanas después (clips "bueno"). Cada clip viene con lo que se dijo justo antes y justo después, sacado de una transcripción automática (Fathom). La cita del clip va marcada entre >>> y <<<.

Para cada clip decide "problema":
- "ninguno": es el ALUMNO hablando inglés por su cuenta: contesta, cuenta algo, opina. Vale aunque se equivoque.
- "otra_persona": por el contenido o el contexto habla otra persona que no es ese alumno (otro alumno, un compañero, un familiar).
- "habla_el_profe": la cita es del profesor aunque la etiqueta diga ALUMNO: corrige, explica, da instrucciones, pregunta como profe, felicita.
- "lectura": lee en voz alta un texto, un ejercicio, un diálogo, una redacción o un ensayo (aunque sea suyo). Pistas: el profe pide leer o corregir un texto, el inglés es de libro o de texto escrito, frases demasiado perfectas para su nivel.
- "audio_o_video": es un audio, podcast o vídeo puesto en clase (un hablante nativo, un locutor, "in this podcast", "now we are going to listen").
- "repite": repite lo que acaba de decir el profe o lee la frase de un ejercicio.
- "memorizado": una presentación preparada o frases aprendidas de memoria.
- "espanol": la mayor parte está en español.
- "no_se_entiende": no se entiende qué quiere decir o es un error de la transcripción.

"nivel" es la soltura del alumno EN ESE CLIP, de 1 a 5: 1 se traba mucho (pausas, frases abandonadas, español), 3 se defiende con errores, 5 habla con total soltura. Puntúa igual de exigente todos los clips, sean "malo" o "bueno".
"motivo": una frase corta en español con lo que lo decide.
"summary": EXACTAMENTE DOS frases en español, mirando solo los clips sin problema: la primera dice cómo hablaba el alumno en los "malo" y la segunda cómo habla en los "bueno". Concretas y sin exagerar.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clips', 'summary'],
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'problema', 'nivel', 'motivo'],
        properties: {
          id: { type: 'string', description: 'El id del clip, copiado tal cual.' },
          problema: { type: 'string', enum: [...CLIP_PROBLEMS] },
          nivel: { type: 'integer', enum: [1, 2, 3, 4, 5], description: 'Soltura del alumno en el clip.' },
          motivo: { type: 'string', description: 'Una frase corta en español.' },
        },
      },
    },
    summary: { type: 'string', description: 'Dos frases en español: cómo hablaba antes y cómo habla ahora.' },
  },
};

export async function verifyClips(input: {
  studentName: string;
  clips: ClipToVerify[];
  /** Tope de la llamada (por defecto 15 s). */
  timeoutMs?: number;
}): Promise<AiResult<VerifyIA>> {
  const body = input.clips
    .map(c => `=== CLIP ${c.id} (${c.kind}) ===\n${c.context}`)
    .join('\n\n');
  return askClaudeJson<VerifyIA>({
    label: 'testimonial-revision',
    model: FLUENCY_MODEL,
    system: SYSTEM,
    prompt: `Alumno/a: ${input.studentName}\n\n${body}`,
    schema: SCHEMA,
    maxTokens: 1200,
    timeoutMs: input.timeoutMs ?? 15_000,
    maxRetries: 0,
    skipCleanKeys: ['id', 'problema'],
  });
}
