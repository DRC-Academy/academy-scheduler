// Testimoniales — Haiku elige los dos momentos del clip. SOLO SERVIDOR.
// Modelo: claude-haiku-4-5 (~3-5 céntimos por alumno: lee hasta 6 transcripts).
//
// Dos llamadas por alumno:
//   · 'malo':  el PEOR momento entre sus primeras clases (donde más se traba);
//   · 'bueno': el MEJOR entre sus últimas, y el resumen de 2 frases para el admin.
// El código comprueba después que la cita existe literal y que es del alumno
// (lib/testimonialStore), y calcula su segundo exacto (lib/fluency).

import 'server-only';   // llega al SDK de Anthropic vía askClaudeJson

import { askClaudeJson, type AiResult } from '@/lib/anthropic';
import { FLUENCY_MODEL } from '@/lib/analyzeFluency';

export type MomentKind = 'malo' | 'bueno';

export interface MomentIA {
  class_option: number;
  excerpt: string;
  at: string;
  why: string;
  /** Solo en 'bueno'. */
  summary?: string;
}

/** Una clase tal como se le enseña a la IA. */
export interface MomentClass {
  date: string;
  /** Transcript con roles (lib/fluency formatTurnsForAi). */
  turnsText: string;
}

const CLIP_RULES = `REGLAS DEL CLIP (todas obligatorias):
- Habla el ALUMNO, no el profe. Fathom a veces pega frases del profe en un turno del alumno: una frase que corrige, explica gramática, da instrucciones o felicita es del profe aunque la etiqueta diga ALUMNO. Esas no valen.
- Habla espontáneamente. Nada de lectura en voz alta de un texto o ejercicio, ni de repetir lo que acaba de decir el profe, ni de frases memorizadas.
- Se entiende lo que intenta decir. Nada de frases incoherentes ni de errores de la transcripción automática.
- Dura unos 5 a 7 segundos: entre 12 y 25 palabras seguidas.
- Preferiblemente al INICIO de una intervención del alumno (el minuto del corchete es entonces el segundo exacto del clip).
- La cita es LITERAL: copiada carácter a carácter de UN solo turno, sin cortar palabras, sin corregir, sin parafrasear. Se comprueba automáticamente.
- "at" es el minuto del corchete de ese turno, copiado tal cual.`;

const SYSTEM_MALO = `Buscas material para un anuncio de una academia de inglés online para adultos hispanohablantes: el ANTES de un alumno. Recibes las transcripciones automáticas (Fathom) de sus primeras clases y eliges el momento en que MÁS SE TRABA hablando inglés: pausas, muletillas ("eh", "um"), frases que empieza y abandona, palabras repetidas, saltos al español para salir del paso. Tiene que verse claramente que le cuesta, pero que se entienda qué intenta decir.

${CLIP_RULES}

"class_option" es el número de la CLASE (1, 2, 3...) donde está la cita. "why" es una frase en español que explica qué se ve en el clip.`;

const SYSTEM_BUENO = `Buscas material para un anuncio de una academia de inglés online para adultos hispanohablantes: el DESPUÉS de un alumno. Recibes las transcripciones automáticas (Fathom) de sus últimas clases y eliges el momento en que MEJOR HABLA inglés: frases largas y completas, ideas encadenadas, sin apenas pausas ni español. Te doy también su momento malo de las primeras clases, para que el contraste sea claro.

${CLIP_RULES}

"class_option" es el número de la CLASE (1, 2, 3...) donde está la cita. "why" es una frase en español que explica qué se ve en el clip.
"summary": EXACTAMENTE DOS frases en español: la primera describe cómo hablaba el alumno antes y la segunda cómo habla ahora. Concretas, sin exagerar, aptas para que el equipo decida si pedir las grabaciones.`;

function schema(kind: MomentKind, options: number): Record<string, unknown> {
  const props: Record<string, unknown> = {
    class_option: { type: 'integer', enum: Array.from({ length: options }, (_, i) => i + 1), description: 'Número de la CLASE donde está la cita.' },
    excerpt: { type: 'string', description: 'Cita LITERAL del alumno, de 12 a 25 palabras, copiada de un solo turno.' },
    at: { type: 'string', description: 'Minuto del corchete del turno de la cita, p. ej. "12:40".' },
    why: { type: 'string', description: 'Una frase en español: qué se ve en el clip.' },
  };
  const required = ['class_option', 'excerpt', 'at', 'why'];
  if (kind === 'bueno') {
    props.summary = { type: 'string', description: 'Exactamente DOS frases en español: cómo hablaba antes y cómo habla ahora.' };
    required.push('summary');
  }
  return { type: 'object', additionalProperties: false, required, properties: props };
}

export async function pickMoment(input: {
  kind: MomentKind;
  studentName: string;
  classes: MomentClass[];
  /** 'bueno': el momento malo ya elegido, para el contraste y el resumen. */
  badMoment?: { date: string; excerpt: string };
  /** Reintento: por qué no valió la cita anterior. */
  retryNote?: string;
  /** Tope de la llamada (por defecto 25 s). */
  timeoutMs?: number;
}): Promise<AiResult<MomentIA>> {
  const header = [
    `Alumno/a: ${input.studentName}`,
    input.badMoment ? `Su momento MALO (clase del ${input.badMoment.date}): "${input.badMoment.excerpt}"` : '',
    input.retryNote ? `OJO, en el intento anterior: ${input.retryNote} Elige una cita que cumpla todas las reglas.` : '',
  ].filter(Boolean).join('\n');
  const body = input.classes
    .map((c, i) => `=== CLASE ${i + 1} (${c.date}) ===\n${c.turnsText}`)
    .join('\n\n');

  return askClaudeJson<MomentIA>({
    label: `testimonial-${input.kind}`,
    model: FLUENCY_MODEL,
    system: input.kind === 'malo' ? SYSTEM_MALO : SYSTEM_BUENO,
    prompt: `${header}\n\n${body}`,
    schema: schema(input.kind, input.classes.length),
    maxTokens: 800,
    // Dos llamadas por alumno en una función de 60 s (app/api/admin/testimonial-prepare).
    timeoutMs: input.timeoutMs ?? 25_000,
    maxRetries: 0,
    // La cita es literal y el minuto se copia: la limpieza de guiones los rompería.
    skipCleanKeys: ['excerpt', 'at'],
  });
}
