// Testimoniales V6 — clips A ("antes", se traba) y B ("después", habla fluido)
// elegidos SOLO CON CÓDIGO, entre TODAS las intervenciones del alumno.
//
// Módulo PURO (sin red ni base). Lo prueba lib/testimonialScoring.test.ts. Los
// umbrales y pesos viven en lib/testimonialConfig.
//
//   1. extractSegments: de un transcript ya resuelto (lib/testimonialSpeaker), los
//      recortes de frases de las intervenciones del alumno que pueden ser clip,
//      con sus rasgos medidos (muletillas, repeticiones, búsqueda de palabra,
//      palabras en español, velocidad). Fuera: cortas, en español, lecturas y audios.
//   2. blockingScore / fluencyScore: la puntuación de cada recorte como A y como
//      B, con la velocidad relativa al promedio del alumno.
//   3. choosePair: la mejor pareja de un alumno (una sola), o por qué no hay.

import { toSeconds, readingCue, type Turn } from '@/lib/fluency';
import { soundsScripted } from '@/lib/testimonialPairs';
import * as C from '@/lib/testimonialConfig';

// ── Rasgos del texto ─────────────────────────────────────────────────────────

const plainWords = (s: string): string[] =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-zñ']+/).filter(Boolean);

/** Muletillas de peso completo (con sus versiones alargadas: "ummm", "hmmm"). */
const FILLER = /^(?:um+|uh+|e+hh+|mm+|hm+|em+|am+m)$/;
/** "ah" / "eh": pesan menos, y nada si van seguidas de una respuesta ("ah, ok"). */
const AH_EH = /^(?:a+h+|eh)$/;
const AH_EH_ACK = new Set(['ok', 'okay', 'yes', 'yeah', 'right', 'sure']);

/** Repeticiones que son normales al hablar, no un bloqueo ("bye bye", "no no"). */
const NATURAL_REPEATS = new Set(['bye', 'yes', 'yeah', 'no', 'ok', 'okay', 'very', 'ha', 'hi', 'hey']);

const WORD_SEARCH = new RegExp([
  'how (?:do|can|could|would) (?:you|i) say',
  'how (?:do|can) you call',
  "i (?:don'?t|do not) know how to (?:say|call|explain)",
  "what(?:'s| is) the word",
  'c[oó]mo se (?:dice|llama|dec[ií]a)',
  'c[oó]mo (?:lo )?digo',
  'no s[eé] c[oó]mo',
].map(p => `(?<![\\p{L}])${p}(?![\\p{L}])`).join('|'), 'giu');

/** Palabras frecuentes del español que NO existen en inglés. */
const ES_INLINE = new Set(('que pero porque entonces bueno pues vale como eso esto esta este estoy tengo '
  + 'muy tambien nada algo osea el los las del una uno con para por mas cuando donde y de es '
  + 'yo se lo le la en un hay fue tiene hace digo creo').split(' '));
/** Otras palabras del español muy frecuentes al hablar (solo para decidir el idioma). */
const ES_EXTRA = new Set(('bien mal si mucho mucha muchos poco todo todos ahora siempre nunca hoy ayer manana '
  + 'gracias claro perdon sea tu mira oye estan tranquila tranquilo verdad vamos voy vas va sabes se '
  + 'asi aqui alli ya bastante gente cosa cosas tambien solo mismo otra otro hola dia').split(' '));
/** Palabras frecuentes del inglés (para decidir el idioma de un recorte). */
const EN_COMMON = new Set(('the and i is to it you in of that was my we they he she have has are this but with for '
  + 'be do did what so like at on about there can would not because when me your our us his her them their '
  + 'a an if or as from by up out just think know go going went get got really very much more some all one '
  + 'time people work day week also then than which who will been had were could should yes yeah well good '
  + 'little lot things thing make made want need say said see because how now here its it\'s i\'m don\'t '
  + 'i\'ve that\'s there\'s can\'t didn\'t of other years year family friends school job house').split(' '));
/** Terminaciones claramente españolas ("rencoroso", "situación", "realidad"). */
const ES_SUFFIX = /(?:cion|ciones|idad|idades|oso|osa|osos|osas)$/;
const FIRST_PERSON = new Set(['i', "i'm", "i've", "i'd", "i'll", 'my', 'me', 'mine', 'myself', 'we', "we're", "we've", 'our', 'us']);

/**
 * ¿El recorte está sobre todo en español? Palabras reconocibles de cada idioma:
 * gana el que más tenga (a igualdad, español: mejor perder un clip dudoso).
 */
