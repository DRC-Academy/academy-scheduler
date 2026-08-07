// ── Alumnos próximos a terminar su plan ──────────────────────────────────────
//
// FUENTE ÚNICA de "¿a quién se le acaba el plan?". La consumen la pestaña
// /proximos-cancelar (admin y setter), el cron que manda el aviso interno
// (/api/cron/check-ending-plans) y la sección "Alumnos". Los tres tienen que
// coincidir en quién entra, cuántos días le quedan y si ya se avisó: si cada uno
// lo calculara por su cuenta, volveríamos al problema de las cuatro vistas que
// responden distinto sobre el mismo hecho.
//
// QUÉ CUENTA COMO "FIN DE PLAN" (auditoría del 07/08/2026)
//
// SOLO `students.manual_active_until`. No es una simplificación: es el único fin
// de plan que existe hoy en el sistema.
//
//   · WooCommerce NO devuelve ninguna fecha de fin. Se comprobó contra
//     producción con tres alumnos de perfiles distintos (una suscripción activa,
//     otra activa recién salida de 'scheduled' y una 'pending-cancel'): las tres
//     devuelven endDate null. `check-subscription` las pide como
//     `firstNonEmpty(end_date, next_payment_date)` y no llega ninguna de las dos,
//     aunque el panel de Woo sí las muestre. Hasta que eso se arregle, no hay
//     fecha de fin que leer.
//
//   · Los INTENSIVOS tampoco la tienen en Woo: son productos de pago único
//     (ONE_TIME_PRODUCTS), y para ellos check-subscription ni siquiera consulta
//     las suscripciones. Su fin de plan ES la activación manual que carga el
//     admin a mano, y así está en los datos: 24 de los 25 alumnos one_time
//     tienen `manual_active_until`.
//
// Efecto lateral bueno: como Woo no aporta fechas, un alumno con suscripción
// mensual recurrente NO PUEDE colarse acá. El requisito de no molestar a quien se
// renueva solo se cumple por construcción, no por un filtro que haya que recordar.
//
// Oritalk queda fuera a propósito (decisión del 07/08/2026: "solo los activados
// manualmente"). Si algún día entra, es añadir su fecha a `endDateOf`.

import { parseHoursFromText } from '@/lib/productUtils';
import { madridToday } from '@/lib/subscriptionAccess';

/** Ventana de la PESTAÑA: cuántos días hacia adelante se listan. */
export const ENDING_WINDOW_DAYS = 30;

/** Ventana del AVISO por email: se avisa cuando quedan estos días o menos. */
export const ENDING_NOTICE_DAYS = 7;

/** Umbrales de urgencia de la columna "días restantes". */
export const ENDING_CRITICAL_DAYS = 3;
export const ENDING_WARN_DAYS = 7;

/** Fila de `students` en lo que respecta al fin de plan. */
export interface EndingStudentRow {
  id: string;
  name: string;
  email?: string | null;
  productType?: 'subscription' | 'one_time' | null;
  productName?: string | null;
  plan?: string | null;
  manualActiveUntil?: string | null;
  endingNoticeSentAt?: string | null;
  endingNoticeForDate?: string | null;
}

/** Lo que se necesita de `student_profiles` para el semáforo. */
export interface EndingProfileRow {
  student_id?: string | null;
  student_name?: string | null;
  progress_score?: number | null;
  risk_signal?: string | null;
}

export type RetentionSignal = 'verde' | 'amarillo' | 'rojo' | null;

export interface EndingPlan {
  studentId: string;
  studentName: string;
  studentEmail: string;
  /** 'YYYY-MM-DD' — último día de acceso INCLUIDO. */
  endDate: string;
  /** Días hasta el fin. 0 = termina hoy. Nunca negativo (los vencidos se excluyen). */
  daysLeft: number;
  planKind: 'intensivo' | 'manual';
  /** "Intensivo PET · 4h/sem" — lo que ve ventas en la columna TIPO DE PLAN. */
  planLabel: string;
  hours: number | null;
  progressScore: number | null;
  riskSignal: RetentionSignal;
  /** ¿Ya se mandó el aviso interno de ESTE ciclo? */
  noticeSent: boolean;
}

