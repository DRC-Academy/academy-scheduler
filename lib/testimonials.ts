// Testimoniales — qué alumnos entran y entre qué clases se busca el momento.
//
// Módulo PURO (sin red ni base): recibe las clases con nota de fluidez de un
// alumno y decide, con las reglas de lib/testimonialRules, si su tendencia es
// de mejora. Lo prueba lib/testimonials.test.ts. Lo usan la detección (servidor)
// y la pestaña del admin (para la línea "Media de 5,0 → 7,0").
//
// Los momentos NO los fija esta cuenta: Haiku elige hasta 3 clips malos entre
// las primeras clases y hasta 3 buenos entre las últimas (lib/testimonialClips).
// Aquí solo se dice entre cuáles puede elegir, respetando los días mínimos.

import { TESTIMONIAL_RULES, type TestimonialRules } from '@/lib/testimonialRules';
import { formatSeconds, type EnglishStats } from '@/lib/fluency';

/** Una clase del alumno con nota (fila de transcript_fluency_numbered). */
export interface FluencyClass {
  analysisId: string;
  classNumber: number | null;
  /** 'YYYY-MM-DD', fecha de la clase en España. */
  classDay: string;
  teacherId: string | null;
  score: number;
  fathomUrl: string | null;
}

export interface StudentTrend {
  /** Sus primeras y últimas clases con nota, en orden cronológico. */
  first: FluencyClass[];
  last: FluencyClass[];
  firstMean: number;
  lastMean: number;
  /** lastMean − firstMean. */
  improvement: number;
}

export interface TestimonialCandidatePlan {
  trend: StudentTrend;
  /** Primeras clases que tienen alguna de las últimas a DIAS_MIN o más. */
  badOptions: FluencyClass[];
  /** Últimas clases que tienen alguna de las primeras a DIAS_MIN o más antes. */
  goodOptions: FluencyClass[];
  /** Pareja provisional (la peor nota de las primeras, la mejor de las últimas) hasta que elija la IA. */
  before: FluencyClass;
  after: FluencyClass;
}

const DAY_MS = 86_400_000;
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

const byDate = (a: FluencyClass, b: FluencyClass): number =>
  a.classDay.localeCompare(b.classDay) || a.analysisId.localeCompare(b.analysisId);

/** Media de las primeras y las últimas clases. null si no llega al mínimo de clases. */
export function studentTrend(classes: FluencyClass[], rules: TestimonialRules = TESTIMONIAL_RULES): StudentTrend | null {
  if (classes.length < rules.CLASES_MIN) return null;
  const sorted = [...classes].sort(byDate);
  const first = sorted.slice(0, rules.VENTANA);
  const last = sorted.slice(-rules.VENTANA);
  const firstMean = mean(first.map(c => c.score));
  const lastMean = mean(last.map(c => c.score));
  return { first, last, firstMean, lastMean, improvement: lastMean - firstMean };
}

/** Las últimas clases que están a DIAS_MIN o más de la clase mala elegida. */
export function goodOptionsAfter(bad: FluencyClass, goodOptions: FluencyClass[], rules: TestimonialRules = TESTIMONIAL_RULES): FluencyClass[] {
  return goodOptions.filter(g => daysBetween(bad.classDay, g.classDay) >= rules.DIAS_MIN);
}

/**
 * ¿El alumno entra? Sí si tiene CLASES_MIN clases con nota, su media sube al
 * menos MEJORA_MEDIA_MIN y alguna de las primeras está a DIAS_MIN o más de
 * alguna de las últimas. Sin mínimos ni máximos de nota.
 */
export function planCandidate(classes: FluencyClass[], rules: TestimonialRules = TESTIMONIAL_RULES): TestimonialCandidatePlan | null {
  const trend = studentTrend(classes, rules);
  // Margen por los decimales: (6+6+7)/3 − (5+5+6)/3 tiene que contar como 1.
  if (!trend || trend.improvement < rules.MEJORA_MEDIA_MIN - 1e-9) return null;

  const badOptions = trend.first.filter(b => goodOptionsAfter(b, trend.last, rules).length > 0);
  if (badOptions.length === 0) return null;
  const goodOptions = trend.last.filter(g => badOptions.some(b => daysBetween(b.classDay, g.classDay) >= rules.DIAS_MIN));

  // Provisional: peor nota de las primeras (la más antigua si empatan) y mejor
  // nota de las últimas a la distancia mínima (la más reciente si empatan).
  const before = [...badOptions].sort((a, b) => a.score - b.score || byDate(a, b))[0];
  const after = [...goodOptionsAfter(before, goodOptions, rules)].sort((a, b) => b.score - a.score || byDate(b, a))[0];
  return { trend, badOptions, goodOptions, before, after };
}

// ── Evidencia del transcript (V3) ────────────────────────────────────────────

