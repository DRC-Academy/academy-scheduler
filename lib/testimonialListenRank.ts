// Testimoniales — ESCUCHA DIRIGIDA: qué se escucha y qué parejas salen. Módulo PURO.
//
// En vez de buscar trabas en el texto de Fathom (que las limpia), se ESCUCHAN con
// Deepgram los tramos largos del alumno en sus primeras y sus últimas clases
// grabadas (dentro de los filtros del panel), y con esas medidas salen, por
// alumno, sus parejas ANTES/DESPUÉS con el mismo profe. Entran al verificador.
//
//   selectListenClasses: qué clases de un alumno se escuchan.
//   pickTurns:           qué tramos de una clase (los N más largos, sin lecturas).
//   listenPairs:         las parejas, con las MISMAS reglas que el verificador
//                        (lib/testimonialMeasures), para no proponerle lo que tiraría.
// Todos los números salen de testimonial_config.

import { readingCue, toSeconds, type Turn } from '@/lib/fluency';
import {
  checkAudio, checkAntes, checkDespues, checkContraste, weeksBetween,
  type ClipMeasures, type VerifyConfig,
} from '@/lib/testimonialMeasures';

// ── Clases ───────────────────────────────────────────────────────────────────

export interface ListenClass {
  analysisId: string;
  studentGroup: string;
  teacherId: string | null;
  /** 'YYYY-MM-DD' */
  classDay: string;
  fathomUrl: string;
}

// ── Tramos de una clase ──────────────────────────────────────────────────────

export interface TurnPick {
  turnIndex: number;
  /** Segundos desde el inicio de la grabación donde empieza a bajarse el tramo. */
  start: number;
  dur: number;
}

/**
 * Los tramos que se escuchan: intervenciones del alumno de más de
 * `escucha_min_turno_s` (según Fathom: hasta que habla otro), sin pista de
 * lectura, las `escucha_tramos_por_clase` más largas, con tope y margen.
 */
export function pickTurns(turns: Turn[], studentLabel: string, c: VerifyConfig): TurnPick[] {
  const secs = turns.map(t => toSeconds(t.at));
  const largos: Array<{ k: number; s: number; d: number }> = [];
  turns.forEach((t, k) => {
    if (t.speaker !== studentLabel) return;
    const s = secs[k];
    const next = secs.slice(k + 1).find(x => x != null);
    if (s == null || next == null) return;
    const d = next - s;
    if (d <= c.escucha_min_turno_s || readingCue(turns, k)) return;
    largos.push({ k, s, d });
  });
  return largos
    .sort((a, b) => b.d - a.d || a.s - b.s)
    .slice(0, c.escucha_tramos_por_clase)
    .map(({ k, s, d }) => {
      const start = Math.max(0, s - c.escucha_margen_s);
      return { turnIndex: k, start, dur: Math.round((Math.min(d, c.escucha_tope_s) + (s - start)) * 10) / 10 };
    })
    .sort((a, b) => a.start - b.start);
}

// ── La pareja ────────────────────────────────────────────────────────────────

export interface ListenSegment {
  id: string;
  analysisId: string;
  teacherId: string | null;
  classDay: string;
  /** Donde habla de verdad el alumno (Deepgram), en segundos absolutos. */
  hablaStart: number;
  hablaEnd: number;
  medidas: ClipMeasures | null;
  texto: string;
}

/** Vale como tramo de alguien hablando inglés solo: sin español, sin otra voz, sin ejercicio. */
const usable = (s: ListenSegment, c: VerifyConfig): s is ListenSegment & { medidas: ClipMeasures } =>
  !!s.medidas && s.medidas.palabras >= c.escucha_min_palabras && checkAudio(s.medidas, 'ANTES', c).ok;

/** Cuánto mejora: velocidad relativa + pausas por minuto que desaparecen + muletillas. */
export function contrastScore(a: ClipMeasures, b: ClipMeasures): number {
  const mulA = a.muletillas / Math.max(0.5, a.habla_s / 60), mulB = b.muletillas / Math.max(0.5, b.habla_s / 60);
  return Math.round(((b.ppm - a.ppm) / Math.max(1, a.ppm)
    + (a.pausas_min - b.pausas_min) / Math.max(1, a.pausas_min)
    + (mulA - mulB) / Math.max(1, mulA)) * 100) / 100;
}