const nk = (s: string | null | undefined): string =>
  (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Días entre hoy y la fecha de fin. Las dos son fechas de CALENDARIO en hora de
 * España (madridToday), no instantes: se comparan a mediodía para que ningún
 * cambio de horario de verano convierta 7 días en 6.
 */
export function daysUntil(endIso: string, todayIso: string): number {
  const end = new Date(`${endIso}T12:00:00`);
  const today = new Date(`${todayIso}T12:00:00`);
  if (isNaN(end.getTime()) || isNaN(today.getTime())) return NaN;
  return Math.round((end.getTime() - today.getTime()) / DAY_MS);
}

/** La fecha de fin del alumno, o null si no tiene ninguna. */
export function endDateOf(s: EndingStudentRow): string | null {
  const d = (s.manualActiveUntil ?? '').trim();
  return d ? d : null;
}

/**
 * ¿El aviso interno ya salió para el ciclo VIGENTE?
 *
 * Las dos condiciones importan. Mirar solo `sentAt` haría que un alumno que
 * renueva no volviera a avisarse nunca; mirar solo la fecha daría por avisado a
 * quien nunca recibió nada.
 */
export function noticeSentForCycle(s: EndingStudentRow): boolean {
  const end = endDateOf(s);
  if (!end || !s.endingNoticeSentAt) return false;
  return (s.endingNoticeForDate ?? '').slice(0, 10) === end;
}

/** Tipo de plan legible. El intensivo se reconoce por `product_type` one_time. */
function planLabelOf(s: EndingStudentRow): { kind: 'intensivo' | 'manual'; label: string; hours: number | null } {
  const raw = (s.productName ?? s.plan ?? '').trim();
  // El nombre de WooCommerce viene con la variación pegada detrás ("Intensivo
  // PET — 17 pm · Lunes, martes · 06/08/2026"): para la columna sobra todo lo
  // que va tras el guion largo, que es horario y no plan.
  const base = raw.split('—')[0].trim() || raw;
  const hours = parseHoursFromText(raw);
  const kind: 'intensivo' | 'manual' = s.productType === 'one_time' ? 'intensivo' : 'manual';
  const label = base || (kind === 'intensivo' ? 'Intensivo' : 'Activación manual');
  return { kind, label, hours };
}

/** Lo que el semáforo necesita saber de un alumno. */
export interface RetentionInfo {
  progressScore: number | null;
  riskSignal: RetentionSignal;
}

/**
 * Buscador de ficha por alumno: por `student_id` y, como respaldo, por nombre
 * normalizado — el mismo criterio tolerante que usa el resto del sistema, porque
 * la mitad de las fichas antiguas tienen `student_id` en null.
 *
 * Se exporta para que la sección "Alumnos" pinte el MISMO semáforo sin
 * reimplementar el emparejamiento: dos índices distintos sobre los mismos datos
 * es como se llega a que dos pantallas discrepen del mismo alumno.
 */
export function profileLookup(profiles: EndingProfileRow[]):
  (student: { id?: string | null; name: string }) => RetentionInfo | null {
  const byId = new Map<string, EndingProfileRow>();
  const byName = new Map<string, EndingProfileRow>();
  for (const p of profiles) {
    if (p.student_id && !byId.has(p.student_id)) byId.set(p.student_id, p);
    const k = nk(p.student_name);
    if (k && !byName.has(k)) byName.set(k, p);
  }
  return student => {
    const p = (student.id ? byId.get(student.id) : undefined) ?? byName.get(nk(student.name));
    if (!p) return null;
    return {
      progressScore: p.progress_score ?? null,
      riskSignal: isRetentionSignal(p.risk_signal) ? (p.risk_signal as RetentionSignal) : null,
    };
  };
}

/**
 * Alumnos cuyo plan termina dentro de la ventana, del más urgente al menos.
 *
 * `windowDays` separa los dos usos: la pestaña mira 30 días (ventas quiere ver lo
 * que viene) y el cron 7 (solo avisa de lo inminente). Es el MISMO cálculo con
 * distinta ventana, no dos listas que puedan discrepar.
 */
export function buildEndingPlans(args: {
  students: EndingStudentRow[];
  profiles?: EndingProfileRow[];
  today?: string;
  windowDays?: number;
}): EndingPlan[] {
  const today = args.today ?? madridToday();
  const window = args.windowDays ?? ENDING_WINDOW_DAYS;
  const lookup = profileLookup(args.profiles ?? []);

  const out: EndingPlan[] = [];
  for (const s of args.students) {
    const endDate = endDateOf(s);
    if (!endDate) continue;

    const daysLeft = daysUntil(endDate, today);
    // Fuera: fecha ilegible, plan ya vencido (eso no es "próximo a cancelar",
    // ya cerró) y lo que cae más allá de la ventana.
    if (!Number.isFinite(daysLeft) || daysLeft < 0 || daysLeft > window) continue;

    const profile = lookup(s);
    const { kind, label, hours } = planLabelOf(s);

    out.push({
      studentId:     s.id,
      studentName:   s.name,
      studentEmail:  (s.email ?? '').trim(),
      endDate,
      daysLeft,
      planKind:      kind,
      planLabel:     hours ? `${label} · ${hours}h/sem` : label,
      hours,
      progressScore: profile?.progressScore ?? null,
      riskSignal:    profile?.riskSignal ?? null,
      noticeSent:    noticeSentForCycle(s),
    });
  }

  // Los más urgentes arriba; a igualdad de días, alfabético para que el orden no
  // baile entre recargas.
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.studentName.localeCompare(b.studentName, 'es'));
}

