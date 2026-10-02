// "No puedo dar esta clase" — las REGLAS, sin red ni base.
//
// El profesor que no puede dar una clase la cancela proponiendo dos fechas para
// recuperarla (o una sola si ya lo acordó con el alumno). El alumno elige desde
// el LMS. Este módulo decide, sin tocar nada:
//   · la antelación (minutos exactos, hora de España);
//   · los comodines: 2 cancelaciones con menos de 24 h al mes por profesor, en
//     total; desde la 3.ª, −5 € (a partir de PENALTY_START_DATE);
//   · si las fechas propuestas valen;
//   · qué cambios de estado están permitidos.
// El servidor (lib/classRecoveryStore.ts) aplica lo que esto decide. La pantalla
// solo lo muestra. Lo prueba lib/classRecoveries.test.ts.
//
// SEPARADO DE LAS FALTAS DEL ALUMNO, a propósito. Los comodines se cuentan SOLO
// sobre la tabla class_recoveries (cancelaciones del profesor). Nunca se mira
// falta_sin_aviso, cancelacion_hora ni falta_con_aviso: mezclar culpables fue el
// bug del 06/08/2026 (commit 33393b6), donde la falta del alumno le quitaba 5 €
// al profesor.

import { getSpainParts, spainWallClockToEpoch } from '@/lib/spainTime';
import { addDaysIso, dayNameFromIso } from '@/lib/teacherClasses';
import { hourNum, hourText } from '@/lib/sessions';

// ── Beta ──────────────────────────────────────────────────────────────────────

/**
 * Profesores que ven y usan el flujo nuevo. El resto sigue EXACTAMENTE como
 * antes (mismo "Cancelar clase", mismo "Reprogramar", sin reservas, sin
 * consultar class_recoveries).
 *
 * PARA ABRIRLO A TODOS: cambiar esta línea por `['*']`.
 */
export const RECOVERY_BETA_TEACHERS: readonly string[] = ['t1'];

export function isRecoveryBetaTeacher(teacherId: string | null | undefined): boolean {
  if (RECOVERY_BETA_TEACHERS.includes('*')) return true;
  return !!teacherId && RECOVERY_BETA_TEACHERS.includes(teacherId);
}

// ── Constantes de la regla ────────────────────────────────────────────────────

/**
 * Desde qué día (fecha de la CANCELACIÓN, hora de España) se cobra la multa.
 * Antes se cuenta igual y se avisa "te costaría 5 €", pero no se crea el evento
 * de −5 €: queda `would_have_penalty` para saber cuántas habría habido.
 */
export const PENALTY_START_DATE = '2026-10-15';
/** Menos de esto es "sin antelación" y gasta comodín. */
export const LATE_NOTICE_MINUTES = 24 * 60;
/** Cancelaciones sin antelación gratis al mes, por profesor y en total. */
export const MONTHLY_WILDCARDS = 2;
export const PENALTY_EUROS = 5;
/** Solo texto por ahora: nada detecta todavía la ausencia sin cancelar. */
export const NO_SHOW_PENALTY_EUROS = 10;
/** Las fechas propuestas (del profesor o del alumno) caen en los próximos N días. */
export const PROPOSAL_WINDOW_DAYS = 7;
export const MAX_ROUNDS = 2;
export const MAX_STUDENT_PROPOSALS = 3;

/**
 * De dónde salió una fila. 'admin_reclasificacion': el admin aprobó una
 * revisión como "cancelada por el profesor" (la clase pasó sin aviso). Esa NO
 * usa comodín ni ocupa uno: lleva la multa fija (ver reclassPenalty).
 */
export type RecoveryOrigin = 'profesor' | 'admin_reclasificacion';

/**
 * Multa de una reclasificación del admin: fija, sin comodines, contada en el
 * mes de la CLASE. Antes de PENALTY_START_DATE no se cobra, solo se marca.
 */
export function reclassPenalty(classDate: string): { chargeNow: boolean; wouldHavePenalty: boolean; penaltyEuros: number } {
  const chargeNow = classDate >= PENALTY_START_DATE;
  return { chargeNow, wouldHavePenalty: !chargeNow, penaltyEuros: chargeNow ? -PENALTY_EUROS : 0 };
}
export const MAX_NOTE_LENGTH = 500;

// ── Estados ───────────────────────────────────────────────────────────────────

