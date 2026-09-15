// ── Bonos a profesores: la lista que ven el profesor y el admin ──────────────
//
// Módulo PURO (sin Supabase): cruza `assignments` con `teacher_bonuses` y devuelve
// una fila por alumno+profesor con su estado. La regla de los 180 días vive en
// lib/retention.ts; acá solo se combina con lo que ya hay cargado en la tabla.
//
//   estado                de dónde sale
//   ───────────────────── ──────────────────────────────────────────────────────
//   en_curso / proximo    todavía no cumplió 180 días con el profe (próximo = ≤30 días)
//   disponible            cumplió y no hay bono para el par
//   reclamado             el profesor lo pidió (fila 'reclamado')
//   pagado                el admin lo marcó pagado (fila 'pagado'), o histórico
//                         pagado por email antes de la app (fila 'pagado_externo')
//
// El admin tiene UNA acción: "Marcar pagado", solo cuando el bono ya cumplió
// (disponible o reclamado). Marcarlo lo mete en la liquidación del mes en curso
// (o del siguiente si ese mes ya se cerró en Finanzas): ver accrualMonthFor.
// 'pagado_externo' se muestra igual que 'pagado' pero NUNCA suma a finanzas:
// ese dinero ya salió por email. Los upsells son siempre filas de la tabla
// (nunca "disponibles": los carga el admin, ya pagados).
//
// CUENTAS DE PRUEBA (t1/t2): quedan fuera de las listas globales y de las
// cifras, como en /api/external. Cuando se pide UN profesor concreto sí se
// incluyen, para poder probar el circuito completo con ellas.

import type { Assignment, Teacher, TeacherBonus, BonusType, FinancePayment } from '@/types';
import { EVENT_EUROS } from '@/lib/scoringConstants';
import { PROFESORES_DE_PRUEBA } from '@/lib/externalTeachers';
import {
  RETENTION_BONUS_DAYS, RETENTION_UPCOMING_DAYS, addDaysIso, bonusBlocksPair, isActiveAssignmentLike, normName,
  retentionBonusFor, retentionDaysLeft, retentionDueIso, retentionStartIso, spainTodayIso, toSpainDateIso,
} from '@/lib/retention';

export type BonusRowState =
  | 'disponible' | 'proximo' | 'en_curso'
  | 'reclamado' | 'aprobado' | 'pagado' | 'pagado_externo' | 'rechazado';

export interface BonusRow {
  /** Clave estable para React: id del bono, o de la asignación si no hay bono. */
  key: string;
  assignment: Assignment | null;
  /** La fila de teacher_bonuses, si existe (null en disponible/proximo). */
  bonus: TeacherBonus | null;
  studentName: string;
  teacherId: string;
  teacherName: string;
  bonusType: BonusType;
  euros: number;
  /** 'YYYY-MM-DD' desde el que corre el reloj (null si no hay asignación). */
  teacherSince: string | null;
  /** 'YYYY-MM-DD' en que cumple/cumplió los 180 días (null en upsells sin asignación). */
  dueDate: string | null;
  /** Días que faltan (negativo si ya cumplió). null si no hay fecha. */
  daysLeft: number | null;
  estado: BonusRowState;
}

/** Importe de cada tipo. Única fuente: EVENT_EUROS (lib/scoringConstants). */
export function bonusEurosFor(type: BonusType): number {
  return type === 'retencion_6m' ? EVENT_EUROS.bonus_retencion : EVENT_EUROS.upsell;
}

// Para el admin y el profesor "pagado" es uno solo: el histórico por email y el
// marcado en la app se leen igual. 'aprobado' y 'rechazado' ya no se producen
// (quedan en el tipo porque la tabla los admite).
export const BONUS_STATE_LABEL: Record<BonusRowState, string> = {
  disponible:     'Disponible',
  proximo:        'En curso',
  en_curso:       'En curso',
  reclamado:      'Reclamado',
  aprobado:       'Pagado',
  pagado:         'Pagado',
  pagado_externo: 'Pagado',
  rechazado:      'Rechazado',
};

/** ¿Ya cumplió y se puede marcar pagado? */
export function bonusIsPayable(estado: BonusRowState): boolean {
  return estado === 'disponible' || estado === 'reclamado';
}

/** Orden por defecto: primero lo que espera al admin, después el historial, al final lo que aún no cumplió. */
const ORDEN_ESTADO: Record<BonusRowState, number> = {
  reclamado: 0, disponible: 1, aprobado: 2, pagado: 2, pagado_externo: 2, rechazado: 3, proximo: 4, en_curso: 5,
};

