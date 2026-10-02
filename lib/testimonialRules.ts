// Testimoniales — las reglas para proponer un alumno "antes / después".
//
// Único sitio donde se tocan. La detección (lib/testimonials.ts) solo las lee.
// Cambiar un número aquí afecta a los alumnos que se detecten DESDE ese momento;
// las parejas que ya están en la tabla no se recalculan solas.
//
// Regla (02/10/2026, la "6b" del diagnóstico): se mira la TENDENCIA del alumno,
// no dos notas sueltas. Las notas de fluidez de Haiku casi siempre caen entre 5
// y 7, así que los mínimos y máximos fijos (≤ 4 → ≥ 7) no dejaban pasar a nadie.

export const TESTIMONIAL_RULES = {
  /** Clases con nota de fluidez que tiene que tener el alumno como mínimo. */
  CLASES_MIN: 6,
  /** Se comparan sus N primeras clases con sus N últimas. */
  VENTANA: 3,
  /** La media de las últimas tiene que superar a la de las primeras en al menos esto. */
  MEJORA_MEDIA_MIN: 1,
  /** Días mínimos entre la clase mala y la buena. */
  DIAS_MIN: 28,
} as const;

export type TestimonialRules = { [K in keyof typeof TESTIMONIAL_RULES]: number };
