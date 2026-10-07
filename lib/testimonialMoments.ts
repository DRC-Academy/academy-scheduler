// Testimoniales V5 — Haiku elige los MOMENTOS de UNA clase. SOLO SERVIDOR.
// Modelo: claude-haiku-4-5 (~1 céntimo por transcript: solo ve al alumno).
//
// La IA ya no puede equivocarse de persona: solo recibe las intervenciones del
// alumno (lib/testimonialSpeaker formatInterventionsForAi), numeradas y con su
// tiempo. Lo que dice el profe va como contexto, marcado NO ELEGIBLE. Elige hasta
// 2 momentos malos y 2 muy buenos, cada uno con el número de la intervención, la
// cita literal, una puntuación 1-10 y el porqué. El código comprueba después que
// la cita está dentro de esa intervención y calcula el segundo de inicio y de fin
// (lib/testimonialMomentsStore).

import 'server-only';   // llega al SDK de Anthropic vía askClaudeJson

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import { FLUENCY_MODEL } from '@/lib/analyzeFluency';

/** Momentos de cada tipo que se guardan por clase (el esquema no lleva maxItems). */
export const MAX_PER_KIND = 2;

export interface MomentIA {
  tipo: 'malo' | 'bueno';
  /** Número de la intervención (#12 → 12). */
  intervencion: number;
  cita: string;
  /** Lo malo o lo bueno que es: 10 = se traba muchísimo / habla genial. */
  puntuacion: number;
  porque: string;
}

export interface MomentsIA {
  momentos: MomentIA[];
}

const SYSTEM = `Buscas material para un anuncio de una academia de inglés online para adultos hispanohablantes. Recibes las intervenciones de UN alumno en UNA clase, sacadas de la transcripción automática (Fathom). Cada intervención lleva su número y su tiempo: "#12 [8:20–8:41] texto". Antes de algunas va la última frase del profesor, marcada "[PROFE - SOLO CONTEXTO, NO ELEGIBLE]": sirve para entender a qué contesta el alumno, pero NUNCA se elige.

Elige hasta ${MAX_PER_KIND} momentos MALOS y hasta ${MAX_PER_KIND} momentos MUY BUENOS:
- MALO: el alumno se traba intentando hablar inglés por su cuenta: dudas, pausas, muletillas ("eh", "um"), frases empezadas y abandonadas, repeticiones, salta al español para salir del paso. Tiene que entenderse qué intenta decir.
- MUY BUENO: el alumno habla inglés con soltura y de forma espontánea RESPONDIENDO al profe: frases completas, ideas encadenadas, sin apenas pausas ni español.

PROHIBIDO (no los elijas nunca, ni como malos ni como buenos):
- Audios o vídeos puestos en clase (Fathom los transcribe como si hablara alguien). Pistas: justo antes el profe dice "listen", "watch", "audio", "video", "podcast"; inglés nativo perfecto y largo sin interacción.
- Lectura en voz alta de un texto, ejercicio, diálogo, redacción o ensayo (aunque lo haya escrito él). Pistas: el profe dice antes "read", "lee", "párrafo", "ensayo"; frases de libro demasiado perfectas para su nivel.
- Repetir lo que acaba de decir el profe, o leer el enunciado o las frases de un ejercicio.
- Presentaciones preparadas o frases memorizadas.
- Momentos casi todo en español, o que no se entienden.

CADA MOMENTO:
- "intervencion": el número de la intervención (solo el número, sin #).
- "cita": copiada LITERAL de esa intervención, carácter a carácter, de 12 a 35 palabras seguidas (unos 5 a 15 segundos). Sin cortar palabras, sin corregir, sin parafrasear. Si puede ser, que empiece al principio de la intervención. Se comprueba automáticamente y la que no aparezca se tira.
- "puntuacion": de 1 a 10, lo malo que es el malo o lo bueno que es el bueno (10 = se traba muchísimo / habla genial). Sé exigente: un 8 o más solo si se nota sin esfuerzo en un vídeo de pocos segundos.
- "porque": una frase corta en español con lo que se ve en el clip.

Si no hay ninguno que cumpla todo, devuelve la lista vacía: mejor ninguno que uno dudoso.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['momentos'],
  properties: {
    // Sin maxItems ni minItems: la API los rechaza o los ignora según el modelo.
    momentos: {
      type: 'array',
      description: `Hasta ${MAX_PER_KIND} malos y ${MAX_PER_KIND} buenos.`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tipo', 'intervencion', 'cita', 'puntuacion', 'porque'],
        properties: {
          tipo: { type: 'string', enum: ['malo', 'bueno'] },
          intervencion: { type: 'integer', description: 'Número de la intervención, sin #.' },
          cita: { type: 'string', description: 'Cita LITERAL de esa intervención, 12 a 35 palabras.' },
          puntuacion: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
          porque: { type: 'string', description: 'Una frase corta en español.' },
        },
      },
    },
  },
};

export async function pickClassMoments(input: {
  studentName: string;
  interventionsText: string;
  timeoutMs?: number;
}): Promise<AiResult<MomentsIA>> {
  return askClaudeJson<MomentsIA>({
    label: 'testimonial-momentos',
    model: FLUENCY_MODEL,
    system: SYSTEM,
    prompt: `Alumno/a: ${input.studentName}\n\n${input.interventionsText}`,
    schema: SCHEMA,
    maxTokens: 1500,
    timeoutMs: input.timeoutMs ?? 40_000,
    maxRetries: 0,
    // La cita es literal: la limpieza de guiones la rompería.
    skipCleanKeys: ['cita', 'tipo'],
  });
}
