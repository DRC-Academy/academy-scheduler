// ── Aviso de renovación de programas → Slack ─────────────────────────────────
//
// Arma el aviso "🔔 Renovación en N días" de una fila de student_programs y lo
// publica en SLACK_RENOVACIONES_WEBHOOK_URL. SOLO SERVIDOR.
//
// EL DESTINO es un Incoming Webhook de Slack DIRECTO (https://hooks.slack.com/…).
// Nada de Zapier: se da de baja el 14/11/2026. Si la variable apunta a otra
// cosa, no se envía (así un Catch Hook viejo pegado por error no recibe nada).
// Si está vacía, tampoco se envía, se deja en el log y no se marca a nadie:
// cuando se cree la variable, el cron avisa de los que quedaron pendientes.
//
// ORDEN: primero el envío, después la marca. Si Slack falla, el alumno no queda
// marcado y el cron lo reintenta al día siguiente.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildRenewalText, daysBetween, formatDateEs, paymentsLabel, programLabel, paymentModeLabel,
  renewalSkipReason, type RenewalMessageData, type StudentProgramRow, type RenewalSkipReason,
} from '@/lib/programRenewal';
import { ENDING_NOTICE_DAYS } from '@/lib/endingPlans';

const TIMEOUT_MS = 10_000;
export const RENEWAL_WEBHOOK_ENV = 'SLACK_RENOVACIONES_WEBHOOK_URL';

interface StudentInfo {
  id: string; name: string; email: string | null; phone: string | null; manual_active_until: string | null;
}

export interface RenewalContext {
  programs: StudentProgramRow[];
  students: Map<string, StudentInfo>;
  /** student_id → profesor de la asignación activa. */
  teacherByStudent: Map<string, string>;
  /** email → profesor (respaldo cuando la asignación no tiene student_id). */
  teacherByEmail: Map<string, string>;
}

export async function loadRenewalContext(admin: SupabaseClient, programs: StudentProgramRow[]): Promise<RenewalContext> {
  const students = new Map<string, StudentInfo>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('students')
      .select('id, name, email, phone, manual_active_until').order('id').range(from, from + 999);
    if (error) throw new Error(`students: ${error.message}`);
    for (const s of data ?? []) {
      students.set(String(s.id), {
        id: String(s.id), name: s.name, email: s.email, phone: s.phone, manual_active_until: s.manual_active_until ?? null,
      });
    }
    if ((data ?? []).length < 1000) break;
  }

  const teacherByStudent = new Map<string, string>();
  const teacherByEmail = new Map<string, string>();
  const { data: asg, error } = await admin.from('assignments').select('student_id, student_email, teacher_name, status');
  if (error) throw new Error(`assignments: ${error.message}`);
  for (const a of asg ?? []) {
    if (a.status != null && a.status !== 'active') continue;
    const t = String(a.teacher_name ?? '').trim();
    if (!t) continue;
    if (a.student_id && !teacherByStudent.has(String(a.student_id))) teacherByStudent.set(String(a.student_id), t);
    const e = String(a.student_email ?? '').trim().toLowerCase();
    if (e && !teacherByEmail.has(e)) teacherByEmail.set(e, t);
  }
  return { programs, students, teacherByStudent, teacherByEmail };
}

/** Los demás programas del mismo alumno (o del mismo email si no está enlazado). */
export function siblingsOf(r: StudentProgramRow, all: StudentProgramRow[]): StudentProgramRow[] {
  return all.filter(o => o.order_id !== r.order_id && (
    (!!r.student_id && o.student_id === r.student_id)
    || (!!r.email && !!o.email && o.email === r.email)
  ));
}

export interface RenewalPayload {
  /** Lo único que se manda a Slack. */
  text: string;
  // El resto es para el modo dry y los logs: no sale de Gestión.
  alumno: string;
  programa: string;
  forma_pago: string;
  profe: string;
  fecha_fin: string;
  dias_restantes: number;
  telefono: string;
  email: string;
  estado_pago: string;
  enlazado: boolean;
  pedido: number;
  suscripcion: number | null;
  /**
   * true si ese mismo día al alumno también le puede llegar el aviso de 7 días
   * (check-ending-plans): le quedan 7 días o menos y su acceso en Gestión acaba
   * dentro de esa ventana. Solo informativo: los dos avisos conviven.
   */
  coincide_con_aviso_7_dias: boolean;
}

