// ── Cuánto le falta al alumno y qué gana ampliando el plan ───────────────────
//
// ÚNICA FUENTE DE VERDAD DEL CÁLCULO. Si hay que ajustar los números que ve el
// alumno se tocan las constantes de aquí arriba y nada más: el banner no calcula,
// solo pinta lo que devuelve `construirEstimacion`.
//
// Sustituye a lib/progressEstimate.ts, que estimaba con las *Guided Learning
// Hours* de Cambridge por nivel (A2 190 h, B1 375 h, B2 550 h…). Ese modelo hacía
// depender el plazo del salto entre niveles, así que un A2 veía "7 meses" y un B1
// "15 meses" por el mismo esfuerzo semanal, y la promesa se volvía impredecible.
// Ahora el horizonte es FIJO —`HORAS_OBJETIVO`— y lo único que cambia el plazo es
// cuántas horas hace el alumno a la semana, que es justo lo que el banner ofrece
// cambiar.
//
// NULL NO ES CERO: si falta el nivel o las horas del plan, `construirEstimacion`
// devuelve null y el banner no se pinta. Preferimos no decir nada a darle a un
// alumno un número inventado sobre su propio aprendizaje.

import { CEFR_LADDER, parseCefr } from '@/lib/studentViz';

export type NivelCefr = typeof CEFR_LADDER[number];

// ── Constantes ajustables ────────────────────────────────────────────────────

/**
 * Horas guiadas del horizonte que se le pinta al alumno. Es el tramo de trabajo
 * que separa "donde estás" de "el siguiente escalón", y no depende del nivel.
 */
export const HORAS_OBJETIVO = 84;

/**
 * Horas guiadas que produce cada hora de clase.
 *
 * 1.5 = por cada hora de clase el alumno suma media hora de práctica propia
 * (deberes, series, conversación). Es el valor CONSERVADOR: con 2.0 los plazos
 * bajan casi un tercio y siguen siendo razonables, pero preferimos quedarnos
 * cortos en la promesa antes que pasarnos.
 */
export const MULTIPLICADOR_PRACTICA = 1.5;

/**
 * Semanas útiles en un mes. 4.0 y no 4.33 a propósito: descuenta vacaciones,
 * festivos y clases perdidas, unas 48 semanas activas al año.
 */
export const SEMANAS_POR_MES = 4.0;

/** Techo de horas semanales que tiene sentido proponer. */
export const HORAS_SEMANALES_MAXIMAS = 5;

/** Escalones de ampliación que se ofrecen sobre el plan actual. */
export const ESCALONES = [1, 2];

// ── Plazo ────────────────────────────────────────────────────────────────────

/**
 * Meses que lleva cubrir el horizonte a razón de `horasSemanales` de clase.
 *
 * Nunca menos de 1: "llegarías en 0 meses" no significa nada, y redondear a la
 * baja un plan intensivo prometería más de lo que se puede sostener.
 */
export function mesesPara(horasSemanales: number, horasObjetivo = HORAS_OBJETIVO): number {
  if (!Number.isFinite(horasSemanales) || horasSemanales <= 0) return 0;
  const guiadasPorMes = horasSemanales * MULTIPLICADOR_PRACTICA * SEMANAS_POR_MES;
  return Math.max(1, Math.round(horasObjetivo / guiadasPorMes));
}

/**
 * "mayo de 2028" a partir de hoy más `meses`.
 *
 * Aritmética en UTC a propósito: es una etiqueta de calendario, no un instante, y
 * calcularla en la zona del navegador haría que el día 1 de mes saltara al mes
 * anterior para media Europa.
 */
export function etiquetaLlegada(meses: number, desde: Date): string {
  const d = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth() + meses, 1));
  return d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "1 mes" · "15 meses". */
export function etiquetaMeses(n: number): string {
  return n === 1 ? '1 mes' : `${n} meses`;
}

/** "1 hora a la semana" · "3 horas a la semana". */
export function etiquetaHoras(n: number): string {
  return n === 1 ? '1 hora a la semana' : `${n} horas a la semana`;
}

// ── Detección de la meta ─────────────────────────────────────────────────────
//
// Muchos alumnos preparan un examen concreto, y ese examen ES su meta: quien
// prepara el First va a por el B2, no "al siguiente nivel".
//
// Las fuentes se miran EN ORDEN y gana la primera que contenga un examen
// reconocible, no la suma de todas. El nombre del producto de WooCommerce va
// primero porque es lo que el alumno compró —el dato más explícito y el más
// específico ("Preparación B2 First Certificate" frente a un escueto "B2
// Exámenes")— y el objetivo personal de la ficha va último porque es texto libre.