export function isSpanish(text: string): boolean {
  let es = 0, en = 0;
  for (const raw of text.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean)) {
    const w = plainWords(raw).join('');
    if (EN_COMMON.has(w) || EN_COMMON.has(raw)) en++;
    else if (/[ñáéíóú]/.test(raw) || ES_INLINE.has(w) || ES_EXTRA.has(w) || (w.length >= 6 && ES_SUFFIX.test(w))) es++;
  }
  return es > 0 && es >= en;
}

export interface TextFeatures {
  words: number;
  /** Muletillas ponderadas (ah/eh a PESO_AH_EH, el resto a PESO_MULETILLA). */
  fillers: number;
  repeats: number;
  searches: number;
  spanishWords: number;
}

export function textFeatures(text: string): TextFeatures {
  // Palabras con sus tildes (para reconocer el español) y sin ellas (para comparar).
  const raw = text.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
  const ws = raw.map(w => plainWords(w).join(''));
  let fillers = 0, repeats = 0, spanishWords = 0;
  ws.forEach((w, i) => {
    if (!w) return;
    if (FILLER.test(w)) { fillers += C.PESO_MULETILLA; return; }
    if (AH_EH.test(w)) {
      const next = ws[i + 1];
      const ack = (next && AH_EH_ACK.has(next)) || (next === 'i' && ws[i + 2] === 'see');
      if (!ack) fillers += C.PESO_AH_EH;
      return;
    }
    if (i > 0 && w === ws[i - 1] && !NATURAL_REPEATS.has(w)) repeats++;
    if (/[ñáéíóú]/.test(raw[i]) || ES_INLINE.has(w) || (w.length >= 6 && ES_SUFFIX.test(w))) spanishWords++;
  });
  const searches = (text.match(WORD_SEARCH) ?? []).length;
  return { words: ws.filter(Boolean).length, fillers, repeats, searches, spanishWords };
}

/** Bloqueo SIN la lentitud: lo que se oye en el clip. */
export function linguisticBlock(f: Pick<TextFeatures, 'fillers' | 'repeats' | 'searches' | 'spanishWords'>): number {
  return f.fillers
    + f.repeats * C.PESO_REPETICION
    + f.searches * C.PESO_BUSQUEDA_PALABRA
    + Math.min(f.spanishWords, C.MAX_PALABRAS_ESPANOL) * C.PESO_PALABRA_ESPANOL;
}

// ── Recortes dentro de las intervenciones del alumno ─────────────────────────

export type SegmentKind = 'A' | 'B';

/** Un recorte que puede ser clip A o clip B, con todo lo medido. */
export interface Segment extends TextFeatures {
  /** `${analysisId}:${turnIndex}:${kind}:${palabras antes del recorte}` */
  id: string;
  kind: SegmentKind;
  analysisId: string;
  studentGroup: string;
  teacherId: string | null;
  /** 'YYYY-MM-DD', fecha de la clase en España. */
  classDay: string;
  studentLabel: string;
  fathomUrl: string | null;
  turnIndex: number;
  /** Segundos desde el inicio de la grabación (estimados dentro de la intervención). */
  start: number;
  end: number;
  text: string;
  /** Palabras por minuto de la intervención entera (dentro no hay tiempos). */
  turnWpm: number;
  /** El turno anterior es del profe (el B tiene que contestarle). */
  teacherBefore: boolean;
}

export const segDuration = (s: Pick<Segment, 'start' | 'end'>): number => s.end - s.start;

/** Lo que quedó fuera al extraer (para la auditoría). */
export interface ExtractStats {
  intervenciones: number;
  /** Sin minuto de fin (la última) o de menos de MIN_PALABRAS_CLIP. */
  cortas: number;
  /** Intervenciones sobre todo en español (sus recortes en inglés sí se miran). */
  espanol: number;
  lectura: number;
  /** Recortes guardados como posible A y como posible B. */
  recortesA: number;
  recortesB: number;
  /** Para el promedio de velocidad del alumno (intervenciones de 5+ palabras y ≤120 s). */
  palabras: number;
  segundos: number;
}

export interface ExtractInput {
  analysisId: string;
  studentGroup: string;
  teacherId: string | null;
  classDay: string;
  studentLabel: string;
  fathomUrl: string | null;
  turns: Turn[];
}

