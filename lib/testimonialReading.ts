// Testimoniales — ¿HABLA ESPONTÁNEA O LECTURA EN VOZ ALTA? (servidor). SOLO SERVIDOR.
//
// Un DESPUÉS rápido y sin pausas muchas veces es el alumno LEYENDO un texto (un
// cuento, un diálogo del libro, su redacción). Eso no es un testimonio. Antes de
// armar testimonios (planificarTanda), los tramos que por sus medidas podrían ser
// un DESPUÉS se clasifican con Haiku sobre el texto de Deepgram + la frase previa
// del profe en Fathom. Se guarda en testimonial_listen_segments.lectura, así que
// cada tramo se paga una sola vez (decisión de Facundo, 02/11/2026).
//
// Requiere supabase-testimoniales-lectura.sql (columnas lectura y lectura_motivo).

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { askClaudeJson } from '@/lib/anthropic';
import { parseTurns } from '@/lib/fluency';

/** Barato y de sobra para esto (como el resto de tareas de volumen del proyecto). */
export const READING_MODEL = 'claude-haiku-4-5';
/** Precio de Haiku 4.5 por millón de tokens (entrada / salida), para el gasto. */
const USD_MTOK = { entrada: 1, salida: 5 };
const LOTE = 12;
const EN_PARALELO = 4;

type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

export type Lectura = 'espontaneo' | 'lectura';
export interface ReadingInput { id: string; texto: string; previa: string }
export interface ReadingVerdict { id: string; tipo: Lectura; motivo: string }

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array', description: 'Uno por tramo, con su id tal cual.',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'tipo', 'motivo'],
        properties: {
          id: { type: 'string' },
          tipo: { type: 'string', enum: ['espontaneo', 'lectura'] },
          motivo: { type: 'string', description: 'Por qué, en español, 15 palabras como mucho.' },
        },
      },
    },
  },
};

const SYSTEM = `Clasificas tramos de alumnos adultos de inglés en clases online por videollamada. De cada tramo tienes lo que dijo el alumno (transcripción automática, puede tener errores) y la frase anterior del profe.

"lectura": el alumno LEE en voz alta un texto escrito (libro, artículo, diálogo o ejercicio del libro, enunciados, frases para completar, una redacción o presentación que trae escrita) o repite un audio.
"espontaneo": el alumno habla con sus propias palabras: cuenta algo, responde a una pregunta, opina, describe una foto o una situación.

Pistas de lectura: el profe pide leer o señala un texto ("read", "lee", "next paragraph", "number three", "start from"); narración en tercera persona con nombres de personajes; diálogos de libro; vocabulario y gramática claramente por encima del resto del alumno; frases largas y perfectas sin titubeos ni autocorrecciones; cifras, fechas o títulos que suenan a texto escrito.
Pistas de habla espontánea: habla de su vida, su trabajo o su opinión en primera persona; errores típicos de alumno; autocorrecciones; "I think", "you know", "like"; responde a lo que le acaba de preguntar el profe.

Si no está claro, elige lo más probable.`;

const recorta = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

/** Clasifica tramos (en lotes de LOTE, varios lotes a la vez). Lo que falle queda sin veredicto. */
export async function classifyReading(items: ReadingInput[]): Promise<{ verdicts: ReadingVerdict[]; usd: number; errores: number }> {
  const lotes: ReadingInput[][] = [];
  for (let i = 0; i < items.length; i += LOTE) lotes.push(items.slice(i, i + LOTE));
  const verdicts: ReadingVerdict[] = [];
  let usd = 0, errores = 0;
  const uno = async (lote: ReadingInput[]) => {
    const prompt = lote.map(x => `### id: ${x.id}\nProfe justo antes: ${recorta(x.previa, 300) || '(no consta)'}\nAlumno: ${x.texto.slice(0, 700)}`).join('\n\n');
    const r = await askClaudeJson<{ items: ReadingVerdict[] }>({
      system: SYSTEM, prompt: `Clasifica estos ${lote.length} tramos.\n\n${prompt}`, schema: SCHEMA,
      maxTokens: 120 + 60 * lote.length, model: READING_MODEL, timeoutMs: 60_000, maxRetries: 2,
      label: 'testimonial-lectura', skipCleanKeys: ['id', 'tipo'],
    });
    if (r.usage) usd += (r.usage.input * USD_MTOK.entrada + r.usage.output * USD_MTOK.salida) / 1e6;
    const ids = new Set(lote.map(x => x.id));
    const ok = r.status === 'ready' ? (r.data?.items ?? []).filter(v => ids.has(v.id) && (v.tipo === 'lectura' || v.tipo === 'espontaneo')) : [];
    if (!ok.length) errores++;
    verdicts.push(...ok);
  };
  for (let i = 0; i < lotes.length; i += EN_PARALELO) await Promise.all(lotes.slice(i, i + EN_PARALELO).map(uno));
  return { verdicts, usd, errores };
}

/**
 * Texto de cada tramo + la frase previa del profe (el turno anterior de otra
 * persona en el transcript de Fathom). Solo lee, no gasta.
 */
export async function readingInputs(admin: SupabaseClient, segs: Array<{ id: string; analysisId: string; turnIndex: number; texto: string }>): Promise<ReadingInput[]> {
  const ids = [...new Set(segs.map(s => s.analysisId))];
  const turnsBy = new Map<string, ReturnType<typeof parseTurns>>();
  const labelBy = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 20) {
    const ch = ids.slice(i, i + 20);
    const [{ data: ca }, { data: tt }] = await Promise.all([
      admin.from('class_analyses').select('id, transcript').in('id', ch),
      admin.from('testimonial_transcripts').select('analysis_id, student_label').in('analysis_id', ch),
    ]);
    for (const r of (ca ?? []) as Row[]) turnsBy.set(String(r.id), parseTurns(String(r.transcript ?? '')));
    for (const r of (tt ?? []) as Row[]) labelBy.set(String(r.analysis_id), String(r.student_label ?? ''));
  }
  return segs.map(s => {
    const turns = turnsBy.get(s.analysisId) ?? [];
    const label = labelBy.get(s.analysisId) ?? turns[s.turnIndex]?.speaker ?? '';
    let previa = '';
    for (let k = s.turnIndex - 1; k >= 0 && k >= s.turnIndex - 4; k--) {
      if (turns[k] && turns[k].speaker !== label) { previa = turns[k].text; break; }
    }
    return { id: s.id, texto: s.texto, previa };
  });
}

/** Clasifica y guarda. Devuelve cuántos se guardaron y el gasto. */
export async function clasificarYGuardar(admin: SupabaseClient, segs: Array<{ id: string; analysisId: string; turnIndex: number; texto: string }>): Promise<{ guardados: number; usd: number; errores: number }> {
  if (!segs.length) return { guardados: 0, usd: 0, errores: 0 };
  const { verdicts, usd, errores } = await classifyReading(await readingInputs(admin, segs));
  let guardados = 0;
  for (let i = 0; i < verdicts.length; i += 10) {
    const r = await Promise.all(verdicts.slice(i, i + 10).map(v => admin.from('testimonial_listen_segments')
      .update({ lectura: v.tipo, lectura_motivo: v.motivo.slice(0, 300) }).eq('id', v.id)));
    const err = r.find(x => x.error)?.error;
    if (err) throw new Error(`testimonial_listen_segments (lectura): ${err.message}`);
    guardados += r.length;
  }
  return { guardados, usd, errores };
}