function isRetentionSignal(v: unknown): boolean {
  return v === 'verde' || v === 'amarillo' || v === 'rojo';
}

/**
 * Los que le tocan al cron: dentro de la ventana de aviso y todavía sin avisar.
 *
 * No se exige "exactamente 7 días". Si el cron no corre un día (deploy, caída),
 * al día siguiente el alumno tendría 6 y se habría perdido su aviso para
 * siempre. Con "≤ 7 y sin avisar" se recupera solo, y el anti-duplicado lo
 * garantiza `noticeSent`, no la coincidencia exacta de la fecha.
 */
export function plansNeedingNotice(plans: EndingPlan[], noticeDays = ENDING_NOTICE_DAYS): EndingPlan[] {
  return plans.filter(p => !p.noticeSent && p.daysLeft <= noticeDays);
}

// ── Presentación (compartida por la pestaña y la sección Alumnos) ─────────────

/** Color de los días restantes: rojo ≤3, ámbar ≤7, normal más allá. */
export function endingUrgency(daysLeft: number): { label: string; color: string; bg: string } {
  const dias = daysLeft === 0 ? 'hoy' : daysLeft === 1 ? '1 día' : `${daysLeft} días`;
  if (daysLeft <= ENDING_CRITICAL_DAYS) {
    return { label: dias, color: '#dc2626', bg: 'rgba(239,68,68,0.10)' };
  }
  if (daysLeft <= ENDING_WARN_DAYS) {
    return { label: dias, color: '#b45309', bg: 'rgba(255,196,0,0.18)' };
  }
  return { label: dias, color: 'var(--text-secondary)', bg: 'var(--bg-surface-3)' };
}

/**
 * Semáforo de retención: a quién llamar primero.
 *
 * El color lo manda la señal de riesgo de la ficha (verde = enganchado, alta
 * probabilidad de retener) y el número acompaña como matiz. Sin ficha se dice
 * "sin datos" y NO se inventa un color: media tabla no tiene ficha, y pintar de
 * verde a quien no hemos evaluado haría que ventas lo dejara para el final.
 */
export function retentionBadge(p: Pick<EndingPlan, 'progressScore' | 'riskSignal'>):
  { label: string; color: string; bg: string; dot: string } {
  const score = p.progressScore != null ? ` · ${p.progressScore}/10` : '';
  switch (p.riskSignal) {
    case 'verde':
      return { label: `Viene bien${score}`, color: '#1f7a3d', bg: '#eaf5ec', dot: '#1E9E3A' };
    case 'amarillo':
      return { label: `Flojo${score}`, color: '#9a6516', bg: '#fdf3e7', dot: '#FFC400' };
    case 'rojo':
      return { label: `Desenganchado${score}`, color: '#b91c1c', bg: 'rgba(239,68,68,0.10)', dot: '#dc2626' };
    default:
      return { label: 'Sin datos', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)', dot: 'var(--text-muted)' };
  }
}

/** Una línea con cómo viene el alumno, para el email interno. */
export function retentionLine(p: EndingPlan): string {
  switch (p.riskSignal) {
    case 'verde':
      return `Viene bien${p.progressScore != null ? ` (progreso ${p.progressScore}/10)` : ''}. Buena candidata a renovar.`;
    case 'amarillo':
      return `Viene flojo${p.progressScore != null ? ` (progreso ${p.progressScore}/10)` : ''}. Conviene preguntarle qué le está costando antes de proponerle nada.`;
    case 'rojo':
      return `Desenganchado${p.progressScore != null ? ` (progreso ${p.progressScore}/10)` : ''}. Prioridad alta: llamarle cuanto antes.`;
    default:
      return 'Sin ficha todavía: no hay lectura de cómo viene.';
  }
}

/** 'YYYY-MM-DD' → '15 de agosto de 2026'. */
export function longDateEs(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}
