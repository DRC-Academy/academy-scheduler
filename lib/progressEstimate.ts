// ── Estimación de cuánto le falta al alumno para llegar a su objetivo ────────
//
// ESTE ARCHIVO ES LA ÚNICA FUENTE DE VERDAD DEL CÁLCULO. Si algún día hay que
// ajustar los números que ve el alumno, se tocan las constantes de aquí arriba y
// nada más: la página no calcula, sólo pinta lo que devuelve `buildEstimate`.
//
// DE DÓNDE SALEN LAS HORAS (para poder defenderlo si un alumno pregunta)
//
// La tabla son las *Guided Learning Hours* que publica Cambridge English para
// cada uno de sus exámenes, que es la referencia pública y citable sobre cuántas
// horas de estudio guiado lleva alcanzar cada nivel del MCER:
//
//     A2 Key            180 – 200 h
//     B1 Preliminary    350 – 400 h
//     B2 First          500 – 600 h
//     C1 Advanced       700 – 800 h
//     C2 Proficiency  1.000 – 1.200 h
//
// Se usa el valor medio de cada rango. A1 no lo publica Cambridge (no tiene
// examen a ese nivel); 90 h es la cifra de consenso habitual y sólo se usa como
// suelo de la escalera, nunca como objetivo.
//
// NO SON HORAS DE CLASE, SON HORAS GUIADAS. Es la distinción que justifica el
// multiplicador de práctica: un alumno que da una hora de clase no avanza una
// hora guiada, avanza esa hora MÁS lo que practica por su cuenta entre clases.
// Contar sólo el aula supondría que el alumno no toca el inglés el resto de la
// semana, y devolvería estimaciones absurdamente pesimistas.
//
// NULL NO ES CERO, la misma regla que gobierna lib/billing.ts: si falta el nivel
// actual o las horas del plan, `buildEstimate` devuelve null y la página no
// enseña el bloque. Preferimos no decir nada a decirle a un alumno un número
// inventado sobre su propio aprendizaje.

import { CEFR_LADDER, parseCefr } from '@/lib/studentViz';

export type CefrLevel = typeof CEFR_LADDER[number];

// ── Constantes ajustables ────────────────────────────────────────────────────

/** Horas guiadas ACUMULADAS para alcanzar cada nivel (Cambridge, media del rango). */
export const GUIDED_HOURS_TO_REACH: Record<CefrLevel, number> = {
  A1: 90,
  A2: 190,
  B1: 375,
  B2: 550,
  C1: 750,
  C2: 1100,
};

/**
 * Horas guiadas que produce cada hora de clase.
 *
 * 1.5 = por cada hora de clase el alumno suma media hora de práctica propia
 * (deberes, series, conversación, la app). Es el valor CONSERVADOR: con 2.0 las
 * estimaciones bajan casi un tercio y siguen siendo razonables, pero preferimos
 * quedarnos cortos en la promesa antes que pasarnos.
 */
export const PRACTICE_MULTIPLIER = 1.5;

/**
 * Semanas útiles en un mes. 4.0 y no 4.33 a propósito: descuenta vacaciones,
 * festivos y clases perdidas, unas 48 semanas activas al año.
 */
export const WEEKS_PER_MONTH = 4.0;

/** Techo de horas semanales que tiene sentido proponer en el banner. */
export const MAX_WEEKLY_HOURS = 5;

/** Escalones de ampliación que se ofrecen sobre el plan actual. */
export const UPGRADE_STEPS = [1, 2];

// ── Nivel objetivo ───────────────────────────────────────────────────────────

/**
 * Exámenes de Cambridge y el nivel MCER que certifican. Es el mapeo oficial, no
 * una interpretación nuestra.
 *
 * IELTS no certifica un nivel fijo (es una banda de 0 a 9), así que se toma B2:
 * corresponde a la banda 5.5 – 6.5, que es la que pide la inmensa mayoría de
 * universidades y visados, y es lo que persigue casi todo el que se apunta.
 */
const EXAM_TARGETS: Array<{ level: CefrLevel; re: RegExp }> = [
  { level: 'C2', re: /\b(proficiency|cpe)\b/ },
  { level: 'C1', re: /\b(advanced)\b/ },
  { level: 'B2', re: /\b(first\s+certificate|first|fce|ielts|toefl)\b/ },
  { level: 'B1', re: /\b(preliminary)\b/ },
];