export type RecoveryStatus =
  | 'esperando_alumno'   // el profe propuso fechas (reservadas) y el alumno elige
  | 'alumno_propuso'     // el alumno dijo "ninguna" y propuso horarios: le toca al profe
  | 'confirmada'         // hay fecha: celda de recuperación + constancia creadas
  | 'recuperada'         // la recuperación se dio (hay ingreso)
  | 'sin_acuerdo'        // sin fecha tras las rondas o con las fechas vencidas
  | 'anulada';           // baja del alumno, anulación del admin…

export const RECOVERY_STATUSES: readonly RecoveryStatus[] =
  ['esperando_alumno', 'alumno_propuso', 'confirmada', 'recuperada', 'sin_acuerdo', 'anulada'];

/**
 * Estados que bloquean otra recuperación de la MISMA clase (índice único en la
 * base). 'sin_acuerdo' no: la clase sigue a favor del alumno y se puede volver a
 * intentar.
 */
export const BLOCKING_STATUSES: readonly RecoveryStatus[] = ['esperando_alumno', 'alumno_propuso', 'confirmada', 'recuperada'];

const TRANSITIONS: Record<RecoveryStatus, readonly RecoveryStatus[]> = {
  esperando_alumno: ['confirmada', 'alumno_propuso', 'sin_acuerdo', 'anulada'],
  // Ronda 2: el profe vuelve a proponer (→ esperando_alumno) o acepta uno (→ confirmada).
  alumno_propuso:   ['confirmada', 'esperando_alumno', 'sin_acuerdo', 'anulada'],
  confirmada:       ['recuperada', 'anulada'],
  recuperada:       [],
  sin_acuerdo:      ['anulada'],
  anulada:          [],
};