export function buildRenewalPayload(r: StudentProgramRow, ctx: RenewalContext, today: string): RenewalPayload {
  const st = r.student_id ? ctx.students.get(r.student_id) ?? null : null;
  const email = (st?.email ?? r.email ?? '').trim();
  const teacher = st
    ? ctx.teacherByStudent.get(st.id) ?? (email ? ctx.teacherByEmail.get(email.toLowerCase()) : undefined) ?? null
    : null;
  const data: RenewalMessageData = {
    studentName: st?.name?.trim() || r.billing_name || email || `Pedido #${r.order_id}`,
    program: r.program,
    paymentMode: r.payment_mode,
    teacherName: teacher,
    endDate: r.end_date ?? '',
    daysLeft: r.end_date ? daysBetween(today, r.end_date) : 0,
    phone: (st?.phone ?? '').trim() || (r.billing_phone ?? '').trim(),
    email,
    payments: paymentsLabel(r),
    linked: !!st,
  };
  const access = st?.manual_active_until?.slice(0, 10) ?? null;
  const accessDays = access ? daysBetween(today, access) : null;
  return {
    text: buildRenewalText(data),
    alumno: data.studentName,
    programa: programLabel(r.program),
    forma_pago: paymentModeLabel(r.payment_mode),
    profe: (st && teacher) || 'sin asignar',
    fecha_fin: formatDateEs(r.end_date),
    dias_restantes: data.daysLeft,
    telefono: data.phone,
    email: data.email,
    estado_pago: data.payments,
    enlazado: data.linked,
    pedido: Number(r.order_id),
    suscripcion: r.subscription_id ? Number(r.subscription_id) : null,
    coincide_con_aviso_7_dias: data.daysLeft <= ENDING_NOTICE_DAYS
      && accessDays != null && accessDays >= 0 && accessDays <= ENDING_NOTICE_DAYS,
  };
}

export type WebhookCheck = { ok: true; url: string } | { ok: false; reason: string };

/** ¿Hay un Incoming Webhook de Slack válido en la variable? */
export function renewalWebhook(raw: string | undefined = process.env[RENEWAL_WEBHOOK_ENV]): WebhookCheck {
  const url = (raw ?? '').trim();
  if (!url) return { ok: false, reason: `${RENEWAL_WEBHOOK_ENV} está vacía: no se envía nada` };
  if (!/^https:\/\/hooks\.slack\.com\//i.test(url)) {
    return { ok: false, reason: `${RENEWAL_WEBHOOK_ENV} no es un Incoming Webhook de Slack (https://hooks.slack.com/…): no se envía nada` };
  }
  return { ok: true, url };
}

/** Publica en Slack. Nunca lanza: devuelve el motivo del fallo o null. */
export async function postRenewal(payload: Pick<RenewalPayload, 'text'>): Promise<string | null> {
  const hook = renewalWebhook();
  if (!hook.ok) return hook.reason;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: payload.text }),
      signal: controller.signal,
      cache: 'no-store',
    });
    return res.ok ? null : `Slack respondió HTTP ${res.status}`;
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return err?.name === 'AbortError' ? `timeout tras ${TIMEOUT_MS}ms` : String(err?.message ?? e);
  } finally {
    clearTimeout(timer);
  }
}

export async function markRenewalNotified(admin: SupabaseClient, r: StudentProgramRow): Promise<string | null> {
  const { error } = await admin.from('student_programs')
    .update({ renewal_notified_at: new Date().toISOString(), renewal_notified_for: r.end_date })
    .eq('order_id', r.order_id);
  return error ? error.message : null;
}

/** Las filas a las que hoy les toca aviso. */
export function dueRenewals(programs: StudentProgramRow[], today: string): {
  due: StudentProgramRow[]; skipped: Partial<Record<RenewalSkipReason, number>>;
} {
  const due: StudentProgramRow[] = [];
  const skipped: Partial<Record<RenewalSkipReason, number>> = {};
  for (const r of programs) {
    const reason = renewalSkipReason(r, siblingsOf(r, programs), today);
    if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
    else due.push(r);
  }
  return { due, skipped };
}

export interface RenewalRunResult {
  sent: Array<{ pedido: number; alumno: string; fecha_fin: string }>;
  failed: Array<{ pedido: number; alumno: string; motivo: string }>;
  /** Cuántas filas quedaron fuera, por motivo. */
  skipped: Partial<Record<RenewalSkipReason, number>>;
  /** Motivo por el que no se envió NADA (sin webhook). null si se intentó enviar. */
  sinWebhook: string | null;
}

/** El aviso diario: todas las filas a las que les toca, una vez cada una. */
export async function runRenewalNotices(admin: SupabaseClient, ctx: RenewalContext, today: string): Promise<RenewalRunResult> {
  const { due, skipped } = dueRenewals(ctx.programs, today);
  const result: RenewalRunResult = { sent: [], failed: [], skipped, sinWebhook: null };
  if (due.length === 0) return result;

  const hook = renewalWebhook();
  if (!hook.ok) {
    console.warn(`[renovaciones] ${hook.reason}. Quedan ${due.length} aviso(s) pendientes; no se marca ninguno.`);
    result.sinWebhook = hook.reason;
    return result;
  }

  for (const r of due) {
    const payload = buildRenewalPayload(r, ctx, today);
    const fail = await postRenewal(payload);
    if (fail) { result.failed.push({ pedido: payload.pedido, alumno: payload.alumno, motivo: fail }); continue; }
    const markErr = await markRenewalNotified(admin, r);
    if (markErr) {
      // Enviado pero sin marcar: mañana se repetiría. Queda en el log para verlo.
      console.error(`[renovaciones] Aviso enviado pero NO marcado (pedido ${r.order_id}): ${markErr}`);
    }
    result.sent.push({ pedido: payload.pedido, alumno: payload.alumno, fecha_fin: payload.fecha_fin });
  }
  return result;
}