/** Exámenes de Cambridge y el nivel MCER que certifican. Mapeo oficial. */
const EXAMENES: Array<{ nivel: NivelCefr; re: RegExp }> = [
  { nivel: 'C2', re: /\b(proficiency|cpe)\b/ },
  { nivel: 'C1', re: /\b(advanced)\b/ },
  // IELTS no certifica un nivel fijo (banda 0-9): se toma B2, que corresponde a
  // la banda 5.5-6.5, la que pide la mayoría de universidades y visados.
  { nivel: 'B2', re: /\b(first\s+certificate|first|fce|ielts|toefl)\b/ },
  { nivel: 'B1', re: /\b(preliminary)\b/ },
];

/**
 * CAE y PET son a la vez códigos de examen y palabras españolas corrientes
 * ("cae bien el horario", "el pet de la familia"). Se exigen en MAYÚSCULAS sobre
 * el texto SIN normalizar, que es como se escriben siempre los exámenes.
 */
const CODIGOS_EXAMEN: Array<{ nivel: NivelCefr; re: RegExp }> = [
  { nivel: 'C1', re: /\bCAE\b/ },
  { nivel: 'B1', re: /\bPET\b/ },
];

/**
 * Muchos planes no nombran el examen, nombran su NIVEL: "B2 Exámenes",
 * "Preparación B1". Sin esto la detección se pierde a la mitad de los alumnos.
 *
 * El código MCER solo cuenta si aparece junto a una palabra de examen. Sin esa
 * condición, "Curso de inglés general - 2h semanales, B2" declararía el B2 como
 * meta cuando es el nivel al que YA da clase, y todos los alumnos de inglés
 * general saldrían con un objetivo inventado.
 */
const CONTEXTO_EXAMEN = /\b(examen(?:es)?|preparacion(?:es)?|certificad[oa]s?)\b/;
const CODIGO_CEFR = /\b(A1|A2|B1|B2|C1|C2)\b/g;

