// Testimoniales — la parte SIN IA del análisis de fluidez del alumno.
//
// Lee un transcript exportado de Fathom, averigua quién es el profe y quién el
// alumno, y decide si merece la pena gastar una llamada a la IA. Módulo PURO:
// no toca la red ni la base, así que se prueba entero en lib/fluency.test.ts.
//
// FORMATO DE FATHOM (78 de 80 transcripts de la muestra de sep/2026):
//
//   Impromptu Google Meet Meeting - August 25
//   VIEW RECORDING - 55 mins (No highlights): https://fathom.video/share/…
//   ---
//   0:01 - Nombre Alumno
//     So, is there anything to check today?
//   0:06 - Nombre Profe (profe@gmail.com)
//     No.
//
// El PROFE es quien organiza la reunión y Fathom le pone el email entre
// paréntesis. Es la pista más fiable (70 de 78): los nombres de la plataforma
// solo coinciden con los de Meet en ~60 de 78.

import { normName } from '@/lib/retention';

/** Por debajo de esto no hay material para juzgar la soltura. */
export const MIN_WORDS = 800;

export type FluencySkipReason =
  | 'pocas_palabras'
  | 'mas_de_dos_hablantes'
  | 'un_solo_hablante'
  | 'sin_formato_hablantes';

export interface Turn {
  /** Minuto tal como lo escribe Fathom: "12:40" o "1:02:15". */
  at: string;
  speaker: string;
  text: string;
}

export interface FluencyPrep {
  turns: Turn[];
  speakers: string[];
  wordCount: number;
  teacherSpeaker: string | null;
  studentSpeaker: string | null;
  /** % de palabras del alumno según las ETIQUETAS de Fathom (que a veces fallan). */
  labelShare: number | null;
  fathomUrl: string | null;
  skip: FluencySkipReason | null;
}

const TURN_HEADER = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s+-\s+(.+?)\s*$/;
const EMAIL_IN_LABEL = /\([^()\s]+@[^()\s]+\)/;

const countWords = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** Turnos de habla. Lo que va antes del primer "m:ss - Nombre" (título, enlace) se ignora. */
export function parseFathomTurns(transcript: string): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const line of (transcript ?? '').split(/\r?\n/)) {
    const m = line.match(TURN_HEADER);
    if (m) {
      if (current) turns.push(current);
      current = { at: m[1], speaker: m[2].trim(), text: '' };
    } else if (current && line.trim()) {
      current.text = current.text ? `${current.text} ${line.trim()}` : line.trim();
    }
  }
  if (current) turns.push(current);
  return turns.filter(t => t.text);
}

// Formato de SUBTÍTULOS (Meet/Zoom), el otro que aparece con hablantes:
//   06:03:51 --> 06:03:53
//   Nury Barreto: Michael Jast?
// Sin emails: el profe se identifica por los nombres.
const CAPTION_TIME = /^\s*(\d{1,2}:\d{2}:\d{2})(?:[.,]\d+)?\s*-->\s*\d{1,2}:\d{2}:\d{2}/;
const CAPTION_LINE = /^\s*([^:]{2,60}?):\s+(.+)$/;

export function parseCaptionTurns(transcript: string): Turn[] {
  const turns: Turn[] = [];
  let at: string | null = null;
  for (const line of (transcript ?? '').split(/\r?\n/)) {
    const t = line.match(CAPTION_TIME);
    if (t) { at = t[1].replace(/^0(?=\d:)/, ''); continue; }
    const m = at ? line.match(CAPTION_LINE) : null;
    if (m && at) {
      turns.push({ at, speaker: m[1].trim(), text: m[2].trim() });
      at = null;
    }
  }
  return turns;
}

/** Turnos del transcript en cualquiera de los dos formatos con hablantes. */
export function parseTurns(transcript: string): Turn[] {
  const fathom = parseFathomTurns(transcript);
  return fathom.length >= 5 ? fathom : parseCaptionTurns(transcript);
}

/** Primer enlace de Fathom del transcript (la grabación), si lo trae. */
export function extractFathomUrl(transcript: string): string | null {
  const m = (transcript ?? '').match(/https?:\/\/(?:www\.)?fathom\.video\/[^\s)>\]"']+/i);
  return m ? m[0] : null;
}

/** Primer nombre normalizado ("María José Pérez" → "maria"). */
const firstName = (s: string | null | undefined): string => normName(s).split(' ')[0] ?? '';

/**
 * Quién es el profe entre los hablantes. Orden de confianza:
 *   1. el ÚNICO que lleva email entre paréntesis;
 *   2. el que contiene el nombre del profe de la plataforma;
 *   3. con dos hablantes, el que NO contiene el nombre del alumno.
 * Si nada lo decide, null: la IA recibe los nombres y lo deduce por el contenido.
 */