/** ¿La asignación cuenta como activa? (`status` ausente = anterior a la migración). */
export const isActiveAssignment = (a: Assignment): boolean => isActiveAssignmentLike(a);

export interface BuildBonusRowsInput {
  assignments: Assignment[];
  bonuses: TeacherBonus[];
  teachers: Teacher[];
  /** Un profesor concreto. Sin él, la lista global (sin cuentas de prueba). */
  teacherId?: string;
  /** Para los tests. Por defecto, hoy en hora de España. */
  now?: Date;
}

/**
 * Filas de bonos para el profesor (`teacherId`) o para todos.
 *
 * Con `teacherId` se devuelve TODO lo de ese profesor. Sin él, se excluyen los
 * profesores archivados y las cuentas de prueba, salvo las filas que YA existen
 * en teacher_bonuses (un bono reclamado o pagado es un registro real y tiene
 * que verse, sea de un archivado o de una cuenta de prueba); lo que se excluye
 * de ellos es lo CALCULADO (disponible, próximo, en curso), que solo mete ruido.
 */
export function buildBonusRows(input: BuildBonusRowsInput): BonusRow[] {
  const { assignments, bonuses, teachers, teacherId } = input;
  const now = input.now ?? new Date();
  const teacherById = new Map(teachers.map(t => [t.id, t]));
  const nameOf = (id: string, fallback?: string) => teacherById.get(id)?.name ?? fallback ?? id;

  const quiereProfe = (id: string) => !teacherId || id === teacherId;
  // Sin filtro de profesor, las cuentas de prueba solo aportan sus filas reales.
  const soloFilasReales = (id: string) => !teacherId && PROFESORES_DE_PRUEBA.has(id);
  const profeVigente = (id: string) => {
    const t = teacherById.get(id);
    return !!t && !t.archivedAt;
  };

  const rows: BonusRow[] = [];
  const usados = new Set<string>();   // ids de bonos ya representados por una asignación

  // 1) Una fila por asignación activa: la asignación manda sobre el estado del par.
  for (const a of assignments) {
    if (!isActiveAssignment(a) || !quiereProfe(a.teacherId) || !profeVigente(a.teacherId)) continue;
    const vigente = retentionBonusFor(bonuses, a);
    if (soloFilasReales(a.teacherId) && !vigente) continue;
    const teacherSince = retentionStartIso(a);
    const dueDate = retentionDueIso(a);
    const daysLeft = retentionDaysLeft(a, now);

    // 'en_curso' = le falta más de un mes: no es un bono todavía, pero el admin
    // tiene que poder ver (y corregir) desde cuándo está con el profesor.
    let estado: BonusRowState;
    if (vigente) {
      estado = vigente.status;
      usados.add(vigente.id);
    } else if (daysLeft <= 0) {
      estado = 'disponible';
    } else if (daysLeft <= RETENTION_UPCOMING_DAYS) {
      estado = 'proximo';
    } else {
      estado = 'en_curso';
    }

    rows.push({
      key: vigente ? vigente.id : `asg_${a.id}`,
      assignment: a, bonus: vigente ?? null,
      studentName: vigente?.studentName ?? a.studentName,
      teacherId: a.teacherId, teacherName: nameOf(a.teacherId, a.teacherName),
      bonusType: 'retencion_6m', euros: vigente?.euros ?? bonusEurosFor('retencion_6m'),
      teacherSince, dueDate, daysLeft, estado,
    });
  }

  // 2) El resto de la tabla: upsells, rechazados, históricos sin asignación activa.
  const asgById = new Map(assignments.map(a => [a.id, a]));
  for (const b of bonuses) {
    if (usados.has(b.id) || !quiereProfe(b.teacherId)) continue;
    // La asignación solo sirve si sigue siendo de ESTE profesor: tras un cambio
    // de profesor la misma fila apunta al nuevo, y su teacher_since ya no dice
    // nada sobre el bono que cobró el anterior.
    const candidata: Assignment | null = (b.assignmentId ? asgById.get(b.assignmentId) : undefined)
      ?? assignments.find(x => x.teacherId === b.teacherId && normName(x.studentName) === normName(b.studentName))
      ?? null;
    const a = candidata && candidata.teacherId === b.teacherId ? candidata : null;
    const dueDate = b.bonusType === 'retencion_6m'
      ? (b.dueDate ? toSpainDateIso(b.dueDate) : a ? retentionDueIso(a) : null)
      : null;
    // Sin asignación vigente, el "desde" se deduce de la fecha en que cumplió.
    const teacherSince = a ? retentionStartIso(a) : dueDate ? addDaysIso(dueDate, -RETENTION_BONUS_DAYS) : null;
    const daysLeft = dueDate ? daysLeftTo(dueDate, now) : null;
    rows.push({
      key: b.id, assignment: a, bonus: b,
      studentName: b.studentName,
      teacherId: b.teacherId, teacherName: nameOf(b.teacherId, a?.teacherName),
      bonusType: b.bonusType, euros: b.euros,
      teacherSince, dueDate, daysLeft, estado: b.status,
    });
  }

  return rows.sort(compareBonusRows);
}

