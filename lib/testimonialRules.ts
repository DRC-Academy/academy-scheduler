// Testimoniales — las reglas para proponer un alumno "antes / después".
//
// Único sitio donde se tocan. La detección (lib/testimonials.ts) solo las lee.
// Cambiar un número aquí afecta a los alumnos que se detecten DESDE ese momento;
// las parejas que ya están en la tabla no se recalculan solas.
//
// HISTORIA (para no volver atrás):
//   · V1 (≤ 4 → ≥ 7, 6 semanas): 0 alumnos. Las notas de fluidez de Haiku caen
//     casi siempre entre 5 y 6 (73 % de 2.187 clases a 05/10/2026).
//   · V2 (02/10/2026, tendencia de la nota +1): 13 alumnos, varios flojos.
//   · V3 (05/10/2026): tendencia de la nota + evidencia del transcript +
//     comparación a ciegas de clases ENTERAS. Solo 15 de 238 alumnos con nota
//     llegaban a la pestaña, y entre ellos había clips de OTRA persona (clases
//     guardadas en el alumno equivocado, o un tercero con la cuenta) y de AUDIOS
//     y lecturas puestos en clase.
//   · V4 (07/10/2026, la de abajo): decisión de Facundo: no hace falta que TODA
//     la clase sea mejor; basta un clip corto en que el alumno habla mal y otro,
//     semanas después, en que habla muy bien. Fuera la nota como filtro. Lo que
//     se exige ahora es que sea SIEMPRE el mismo alumno (lib/testimonials
//     ownClasses + el hablante del clip) y que cada clip sea él hablando de forma
//     espontánea (lib/testimonialVerify), con el bueno mejor que el malo.

export const TESTIMONIAL_RULES = {
  /** Clases suyas (con nota de fluidez y con su nombre de hablante) que tiene que tener como mínimo. */
  CLASES_MIN: 4,
  /** El clip malo se busca en sus N primeras clases y el bueno en sus N últimas (sin solaparse). */
  VENTANA: 3,
  /** Días mínimos entre la clase del clip malo y la del bueno. */
  DIAS_MIN: 21,
  /** Nivel (1-5, de lib/testimonialVerify) que el clip bueno tiene que superar al malo, como poco. */
  MEJORA_CLIP_MIN: 1,
} as const;

export type TestimonialRules = { [K in keyof typeof TESTIMONIAL_RULES]: number };