/** ¿Vale como A por lo que se oye (sin contar la velocidad)? */
export const canBeA = (s: Segment): boolean =>
  s.kind === 'A' && segDuration(s) >= C.MIN_DURACION_A_SEG && s.words >= C.MIN_PALABRAS_CLIP
  && linguisticBlock(s) >= C.MIN_BLOQUEO_LINGUISTICO_A && !isSpanish(s.text);

/** ¿Vale como B por lo que se oye (sin contar la velocidad)? */
export const canBeB = (s: Segment): boolean =>
  s.kind === 'B' && segDuration(s) >= C.MIN_DURACION_B_SEG && s.words >= C.MIN_PALABRAS_CLIP
  && s.searches === 0 && linguisticBlock(s) <= C.MAX_BLOQUEO_B && s.teacherBefore && !isSpanish(s.text)
  && (s.text.match(/[?¿]/g) ?? []).length <= C.MAX_PREGUNTAS_B
  && (!C.B_EN_PRIMERA_PERSONA || inFirstPerson(s.text))
  && !(C.DESCARTAR_B_SIN_DUDAS && soundsScripted(s.text));

/** ¿Habla de sí mismo? (I, my, me, we, our…) */
export const inFirstPerson = (text: string): boolean =>
  text.toLowerCase().split(/[^\p{L}']+/u).some(w => FIRST_PERSON.has(w.replace(/[’]/g, "'")));

/**
 * Trozos de una intervención: sus frases, y las que duran más que `maxSec`
 * partidas en trozos de palabras que sí caben.
 */
export function turnUnits(text: string, secondsPerWord: number, maxSec: number): string[] {
  const maxWords = Math.max(1, Math.floor(maxSec / Math.max(secondsPerWord, 0.01)));
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?…])\s+/).filter(Boolean)) {
    const ws = sentence.split(/\s+/).filter(Boolean);
    for (let i = 0; i < ws.length; i += maxWords) out.push(ws.slice(i, i + maxWords).join(' '));
  }
  return out;
}

/**
 * Los recortes de UNA intervención para un tipo de clip: desde cada frase, se
 * añaden frases seguidas mientras quepan en el máximo del tipo (A: lo justo
 * alrededor del bloqueo; B: lo más largo posible, hasta MAX_DURACION_B_SEG).
 */
export function turnWindows(kind: SegmentKind, input: ExtractInput, i: number, start: number, end: number): Segment[] {
  const { turns, studentLabel } = input;
  const t = turns[i];
  const maxSec = kind === 'A' ? C.MAX_DURACION_A_SEG : C.MAX_DURACION_B_SEG;
  const spaceWords = t.text.split(/\s+/).filter(Boolean).length;
  const spw = (end - start) / Math.max(1, spaceWords);
  const units = turnUnits(t.text, spw, maxSec);
  const unitWords = units.map(u => u.split(/\s+/).filter(Boolean).length);
  const prev = turns[i - 1];
  const out: Segment[] = [];
  let before = 0;
  for (let a = 0; a < units.length; a++) {
    let words = 0, b = a;
    while (b < units.length && (words + unitWords[b]) * spw <= maxSec + 0.5) words += unitWords[b++];
    if (b > a) {
      const text = units.slice(a, b).join(' ');
      const s0 = start + before * spw;
      // Al inicio de la intervención el segundo es exacto; en medio, 1 s de margen.
      const segStart = before === 0 ? start : Math.max(start, Math.floor(s0) - 1);
      const segEnd = b === units.length ? end : Math.min(end, Math.ceil(s0 + words * spw) + 1);
      out.push({
        ...textFeatures(text), id: `${input.analysisId}:${i}:${kind}:${before}`, kind,
        analysisId: input.analysisId, studentGroup: input.studentGroup, teacherId: input.teacherId,
        classDay: input.classDay, studentLabel, fathomUrl: input.fathomUrl, turnIndex: i,
        start: segStart, end: segEnd, text, turnWpm: (spaceWords / (end - start)) * 60,
        teacherBefore: !!prev && prev.speaker !== studentLabel,
      });
    }
    before += unitWords[a];
  }
  return out;
}

/** Los `limit` mejores según `better` (>0 si el primero es mejor), sin dos que se pisen. */
function bestNonOverlapping(list: Segment[], limit: number, better: (x: Segment, y: Segment) => number): Segment[] {
  const chosen: Segment[] = [];
  for (const s of [...list].sort((x, y) => better(y, x) || x.start - y.start)) {
    if (chosen.length === limit) break;
    if (chosen.some(c => c.analysisId === s.analysisId && c.start < s.end && s.start < c.end)) continue;
    chosen.push(s);
  }
  return chosen;
}