export function identifyTeacher(
  speakers: string[], names: { teacherName?: string | null; studentName?: string | null },
): string | null {
  const withEmail = speakers.filter(s => EMAIL_IN_LABEL.test(s));
  if (withEmail.length === 1) return withEmail[0];

  const t = firstName(names.teacherName);
  const byTeacher = t ? speakers.filter(s => normName(s).includes(t)) : [];
  if (byTeacher.length === 1) return byTeacher[0];

  const a = firstName(names.studentName);
  if (speakers.length === 2 && a) {
    const notStudent = speakers.filter(s => !normName(s).includes(a));
    if (notStudent.length === 1) return notStudent[0];
  }
  return null;
}

/** Todo lo que se sabe del transcript antes de (y para decidir si) llamar a la IA. */
export function prepareFluency(
  transcript: string, names: { teacherName?: string | null; studentName?: string | null } = {},
): FluencyPrep {
  const turns = parseTurns(transcript);
  const speakers = [...new Set(turns.map(t => t.speaker))];
  const wordCount = turns.reduce((n, t) => n + countWords(t.text), 0);
  const fathomUrl = extractFathomUrl(transcript);

  const teacherSpeaker = speakers.length === 2 ? identifyTeacher(speakers, names) : null;
  const studentSpeaker = teacherSpeaker ? speakers.find(s => s !== teacherSpeaker) ?? null : null;

  let labelShare: number | null = null;
  if (studentSpeaker && wordCount > 0) {
    const w = turns.filter(t => t.speaker === studentSpeaker).reduce((n, t) => n + countWords(t.text), 0);
    labelShare = Math.round((100 * w) / wordCount);
  }

  // Menos de 5 turnos = no es un transcript con hablantes. Suele ser el RESUMEN
  // de Fathom ("Meeting Purpose / Key Takeaways") pegado en lugar del transcript.
  const skip: FluencySkipReason | null =
      turns.length < 5         ? 'sin_formato_hablantes'
    : speakers.length > 2      ? 'mas_de_dos_hablantes'
    : speakers.length < 2      ? 'un_solo_hablante'
    : wordCount < MIN_WORDS    ? 'pocas_palabras'
    : null;

  return { turns, speakers, wordCount, teacherSpeaker, studentSpeaker, labelShare, fathomUrl, skip };
}

/**
 * El transcript tal como lo lee la IA: una línea por turno, con el ROL delante
 * y sin los emails (no aportan y gastan tokens).
 *   [12:40] ALUMNO (Sonia): I was afraid of the dark...
 */
export function formatTurnsForAi(prep: Pick<FluencyPrep, 'turns' | 'teacherSpeaker' | 'studentSpeaker'>): string {
  const clean = (s: string) => s.replace(EMAIL_IN_LABEL, '').trim();
  const role = (s: string) =>
      s === prep.teacherSpeaker ? `PROFE (${clean(s)})`
    : s === prep.studentSpeaker ? `ALUMNO (${clean(s)})`
    : clean(s);
  return prep.turns.map(t => `[${t.at}] ${role(t.speaker)}: ${t.text}`).join('\n');
}

// ── Evidencia del transcript, sin IA (testimoniales V3) ─────────────────────
//
// ¿En qué idioma está una intervención? Se cuentan palabras de función, que
// aparecen en cualquier frase y casi no se cruzan entre los dos idiomas. No es
// un detector de idioma de verdad, pero para separar "el alumno habla inglés"
// de "el alumno se pasa al español" en un turno entero basta y no cuesta nada.
const EN_WORDS = new Set(('the and you is are was were have has i it to of in that this what do does did not but '
  + 'with for my your can will would going like think know really very so because').split(' '));
const ES_WORDS = new Set(('el la los las que de y en es un una por para con no lo se pero como muy porque yo tu '
  + 'mi está estoy tengo hay sí bueno vale entonces').split(' '));

/** Lo que mide la evidencia en UNA clase: las intervenciones en inglés del alumno. */
export interface EnglishStats {
  /** Media de palabras de sus N intervenciones en inglés más largas. */
  topTurnsMean: number;
  /** Cuántas intervenciones en inglés de al menos `longWords` palabras hace. */
  longTurns: number;
}

/**
 * Intervenciones en inglés del alumno en una clase. null si no se sabe quién es
 * el alumno (sin hablantes, o el profe no se identificó): esa clase no cuenta.
 */
