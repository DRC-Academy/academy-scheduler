// ── "Tu plan ha finalizado": QUIÉN recibe el aviso ────────────────────────────
//
// Reglas puras (sin base ni red). Las usa lib/endedPlanJob, que va colgado del
// cron diario /api/cron/check-ending-plans. Sustituye al zap "Aviso Intensivos
// profe + alumno", que leía la pestaña "Intensivos" de la planilla.
//
// QUIÉN ENTRA (decisión de Facundo, 11/11/2026):
//   · `manual_active_until` = AYER en hora de España (es el último día con acceso
//     incluido, así que ayer fue su último día). Con un MARGEN de 3 días para
//     reintentar si un envío falló o el cron no corrió.
//   · NUNCA un fin anterior a ENDED_NOTICE_SINCE (la publicación): los alumnos
//     que ya habían vencido no reciben nada.
//   · Fuera: cuentas de prueba (is_test, o solo con profes de prueba), Oritalk,
//     empresa y los productos del catálogo fraccionados o mensuales.
//   · La comprobación de que NO renovó (check-subscription inactivo) la hace el
//     job justo antes de enviar; acá no hay red.
//
// NO REPETIR: tres columnas en `students` (supabase/migraciones/
// 2026-11-12-aviso-plan-finalizado.sql):
//   · ended_notice_for_date: el fin de plan del ciclo avisado. Si el alumno
//     renueva y vuelve a vencer, la fecha cambia y vuelve a poder avisarse.
//   · ended_notice_canales: resultado por destinatario (alumno, profe, equipo).
//     Solo se reintenta el que salió 'error': lo enviado no se repite nunca.
//   · ended_notice_sent_at: cuándo quedó completo el ciclo (ninguno en error).
//     Mientras sea null y haya errores, se reintenta dentro del margen.

import { baseProductName, isCompanyProduct } from '@/lib/productUtils';
import { catalogProduct } from '@/lib/productCatalog';
import { PLAN_ACTIVATION_EXCLUDED_EMAILS } from '@/lib/planOrders';
import { isPausedStatus } from '@/lib/subscriptionAccess';

/**
 * Primer fin de plan que puede avisarse: el "ayer" del día de la publicación.
 * Lo anterior lo cubrió el zap o no se avisa. Si la publicación se retrasa, hay
 * que subir esta fecha al día anterior al deploy.
 */
export const ENDED_NOTICE_SINCE = '2026-11-11';

/** Días hacia atrás que se sigue intentando un aviso que falló (ayer incluido). */
export const ENDED_RETRY_DAYS = 3;

export const ENDED_CHANNELS = ['alumno', 'profe', 'equipo'] as const;
export type EndedChannel = typeof ENDED_CHANNELS[number];

export type EndedChannelState = 'enviado' | 'error' | 'omitido';
export interface EndedChannelResult {
  estado: EndedChannelState;
  at?: string;
  to?: string;
  error?: string;
}
export type EndedChannels = Partial<Record<EndedChannel, EndedChannelResult>>;

export interface EndedStudentRow {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  productType?: string | null;
  productName?: string | null;
  plan?: string | null;
  manualActiveUntil?: string | null;
  isTest?: boolean | null;
  isOritalk?: boolean | null;
  companyPlanMonths?: number | null;
  wooProductId?: number | string | null;
  /** Ciclo del aviso de 7 días (solo informativo para el equipo). */
  endingNoticeForDate?: string | null;
  endedNoticeSentAt?: string | null;
  endedNoticeForDate?: string | null;
  endedNoticeCanales?: EndedChannels | null;
}

export interface EndedAssignmentRow {
  teacherId: string;
  studentId?: string | null;
  studentEmail?: string | null;
  studentName?: string | null;
  status?: string | null;
  createdAt?: string | null;
}

export interface EndedTeacherRow {
  id: string;
  name: string;
  email?: string | null;
  notificationEmail?: string | null;
  isTest?: boolean | null;
  archivedAt?: string | null;
}