/**
 * Los recortes de un transcript que se guardan: los MAX_RECORTES_POR_CLASE
 * mejores A (más bloqueo, más lentos) y B (más rápidos, menos bloqueo, más
 * largos). Fuera: intervenciones cortas, en español y lecturas o audios.
 */
export function extractSegments(input: ExtractInput): { segments: Segment[]; stats: ExtractStats } {
  const { turns, studentLabel } = input;
  const stats: ExtractStats = { intervenciones: 0, cortas: 0, espanol: 0, lectura: 0, recortesA: 0, recortesB: 0, palabras: 0, segundos: 0 };
  const As: Segment[] = [], Bs: Segment[] = [];
  turns.forEach((t, i) => {
    if (t.speaker !== studentLabel) return;
    stats.intervenciones++;
    const start = toSeconds(t.at), next = toSeconds(turns[i + 1]?.at);
    // Sin turno siguiente no hay fin: no sirve de clip.
    if (start == null || next == null || next <= start) { stats.cortas++; return; }
    const words = plainWords(t.text).length;
    if (words >= 5 && next - start <= 120) { stats.palabras += words; stats.segundos += next - start; }
    if (words < C.MIN_PALABRAS_CLIP) { stats.cortas++; return; }
    if (readingCue(turns, i)) { stats.lectura++; return; }
    // El español se mira por RECORTE (canBeA / canBeB): en una intervención que
    // mezcla idiomas, el trozo en inglés puede servir. Aquí solo se cuenta.
    if (isSpanish(t.text)) stats.espanol++;
    As.push(...turnWindows('A', input, i, start, next).filter(canBeA));
    Bs.push(...turnWindows('B', input, i, start, next).filter(canBeB));
  });
  const a = bestNonOverlapping(As, C.MAX_RECORTES_POR_CLASE, (x, y) =>
    linguisticBlock(x) - linguisticBlock(y) || y.turnWpm - x.turnWpm);
  const b = bestNonOverlapping(Bs, C.MAX_RECORTES_POR_CLASE, (x, y) =>
    x.turnWpm - y.turnWpm || linguisticBlock(y) - linguisticBlock(x) || segDuration(x) - segDuration(y));
  stats.recortesA = a.length; stats.recortesB = b.length;
  return { segments: [...a, ...b], stats };
}

/** Palabras por minuto del alumno, o null si hay poco habla para fiarse. */
export function averageWpm(stats: Array<Pick<ExtractStats, 'palabras' | 'segundos'>>): number | null {
  const w = stats.reduce((a, s) => a + s.palabras, 0), s = stats.reduce((a, x) => a + x.segundos, 0);
  return s >= C.MIN_SEGUNDOS_PROMEDIO ? (w / s) * 60 : null;
}

const STEP = 1 - C.FACTOR_VELOCIDAD_A;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Puntuación de bloqueo del A: lo que se oye + lo lento que va respecto a su promedio. */
export function blockingScore(s: Pick<Segment, 'turnWpm' | 'fillers' | 'repeats' | 'searches' | 'spanishWords'>, avgWpm: number | null): number {
  const slow = avgWpm ? clamp((1 - s.turnWpm / avgWpm) / STEP, 0, C.MAX_PUNTOS_LENTITUD_A) : 0;
  return linguisticBlock(s) + slow * C.PESO_LENTITUD_A;
}

/** Puntuación de fluidez del B: lo rápido que va respecto a su promedio, menos lo que se traba. */
export function fluencyScore(s: Pick<Segment, 'turnWpm' | 'fillers' | 'repeats' | 'searches' | 'spanishWords'>, avgWpm: number | null): number {
  const fast = avgWpm ? clamp((s.turnWpm / avgWpm - 1) / STEP, 0, C.MAX_PUNTOS_RAPIDEZ_B) : 0;
  return fast * C.PESO_RAPIDEZ_B - linguisticBlock(s);
}

// ── La pareja de un alumno ───────────────────────────────────────────────────

export type NoPairReason =
  | 'sin_clip_a'          // ningún recorte con bloqueo
  | 'sin_clip_b'          // ningún recorte fluido
  | 'sin_grabacion'       // hay A y B, pero en clases sin enlace de Fathom
  | 'distinto_profe'      // A y B solo con profes distintos
  | 'profe_bloqueado'     // el admin marcó "No sirve" esa combinación alumno + profe
  | 'poca_distancia'      // A y B a menos de MIN_SEMANAS_ENTRE_CLIPS (o el B antes que el A)
  | 'b_no_mas_largo';     // con distancia suficiente, el B nunca dura más que el A

