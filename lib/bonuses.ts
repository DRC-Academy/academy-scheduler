// ── Bonos a profesores: la lista que ven el profesor y el admin ──────────────
//
// Módulo PURO (sin Supabase): cruza `assignments` con `teacher_bonuses` y devuelve
// una fila por alumno+profesor con su estado. La regla de los 180 días vive en
// lib/retention.ts; acá solo se combina con lo que ya hay cargado en la tabla.
//
//   estado                de dónde sale
//   ───────────────────── ──────────────────────────────────────────────────────
//   disponible            ≥180 días con el profe y ningún bono (no rechazado)
//   proximo               cumple 180 en los próximos 30 días, sin bono
//   reclamado / aprobado  fila de teacher_bonuses con ese status
//   pagado / pagado_externo / rechazado   ídem
//
// Los 'rechazado' aparecen como historial, en su propia fila; el par vuelve a
// 'disponible' (o 'proximo') en la fila de la asignación. Los upsells son
// siempre filas de la tabla (nunca "disponibles": los carga el admin).
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

export const BONUS_STATE_LABEL: Record<BonusRowState, string> = {
  disponible:     'Disponible',
  proximo:        'Próximo',
  en_curso:       'En curso',
  reclamado:      'Reclamado',
  aprobado:       'Aprobado',
  pagado:         'Pagado',
  pagado_externo: 'Pagado fuera del sistema',
  rechazado:      'Rechazado',
};

/** Orden por defecto: primero lo que espera al admin, después lo que espera al profe. */
const ORDEN_ESTADO: Record<BonusRowState, number> = {
  reclamado: 0, disponible: 1, proximo: 2, aprobado: 3, pagado: 4, pagado_externo: 5, rechazado: 6, en_curso: 7,
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
 * profesores archivados y las cuentas de prueba, salvo los bonos que ya existen
 * de un archivado (historial: un bono pagado no desaparece porque el profe se
 * fue después).
 */
export function buildBonusRows(input: BuildBonusRowsInput): BonusRow[] {
  const { assignments, bonuses, teachers, teacherId } = input;
  const now = input.now ?? new Date();
  const teacherById = new Map(teachers.map(t => [t.id, t]));
  const nameOf = (id: string, fallback?: string) => teacherById.get(id)?.name ?? fallback ?? id;

  const quiereProfe = (id: string) => {
    if (teacherId) return id === teacherId;
    if (PROFESORES_DE_PRUEBA.has(id)) return false;
    return true;
  };
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

// ── Mes contable de un bono aprobado ─────────────────────────────────────────
//
// Un bono aprobado suma en el mes de `approved_at` (hora de España, igual que
// las clases). Si ese mes YA estaba marcado como pagado cuando se aprobó
// (paid_at < approved_at), el total está congelado y el bono pasa al mes
// siguiente: por eso `calculateTeacherFinance` recibe también el pago del mes
// anterior. Un bono ya 'pagado' se ancla a su `paid_month` y no se recalcula.

/** 'YYYY-MM' del mes anterior. */
export function previousMonthYear(monthYear: string): string {
  const [y, m] = monthYear.split('-').map(Number);
  const d = new Date(Date.UTC(y, (m ?? 1) - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM' (España) de un instante ISO. */
export function spainMonthOf(iso: string): string {
  return toSpainDateIso(iso).slice(0, 7);
}

function pagadoAntesDe(payment: FinancePayment | null, iso: string): boolean {
  return !!payment && payment.status === 'paid' && !!payment.paidAt && payment.paidAt < iso;
}

/**
 * Bonos de un profesor que suman en `monthYear`: aprobados (o ya pagados) cuyo
 * mes contable es ese. `payment` es el pago de `monthYear`, `previousPayment`
 * el del mes anterior (ambos null si no existen).
 */
export function bonusesForMonth(
  bonuses: TeacherBonus[], teacherId: string, monthYear: string,
  payment: FinancePayment | null, previousPayment: FinancePayment | null,
): TeacherBonus[] {
  const prev = previousMonthYear(monthYear);
  return bonuses.filter(b => {
    if (b.teacherId !== teacherId) return false;
    if (b.status === 'pagado') return b.paidMonth === monthYear;
    if (b.status !== 'aprobado' || !b.approvedAt) return false;
    const m = spainMonthOf(b.approvedAt);
    if (m === monthYear) return !pagadoAntesDe(payment, b.approvedAt);
    if (m === prev) return pagadoAntesDe(previousPayment, b.approvedAt);
    return false;
  });
}

export function sumBonusEuros(bonuses: TeacherBonus[]): number {
  return bonuses.reduce((s, b) => s + (Number(b.euros) || 0), 0);
}

/** ¿Suma a finanzas? Solo aprobado y pagado; nunca pagado_externo ni rechazado. */
export function bonusCountsForFinance(b: TeacherBonus): boolean {
  return b.status === 'aprobado' || b.status === 'pagado';
}

export { bonusBlocksPair };