export interface EndedTeacher { id: string; name: string; email: string }

export interface EndedPlan {
  studentId: string;
  studentName: string;
  studentEmail: string;
  studentPhone: string;
  /** 'YYYY-MM-DD': último día con acceso. */
  endDate: string;
  /** "Intensivo FCE", o null si no sabemos el nombre del plan. */
  planName: string | null;
  teacher: EndedTeacher | null;
  /** ¿Recibió el equipo el aviso de 7 días de este mismo ciclo? */
  sevenDayNotice: boolean;
  /** Destinatarios que faltan en este ciclo. */
  pendientes: EndedChannel[];
  /** Lo ya hecho en ESTE ciclo (vacío si es un ciclo nuevo). */
  previos: EndedChannels;
}

export interface EndedExclusion { studentId: string; studentName: string; endDate: string; motivo: string }

// ── Fechas ────────────────────────────────────────────────────────────────────

/** Suma días a una fecha de calendario 'YYYY-MM-DD' (a mediodía UTC: sin saltos de horario). */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Fines de plan que mira la vuelta de `today`: del margen (o la publicación) hasta ayer. */
export function endedWindow(today: string): { desde: string; hasta: string } {
  const hasta = addDays(today, -1);
  const margen = addDays(today, -ENDED_RETRY_DAYS);
  return { desde: margen > ENDED_NOTICE_SINCE ? margen : ENDED_NOTICE_SINCE, hasta };
}

// ── Piezas ────────────────────────────────────────────────────────────────────

const nk = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function assignmentsOf(s: EndedStudentRow, asgs: EndedAssignmentRow[]): EndedAssignmentRow[] {
  const email = nk(s.email);
  const name = nk(s.name);
  return asgs.filter(a =>
    (a.studentId && a.studentId === s.id) ||
    (email && nk(a.studentEmail) === email) ||
    (name && nk(a.studentName) === name));
}

/** Motivo por el que el alumno NO recibe este aviso, o null si entra. */
export function exclusionOf(s: EndedStudentRow, asgs: EndedAssignmentRow[], testTeacherIds: ReadonlySet<string>): string | null {
  if (s.isTest) return 'cuenta de prueba';
  const propias = assignmentsOf(s, asgs);
  if (propias.length > 0 && propias.every(a => testTeacherIds.has(a.teacherId))) return 'solo con profesores de prueba';
  if (s.isOritalk) return 'Oritalk';
  const base = baseProductName((s.productName ?? s.plan ?? '').trim());
  if (s.companyPlanMonths != null || isCompanyProduct(base) || PLAN_ACTIVATION_EXCLUDED_EMAILS.has(nk(s.email))) return 'empresa';
  const cat = catalogProduct(s.wooProductId);
  if (cat?.kind === 'fraccionado') return 'programa fraccionado';
  if (cat?.kind === 'mensual') return 'suscripción mensual';
  if (!(s.email ?? '').trim()) return 'sin email';
  return null;
}

/** Nombre del plan para el alumno: el del catálogo, o el del producto sin el horario. */
export function planNameOf(s: EndedStudentRow): string | null {
  const cat = catalogProduct(s.wooProductId);
  if (cat && cat.kind !== 'sin_datos') return cat.name;
  const base = baseProductName((s.productName ?? s.plan ?? '').trim());
  return base || null;
}

/**
 * Su profe: el de la asignación ACTIVA más reciente; si no hay, el de la última.
 * Nunca un profe de prueba ni archivado. null si no hay a quién avisar.
 */
export function teacherOf(s: EndedStudentRow, asgs: EndedAssignmentRow[], teachers: EndedTeacherRow[]): EndedTeacher | null {
  const byId = new Map(teachers.map(t => [t.id, t]));
  const valid = assignmentsOf(s, asgs).filter(a => {
    const t = byId.get(a.teacherId);
    return t && !t.isTest && !t.archivedAt;
  });
  const recent = (xs: EndedAssignmentRow[]) => [...xs].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
  const a = recent(valid.filter(x => x.status === 'active')) ?? recent(valid);
  if (!a) return null;
  const t = byId.get(a.teacherId)!;
  const email = (t.notificationEmail?.trim() || t.email?.trim() || '');
  return { id: t.id, name: t.name, email };
}