// CAE y PET son a la vez códigos de examen y palabras españolas corrientes
// ("cae bien el horario"). Igual que en lib/productUtils, se exigen en MAYÚSCULAS
// sobre el texto SIN normalizar, que es como se escriben siempre los exámenes.
const EXAM_CODES: Array<{ level: CefrLevel; re: RegExp }> = [
  { level: 'C1', re: /\bCAE\b/ },
  { level: 'B1', re: /\bPET\b/ },
];

/**
 * Muchos planes no nombran el examen, nombran su NIVEL: "B2 Exámenes",
 * "Preparación B1". Son 32 de las 184 assignments reales, así que sin esto la
 * detección se pierde a la mitad de los alumnos de examen.
 *
 * El código MCER sólo cuenta si aparece junto a una palabra de examen. Sin esa
 * condición, "Curso de inglés general - 2h semanales, B2" declararía el B2 como
 * meta cuando es el nivel al que YA da clase, y todos los alumnos de inglés
 * general saldrían con un objetivo inventado.
 */
const EXAM_CONTEXT_RE = /\b(examen(?:es)?|preparacion(?:es)?|certificad[oa]s?)\b/;
const CEFR_CODE_RE = /\b(A1|A2|B1|B2|C1|C2)\b/g;

function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** El nivel del examen escrito en el texto, o null si no hay uno inequívoco. */
function examLevelOf(raw: string, text: string): CefrLevel | null {
  if (EXAM_CONTEXT_RE.test(text)) {
    // Un solo código y sin ambigüedad. Con dos ("B1 Exámenes … objetivo C1") no
    // se sabe cuál es la meta, y adivinar es peor que no decir nada.
    const found = [...new Set(raw.toUpperCase().match(CEFR_CODE_RE) ?? [])];
    if (found.length === 1) return found[0] as CefrLevel;
  }
  for (const { level, re } of EXAM_TARGETS) if (re.test(text)) return level;
  for (const { level, re } of EXAM_CODES) if (re.test(raw)) return level;
  return null;
}

export type TargetSource = 'examen' | 'siguiente_nivel';

export interface TargetLevel {
  level: CefrLevel;
  source: TargetSource;
}

/**
 * El nivel al que apunta el alumno.
 *
 * 1. Si su plan es de examen, el nivel que certifica ese examen. Es el objetivo
 *    real y explícito: quien prepara el First va a por el B2, no "al siguiente".
 * 2. Si no, el siguiente peldaño de la escalera. Modesto y honesto.
 *
 * NULL EN DOS CASOS, y los dos significan lo mismo para la página (no hay banner):
 *
 *   · El alumno ya está en C2. No hay escalón por encima que prometer.
 *   · El alumno ya está EN el nivel del examen que prepara. Es el caso de 41 de
 *     los 55 alumnos de examen reales: alguien "en B1" preparando el B1. Su meta
 *     es aprobar ese examen, no subir al B2, y decirle "para llegar al B2 te
 *     quedan 175 horas" contesta una pregunta que no ha hecho. No tenemos una
 *     referencia defendible de cuántas horas lleva consolidar un nivel hasta
 *     aprobar su examen, así que no se estima. Ese alumno recupera el banner en
 *     cuanto la ficha o el test de nivel le fijan su nivel real, que estará por
 *     debajo del examen.
 *
 * Un examen POR DEBAJO del nivel actual (un C1 apuntado al First) es un dato
 * incoherente: se ignora y se sigue por la escalera.
 */
export function detectTargetLevel(
  planTexts: Array<string | null | undefined>,
  currentLevel: CefrLevel,
): TargetLevel | null {
  const raw = planTexts.filter(Boolean).join(' ');
  const text = normalize(raw);
  const currentIdx = CEFR_LADDER.indexOf(currentLevel);

  const exam = examLevelOf(raw, text);
  if (exam) {
    const examIdx = CEFR_LADDER.indexOf(exam);
    if (examIdx > currentIdx) return { level: exam, source: 'examen' };
    if (examIdx === currentIdx) return null;
  }

  const next = CEFR_LADDER[currentIdx + 1];
  return next ? { level: next, source: 'siguiente_nivel' } : null;
}

// ── Aritmética ───────────────────────────────────────────────────────────────

