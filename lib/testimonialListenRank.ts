// Testimoniales — ESCUCHA DIRIGIDA: qué se escucha y qué parejas salen. Módulo PURO.
//
// En vez de buscar trabas en el texto de Fathom (que las limpia), se ESCUCHAN con
// Deepgram los tramos largos del alumno en sus primeras y sus últimas clases
// grabadas (dentro de los filtros del panel), y con esas medidas salen, por
// alumno, sus parejas ANTES/DESPUÉS con el mismo profe. Entran al verificador.
//
//   listenableClasses:   qué clases de un alumno se escuchan (todas, una por grabación).
//   pickTurns:           qué tramos de una clase (los N más largos de los que Haiku
//                        ve como habla espontánea en el texto de Fathom).
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
 * Versión del criterio con que se escuchó una clase (testimonial_listen_classes.criterio).
 *   1: los turnos más largos (casi siempre lecturas: la tanda del 02/11/2026 dio 0).
 *   2: solo turnos que Haiku, sobre el texto de Fathom, ve como habla espontánea.
 * Solo informativo: una clase ya escuchada no se vuelve a escuchar (decisión de
 * Facundo, 03/11/2026: se reutilizan sus medidas).
 */
export const LISTEN_CRITERIO = 2;

export interface TurnCandidate { turnIndex: number; s: number; d: number }

/**
 * Intervenciones del alumno de más de `escucha_min_turno_s` (según Fathom: hasta
 * que habla otro) sin pista de lectura en el texto: lo que se clasifica antes de
 * pagar la escucha.
 */
export function turnCandidates(turns: Turn[], studentLabel: string, c: VerifyConfig): TurnCandidate[] {
  const secs = turns.map(t => toSeconds(t.at));
  const largos: TurnCandidate[] = [];
  turns.forEach((t, k) => {
    if (t.speaker !== studentLabel) return;
    const s = secs[k];
    const next = secs.slice(k + 1).find(x => x != null);
    if (s == null || next == null) return;
    const d = next - s;
    if (d <= c.escucha_min_turno_s || readingCue(turns, k)) return;
    largos.push({ turnIndex: k, s, d });
  });
  return largos;
}

/**
 * Los tramos que se escuchan: de los candidatos (solo los `espontaneos`, si se
 * pasa la lista), los `escucha_tramos_por_clase` más largos, con tope y margen.
 */
export function pickTurns(turns: Turn[], studentLabel: string, c: VerifyConfig, espontaneos?: Set<number>): TurnPick[] {
  return turnCandidates(turns, studentLabel, c)
    .filter(x => !espontaneos || espontaneos.has(x.turnIndex))
    .map(({ turnIndex: k, s, d }) => ({ k, s, d }))
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
  /**
   * Haiku sobre el texto: 'espontaneo' (habla por su cuenta) o 'lectura' (lee en
   * voz alta). null = sin clasificar todavía. Una lectura nunca es DESPUÉS.
   */
  lectura?: 'espontaneo' | 'lectura' | null;
}

/** Vale como tramo de alguien hablando inglés solo: sin español, sin otra voz, sin ejercicio. */
const usable = (s: ListenSegment, c: VerifyConfig): s is ListenSegment & { medidas: ClipMeasures } =>
  !!s.medidas && s.medidas.palabras >= c.escucha_min_palabras && checkAudio(s.medidas, 'ANTES', c).ok;

/** Podría ser un DESPUÉS por sus medidas (sin mirar aún si es una lectura): lo que se clasifica. */
export const candidatoDespues = (s: ListenSegment, c: VerifyConfig): boolean => usable(s, c) && checkDespues(s.medidas, c).ok;

/** Cuánto mejora: velocidad relativa + pausas por minuto que desaparecen + muletillas. */
export function contrastScore(a: ClipMeasures, b: ClipMeasures): number {
  const mulA = a.muletillas / Math.max(0.5, a.habla_s / 60), mulB = b.muletillas / Math.max(0.5, b.habla_s / 60);
  return Math.round(((b.ppm - a.ppm) / Math.max(1, a.ppm)
    + (a.pausas_min - b.pausas_min) / Math.max(1, a.pausas_min)
    + (mulA - mulB) / Math.max(1, mulA)) * 100) / 100;
}

// ── Panel de análisis: varias parejas por alumno ─────────────────────────────

/**
 * Clases de un alumno que se escuchan dentro de los filtros del panel: TODAS
 * (decisión de Facundo, 03/11/2026), una por grabación (`recKey`: la misma
 * grabación copiada en dos clases cuenta una vez, la más antigua), y solo con un
 * profe con el que el alumno tenga al menos `semanas_min` semanas entre su primera
 * y su última clase: con los demás no puede salir ninguna pareja.
 */
export function listenableClasses(classes: ListenClass[], c: Pick<VerifyConfig, 'semanas_min'>, recKey: (x: ListenClass) => string): ListenClass[] {
  const sorted = [...classes].sort((a, b) => a.classDay.localeCompare(b.classDay) || a.analysisId.localeCompare(b.analysisId));
  const vistas = new Set<string>();
  const unicas = sorted.filter(x => {
    const k = recKey(x);
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
  const porProfe = new Map<string, ListenClass[]>();
  for (const x of unicas) if (x.teacherId) porProfe.set(x.teacherId, [...(porProfe.get(x.teacherId) ?? []), x]);
  return unicas.filter(x => {
    const l = x.teacherId ? porProfe.get(x.teacherId) : undefined;
    return !!l && l.length >= 2 && weeksBetween(l[0].classDay, l[l.length - 1].classDay) >= c.semanas_min;
  });
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
  const bs = ok.filter(s => s.lectura !== 'lectura' && checkDespues(s.medidas!, c).ok);
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

/**
 * El clip que se propone al verificador: EXACTAMENTE el trozo que midió la escucha
 * (el tope `escucha_clip_max_s` ya se aplicó al medir, lib/testimonialListen), para
 * que el verificador mida lo mismo y no rechace lo que el buscador dio por bueno.
 * Los tramos escuchados antes del 02/11/2026 se midieron sin ese tope: su clip
 * es su trozo entero (hasta ~47 s).
 */
export function clipBounds(s: ListenSegment): { start: number; end: number } {
  return { start: Math.max(0, Math.round(s.hablaStart * 10) / 10), end: Math.round(s.hablaEnd * 10) / 10 };
}
