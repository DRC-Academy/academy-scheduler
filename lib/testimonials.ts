// Testimoniales — elección de la mejor pareja "antes / después" de un alumno.
//
// Módulo PURO (sin red ni base): recibe las clases del alumno con su nota de
// fluidez y devuelve la mejor pareja que cumple las reglas de
// lib/testimonialRules. Lo prueba lib/testimonials.test.ts.
//
// "Antes" usa la cita donde MÁS se trababa; "después", la cita donde MEJOR
// habla. Así la pareja es directamente el material del anuncio.

import { TESTIMONIAL_RULES, type TestimonialRules } from '@/lib/testimonialRules';

/** Una clase del alumno con nota (fila de transcript_fluency_numbered). */
export interface FluencyClass {
  analysisId: string;
  classNumber: number | null;
  /** 'YYYY-MM-DD', fecha de la clase en España. */
  classDay: string;
  teacherId: string | null;
  score: number;
  bestExcerpt: string | null;
  bestAt: string | null;
  bestFound: boolean | null;
  worstExcerpt: string | null;
  worstAt: string | null;
  worstFound: boolean | null;
  fathomUrl: string | null;
}

export interface TestimonialPair {
  before: FluencyClass;
  after: FluencyClass;
  improvement: number;
  daysApart: number;
}

/** Clave de una pareja, para no volver a proponer una ya descartada. */
export const pairKey = (beforeId: string, afterId: string): string => `${beforeId}|${afterId}`;

const DAY_MS = 86_400_000;
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

/** ¿`a` es mejor pareja que `b`? Más mejora; a igualdad, "después" más reciente; luego más separación. */
export function isBetterPair(
  a: Pick<TestimonialPair, 'improvement' | 'daysApart'> & { afterDay: string },
  b: Pick<TestimonialPair, 'improvement' | 'daysApart'> & { afterDay: string },
): boolean {
  if (a.improvement !== b.improvement) return a.improvement > b.improvement;
  if (a.afterDay !== b.afterDay) return a.afterDay > b.afterDay;
  return a.daysApart > b.daysApart;
}

const hasText = (s: string | null | undefined): boolean => !!s && s.trim().length > 0;

/**
 * La mejor pareja del alumno, o null si ninguna cumple las reglas.
 * `excluded`: claves (pairKey) de parejas ya descartadas, que no se repiten.
 */
export function findBestPair(
  classes: FluencyClass[],
  rules: TestimonialRules = TESTIMONIAL_RULES,
  excluded: ReadonlySet<string> = new Set(),
): TestimonialPair | null {
  const minDays = rules.SEMANAS_MIN * 7;
  const befores = classes.filter(c =>
    c.score <= rules.NOTA_ANTES_MAX &&
    hasText(c.worstExcerpt) &&
    (!rules.CITAS_COMPROBADAS || c.worstFound === true));
  const afters = classes.filter(c =>
    c.score >= rules.NOTA_DESPUES_MIN &&
    hasText(c.bestExcerpt) &&
    (!rules.CITAS_COMPROBADAS || c.bestFound === true));

  let best: TestimonialPair | null = null;
  for (const before of befores) {
    for (const after of afters) {
      if (before.analysisId === after.analysisId) continue;
      const daysApart = daysBetween(before.classDay, after.classDay);
      const improvement = after.score - before.score;
      if (daysApart < minDays || improvement < rules.MEJORA_MIN) continue;
      if (excluded.has(pairKey(before.analysisId, after.analysisId))) continue;
      const cand = { before, after, improvement, daysApart };
      if (!best || isBetterPair({ ...cand, afterDay: after.classDay }, { ...best, afterDay: best.after.classDay })) {
        best = cand;
      }
    }
  }
  return best;
}
