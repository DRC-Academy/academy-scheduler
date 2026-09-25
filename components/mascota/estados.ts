/**
 * Los estados de la mascota.
 *
 * Módulo puro, sin React: lo importan el componente, el hook y la
 * página de pruebas. Qué se ve en cada estado lo dice parches.json (lo
 * escribe mascota/scripts/parches.py); cómo se mueve, el componente.
 */

export type EstadoMascota =
  | "idle"
  | "estudiando"
  | "exito"
  | "duda"
  | "animo"
  | "racha_perdida"
  | "nivel_superado";

export const ESTADOS_MASCOTA: readonly EstadoMascota[] = [
  "idle",
  "estudiando",
  "exito",
  "duda",
  "animo",
  "racha_perdida",
  "nivel_superado",
];

/** Cuánto dura un estado que no es idle antes de volver solo. */
export const DURACION_ESTADO_MS = 2500;

/**
 * Los gestos: poses sueltas que se ponen ENCIMA del estado que haya
 * (`mascota.gesto("saludo")`), duran un rato y se van; el estado sigue
 * debajo con su reloj. «salto» y «sentado» cambian la pose entera: su
 * parche es el personaje completo y tapa el cuerpo y la cola. «guino»
 * no tiene variante propia: usa la cara de «ánimo» (ver Geckonoid).
 */
export type GestoMascota =
  | "saludo"
  | "senala"
  | "salto"
  | "dormido"
  | "estira"
  | "piensa"
  | "asombro"
  | "mira_izq"
  | "mira_der"
  | "sentado"
  | "guino";

export const GESTOS_MASCOTA: readonly GestoMascota[] = [
  "saludo",
  "senala",
  "salto",
  "dormido",
  "estira",
  "piensa",
  "asombro",
  "mira_izq",
  "mira_der",
  "sentado",
  "guino",
];

/** Cuánto se enseña cada gesto. Dormir y sentarse piden algo más de tiempo para leerse. */
export const DURACION_GESTO_MS: Record<GestoMascota, number> = {
  saludo: 1800,
  senala: 1800,
  salto: 1400,
  dormido: 3000,
  estira: 2000,
  piensa: 2200,
  asombro: 1600,
  mira_izq: 1400,
  mira_der: 1400,
  sentado: 2600,
  guino: 900,
};
