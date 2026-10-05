// Testimoniales — las reglas para proponer un alumno "antes / después".
//
// Único sitio donde se tocan. La detección (lib/testimonials.ts) solo las lee.
// Cambiar un número aquí afecta a los alumnos que se detecten DESDE ese momento;
// las parejas que ya están en la tabla no se recalculan solas.
//
// HISTORIA (para no volver atrás):
//   · V1 (≤ 4 → ≥ 7, 6 semanas): 0 alumnos. Las notas de fluidez de Haiku caen
//     casi siempre entre 5 y 6 (73 % de 2.187 clases a 05/10/2026).
//   · V2 (02/10/2026, tendencia: media de las 3 últimas +1 sobre las 3 primeras):
//     13 alumnos, varios flojos ("5/5/5 → 6/6/6").
//   · V3 (05/10/2026, la de abajo): la nota SOLA es ruidosa. Con el tiempo dado la
//     vuelta salían tantos alumnos que "empeoran claramente" como que mejoran,
//     porque la nota depende mucho del tipo de clase (gramática o conversación).
//     Por eso la tendencia de la nota es solo el primer filtro (más suave), y
//     detrás van dos comprobaciones que la nota no puede dar:
//       1. EVIDENCIA del transcript, sin IA: el alumno hace intervenciones en
//          inglés más largas en sus últimas clases que en las primeras. Junto a
//          la nota dejaba 16 que mejoran frente a 6 que empeoran (la señal más
//          limpia de las probadas).
//       2. COMPARACIÓN A CIEGAS con Haiku (lib/testimonialCompare): dos clases
//          en orden aleatorio y sin fechas; tiene que elegir la reciente.

export const TESTIMONIAL_RULES = {
  /** Clases con nota de fluidez que tiene que tener el alumno como mínimo. */
  CLASES_MIN: 5,
  /** Se comparan sus N primeras clases con sus N últimas. */
  VENTANA: 3,
  /** La media de las últimas tiene que superar a la de las primeras en al menos esto (2 puntos entre 3 clases). */
  MEJORA_MEDIA_MIN: 2 / 3,
  /** Días mínimos entre la clase mala y la buena. */
  DIAS_MIN: 28,

  // ── Evidencia del transcript (lib/fluency studentEnglishStats) ──
  /** Una intervención en inglés de al menos estas palabras cuenta como "larga". */
  PALABRAS_TURNO_LARGO: 25,
  /** Se promedian las N intervenciones en inglés más largas de cada clase. */
  TURNOS_TOP: 10,
  /** Basta con UNA de las dos subidas: la media de sus intervenciones más largas sube al menos esto (palabras)… */
  MEJORA_TURNOS_TOP_MIN: 5,
  /** …o hace al menos estas intervenciones largas más por clase. */
  MEJORA_TURNOS_LARGOS_MIN: 2,
  /** Clases legibles (con hablantes identificados) que hacen falta a cada lado para juzgar la evidencia. */
  EVIDENCIA_CLASES_MIN: 2,
} as const;

export type TestimonialRules = { [K in keyof typeof TESTIMONIAL_RULES]: number };