export interface EvidenceResult {
  ok: boolean;
  /** Frase para el admin y los logs: qué se midió y por qué entra o no. */
  reason: string;
  firstTop: number;
  lastTop: number;
  firstLong: number;
  lastLong: number;
}

/**
 * ¿El transcript respalda la mejora? Compara las intervenciones en inglés de
 * sus primeras clases con las de sus últimas (solo las clases legibles).
 * Entra si sube UNA de las dos medidas; sin clases legibles suficientes, no.
 */
export function evidenceImproves(
  first: EnglishStats[], last: EnglishStats[], rules: TestimonialRules = TESTIMONIAL_RULES,
): EvidenceResult {
  const firstTop = first.length ? mean(first.map(s => s.topTurnsMean)) : 0;
  const lastTop = last.length ? mean(last.map(s => s.topTurnsMean)) : 0;
  const firstLong = first.length ? mean(first.map(s => s.longTurns)) : 0;
  const lastLong = last.length ? mean(last.map(s => s.longTurns)) : 0;
  const base = { firstTop, lastTop, firstLong, lastLong };

  if (first.length < rules.EVIDENCIA_CLASES_MIN || last.length < rules.EVIDENCIA_CLASES_MIN) {
    return { ...base, ok: false, reason: 'No hay suficientes transcripts legibles (con alumno y profe identificados) para comprobar la mejora.' };
  }
  const subeTop = lastTop - firstTop >= rules.MEJORA_TURNOS_TOP_MIN;
  const subeLargos = lastLong - firstLong >= rules.MEJORA_TURNOS_LARGOS_MIN;
  const medida = `intervenciones en inglés más largas: ${Math.round(firstTop)} → ${Math.round(lastTop)} palabras; `
    + `intervenciones largas por clase: ${fmtMean(firstLong)} → ${fmtMean(lastLong)}`;
  return subeTop || subeLargos
    ? { ...base, ok: true, reason: `El transcript lo respalda (${medida}).` }
    : { ...base, ok: false, reason: `El transcript no muestra intervenciones en inglés más largas (${medida}).` };
}

// ── Comparación a ciegas (V3) ────────────────────────────────────────────────

export type BlindChoice = 'A' | 'B' | 'igual';
export type BlindConfidence = 'alta' | 'media' | 'baja';

/**
 * ¿La comparación a ciegas confirma la mejora? Sí solo si la IA eligió la clase
 * RECIENTE como la de más soltura, con confianza alta o media. Un empate o una
 * confianza baja no confirman: para un anuncio la diferencia tiene que oírse.
 */
export function blindConfirms(choice: BlindChoice, confidence: BlindConfidence, laterIsA: boolean): boolean {
  if (confidence === 'baja' || choice === 'igual') return false;
  return (choice === 'A') === laterIsA;
}

/** "5,0" */
export const fmtMean = (n: number): string => n.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** "Media de 5,0 → 7,0 (+2 puntos)" */
export function improvementLine(firstMean: number, lastMean: number): string {
  const diff = Math.round((lastMean - firstMean) * 10) / 10;
  const n = Number.isInteger(diff) ? String(diff) : fmtMean(diff);
  return `Media de ${fmtMean(firstMean)} → ${fmtMean(lastMean)} (${diff >= 0 ? '+' : ''}${n} ${Math.abs(diff) === 1 ? 'punto' : 'puntos'})`;
}

// ── Clips (columna testimonial_candidates.clips, supabase-testimoniales-clips.sql) ──

/** Un clip corto del alumno, ya comprobado: la cita existe y es suya. */
export interface TestimonialClip {
  analysisId: string;
  /** 'YYYY-MM-DD', fecha de la clase en España. */
  classDate: string;
  teacherId: string | null;
  /** Segundos desde el inicio de la grabación. */
  start: number;
  end: number;
  excerpt: string;
  /** Por qué es un momento malo o bueno (una frase de la IA). */
  why: string;
  /** Grabación de Fathom abierta en `start` (?timestamp=), o null si la clase no la trae. */
  fathomUrl: string | null;
}

/** Del más claro al menos claro, como los ordenó la IA. */
export interface TestimonialClips {
  malos: TestimonialClip[];
  buenos: TestimonialClip[];
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "16 jul · 8:20 – 8:27" */
export function clipLabel(c: Pick<TestimonialClip, 'classDate' | 'start' | 'end'>): string {
  const [, m, d] = c.classDate.slice(0, 10).split('-').map(Number);
  const dia = m && d ? `${d} ${MESES[m - 1]}` : 'Sin fecha';
  return `${dia} · ${formatSeconds(c.start)} – ${formatSeconds(c.end)}`;
}

/** ¿Dos clips de la misma clase se pisan? (la IA a veces repite el mismo momento) */
export const clipsOverlap = (a: TestimonialClip, b: TestimonialClip): boolean =>
  a.analysisId === b.analysisId && a.start < b.end && b.start < a.end;