function daysLeftTo(dueIso: string, now: Date): number {
  const today = spainTodayIso(now);
  const p = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, (m ?? 1) - 1, d ?? 1); };
  return Math.round((p(dueIso) - p(today)) / 86400000);
}

/** Reclamados primero, después disponibles, después próximos por fecha; el resto, más reciente primero. */
export function compareBonusRows(x: BonusRow, y: BonusRow): number {
  const o = ORDEN_ESTADO[x.estado] - ORDEN_ESTADO[y.estado];
  if (o !== 0) return o;
  if (x.estado === 'proximo' || x.estado === 'disponible' || x.estado === 'en_curso') {
    return (x.dueDate ?? '').localeCompare(y.dueDate ?? '') || x.studentName.localeCompare(y.studentName);
  }
  const fx = x.bonus?.approvedAt ?? x.bonus?.claimedAt ?? x.bonus?.createdAt ?? '';
  const fy = y.bonus?.approvedAt ?? y.bonus?.claimedAt ?? y.bonus?.createdAt ?? '';
  return fy.localeCompare(fx) || x.studentName.localeCompare(y.studentName);
}

/** Las tres cifras de arriba de la pestaña Bonos. */
export function bonusCounters(rows: BonusRow[]): { reclamados: number; proximos: number; disponibles: number } {
  return {
    reclamados:  rows.filter(r => r.estado === 'reclamado').length,
    proximos:    rows.filter(r => r.estado === 'proximo').length,
    disponibles: rows.filter(r => r.estado === 'disponible').length,
  };
}

// ── Mes en que un bono entra a la liquidación ────────────────────────────────
//
// Al marcarlo pagado, el bono queda anclado a `paid_month`: el mes en curso (hora
// de España, como las clases) o el SIGUIENTE si Finanzas ya cerró el mes en
// curso para ese profesor (el total está congelado y el bono se perdería).
// Decidirlo en ese momento, y guardarlo, es lo que evita que el cálculo del mes
// dependa de los pagos de otros meses.

/** 'YYYY-MM' del mes siguiente. */
export function nextMonthYear(monthYear: string): string {
  const [y, m] = monthYear.split('-').map(Number);
  const d = new Date(Date.UTC(y, m ?? 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Mes de liquidación para un bono que se marca pagado AHORA. `currentMonthPayment`
 * es el pago de Finanzas del profesor para el mes en curso (null si no existe).
 */
export function accrualMonthFor(currentMonthPayment: FinancePayment | null, now: Date = new Date()): string {
  const mes = spainTodayIso(now).slice(0, 7);
  const cerrado = !!currentMonthPayment && currentMonthPayment.monthYear === mes && currentMonthPayment.status === 'paid';
  return cerrado ? nextMonthYear(mes) : mes;
}

/** ¿Suma a finanzas? Solo los pagados desde la app; nunca los históricos por email. */
export function bonusCountsForFinance(b: TeacherBonus): boolean {
  return b.status === 'pagado' && !!b.paidMonth;
}

/** Bonos de un profesor que suman en `monthYear`: los pagados desde la app con ese `paid_month`. */
export function bonusesForMonth(bonuses: TeacherBonus[], teacherId: string, monthYear: string): TeacherBonus[] {
  return bonuses.filter(b => b.teacherId === teacherId && bonusCountsForFinance(b) && b.paidMonth === monthYear);
}

/**
 * Bonos de un profesor pagados FUERA del sistema en `monthYear`: los históricos
 * por email (pagado_externo) con ese `paid_month`. Se enseñan en Finanzas y en
 * la vista del profesor para que ese dinero no desaparezca del mes, pero NUNCA
 * suman: ya salió por email antes de que existiera la gestión de bonos.
 */
export function externalBonusesForMonth(bonuses: TeacherBonus[], teacherId: string, monthYear: string): TeacherBonus[] {
  return bonuses.filter(b => b.teacherId === teacherId && b.status === 'pagado_externo' && b.paidMonth === monthYear);
}

export function sumBonusEuros(bonuses: TeacherBonus[]): number {
  return bonuses.reduce((s, b) => s + (Number(b.euros) || 0), 0);
}

export { bonusBlocksPair };
