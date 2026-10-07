// Testimoniales — Haiku propone los CLIPS cortos del alumno. SOLO SERVIDOR.
// Modelo: claude-haiku-4-5 (~3-5 céntimos por alumno: lee hasta 6 transcripts).
//
// Lo que se busca son trozos de 5 a 15 segundos para montar un anuncio, no
// clases enteras buenas o malas. Dos llamadas por alumno, en paralelo:
//   · 'malo':  hasta 3 candidatos de sus PRIMERAS clases en que se traba;
//   · 'bueno': hasta 3 candidatos de sus ÚLTIMAS clases en que habla muy bien.
// La IA los devuelve del más claro al menos claro. El código comprueba después
// que cada cita existe literal y está en un turno del alumno, calcula su segundo
// de inicio y de fin (lib/testimonialStore + lib/fluency), y lib/testimonialVerify
// los revisa uno a uno. Al final se guarda UN clip de cada lado.

import 'server-only';   // llega al SDK de Anthropic vía askClaudeJson

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import { FLUENCY_MODEL } from '@/lib/analyzeFluency';

export type MomentKind = 'malo' | 'bueno';

/** Candidatos de cada tipo que se piden como mucho (el esquema no lleva maxItems). Se guarda uno. */
export const MAX_CLIPS = 3;

export interface MomentIA {
  class_option: number;
  excerpt: string;
  at: string;
  why: string;
}

export interface MomentsIA {
  momentos: MomentIA[];
}

/** Una clase tal como se le enseña a la IA. */
export interface MomentClass {
  date: string;
  /** Transcript con roles (lib/fluency formatTurnsForAi). */
  turnsText: string;
}

const CLIP_RULES = `REGLAS DE CADA CLIP (todas obligatorias):
- Habla el ALUMNO, no el profe ni ninguna otra persona. Solo valen turnos marcados ALUMNO. Fathom a veces pega frases del profe en un turno del alumno: una frase que corrige, explica gramática, da instrucciones, pregunta como profe o felicita es del profe aunque la etiqueta diga ALUMNO. Esas no valen.
- Habla espontáneamente: contesta una pregunta, cuenta algo, opina. NO valen: lectura en voz alta (un texto, un ejercicio, un diálogo, una redacción o ensayo, aunque lo haya escrito él), un audio, podcast o vídeo puesto en clase (Fathom lo transcribe como si hablara alguien), repetir lo que dice el profe, frases de un ejercicio, presentaciones preparadas o frases memorizadas. Si justo antes alguien dice "listen", "read", "lee", "escuchamos", "repeat", "párrafo" o "ensayo", ese turno no vale. Un inglés de libro, sin ninguna duda y demasiado perfecto para el alumno, casi siempre es lectura o audio.
- Se entiende lo que intenta decir. Nada de frases incoherentes ni de errores de la transcripción automática.
- Dura unos 5 a 15 segundos: entre 12 y 35 palabras seguidas.
- Preferiblemente al INICIO de una intervención del alumno (el minuto del corchete es entonces el segundo exacto del clip).
- La cita es LITERAL: copiada carácter a carácter de UN solo turno, sin cortar palabras, sin corregir, sin parafrasear. Se comprueba automáticamente y la que no aparezca se tira.
- "at" es el minuto del corchete de ese turno, copiado tal cual.
- El alumno intenta hablar INGLÉS: la mayor parte de la cita está en inglés. Nada de momentos en que explica gramática o habla con el profe en español.
- Cada clip es un momento distinto (no dos trozos del mismo turno). Si se puede, repártelos entre clases distintas.

Devuelve HASTA ${MAX_CLIPS} clips, ORDENADOS del más claro al menos claro. Si solo hay uno o dos que cumplan todas las reglas, devuelve solo esos: mejor pocos y buenos.`;