export const NO_PAIR_LABEL: Record<NoPairReason, string> = {
  sin_clip_a: 'Ningún momento con bloqueo (clip A)',
  sin_clip_b: 'Ningún momento fluido (clip B)',
  sin_grabacion: 'Las clases con clips no tienen grabación de Fathom',
  distinto_profe: 'El A y el B solo salen con profes distintos',
  profe_bloqueado: 'Combinación alumno + profe marcada "No sirve"',
  poca_distancia: `Menos de ${C.MIN_SEMANAS_ENTRE_CLIPS} semanas entre el A y el B`,
  b_no_mas_largo: 'El B nunca dura más que el A',
};

export interface ScoredPair {
  a: Segment;
  b: Segment;
  aScore: number;
  bScore: number;
  gapDays: number;
}

export type PairChoice =
  | { ok: true; pair: ScoredPair; candidatesA: number; candidatesB: number }
  | { ok: false; reason: NoPairReason; candidatesA: number; candidatesB: number; rejected: Partial<Record<NoPairReason, number>> };

const DAY_MS = 86_400_000;
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * La mejor pareja de UN alumno entre todos sus recortes (de todas sus clases y
 * profes). Mismo profe, con grabación, B al menos MIN_SEMANAS_ENTRE_CLIPS después
 * del A y más largo que él. Gana la de más semanas de distancia; a igualdad, la
 * de más bloqueo + fluidez; luego más días; luego por id (estable).
 */
export function choosePair(segments: Segment[], avgWpm: number | null, blockedTeachers: ReadonlySet<string> = new Set()): PairChoice {
  const As = segments.filter(canBeA), Bs = segments.filter(canBeB);
  const counts = { candidatesA: As.length, candidatesB: Bs.length };
  if (!As.length) return { ok: false, reason: 'sin_clip_a', ...counts, rejected: {} };
  if (!Bs.length) return { ok: false, reason: 'sin_clip_b', ...counts, rejected: {} };
  const As2 = As.filter(s => s.fathomUrl), Bs2 = Bs.filter(s => s.fathomUrl);
  if (!As2.length || !Bs2.length) return { ok: false, reason: 'sin_grabacion', ...counts, rejected: {} };

  const aScore = new Map(As2.map(s => [s.id, blockingScore(s, avgWpm)]));
  const bScore = new Map(Bs2.map(s => [s.id, fluencyScore(s, avgWpm)]));
  const rejected: Partial<Record<NoPairReason, number>> = {};
  const reject = (r: NoPairReason) => { rejected[r] = (rejected[r] ?? 0) + 1; };
  const minDays = C.MIN_SEMANAS_ENTRE_CLIPS * 7;
  let best: { pair: ScoredPair; rank: Array<number | string> } | null = null;
  for (const a of As2) {
    for (const b of Bs2) {
      if (!a.teacherId || a.teacherId !== b.teacherId) { reject('distinto_profe'); continue; }
      if (blockedTeachers.has(a.teacherId)) { reject('profe_bloqueado'); continue; }
      const gap = daysBetween(a.classDay, b.classDay);
      if (gap < minDays) { reject('poca_distancia'); continue; }
      if (segDuration(b) <= segDuration(a)) { reject('b_no_mas_largo'); continue; }
      const sa = aScore.get(a.id)!, sb = bScore.get(b.id)!;
      const rank = [Math.floor(gap / 7), sa + sb, gap, `${a.id}|${b.id}`];
      if (!best || compareRank(rank, best.rank) > 0) best = { pair: { a, b, aScore: sa, bScore: sb, gapDays: gap }, rank };
    }
  }
  if (best) return { ok: true, pair: best.pair, ...counts };
  // El motivo es el de la combinación que más cerca estuvo de valer.
  const order: NoPairReason[] = ['b_no_mas_largo', 'poca_distancia', 'profe_bloqueado', 'distinto_profe'];
  return { ok: false, reason: order.find(r => rejected[r]) ?? 'distinto_profe', ...counts, rejected };
}

/** >0 si `a` es mejor. Números: más es mejor; el id final: menos es mejor. */
function compareRank(a: Array<number | string>, b: Array<number | string>): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return typeof a[i] === 'number' ? (a[i] as number) - (b[i] as number) : (a[i] < b[i] ? 1 : -1);
  }
  return 0;
}
