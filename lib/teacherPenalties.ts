// Penalizaciones a profesores — el SISTEMA ÚNICO, sin red ni base.
//
// Desde el 22/10/2026 (PENALTY_START_DATE) solo hay dos multas en euros:
//   · CANCELACIÓN con menos de 24 h ("No puedo dar esta clase"): 2 gratis al mes
//     por profesor, en total; desde la 3.ª, −5 €. Mes = el de la CANCELACIÓN.
//     Las reglas viven en lib/classRecoveries.ts (wildcardOutcome).
//   · FALTA (no canceló y no se presentó): −10 €. Se cobra AL DETECTAR la
//     posible ausencia (chequeo de cada 5 min, lib/teacherAbsenceStore) o cuando
//     el admin reclasifica una revisión como "cancelada por el profesor"
//     (lib/classRecoveryStore). Mes = el de la CLASE.
// Todo mes se cuenta en hora de España, también en Finanzas (eventMonthOf).
//
// LO QUE SE ELIMINÓ (oct/2026): el −5 € instantáneo del "Cancelar clase" viejo
// (dbApplyFaltaSideEffects), la "Falta injustificada" (−5 €) del formulario de
// scoring y el −5 € fijo de la reclasificación. Los eventos ya cobrados no se
// tocan: siguen sumando en su mes, pero ya no en los contadores de faltas.
//
// Lo prueba lib/teacherPenalties.test.ts.

import { getSpainParts } from '@/lib/spainTime';
import { PENALTY_START_DATE, NO_SHOW_PENALTY_EUROS, fechaLarga } from '@/lib/classRecoveries';
import type { ScoringEvent } from '@/types';

export const FALTA_EVENT_TYPE = 'falta_profesor_penalizacion' as const;
export const FALTA_PENALTY_EUROS = NO_SHOW_PENALTY_EUROS;

// ── Ids fijos ─────────────────────────────────────────────────────────────────

const FALTA_PREFIX = 'se_falta_prof_';

/**
 * Id del evento de la falta de UNA clase. Se deriva del id de la posible
 * ausencia (aus_<profe>_<fecha>_<HH>_<alumno>), que ya es único por clase: el
 * chequeo automático y la reclasificación del admin calculan el MISMO id, así
 * que la clave primaria impide cobrar dos veces la misma clase.
 */
export function faltaEventId(absenceId: string): string {
  return `${FALTA_PREFIX}${absenceId}`;
}

/** La posible ausencia de un evento de falta, o null si el evento no es de falta. */
export function absenceIdOfFaltaEvent(eventId: string | null | undefined): string | null {
  return eventId && eventId.startsWith(FALTA_PREFIX) ? eventId.slice(FALTA_PREFIX.length) : null;
}

// ── Cuándo se cobra ───────────────────────────────────────────────────────────

/** ¿Lleva multa la falta de esta clase? Solo desde PENALTY_START_DATE y nunca a cuentas de prueba. */
export function faltaApplies(args: { classDate: string; isTestTeacher: boolean }): boolean {
  return !args.isTestTeacher && (args.classDate ?? '') >= PENALTY_START_DATE;
}

/** ¿Cuenta esta fecha (cancelación, en hora de España) para los comodines y la multa? */
export function countsForPenalties(spainDate: string): boolean {
  return (spainDate ?? '') >= PENALTY_START_DATE;
}

// ── Mes de imputación ─────────────────────────────────────────────────────────

/** 'YYYY-MM' de un instante en hora de España. '' si no parsea. */
export function spainMonthOfInstant(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : getSpainParts(d).dateStr.slice(0, 7);
}

/**
 * Mes al que cuenta un evento de scoring: el fijado al crearlo (multas del
 * sistema único) y, si no, el de createdAt en hora de España. Antes Finanzas
 * usaba el mes UTC: un evento creado el día 1 entre las 00:00 y las 02:00 de
 * España caía en el mes anterior. Al cambiarlo (20/10/2026) ningún evento con
 * euros de la base cambiaba de mes.
 */
export function eventMonthOf(e: Pick<ScoringEvent, 'createdAt' | 'appliesMonth'>): string {
  return e.appliesMonth || spainMonthOfInstant(e.createdAt);
}

// ── Contadores (admin y dashboard) ────────────────────────────────────────────

/** Lo mínimo de una fila de class_recoveries para contarla. */
export interface CountableRecovery {
  groupId: string; teacherId: string; studentName: string; originalDate: string;
  cancelledAt: string; late: boolean; status: string; origin: string;
}

/**
 * Cancelación tardía del sistema único: del propio profesor ("No puedo dar esta
 * clase"), con menos de 24 h, no anulada y desde PENALTY_START_DATE. Las
 * reclasificaciones del admin son FALTAS (se cuentan por su evento) y las de
 * ausencia no son cancelaciones.
 */
export function isCountedLateCancellation(r: CountableRecovery): boolean {
  return r.origin === 'profesor' && r.late && r.status !== 'anulada'
    && countsForPenalties(getSpainParts(new Date(r.cancelledAt)).dateStr);
}

export interface PenaltyItem { kind: 'cancelacion' | 'falta'; note: string }

/**
 * Faltas del mes de un profesor en el sistema único: cancelaciones tardías (una
 * por cancelación, aunque tenga dos trozos) y faltas cobradas sin revertir.
 * Los −5 € del sistema viejo ya NO cuentan aquí (siguen en Finanzas).
 */
export function teacherPenaltiesInMonth(args: {
  teacherId: string; month: string;
  events: ReadonlyArray<Pick<ScoringEvent, 'teacherId' | 'eventType' | 'createdAt' | 'appliesMonth' | 'reverted' | 'note'>>;
  recoveries: ReadonlyArray<CountableRecovery>;
}): PenaltyItem[] {
  const vistos = new Set<string>();
  const cancelaciones: PenaltyItem[] = [];
  for (const r of args.recoveries) {
    if (r.teacherId !== args.teacherId || !isCountedLateCancellation(r)) continue;
    if (spainMonthOfInstant(r.cancelledAt) !== args.month || vistos.has(r.groupId)) continue;
    vistos.add(r.groupId);
    cancelaciones.push({ kind: 'cancelacion', note: `Cancelación sin antelación: ${r.studentName}, clase del ${r.originalDate}` });
  }
  const faltas: PenaltyItem[] = args.events
    .filter(e => e.teacherId === args.teacherId && e.eventType === FALTA_EVENT_TYPE && !e.reverted && eventMonthOf(e) === args.month)
    .map(e => ({ kind: 'falta' as const, note: e.note }));
  return [...cancelaciones, ...faltas];
}

// ── Textos ────────────────────────────────────────────────────────────────────

/** Campanita al profesor cuando se le cobra una falta. */
export function faltaBellBody(a: { hour: string; studentName: string; classDate: string }): string {
  return `Se ha registrado una falta en tu clase de las ${a.hour} con ${a.studentName} del ${fechaLarga(a.classDate)}. Si es un error, contacta con coordinación.`;
}

export function faltaEventNote(a: { studentName: string; classDate: string; hour: string; origen: 'deteccion' | 'reclasificacion' }): string {
  const como = a.origen === 'deteccion' ? 'no se conectó a la clase' : 'reclasificada por el admin desde una revisión';
  return `Falta del profesor (${como}) — alumno ${a.studentName}, fecha ${a.classDate} ${a.hour}`;
}