// ── Panel de análisis: varias parejas por alumno ─────────────────────────────

/**
 * Clases de un alumno que se escuchan dentro de los filtros del panel: las
 * `escucha_clases_lado` primeras y últimas (sin solaparse). Hace falta que entre la
 * primera y la última haya al menos `semanas_min` semanas; si no, ninguna.
 */
export function selectListenClasses(classes: ListenClass[], c: Pick<VerifyConfig, 'escucha_clases_lado' | 'semanas_min'>): ListenClass[] {
  const sorted = [...classes].sort((a, b) => a.classDay.localeCompare(b.classDay) || a.analysisId.localeCompare(b.analysisId));
  if (sorted.length < 2 || weeksBetween(sorted[0].classDay, sorted[sorted.length - 1].classDay) < c.semanas_min) return [];
  const k = Math.min(c.escucha_clases_lado, Math.floor(sorted.length / 2));
  return [...sorted.slice(0, k), ...sorted.slice(-k)];
}

export interface ListenPlanSegment extends ListenSegment {
  /** momentKey (grabación + intervención) y recordingKey: como en lib/testimonialPairPlan. */
  moment: string;
  recording: string;
}

export interface ListenPlannedPair {
  a: ListenPlanSegment;
  b: ListenPlanSegment;
  teacherId: string;
  semanas: number;
  score: number;
  /** Alguno de los dos tiene algo de español (va al final de su alumno). */
  conEspanol: boolean;
}

/** >0 si `x` va antes que `y`: sin español, más contraste, más semanas. */
export function compareListenPairs(x: ListenPlannedPair, y: ListenPlannedPair): number {
  return (Number(y.conEspanol) - Number(x.conEspanol)) || (x.score - y.score) || (x.semanas - y.semanas)
    || (`${y.a.id}|${y.b.id}` < `${x.a.id}|${x.b.id}` ? -1 : 1);
}

/**
 * Las parejas de UN alumno con lo escuchado, de mejor a peor: el ANTES trabado de
 * verdad, el DESPUÉS fluido, mismo profe, distinta grabación, `semanas_min`
 * semanas y contraste (las reglas del verificador). Sin elegir aún cuántas.
 */
export function listenPairs(segs: ListenPlanSegment[], c: VerifyConfig,
  o: { blocked?: (s: ListenPlanSegment) => boolean; skipPair?: (a: ListenPlanSegment, b: ListenPlanSegment) => boolean } = {}): ListenPlannedPair[] {
  const ok = segs.filter(s => !o.blocked?.(s) && usable(s, c));
  const as = ok.filter(s => checkAntes(s.medidas!, c).ok);
  const bs = ok.filter(s => checkDespues(s.medidas!, c).ok);
  const out: ListenPlannedPair[] = [];
  for (const a of as) for (const b of bs) {
    if (!a.teacherId || a.teacherId !== b.teacherId || a.recording === b.recording) continue;
    const semanas = weeksBetween(a.classDay, b.classDay);
    if (semanas < c.semanas_min || !checkContraste(a.medidas!, b.medidas!, c).ok) continue;
    if (o.skipPair?.(a, b)) continue;
    out.push({
      a, b, teacherId: a.teacherId, semanas, score: contrastScore(a.medidas!, b.medidas!),
      conEspanol: (a.medidas!.espanol_pct ?? 0) > 0 || (b.medidas!.espanol_pct ?? 0) > 0,
    });
  }
  return out.sort((x, y) => compareListenPairs(y, x));
}

/** El clip que se propone al verificador: donde habla el alumno, con tope. */
export function clipBounds(s: ListenSegment, c: VerifyConfig): { start: number; end: number } {
  const start = Math.max(0, Math.round(s.hablaStart * 10) / 10);
  return { start, end: Math.round(Math.min(s.hablaEnd, start + c.escucha_clip_max_s) * 10) / 10 };
}