export function studentEnglishStats(
  prep: Pick<FluencyPrep, 'turns' | 'studentSpeaker' | 'skip'>,
  opts: { top: number; longWords: number },
): EnglishStats | null {
  if (prep.skip || !prep.studentSpeaker) return null;
  const lengths: number[] = [];
  for (const t of prep.turns) {
    if (t.speaker !== prep.studentSpeaker) continue;
    const words = t.text.toLowerCase().match(/[a-záéíóúüñ']+/g) ?? [];
    let en = 0, es = 0;
    for (const w of words) {
      if (EN_WORDS.has(w)) en++;
      if (ES_WORDS.has(w)) es++;
    }
    if (en > es) lengths.push(words.length);
  }
  lengths.sort((a, b) => b - a);
  const top = lengths.slice(0, opts.top);
  return {
    topTurnsMean: top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0,
    longTurns: lengths.filter(n => n >= opts.longWords).length,
  };
}

/**
 * Solo lo que dice el ALUMNO, para la comparación a ciegas: sin el profe, sin
 * nombres y sin minutos (nada que delate cuál de las dos clases es la antigua).
 * Las respuestas de menos de 4 palabras ("yes", "ok, perfect") se saltan: no
 * dicen nada de la soltura y gastarían el espacio. Se corta en `maxChars` por el
 * final de un turno.
 */
export function studentOnlyText(
  prep: Pick<FluencyPrep, 'turns' | 'studentSpeaker'>, maxChars: number,
): string {
  const out: string[] = [];
  let size = 0;
  for (const t of prep.turns) {
    if (t.speaker !== prep.studentSpeaker || countWords(t.text) < 4) continue;
    const line = `- ${t.text}`;
    if (size + line.length > maxChars && out.length > 0) break;
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n');
}

/** Texto comparable: sin acentos, sin puntuación, espacios simples, minúsculas. */
function comparable(s: string): string {
  return (s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * ¿La cita que devolvió la IA aparece de verdad en lo que se dijo? Se busca en el
 * texto hablado (no en las etiquetas), tolerando puntuación y mayúsculas. Una
 * cita inventada no debe llegar nunca a pedirle al profe un minuto concreto.
 */
export function excerptFound(turns: Turn[], excerpt: string | null | undefined): boolean {
  const needle = comparable(excerpt ?? '');
  if (needle.split(' ').length < 3) return false;
  return comparable(turns.map(t => t.text).join(' ')).includes(needle);
}

// ── Segundo exacto de una cita (clips de testimonios) ─────────────────────────
//
// Fathom solo pone la hora al INICIO de cada intervención ("12:40 - Nombre"), con
// precisión de segundo. Si la cita está en mitad de una intervención larga, se
// estima por la posición de sus palabras entre el inicio de esa intervención y
// el de la siguiente. La IA tiene pedido elegir citas al inicio de una
// intervención, donde el segundo es exacto.

/** "12:40" o "1:02:15" → segundos. null si no es una hora. */
export function toSeconds(at: string | null | undefined): number | null {
  const m = (at ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

/** Segundos → "12:40" o "1:02:15", como los escribe Fathom. */
export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export interface ExcerptLocation {
  turnIndex: number;
  /** Palabras de la intervención antes de la cita (0 = empieza la intervención). */
  wordsBefore: number;
  turnWords: number;
}

/**
 * Dónde está la cita: la intervención que la contiene entera. null si no está
 * (o si cruza dos intervenciones: entonces mezcla dos voces y no sirve de clip).
 */
export function locateExcerpt(turns: Turn[], excerpt: string | null | undefined): ExcerptLocation | null {
  const needle = comparable(excerpt ?? '');
  if (needle.split(' ').length < 3) return null;
  for (let i = 0; i < turns.length; i++) {
    const hay = comparable(turns[i].text);
    // Por palabras enteras: "I go" no debe encontrarse dentro de "I gone".
    const idx = ` ${hay} `.indexOf(` ${needle} `);
    if (idx < 0) continue;
    const before = hay.slice(0, idx).trim();
    return { turnIndex: i, wordsBefore: before ? before.split(' ').length : 0, turnWords: hay.split(' ').length };
  }
  return null;
}

/** Palabras por segundo de reserva si no hay intervención siguiente para medir. */
const WORDS_PER_SECOND = 2.5;

/**
 * Segundo en que empieza la cita. Al inicio de una intervención es la hora de
 * Fathom tal cual; en mitad, se reparte el tiempo de la intervención por palabras
 * y se adelanta 1 s de margen (nunca antes del inicio de la intervención).
 */
export function excerptStartSeconds(turns: Turn[], loc: ExcerptLocation): number | null {
  const start = toSeconds(turns[loc.turnIndex]?.at);
  if (start == null) return null;
  if (loc.wordsBefore === 0) return start;
  const next = toSeconds(turns[loc.turnIndex + 1]?.at);
  const offset = next != null && next > start
    ? ((next - start) * loc.wordsBefore) / Math.max(1, loc.turnWords)
    : loc.wordsBefore / WORDS_PER_SECOND;
  return Math.max(start, Math.floor(start + offset) - 1);
}

/** Enlace de Fathom que abre la grabación en ese segundo (?timestamp=SEGUNDOS). */
export function withFathomTimestamp(url: string | null | undefined, seconds: number | null | undefined): string | null {
  if (!url) return null;
  if (seconds == null) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('timestamp', String(Math.max(0, Math.round(seconds))));
    return u.toString();
  } catch {
    return url;
  }
}
