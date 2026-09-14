// Retención / bono de 6 meses: FUENTE ÚNICA de verdad.
//
// Antes había tres cálculos distintos (pestaña Scoring, aviso de Avisos y banner
// del panel) con reglas que no coincidían, y el admin (Seguimiento) tenía una
// cuarta. Desde septiembre de 2026 todos —profesor, admin, aviso in-app, email y
// finanzas— pasan por acá.
//
// LA REGLA (decisión del director, no la cambies desde una pantalla):
//   · 180 días desde `assignments.teacher_since`: seis meses CON EL PROFESOR
//     ACTUAL. Al cambiar de profesor, teacher_since se pone a hoy y el que hereda
//     empieza de cero: no cobra por los meses del anterior.
//   · Un bono por par alumno+profesor. El mismo alumno puede dar un bono a dos
//     profesores distintos si estuvo 6 meses con cada uno; nunca dos al mismo.
//   · "Otorgado" = hay una fila en `teacher_bonuses` para ese par con estado
//     distinto de 'rechazado' (reclamado, aprobado, pagado o pagado_externo).
//     Un rechazo devuelve el par a disponible.
//   · Los bonos no vencen. "Próximo" = cumple los 180 días en los próximos 30.
//
// FECHAS: todo en hora de España (getSpainParts), igual que las clases. Un
// profesor en Argentina a las 21:00 ya está en el día siguiente de Madrid, y
// contar días con la zona del navegador hacía que el bono "apareciera" un día
// distinto según quién mirara.

import type { Assignment, TeacherBonus } from '@/types';
import { getSpainParts } from '@/lib/spainTime';

/**
 * INTERRUPTOR del reclamo por parte del profesor.
 *
 * Mientras esté en `false`, el profesor NO ve el botón "Reclamar bono", ni el
 * banner nuevo, ni recibe el email/aviso de "bono disponible". Sí ve sus bonos
 * ya reclamados/aprobados/pagados. La pestaña Bonos del admin y Finanzas
 * funcionan siempre, sin mirar esto.
 *
 * TODO(Facundo): pasar a `true` cuando termine de cargar y limpiar los bonos
 * históricos (pagado_externo) desde la pestaña Bonos. Hasta entonces, un alumno
 * que ya cobró por email aparecería como reclamable.
 */
export const BONUS_CLAIM_ENABLED = false;

// Días de continuidad necesarios para el bono de retención (6 meses).
export const RETENTION_BONUS_DAYS = 180;

// Ventana de "próximo a cobrar": cumple los 180 días dentro de estos días.
export const RETENTION_UPCOMING_DAYS = 30;

// Normaliza un nombre para comparaciones tolerantes (trim + lower + sin acentos).
export function normName(x: unknown): string {
  return String(x ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ── Fechas ────────────────────────────────────────────────────────────────────

/** Hoy en hora de España ('YYYY-MM-DD'). `now` se acepta para los tests. */
export function spainTodayIso(now: Date = new Date()): string {
  return getSpainParts(now).dateStr;
}

/**
 * 'YYYY-MM-DD' de un valor de fecha: una fecha suelta se usa tal cual; un ISO
 * con hora (created_at) se convierte a la fecha de España de ese instante.
 */
export function toSpainDateIso(raw: string): string {
  if (raw.length <= 10) return raw;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? raw.slice(0, 10) : getSpainParts(d).dateStr;
}

/** Suma días de calendario a un 'YYYY-MM-DD' (aritmética en UTC: sin saltos de DST). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, (m ?? 1) - 1, d ?? 1) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Días de calendario entre dos 'YYYY-MM-DD' (b − a). */
export function daysBetweenIso(a: string, b: string): number {
  const p = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, (m ?? 1) - 1, d ?? 1); };
  return Math.round((p(b) - p(a)) / 86400000);
}

// ── Inicio de la continuidad ─────────────────────────────────────────────────

type RetentionSource = { id?: string; teacherSince?: string | null; startDate?: string | null; createdAt?: string | null };

// Para no repetir el mismo aviso en cada render: una vez por asignación.
const avisadosSinTeacherSince = new Set<string>();

/**
 * 'YYYY-MM-DD' desde el que corre el reloj: `teacherSince`. Si falta (fila sin
 * migrar), cae a `startDate` y luego a `createdAt`, y lo avisa por consola: una
 * asignación sin teacher_since es un dato a corregir, no un caso normal.
 */