function normalizar(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** El examen escrito en UN texto, o null si no hay ninguno inequívoco. */
export function examenEnTexto(crudo: string | null | undefined): NivelCefr | null {
  const raw = (crudo ?? '').trim();
  if (!raw) return null;
  const texto = normalizar(raw);

  if (CONTEXTO_EXAMEN.test(texto)) {
    // Un solo código y sin ambigüedad. Con dos ("B1 Exámenes … objetivo C1") no se
    // sabe cuál es la meta, y adivinar es peor que no decir nada.
    const hallados = [...new Set(raw.toUpperCase().match(CODIGO_CEFR) ?? [])];
    if (hallados.length === 1) return hallados[0] as NivelCefr;
  }
  for (const { nivel, re } of EXAMENES) if (re.test(texto)) return nivel;
  for (const { nivel, re } of CODIGOS_EXAMEN) if (re.test(raw)) return nivel;
  return null;
}

/** De dónde salió el examen detectado, para poder auditarlo. */
export type OrigenFuente =
  | 'producto' | 'plan_alumno' | 'plan_assignment' | 'objetivo' | 'objetivo_personal';

/** Los textos donde puede estar escrito el examen, EN ORDEN de prioridad. */
export interface FuentesMeta {
  /** students.product_name — lo que compró en WooCommerce. */
  productoWoo?: string | null;
  /** students.plan */
  planAlumno?: string | null;
  /** assignments.plan */
  planAssignment?: string | null;
  /** assignments.objetivo */
  objetivo?: string | null;
  /** student_profiles.personal_objective */
  objetivoPersonal?: string | null;
}

const ORDEN_FUENTES: Array<[OrigenFuente, keyof FuentesMeta]> = [
  ['producto',          'productoWoo'],
  ['plan_alumno',       'planAlumno'],
  ['plan_assignment',   'planAssignment'],
  ['objetivo',          'objetivo'],
  ['objetivo_personal', 'objetivoPersonal'],
];

export type OrigenMeta = 'examen' | 'siguiente_nivel';

export interface Meta {
  nivel: NivelCefr;
  origen: OrigenMeta;
  /** Solo con `origen: 'examen'`: en qué campo se leyó. */
  fuente?: OrigenFuente;
}

/**
 * A qué nivel apunta el alumno.
 *
 *   1. Si prepara un examen POR ENCIMA de su nivel, el nivel de ese examen.
 *   2. Si no, el siguiente peldaño de la escalera. Modesto y honesto.
 *
 * Devuelve null en dos casos, y los dos significan lo mismo para la página (no
 * hay banner):
 *
 *   · Ya está en C2: no hay escalón por encima que prometer.
 *   · Ya está EN el nivel del examen que prepara (un "B1" preparando el PET). Su
 *     meta es aprobar ese examen, no subir al B2, y ofrecerle el B2 contesta una
 *     pregunta que no ha hecho. Recupera el banner en cuanto el profesor o la
 *     prueba le fijan su nivel real, que estará por debajo del examen.
 *
 * Un examen POR DEBAJO del nivel actual (un C1 apuntado al First) es un dato
 * incoherente: se ignora y se sigue por la escalera.
 */
export function detectarMeta(fuentes: FuentesMeta, nivelActual: NivelCefr): Meta | null {
  const actual = CEFR_LADDER.indexOf(nivelActual);

  for (const [origen, clave] of ORDEN_FUENTES) {
    const examen = examenEnTexto(fuentes[clave]);
    if (!examen) continue;
    const idx = CEFR_LADDER.indexOf(examen);
    if (idx > actual) return { nivel: examen, origen: 'examen', fuente: origen };
    if (idx === actual) return null;
    // Por debajo: dato incoherente. Se deja de buscar y manda la escalera.
    break;
  }

  const siguiente = CEFR_LADDER[actual + 1];
  return siguiente ? { nivel: siguiente, origen: 'siguiente_nivel' } : null;
}

// ── Los cuatro estados del banner ────────────────────────────────────────────

/**
 * · `sin_datos`  No hay nivel, ni horas, ni meta: el banner NO se pinta y el
 *                resto de la ficha sí.
 * · `tope`       Ya está en el plan más alto: no hay nada que ofrecerle.
 * · `examen`     Su meta es un examen concreto: el texto lo nombra.
 * · `ahorro`     El caso normal: ampliando llega antes.
 *
 * El orden importa y es este: primero si hay datos, luego si queda margen para
 * ampliar, y solo entonces se distingue si la meta es un examen. Un alumno de
 * examen que ya hace 5 h cae en `tope` a propósito: no hay ampliación que
 * venderle, y felicitarle por su ritmo es lo único honesto que se le puede decir.
 */
export type EstadoBanner = 'sin_datos' | 'tope' | 'examen' | 'ahorro';

export interface OpcionPlan {
  horasSemanales: number;
  meses: number;
  /** "mayo de 2028" */
  llegada: string;
  /** Ancho relativo de la barra, 0 a 100. El plan más lento siempre vale 100. */
  anchoPct: number;
  esActual: boolean;
  /** Meses que se ahorra respecto del plan actual. 0 en el plan actual. */
  mesesAhorrados: number;
}

export interface Estimacion {
  estado: Exclude<EstadoBanner, 'sin_datos'>;
  nivelActual: NivelCefr;
  meta: Meta;
  horasObjetivo: number;
  horasSemanalesActuales: number;
  /** Plan actual primero, luego las ampliaciones. Nunca vacío. */
  opciones: OpcionPlan[];
  /** ¿Hay algo que ofrecer? False cuando ya está en el plan más alto. */
  hayAmpliacion: boolean;
  /** La mejor ampliación disponible. null en `tope`. */
  mejor: OpcionPlan | null;
}

export interface EntradaEstimacion {
  /** Nivel actual en crudo: "B1", "Nivel b1", "B1 exámenes"… */
  nivelActual: string | null | undefined;
  /** Horas de clase a la semana (sale de resolveWeeklyHours). */
  horasSemanales: number | null | undefined;
  fuentes: FuentesMeta;
  /** Inyectable para poder testear con una fecha fija. */
  ahora?: Date;
}

/** El estado del banner, sin construir la estimación entera. Para poder testearlo. */
export function estadoDeBanner(entrada: EntradaEstimacion): EstadoBanner {
  return construirEstimacion(entrada)?.estado ?? 'sin_datos';
}

/**
 * La estimación completa, o null si no hay datos suficientes (`sin_datos`).
 */
export function construirEstimacion(entrada: EntradaEstimacion): Estimacion | null {
  const nivelActual = parseCefr(entrada.nivelActual) as NivelCefr | null;
  if (!nivelActual) return null;

  const semanales = Math.round(Number(entrada.horasSemanales ?? 0));
  if (!Number.isFinite(semanales) || semanales < 1) return null;

  const meta = detectarMeta(entrada.fuentes, nivelActual);
  if (!meta) return null;

  const ahora = entrada.ahora ?? new Date();
  const planes = [
    semanales,
    ...ESCALONES.map(s => semanales + s).filter(h => h <= HORAS_SEMANALES_MAXIMAS),
  ];

  const crudas = planes.map(h => ({ horasSemanales: h, meses: mesesPara(h) }));
  const masLento = crudas[0].meses || 1;

  const opciones: OpcionPlan[] = crudas.map(o => ({
    horasSemanales: o.horasSemanales,
    meses: o.meses,
    llegada: etiquetaLlegada(o.meses, ahora),
    // Suelo del 12%: una barra de 3 píxeles no se lee como una barra.
    anchoPct: Math.max(12, Math.round((o.meses / masLento) * 100)),
    esActual: o.horasSemanales === semanales,
    mesesAhorrados: Math.max(0, crudas[0].meses - o.meses),
  }));

  const hayAmpliacion = opciones.length > 1;
  const estado: Exclude<EstadoBanner, 'sin_datos'> =
    !hayAmpliacion ? 'tope' : meta.origen === 'examen' ? 'examen' : 'ahorro';

  return {
    estado,
    nivelActual,
    meta,
    horasObjetivo: HORAS_OBJETIVO,
    horasSemanalesActuales: semanales,
    opciones,
    hayAmpliacion,
    mejor: hayAmpliacion ? opciones[opciones.length - 1] : null,
  };
}