/** Lo ya hecho en ESTE ciclo. Un ciclo anterior no cuenta. */
export function previousOf(s: EndedStudentRow, endDate: string): EndedChannels {
  return s.endedNoticeForDate === endDate ? (s.endedNoticeCanales ?? {}) : {};
}

/** Destinatarios que faltan: todos en un ciclo nuevo; si no, solo los que fallaron o no se intentaron. */
export function pendingChannels(s: EndedStudentRow, endDate: string): EndedChannel[] {
  if (s.endedNoticeForDate !== endDate) return [...ENDED_CHANNELS];
  if (s.endedNoticeSentAt) return [];
  const prev = s.endedNoticeCanales ?? {};
  return ENDED_CHANNELS.filter(c => !prev[c] || prev[c]!.estado === 'error');
}

/** Junta lo de antes con lo nuevo. Lo enviado no se pisa nunca. */
export function mergeChannels(prev: EndedChannels, nuevo: EndedChannels): EndedChannels {
  const out: EndedChannels = { ...prev };
  for (const c of ENDED_CHANNELS) {
    const n = nuevo[c];
    if (!n) continue;
    if (out[c]?.estado === 'enviado') continue;
    out[c] = n;
  }
  return out;
}

/** Ciclo completo: los tres intentados y ninguno en error. */
export function cycleDone(ch: EndedChannels): boolean {
  return ENDED_CHANNELS.every(c => ch[c] && ch[c]!.estado !== 'error');
}

// ── La lista ──────────────────────────────────────────────────────────────────

export function findEndedPlans(args: {
  students: EndedStudentRow[];
  assignments: EndedAssignmentRow[];
  teachers: EndedTeacherRow[];
  today: string;
}): { ventana: { desde: string; hasta: string }; candidatos: EndedPlan[]; excluidos: EndedExclusion[] } {
  const ventana = endedWindow(args.today);
  const testTeacherIds = new Set(args.teachers.filter(t => t.isTest).map(t => t.id));
  const candidatos: EndedPlan[] = [];
  const excluidos: EndedExclusion[] = [];

  for (const s of args.students) {
    const endDate = (s.manualActiveUntil ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) continue;
    if (endDate < ventana.desde || endDate > ventana.hasta) continue;

    const motivo = exclusionOf(s, args.assignments, testTeacherIds);
    if (motivo) {
      excluidos.push({ studentId: s.id, studentName: s.name, endDate, motivo });
      continue;
    }
    const pendientes = pendingChannels(s, endDate);
    if (pendientes.length === 0) continue;

    candidatos.push({
      studentId: s.id,
      studentName: s.name,
      studentEmail: (s.email ?? '').trim(),
      studentPhone: (s.phone ?? '').trim(),
      endDate,
      planName: planNameOf(s),
      teacher: teacherOf(s, args.assignments, args.teachers),
      sevenDayNotice: s.endingNoticeForDate === endDate,
      pendientes,
      previos: previousOf(s, endDate),
    });
  }
  candidatos.sort((a, b) => a.endDate.localeCompare(b.endDate) || a.studentName.localeCompare(b.studentName, 'es'));
  return { ventana, candidatos, excluidos };
}

/**
 * Estados de check-subscription en los que NO se avisa aunque `active` sea false:
 * la renovación está en marcha (pago pendiente o en espera) o el alumno está en
 * pausa. Se vuelve a mirar al día siguiente, dentro del margen.
 */
export function isRenewalInProgress(status: string | null | undefined): boolean {
  return status === 'on-hold' || status === 'pending' || isPausedStatus(status);
}