/** Horas guiadas que separan dos niveles. 0 si el objetivo no está por encima. */
export function hoursBetween(from: CefrLevel, to: CefrLevel): number {
  const diff = GUIDED_HOURS_TO_REACH[to] - GUIDED_HOURS_TO_REACH[from];
  return diff > 0 ? diff : 0;
}

/** Meses que lleva cubrir `hours` a razón de `weeklyHours` de clase por semana. */
export function monthsFor(hours: number, weeklyHours: number): number {
  if (weeklyHours <= 0 || hours <= 0) return 0;
  const perMonth = weeklyHours * PRACTICE_MULTIPLIER * WEEKS_PER_MONTH;
  return Math.max(1, Math.round(hours / perMonth));
}

/**
 * "mayo de 2028" a partir de hoy más `months`.
 *
 * Aritmética en UTC a propósito: es una etiqueta de calendario, no un instante,
 * y calcularla en la zona del navegador haría que el día 1 de mes saltara al mes
 * anterior para media Europa.
 */
export function arrivalLabel(months: number, from: Date): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  return d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// ── Resultado ────────────────────────────────────────────────────────────────

export interface EstimateOption {
  weeklyHours: number;
  months: number;
  /** "mayo de 2028" */
  arrival: string;
  /** Ancho relativo de la barra, 0 a 100. El plan más lento siempre vale 100. */
  barPct: number;
  isCurrent: boolean;
  /** Meses que se ahorra respecto al plan actual. 0 en el plan actual. */
  monthsSaved: number;
}

export interface Estimate {
  currentLevel: CefrLevel;
  target: TargetLevel;
  /** Horas guiadas que separan el nivel actual del objetivo. */
  hoursNeeded: number;
  currentWeeklyHours: number;
  /** Plan actual primero, luego las ampliaciones. Nunca vacío. */
  options: EstimateOption[];
  /** ¿Hay algo que ofrecer? False cuando ya está en el plan más alto. */
  hasUpgrade: boolean;
}

export interface EstimateInput {
  /** Nivel actual en crudo: "B1", "Nivel b1", "B1 exámenes"… */
  currentLevel: string | null | undefined;
  /** Horas de clase a la semana del plan contratado. */
  weeklyHours: number | null | undefined;
  /** Textos donde puede estar escrito el examen: plan, objetivo, producto. */
  planTexts: Array<string | null | undefined>;
  /** Inyectable para poder testear con una fecha fija. */
  now?: Date;
}

/**
 * La estimación completa, o null si no hay datos suficientes.
 *
 * Devuelve null cuando: no se reconoce el nivel actual, no se saben las horas
 * del plan, o el alumno ya está en lo más alto de la escalera. En los tres casos
 * la página simplemente no enseña el bloque.
 */
export function buildEstimate(input: EstimateInput): Estimate | null {
  const currentLevel = parseCefr(input.currentLevel) as CefrLevel | null;
  if (!currentLevel) return null;

  const weekly = Math.round(Number(input.weeklyHours ?? 0));
  if (!Number.isFinite(weekly) || weekly < 1) return null;

  const target = detectTargetLevel(input.planTexts, currentLevel);
  if (!target) return null;

  const hoursNeeded = hoursBetween(currentLevel, target.level);
  if (hoursNeeded <= 0) return null;

  const now = input.now ?? new Date();
  const plans = [weekly, ...UPGRADE_STEPS.map(s => weekly + s).filter(h => h <= MAX_WEEKLY_HOURS)];

  const raw = plans.map(h => ({ weeklyHours: h, months: monthsFor(hoursNeeded, h) }));
  const slowest = raw[0].months || 1;

  const options: EstimateOption[] = raw.map(o => ({
    weeklyHours: o.weeklyHours,
    months: o.months,
    arrival: arrivalLabel(o.months, now),
    barPct: Math.max(12, Math.round((o.months / slowest) * 100)),
    isCurrent: o.weeklyHours === weekly,
    monthsSaved: Math.max(0, raw[0].months - o.months),
  }));

  return {
    currentLevel,
    target,
    hoursNeeded,
    currentWeeklyHours: weekly,
    options,
    hasUpgrade: options.length > 1,
  };
}

/** "1 mes" · "15 meses". */
export function monthsLabel(n: number): string {
  return n === 1 ? '1 mes' : `${n} meses`;
}

/** "1 hora a la semana" · "3 horas a la semana". */
export function weeklyLabel(n: number): string {
  return n === 1 ? '1 hora a la semana' : `${n} horas a la semana`;
}