const SYSTEM_MALO = `Buscas material para un anuncio de una academia de inglés online para adultos hispanohablantes: el ANTES de un alumno. Recibes las transcripciones automáticas (Fathom) de sus primeras clases y eliges los momentos cortos en que SE TRABA intentando hablar inglés por su cuenta: duda, hace pausas o muletillas ("eh", "um"), empieza frases y las abandona, repite palabras, no le sale la pronunciación o la frase, o salta al español para salir del paso. Tiene que verse claramente que le cuesta, pero que se entienda qué intenta decir.

${CLIP_RULES}

"class_option" es el número de la CLASE (1, 2, 3...) donde está la cita. "why" es una frase corta en español que dice por qué es un momento malo (qué se ve en el clip).`;

const SYSTEM_BUENO = `Buscas material para un anuncio de una academia de inglés online para adultos hispanohablantes: el DESPUÉS de un alumno. Recibes las transcripciones automáticas (Fathom) de sus últimas clases y eliges los momentos cortos en que HABLA MUY BIEN inglés por su cuenta: con fluidez, frases completas e ideas encadenadas, sin apenas pausas ni español. No hace falta que toda la clase sea buena: basta un momento.

${CLIP_RULES}

"class_option" es el número de la CLASE (1, 2, 3...) donde está la cita. "why" es una frase corta en español que dice por qué es un momento bueno (qué se ve en el clip).`;

function schema(options: number): Record<string, unknown> {
  const momento = {
    type: 'object', additionalProperties: false,
    required: ['class_option', 'excerpt', 'at', 'why'],
    properties: {
      class_option: { type: 'integer', enum: Array.from({ length: options }, (_, i) => i + 1), description: 'Número de la CLASE donde está la cita.' },
      excerpt: { type: 'string', description: 'Cita LITERAL del alumno, de 12 a 35 palabras, copiada de un solo turno.' },
      at: { type: 'string', description: 'Minuto del corchete del turno de la cita, p. ej. "12:40".' },
      why: { type: 'string', description: 'Una frase corta en español: por qué es un momento malo o bueno.' },
    },
  };
  return {
    type: 'object', additionalProperties: false, required: ['momentos'],
    properties: {
      // Sin maxItems ni minItems: la API los rechaza o los ignora según el modelo.
      // El tope de MAX_CLIPS lo aplica el código.
      momentos: { type: 'array', items: momento, description: `Hasta ${MAX_CLIPS} clips, del más claro al menos claro.` },
    },
  };
}

export async function pickMoments(input: {
  kind: MomentKind;
  studentName: string;
  classes: MomentClass[];
  /** Reintento: por qué no valieron las citas anteriores. */
  retryNote?: string;
  /** Tope de la llamada (por defecto 25 s). */
  timeoutMs?: number;
}): Promise<AiResult<MomentsIA>> {
  const header = [
    `Alumno/a: ${input.studentName} (sus turnos van marcados ALUMNO)`,
    input.retryNote ? `OJO, en el intento anterior ninguna cita valió: ${input.retryNote} Elige citas que cumplan todas las reglas.` : '',
  ].filter(Boolean).join('\n');
  const body = input.classes
    .map((c, i) => `=== CLASE ${i + 1} (${c.date}) ===\n${c.turnsText}`)
    .join('\n\n');

  return askClaudeJson<MomentsIA>({
    label: `testimonial-${input.kind}`,
    model: FLUENCY_MODEL,
    system: input.kind === 'malo' ? SYSTEM_MALO : SYSTEM_BUENO,
    prompt: `${header}\n\n${body}`,
    schema: schema(input.classes.length),
    maxTokens: 1500,
    // Las dos llamadas van en paralelo, más la revisión, en una función de 60 s
    // (app/api/admin/testimonial-prepare).
    timeoutMs: input.timeoutMs ?? 25_000,
    maxRetries: 0,
    // La cita es literal y el minuto se copia: la limpieza de guiones los rompería.
    skipCleanKeys: ['excerpt', 'at'],
  });
}