export function retentionStartIso(a: RetentionSource): string {
  if (a.teacherSince) return toSpainDateIso(a.teacherSince);
  const key = a.id ?? `${a.startDate ?? ''}|${a.createdAt ?? ''}`;
  if (!avisadosSinTeacherSince.has(key)) {
    avisadosSinTeacherSince.add(key);
    console.warn(`[retention] assignment ${a.id ?? '(sin id)'} sin teacher_since: se usa ${a.startDate ? 'start_date' : a.createdAt ? 'created_at' : 'HOY'}`);
  }
  const raw = a.startDate || a.createdAt;
  if (!raw) return spainTodayIso();
  const iso = toSpainDateIso(raw);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : spainTodayIso();
}

/** Igual que `retentionStartIso` pero como Date (medianoche local). Para pantallas viejas. */
export function retentionStartDate(a: RetentionSource): Date {
  return new Date(`${retentionStartIso(a)}T00:00:00`);
}

/** Días de continuidad a una fecha de referencia (por defecto, hoy en España). */
export function retentionDaysActive(a: RetentionSource, now: Date = new Date()): number {
  return daysBetweenIso(retentionStartIso(a), spainTodayIso(now));
}

/** 'YYYY-MM-DD' en que el alumno cumple los 180 días con este profesor. */
export function retentionDueIso(a: RetentionSource): string {
  return addDaysIso(retentionStartIso(a), RETENTION_BONUS_DAYS);
}

/** Igual que `retentionDueIso` pero como Date (medianoche local). */
export function retentionBonusDate(a: RetentionSource): Date {
  return new Date(`${retentionDueIso(a)}T00:00:00`);
}

/** Días que faltan para cumplir (negativo si ya cumplió). */
export function retentionDaysLeft(a: RetentionSource, now: Date = new Date()): number {
  return RETENTION_BONUS_DAYS - retentionDaysActive(a, now);
}

// ── Estado del par alumno+profesor ───────────────────────────────────────────

/**
 * ¿Bloquea el par? Todo bono de retención que no esté rechazado: reclamado,
 * aprobado, pagado o pagado por fuera.
 */
export function bonusBlocksPair(b: TeacherBonus): boolean {
  return b.bonusType === 'retencion_6m' && b.status !== 'rechazado';
}

/**
 * El bono de retención vigente de un par alumno+profesor, si lo hay. Se cruza
 * primero por assignment_id y, si no, por nombre tolerante: los históricos
 * (pagado_externo) pueden no tener assignment_id.
 */
export function retentionBonusFor(
  bonuses: TeacherBonus[], a: { id?: string; teacherId: string; studentName: string },
): TeacherBonus | undefined {
  const target = normName(a.studentName);
  return bonuses.find(b =>
    bonusBlocksPair(b) && b.teacherId === a.teacherId &&
    ((a.id && b.assignmentId === a.id) || normName(b.studentName) === target));
}

/** ¿Ya hay bono de retención (no rechazado) para este alumno con este profesor? */
export function hasRetentionBonus(bonuses: TeacherBonus[], studentName: string, teacherId: string): boolean {
  return retentionBonusFor(bonuses, { teacherId, studentName }) !== undefined;
}

/** ¿Corresponde reclamar? (≥180 días con el profesor y sin bono para el par). */
export function isRetentionBonusDue(a: Assignment, bonuses: TeacherBonus[], now: Date = new Date()): boolean {
  return retentionDaysActive(a, now) >= RETENTION_BONUS_DAYS && !retentionBonusFor(bonuses, a);
}

/** ¿La asignación cuenta como activa? (`status` ausente = anterior a la migración). */
export function isActiveAssignmentLike(a: { status?: string | null }): boolean {
  return (a.status ?? 'active') === 'active';
}

/** ¿Cumple los 180 días en los próximos 30 y todavía no tiene bono? */
export function isRetentionBonusUpcoming(a: Assignment, bonuses: TeacherBonus[], now: Date = new Date()): boolean {
  const left = retentionDaysLeft(a, now);
  return left > 0 && left <= RETENTION_UPCOMING_DAYS && !retentionBonusFor(bonuses, a);
}
