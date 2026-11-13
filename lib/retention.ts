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
import { PROFESORES_DE_PRUEBA } from '@/lib/externalTeachers';
import { catalogProduct } from '@/lib/productCatalog';

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

/**
 * ¿Este profesor ve el reclamo? El interruptor global, o una cuenta de prueba
 * (t1/t2): así se puede ensayar el circuito completo en producción sin que
 * ningún profesor real vea el botón todavía.
 */
export function bonusClaimEnabledFor(teacherId: string): boolean {
  return BONUS_CLAIM_ENABLED || PROFESORES_DE_PRUEBA.has(teacherId);
}

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

// ── ¿El par genera bono? Programas nuevos de pago único ──────────────────────
//
// REGLA (decisión de Facundo, 10/11/2026): los alumnos cuyo producto ACTUAL es
// un PROGRAMA NUEVO de pago único no generan bono de retención. Todo lo demás
// sigue igual que antes: suscripciones (oferta anterior, mensuales y programas
// FRACCIONADOS), pagos únicos de la oferta anterior (Anual 9 meses, Intensivo
// 6 meses, Intensivos de 3 meses), manuales, Oritalk y empresas.
//
//   · Se detecta SOLO por el ID del catálogo (students.woo_product_id, ver
//     lib/productCatalog). NUNCA por product_type ni por el nombre: product_type
//     'one_time' también marca a empresas e intensivos viejos, que sí cobran.
//   · Cambio a mitad de camino (upsell de una suscripción a un programa nuevo):
//     si la compra (students.company_plan_start) es del día en que el par
//     cumplió los 180 días o posterior, el bono ya estaba ganado y APLICA; si
//     compró antes de cumplirlos, NO aplica.
//   · Programa nuevo sin fecha de compra: NO aplica, pero se marca para que el
//     admin lo revise ('revisar_sin_fecha').
//   · Los bonos ya cargados en teacher_bonuses no se tocan: esta regla solo
//     decide si un par SIN bono puede llegar a tenerlo. Finanzas no la mira.

/** Productos (ID de Woo) que NO generan bono de retención: programas nuevos de pago único. */
export const NO_RETENTION_BONUS_PRODUCT_IDS: ReadonlySet<number> = new Set([
  35652,   // Programa Desbloqueo (pago único)
  35653,   // Programa Fluidez (pago único)
  35655,   // Programa Acelerado (pago único)
  35658,   // Plan Platino (pago único)
  35522,   // Plan 6 meses · 2h semanales · 2 personas
  35523,   // Plan 9 meses · 2h semanales · 2 personas
  35773,   // Plan Personalizado · 3 meses x 3h semanales
  37392,   // Plan Platino: 2 clases a la semana, 9 meses - Videollamada
  37036,   // Plan Platino: 1 clase a la semana, 9 meses (pago único)
  // Upsells de pago único (13/11/2026). Siguen 'sin_datos' en el catálogo (no
  // activan ni cambian el cupo), pero tampoco dan bono.
  35905,   // Programa Platino Alumno (upsell)
  36027,   // Programa Fluidez 1h/sem (upsell)
]);

/** Si el par puede generar bono, y por qué no cuando no. */
export type RetentionApplies = 'aplica' | 'no_aplica_pago_unico' | 'revisar_sin_fecha';

/** Lo que hace falta del alumno para decidirlo (subconjunto de `Student`). */
export interface RetentionStudentRef {
  wooProductId?: number | null;
  companyPlanStart?: string | null;
}

/** ¿Es un programa nuevo de pago único? Por ID del catálogo, nunca por nombre. */
export function isNoRetentionBonusProduct(wooProductId: unknown): boolean {
  const c = catalogProduct(wooProductId);
  return !!c && NO_RETENTION_BONUS_PRODUCT_IDS.has(c.id);
}

/** 'YYYY-MM-DD' de la compra, o null si falta o no es una fecha real ('0000-00-00'). */
function purchaseIso(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const iso = toSpainDateIso(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * ¿Este par alumno+profesor puede generar bono de retención? FUENTE ÚNICA: la
 * usan la lista de bonos (lib/bonuses), Seguimiento, Mi Scoring, la campanita y
 * las escrituras de lib/db. Sin alumno (no se encontró la ficha) → aplica, como
 * siempre: la excepción solo vale cuando se SABE que es un programa nuevo.
 */
export function retentionBonusApplies(
  student: RetentionStudentRef | null | undefined, a: RetentionSource,
): RetentionApplies {
  if (!student || !isNoRetentionBonusProduct(student.wooProductId)) return 'aplica';
  const compra = purchaseIso(student.companyPlanStart);
  if (!compra) return 'revisar_sin_fecha';
  return compra >= retentionDueIso(a) ? 'aplica' : 'no_aplica_pago_unico';
}

/** Texto corto del motivo, para la interfaz. */
export const RETENTION_APPLIES_LABEL: Record<RetentionApplies, string> = {
  aplica:               'Aplica',
  no_aplica_pago_unico: 'No aplica · pago único',
  revisar_sin_fecha:    'Revisar · sin fecha de compra',
};

type StudentLike = RetentionStudentRef & { id: string; email?: string | null; name: string };
type AssignmentStudentKey = { studentId?: string | null; studentEmail?: string | null; studentName: string };

/**
 * Buscador de la ficha del alumno de una asignación: por id, después por email
 * y al final por nombre (mismo orden que dbGetAllStudentsWithAssignments).
 */
export function retentionStudentLookup(students: StudentLike[]): (a: AssignmentStudentKey) => StudentLike | undefined {
  const byId = new Map(students.map(s => [s.id, s]));
  const byEmail = new Map(students.filter(s => s.email).map(s => [String(s.email).trim().toLowerCase(), s]));
  const byName = new Map(students.map(s => [normName(s.name), s]));
  return a =>
    (a.studentId ? byId.get(a.studentId) : undefined)
    ?? (a.studentEmail ? byEmail.get(a.studentEmail.trim().toLowerCase()) : undefined)
    ?? byName.get(normName(a.studentName));
}

/** Atajo: ¿aplica el bono para esta asignación, buscando su alumno en `students`? */
export function retentionAppliesFor(
  a: RetentionSource & AssignmentStudentKey, lookup: (a: AssignmentStudentKey) => RetentionStudentRef | undefined,
): RetentionApplies {
  return retentionBonusApplies(lookup(a), a);
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
