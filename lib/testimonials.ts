// Testimoniales — qué alumnos entran y entre qué clases se busca el momento.
//
// Módulo PURO (sin red ni base): recibe las clases con nota de fluidez de un
// alumno y decide, con las reglas de lib/testimonialRules, si su tendencia es
// de mejora. Lo prueba lib/testimonials.test.ts. Lo usan la detección (servidor)
// y la pestaña del admin (para la línea "Media de 5,0 → 7,0").
//
// La clase mala y la buena NO las fija esta cuenta: Haiku elige el peor momento
// entre las primeras clases y el mejor entre las últimas (lib/testimonialClips).
// Aquí solo se dice entre cuáles puede elegir, respetando los días mínimos.

import { TESTIMONIAL_RULES, type TestimonialRules } from '@/lib/testimonialRules';

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

/** "5,0" */
export const fmtMean = (n: number): string => n.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** "Media de 5,0 → 7,0 (+2 puntos)" */
export function improvementLine(firstMean: number, lastMean: number): string {
  const diff = Math.round((lastMean - firstMean) * 10) / 10;
  const n = Number.isInteger(diff) ? String(diff) : fmtMean(diff);
  return `Media de ${fmtMean(firstMean)} → ${fmtMean(lastMean)} (${diff >= 0 ? '+' : ''}${n} ${Math.abs(diff) === 1 ? 'punto' : 'puntos'})`;
}
