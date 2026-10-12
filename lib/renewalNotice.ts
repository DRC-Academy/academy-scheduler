// ── Aviso de renovación de programas → Slack (vía webhook) ───────────────────
//
// Arma el aviso "🔔 Renovación en 4 semanas" de una fila de student_programs y
// lo publica en SLACK_RENOVACIONES_WEBHOOK_URL. SOLO SERVIDOR.
//
// EL WEBHOOK. Puede ser un Incoming Webhook de Slack (hooks.slack.com) o un
// Catch Hook de Zapier que reenvía a Slack. A Slack se le manda solo `text`
// (rechaza claves que no conoce en algunos workspaces); a cualquier otro, `text`
// con el mensaje ya armado MÁS cada dato suelto, para que el Zap pueda pegar el
// texto tal cual o componer el suyo. Los nombres de las claves son contrato con
// el Zap: añadir es seguro, renombrar lo rompe sin ningún error visible.
//
// ORDEN: primero el envío, después la marca. Si el webhook falla, el alumno no
// queda marcado y el cron lo reintenta al día siguiente.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildRenewalText, daysBetween, formatDateEs, paymentsLabel, programFullLabel,
  programLabel, paymentModeLabel, renewalSkipReason,
  type RenewalMessageData, type StudentProgramRow, type RenewalSkipReason,
} from '@/lib/programs';

const TIMEOUT_MS = 10_000;

export interface RenewalContext {
  programs: StudentProgramRow[];
  students: Map<string, { id: string; name: string; email: string | null; phone: string | null }>;
  /** student_id → profesor de la asignación activa. */
  teacherByStudent: Map<string, string>;
  /** email → profesor (respaldo cuando la asignación no tiene student_id). */
  teacherByEmail: Map<string, string>;
}

export async function loadRenewalContext(admin: SupabaseClient, programs: StudentProgramRow[]): Promise<RenewalContext> {
  const students = new Map<string, { id: string; name: string; email: string | null; phone: string | null }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('students').select('id, name, email, phone').order('id').range(from, from + 999);
    if (error) throw new Error(`students: ${error.message}`);
    for (const s of data ?? []) students.set(String(s.id), { id: String(s.id), name: s.name, email: s.email, phone: s.phone });
    if ((data ?? []).length < 1000) break;
  }

  const teacherByStudent = new Map<string, string>();
  const teacherByEmail = new Map<string, string>();
  const { data: asg, error } = await admin.from('assignments').select('student_id, student_email, teacher_name, status');
  if (error) throw new Error(`assignments: ${error.message}`);
  for (const a of asg ?? []) {
    // Sin la columna status (migración antigua) toda asignación cuenta como activa.
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
    (r.student_id && o.student_id === r.student_id)
    || (!!r.email && !!o.email && o.email === r.email)
  ));
}

export interface RenewalPayload {
  text: string;
  alumno: string;
  programa: string;
  forma_pago: string;
  profe: string;
  fecha_fin: string;
  fecha_fin_iso: string;
  dias_restantes: number;
  telefono: string;
  email: string;
  pagos: string;
  enlazado: boolean;
  pedido: number;
  suscripcion: number | null;
  /** true = lanzado a mano desde /api/renovaciones/avisar. */
  manual: boolean;
}

export function buildRenewalPayload(r: StudentProgramRow, ctx: RenewalContext, today: string, manual = false): RenewalPayload {
  const st = r.student_id ? ctx.students.get(r.student_id) ?? null : null;
  const email = (st?.email ?? r.email ?? '').trim();
  const teacher = (st && ctx.teacherByStudent.get(st.id))
    ?? (email ? ctx.teacherByEmail.get(email.toLowerCase()) : undefined)
    ?? null;
  const data: RenewalMessageData = {
    studentName: st?.name?.trim() || r.billing_name || email || `Pedido #${r.order_id}`,
    programLabel: programFullLabel(r),
    teacherName: teacher,
    endDate: r.end_date ?? '',
    daysLeft: r.end_date ? daysBetween(today, r.end_date) : 0,
    phone: (st?.phone ?? '').trim() || (r.billing_phone ?? '').trim(),
    email,
    payments: paymentsLabel(r),
    linked: !!st,
  };
  return {
    text: buildRenewalText(data),
    alumno: data.studentName,
    programa: programLabel(r.program),
    forma_pago: paymentModeLabel(r.payment_mode),
    profe: teacher ?? 'sin asignar',
    fecha_fin: formatDateEs(r.end_date),
    fecha_fin_iso: r.end_date ?? '',
    dias_restantes: data.daysLeft,
    telefono: data.phone,
    email: data.email,
    pagos: data.payments,
    enlazado: data.linked,
    pedido: Number(r.order_id),
    suscripcion: r.subscription_id ? Number(r.subscription_id) : null,
    manual,
  };
}

/** Publica en el webhook. Nunca lanza: devuelve el motivo del fallo o null. */
export async function postRenewal(payload: RenewalPayload): Promise<string | null> {
  const url = process.env.SLACK_RENOVACIONES_WEBHOOK_URL?.trim();
  if (!url) return 'Falta SLACK_RENOVACIONES_WEBHOOK_URL en el entorno';
  const isSlack = /^https:\/\/hooks\.slack\.com\//i.test(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isSlack ? { text: payload.text } : payload),
      signal: controller.signal,
      cache: 'no-store',
    });
    return res.ok ? null : `HTTP ${res.status}`;
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

export interface RenewalRunResult {
  sent: Array<{ pedido: number; alumno: string; fecha_fin: string }>;
  failed: Array<{ pedido: number; alumno: string; motivo: string }>;
  /** Cuántas filas quedaron fuera, por motivo. */
  skipped: Partial<Record<RenewalSkipReason, number>>;
}

/** El aviso diario: todas las filas a las que les toca, una vez cada una. */
export async function runRenewalNotices(admin: SupabaseClient, ctx: RenewalContext, today: string): Promise<RenewalRunResult> {
  const result: RenewalRunResult = { sent: [], failed: [], skipped: {} };
  for (const r of ctx.programs) {
    const reason = renewalSkipReason(r, siblingsOf(r, ctx.programs), today);
    if (reason) { result.skipped[reason] = (result.skipped[reason] ?? 0) + 1; continue; }
    const payload = buildRenewalPayload(r, ctx, today);
    const fail = await postRenewal(payload);
    if (fail) { result.failed.push({ pedido: payload.pedido, alumno: payload.alumno, motivo: fail }); continue; }
    const markErr = await markRenewalNotified(admin, r);
    if (markErr) {
      // Enviado pero sin marcar: mañana se repetiría. Se deja en el log para verlo.
      console.error(`[renovaciones] Aviso enviado pero NO marcado (pedido ${r.order_id}): ${markErr}`);
    }
    result.sent.push({ pedido: payload.pedido, alumno: payload.alumno, fecha_fin: payload.fecha_fin });
  }
  return result;
}