export function canTransition(from: RecoveryStatus, to: RecoveryStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** El alumno dijo "ninguna me viene bien": a qué estado pasa según la ronda. */
export function statusAfterNone(round: number): RecoveryStatus {
  return round < MAX_ROUNDS ? 'alumno_propuso' : 'sin_acuerdo';
}

// ── Tiempo (siempre hora de España) ───────────────────────────────────────────

/** Un hueco en el calendario: fecha, hora de inicio ('HH:00') y horas seguidas. */
export interface Slot {
  date: string;
  hour: string;
  hours: number;
}

/** 'YYYY-MM' de un instante, en hora de España. */
export function spainMonthOf(instant: Date | string | number): string {
  return getSpainParts(new Date(instant)).dateStr.slice(0, 7);
}

/** 'YYYY-MM-DD' de un instante, en hora de España. */
export function spainDateOf(instant: Date | string | number): string {
  return getSpainParts(new Date(instant)).dateStr;
}

/** Instante de inicio de una clase (hora de pared española). NaN si no parsea. */
export function slotStartMs(date: string, hour: string | number): number {
  const h = hourNum(hour);
  return Number.isFinite(h) ? spainWallClockToEpoch(date, h) : NaN;
}

/** Minutos que faltan para la clase. Negativo si ya empezó. */
export function noticeMinutes(original: { date: string; hour: string }, nowMs: number): number {
  return Math.floor((slotStartMs(original.date, original.hour) - nowMs) / 60_000);
}

export function isLateNotice(minutes: number): boolean {
  return minutes < LATE_NOTICE_MINUTES;
}

// ── Comodines y multa ─────────────────────────────────────────────────────────

/** Una cancelación del profesor ya guardada (una por grupo: las partes comparten). */
export interface PriorCancellation {
  groupId: string;
  cancelledAt: string;
  late: boolean;
  status: RecoveryStatus;
}

export interface WildcardOutcome {
  /** Cancelaciones sin antelación de este mes, CONTANDO esta si es sin antelación. */
  lateThisMonth: number;
  /** Posición de esta entre las sin antelación del mes (1, 2, 3…). null si no es sin antelación. */
  position: number | null;
  usedWildcard: boolean;
  /** Comodines que quedan DESPUÉS de esta cancelación. */
  wildcardsLeft: number;
  /** Le corresponde multa por la regla (3.ª o posterior del mes). */
  penaltyApplies: boolean;
  /** Se cobra de verdad (la regla y la fecha de inicio). */
  chargeNow: boolean;
  /** Le habría correspondido multa, pero es anterior a PENALTY_START_DATE. */
  wouldHavePenalty: boolean;
  /** 0 o −5. */
  penaltyEuros: number;
}

/**
 * Comodines de una cancelación. `prior` son las cancelaciones del MISMO profesor
 * (cualquier mes; aquí se filtra por el de la cancelación). Si la propia
 * cancelación ya está guardada y viene en `prior` (con su `groupId`), su posición
 * se decide por el orden (cancelled_at, group_id): dos guardadas casi a la vez no
 * pueden ocupar las dos el último comodín.
 */
export function wildcardOutcome(args: {
  prior: PriorCancellation[];
  groupId?: string;
  cancelledAt: string;
  late: boolean;
}): WildcardOutcome {
  const month = spainMonthOf(args.cancelledAt);
  const others = args.prior.filter(p =>
    p.late && p.status !== 'anulada' && spainMonthOf(p.cancelledAt) === month && p.groupId !== args.groupId);

  if (!args.late) {
    const used = new Set(others.map(p => p.groupId)).size;
    return {
      lateThisMonth: used, position: null, usedWildcard: false,
      wildcardsLeft: Math.max(0, MONTHLY_WILDCARDS - used),
      penaltyApplies: false, chargeNow: false, wouldHavePenalty: false, penaltyEuros: 0,
    };
  }

  const key = (p: { cancelledAt: string; groupId: string }) => `${new Date(p.cancelledAt).toISOString()}|${p.groupId}`;
  const mine = { cancelledAt: args.cancelledAt, groupId: args.groupId ?? '~' };
  const groups = new Map<string, string>();   // groupId → clave de orden (la primera parte)
  for (const p of others) {
    const k = key(p);
    const prev = groups.get(p.groupId);
    if (!prev || k < prev) groups.set(p.groupId, k);
  }
  const before = [...groups.values()].filter(k => k < key(mine)).length;
  const position = before + 1;
  const lateThisMonth = groups.size + 1;

  const penaltyApplies = position > MONTHLY_WILDCARDS;
  const chargeNow = penaltyApplies && spainDateOf(args.cancelledAt) >= PENALTY_START_DATE;
  return {
    lateThisMonth, position,
    usedWildcard: !penaltyApplies,
    wildcardsLeft: Math.max(0, MONTHLY_WILDCARDS - position),
    penaltyApplies, chargeNow,
    wouldHavePenalty: penaltyApplies && !chargeNow,
    penaltyEuros: chargeNow ? -PENALTY_EUROS : 0,
  };
}

// ── Validación de fechas ──────────────────────────────────────────────────────

/** Normaliza '9', '09:00' → '09:00'. null si no es una hora en punto válida. */
export function normalizeHour(hour: string | number | null | undefined): string | null {
  const h = hourNum(hour as string);
  return Number.isFinite(h) && h >= 0 && h <= 23 ? hourText(h) : null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Por qué una hora concreta (fecha + 'HH:00') no está libre, o null si lo está. */
export type OccupiedCheck = (date: string, hour: string) => string | null;

/**
 * Problemas de UN hueco propuesto (todas sus horas). Lista vacía = vale.
 * Se permite recuperar ANTES de la fecha de la clase original.
 */
export function slotProblems(slot: Slot, opts: {
  nowMs: number;
  occupied: OccupiedCheck;
  /** Hueco de la clase cancelada: no se puede "recuperar" en su mismo sitio. */
  original?: { date: string; hour: string };
}): string[] {
  const problems: string[] = [];
  const hour = normalizeHour(slot.hour);
  if (!ISO.test(slot.date ?? '') || !hour) return ['Fecha u hora no válidas.'];
  if (dayNameFromIso(slot.date) === 'Domingo') return ['Los domingos no hay calendario: elige otro día.'];

  const start = slotStartMs(slot.date, hour);
  if (!(start > opts.nowMs)) problems.push(`El ${slot.date} a las ${hour} ya pasó.`);
  const limit = addDaysIso(spainDateOf(opts.nowMs), PROPOSAL_WINDOW_DAYS);
  if (slot.date > limit) problems.push(`Tiene que ser dentro de los próximos ${PROPOSAL_WINDOW_DAYS} días (hasta el ${limit}).`);
  if (opts.original && slot.date === opts.original.date && hour === normalizeHour(opts.original.hour)) {
    problems.push('Es la misma hora de la clase que cancelas.');
  }
  const hours = Math.max(1, Math.min(4, Math.round(slot.hours || 1)));
  const startH = hourNum(hour);
  if (startH + hours > 24) problems.push('La clase terminaría después de medianoche.');
  for (let i = 0; i < hours && startH + i < 24; i++) {
    const why = opts.occupied(slot.date, hourText(startH + i));
    if (why) { problems.push(why); break; }
  }
  return problems;
}

/**
 * Días que el PROFESOR puede proponer: desde mañana hasta dentro de
 * PROPOSAL_WINDOW_DAYS, sin domingos (hora de España). Hoy no: el alumno tiene
 * que tener tiempo de leer el email y elegir. El modal pinta estos días y el
 * servidor valida con la misma regla (teacherSlotProblems).
 */
export function teacherProposalDays(nowMs: number): string[] {
  const today = spainDateOf(nowMs);
  return Array.from({ length: PROPOSAL_WINDOW_DAYS }, (_, i) => addDaysIso(today, i + 1))
    .filter(d => dayNameFromIso(d) !== 'Domingo');
}

/** slotProblems + la regla del profesor: nunca para hoy. */
export function teacherSlotProblems(slot: Slot, opts: Parameters<typeof slotProblems>[1]): string[] {
  const problems = slotProblems(slot, opts);
  if (ISO.test(slot.date ?? '') && slot.date <= spainDateOf(opts.nowMs) && !problems.some(p => p.includes('ya pasó'))) {
    problems.unshift('Tiene que ser a partir de mañana.');
  }
  return problems;
}

/**
 * Las propuestas del profesor para UN trozo a recuperar: 2 obligatorias (o 1 si
 * ya lo acordó con el alumno), distintas entre sí. Devuelve un problema por
 * propuesta (índice) y los generales.
 */
export function validateTeacherProposals(proposals: Slot[], opts: {
  agreedDirectly: boolean;
  nowMs: number;
  occupied: OccupiedCheck;
  original: { date: string; hour: string };
}): { ok: boolean; general: string[]; perSlot: string[][] } {
  const needed = opts.agreedDirectly ? 1 : 2;
  const general: string[] = [];
  if (proposals.length !== needed) {
    general.push(opts.agreedDirectly
      ? 'Indica la fecha que acordaste con el alumno.'
      : 'Propón dos fechas distintas para recuperar la clase.');
  }
  const perSlot = proposals.map(s => teacherSlotProblems(s, opts));
  const keys = proposals.map(s => `${s.date}|${normalizeHour(s.hour)}`);
  if (new Set(keys).size !== keys.length) general.push('Las dos fechas propuestas son iguales.');
  return { ok: general.length === 0 && perSlot.every(p => p.length === 0), general, perSlot };
}

/** Los horarios que propone el alumno ("ninguna me viene bien"): 1 a 3, futuros, en 7 días. */
export function validateStudentProposals(
  horarios: Array<{ date: string; hour: string }>, note: string | null | undefined, nowMs: number,
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(horarios) || horarios.length === 0) problems.push('Indica al menos un horario.');
  if ((horarios?.length ?? 0) > MAX_STUDENT_PROPOSALS) problems.push(`Como máximo ${MAX_STUDENT_PROPOSALS} horarios.`);
  for (const h of horarios ?? []) {
    const hour = normalizeHour(h?.hour);
    if (!ISO.test(h?.date ?? '') || !hour) { problems.push('Fecha u hora no válidas.'); continue; }
    if (!(slotStartMs(h.date, hour) > nowMs)) problems.push(`El ${h.date} a las ${hour} ya pasó.`);
    if (h.date > addDaysIso(spainDateOf(nowMs), PROPOSAL_WINDOW_DAYS)) {
      problems.push(`El ${h.date} queda fuera de los próximos ${PROPOSAL_WINDOW_DAYS} días.`);
    }
  }
  const keys = (horarios ?? []).map(h => `${h?.date}|${normalizeHour(h?.hour)}`);
  if (new Set(keys).size !== keys.length) problems.push('Hay horarios repetidos.');
  if ((note ?? '').length > MAX_NOTE_LENGTH) problems.push(`La nota no puede pasar de ${MAX_NOTE_LENGTH} caracteres.`);
  return problems;
}

/** ¿Ya empezaron TODAS las fechas propuestas? Entonces la espera venció. */
export function proposalsExpired(proposals: Slot[], nowMs: number): boolean {
  return proposals.length > 0 && proposals.every(s => !(slotStartMs(s.date, s.hour) > nowMs));
}

// ── Chequeo nocturno ──────────────────────────────────────────────────────────

/** Lo mínimo de una recuperación que necesita el chequeo nocturno. */
export interface NightlyInput {
  status: RecoveryStatus;
  teacherProposals: Slot[];
  studentProposals: Array<{ date: string; hour: string }>;
  chosenDate: string | null;
  chosenHour: string | null;
}

export type NightlyAction = 'recuperada' | 'sin_acuerdo' | 'anular' | null;

/**
 * Qué hace el chequeo nocturno con una recuperación, en este orden:
 *  1. confirmada, ya empezó y hubo ingreso → 'recuperada' (aunque el alumno se
 *     diera de baja después: la clase se dio);
 *  2. el alumno ya no está activo con ese profesor (baja, desvinculación, cambio
 *     de profesor) y la recuperación sigue viva → 'anular';
 *  3. esperando al alumno y pasaron TODAS las fechas del profesor → 'sin_acuerdo';
 *  4. esperando al profesor y pasaron TODOS los horarios del alumno → 'sin_acuerdo'.
 * Una confirmada que pasó SIN ingreso no se toca: la pestaña del admin la destaca.
 */
export function nightlyAction(r: NightlyInput, opts: { nowMs: number; given: boolean; assignmentActive: boolean }): NightlyAction {
  const chosenStarted = !!r.chosenDate && !!r.chosenHour && !(slotStartMs(r.chosenDate, r.chosenHour) > opts.nowMs);
  if (r.status === 'confirmada' && chosenStarted && opts.given) return 'recuperada';
  if (!opts.assignmentActive && (['esperando_alumno', 'alumno_propuso', 'sin_acuerdo'] as RecoveryStatus[]).includes(r.status)) return 'anular';
  if (!opts.assignmentActive && r.status === 'confirmada' && !chosenStarted) return 'anular';
  if (r.status === 'esperando_alumno' && proposalsExpired(r.teacherProposals, opts.nowMs)) return 'sin_acuerdo';
  if (r.status === 'alumno_propuso' && proposalsExpired(r.studentProposals.map(s => ({ ...s, hours: 1 })), opts.nowMs)) return 'sin_acuerdo';
  return null;
}

// ── Contadores de faltas del admin ────────────────────────────────────────────

/** Lo mínimo de una fila de class_recoveries para los contadores. */
export interface LateCancellationRow {
  teacherId: string;
  groupId: string;
  cancelMonth: string;   // 'YYYY-MM', hora de España
  late: boolean;
  status: RecoveryStatus;
}

/**
 * Cancelaciones SIN antelación de un profesor en un mes, contadas UNA vez por
 * cancelación (una clase de 2 h partida en dos días son dos filas del mismo
 * grupo). Las anuladas no cuentan, igual que en los comodines.
 */
export function lateCancellationsOfMonth(rows: LateCancellationRow[], teacherId: string, month: string): number {
  return new Set(rows
    .filter(r => r.teacherId === teacherId && r.late && r.status !== 'anulada' && r.cancelMonth === month)
    .map(r => r.groupId)).size;
}

/** Las horas que ocupa un hueco: [{date, hour}] una por hora. */
export function slotHours(slot: Slot): Array<{ date: string; hour: string }> {
  const h = hourNum(slot.hour);
  const n = Math.max(1, Math.min(4, Math.round(slot.hours || 1)));
  return Array.from({ length: n }, (_, i) => ({ date: slot.date, hour: hourText(h + i) }));
}

// ── Textos con fecha ──────────────────────────────────────────────────────────

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** '2026-10-12' → 'lunes 12 de octubre'. */
export function fechaLarga(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DIAS[dow]} ${d} de ${MESES[m - 1]}`;
}

/** 'la clase de hoy' / 'la clase de mañana' / 'la clase del jueves 8 de octubre'. */
export function claseDe(iso: string, todayIso: string): string {
  if (iso === todayIso) return 'la clase de hoy';
  if (iso === addDaysIso(todayIso, 1)) return 'la clase de mañana';
  return `la clase del ${fechaLarga(iso)}`;
}

/** 'el lunes 12 de octubre a las 17:00'. */
export function cuandoEs(slot: { date: string; hour: string }): string {
  return `el ${fechaLarga(slot.date)} a las ${normalizeHour(slot.hour) ?? slot.hour}`;
}
