// Testimoniales — ESCUCHA DIRIGIDA: qué se escucha y qué pareja sale. Módulo PURO.
//
// En vez de buscar trabas en el texto de Fathom (que las limpia), se ESCUCHAN con
// Deepgram los tramos largos del alumno en sus primeras y sus últimas clases
// grabadas, y con esas medidas se elige, por alumno, el peor momento del principio
// y el mejor del final con el mismo profe. Esa pareja entra al verificador.
//
//   selectClasses: qué clases de un alumno se escuchan (o por qué no entra).
//   pickTurns:     qué tramos de una clase (los N más largos, sin lecturas).
//   rankPair:      la pareja, con las MISMAS reglas que el verificador
//                  (lib/testimonialMeasures), para no proponerle lo que tiraría.
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

export type ClassSelection =
  | { ok: true; first: ListenClass[]; last: ListenClass[] }
  | { ok: false; reason: 'menos_2_meses' | 'pocas_clases' };

/** 'YYYY-MM-DD' `days` días antes de `today`. */
export function daysBefore(today: string, days: number): string {
  return new Date(Date.parse(`${today}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Las primeras y las últimas clases GRABADAS de un alumno (con transcript y
 * enlace válido). Con pocas clases se reparten sin solaparse.
 */
export function selectClasses(classes: ListenClass[], c: VerifyConfig, today: string): ClassSelection {
  const sorted = [...classes].sort((a, b) => a.classDay.localeCompare(b.classDay) || a.analysisId.localeCompare(b.analysisId));
  if (sorted.length < c.escucha_min_clases) return { ok: false, reason: 'pocas_clases' };
  if (sorted[0].classDay > daysBefore(today, c.escucha_antiguedad_dias)) return { ok: false, reason: 'menos_2_meses' };
  const k = Math.min(c.escucha_clases_lado, Math.floor(sorted.length / 2));
  return { ok: true, first: sorted.slice(0, k), last: sorted.slice(-k) };
}

/** Profes que están en las primeras Y en las últimas clases. */
export function commonTeachers(sel: { first: ListenClass[]; last: ListenClass[] }): string[] {
  const late = new Set(sel.last.map(x => x.teacherId).filter(Boolean));
  return [...new Set(sel.first.map(x => x.teacherId).filter((t): t is string => !!t && late.has(t)))];
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

export type NoListenPair = 'sin_profe_en_comun' | 'sin_tramos_antes' | 'sin_tramos_despues' | 'poca_distancia' | 'sin_contraste';

export const NO_LISTEN_PAIR_LABEL: Record<NoListenPair, string> = {
  sin_profe_en_comun: 'Sin profe en común',
  sin_tramos_antes: 'Ningún tramo trabado de verdad en sus primeras clases',
  sin_tramos_despues: 'Ningún tramo fluido en sus últimas clases',
  poca_distancia: 'Menos de 4 semanas entre las clases con tramos válidos',
  sin_contraste: 'Sin contraste suficiente entre el antes y el después',
};

export type ListenPairResult =
  | { ok: true; a: ListenSegment; b: ListenSegment; teacherId: string; semanas: number; score: number }
  | { ok: false; reason: NoListenPair };

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

/**
 * Peor momento de las primeras clases y mejor de las últimas, con el mismo profe,
 * 4+ semanas entre medias y las reglas del verificador (ANTES trabado de forma
 * sostenida, DESPUÉS fluido, contraste). Gana la de más contraste.
 */
export function rankPair(first: ListenSegment[], last: ListenSegment[], teachers: string[], c: VerifyConfig): ListenPairResult {
  if (!teachers.length) return { ok: false, reason: 'sin_profe_en_comun' };
  const as = first.filter(s => s.teacherId && teachers.includes(s.teacherId) && usable(s, c) && checkAntes(s.medidas!, c).ok);
  if (!as.length) return { ok: false, reason: 'sin_tramos_antes' };
  const bs = last.filter(s => s.teacherId && teachers.includes(s.teacherId) && usable(s, c) && checkDespues(s.medidas!, c).ok);
  if (!bs.length) return { ok: false, reason: 'sin_tramos_despues' };

  let lejos = false;
  let best: Extract<ListenPairResult, { ok: true }> | null = null;
  for (const a of as) for (const b of bs) {
    if (a.teacherId !== b.teacherId || a.analysisId === b.analysisId) continue;
    const semanas = weeksBetween(a.classDay, b.classDay);
    if (semanas < c.semanas_min) continue;
    lejos = true;
    if (!checkContraste(a.medidas!, b.medidas!, c).ok) continue;
    const score = contrastScore(a.medidas!, b.medidas!);
    if (!best || score > best.score || (score === best.score && semanas > best.semanas)) {
      best = { ok: true, a, b, teacherId: a.teacherId!, semanas, score };
    }
  }
  if (best) return best;
  return { ok: false, reason: lejos ? 'sin_contraste' : 'poca_distancia' };
}

/** El clip que se propone al verificador: donde habla el alumno, con tope. */
export function clipBounds(s: ListenSegment, c: VerifyConfig): { start: number; end: number } {
  const start = Math.max(0, Math.round(s.hablaStart * 10) / 10);
  return { start, end: Math.round(Math.min(s.hablaEnd, start + c.escucha_clip_max_s) * 10) / 10 };
}
