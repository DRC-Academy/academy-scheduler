// Testimoniales — las reglas para proponer una pareja "antes / después".
//
// Único sitio donde se tocan. La detección (lib/testimonials.ts) solo las lee.
// Cambiar un número aquí afecta a las parejas que se detecten DESDE ese momento;
// las que ya están en la tabla no se recalculan solas (para eso, el botón
// "Analizar clases pasadas" o `npm run fluidez -- --detectar --apply`).

export const TESTIMONIAL_RULES = {
  /** La clase "antes" tiene una nota de fluidez de como mucho esto (1-10). */
  NOTA_ANTES_MAX: 4,
  /** La clase "después" tiene como mínimo esto. */
  NOTA_DESPUES_MIN: 7,
  /** Diferencia mínima entre las dos notas. */
  MEJORA_MIN: 3,
  /** Semanas mínimas entre las dos clases. */
  SEMANAS_MIN: 6,
  /**
   * Las dos citas (dónde se trababa / dónde habla con soltura) tienen que
   * aparecer de verdad en su transcript. Sin eso no hay un minuto fiable que
   * pedirle al profe de la grabación.
   */
  CITAS_COMPROBADAS: true,
} as const;

export type TestimonialRules = { [K in keyof typeof TESTIMONIAL_RULES]: (typeof TESTIMONIAL_RULES)[K] extends boolean ? boolean : number };
