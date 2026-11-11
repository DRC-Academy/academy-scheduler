// ── "Tu plan ha finalizado": la vuelta diaria ─────────────────────────────────
// SOLO SERVIDOR. Va dentro del cron /api/cron/check-ending-plans (sin cron
// propio). Las reglas de quién entra están en lib/endedPlans; los textos en
// lib/endedPlanEmails.
//
// Por cada alumno de la ventana:
//   1. Comprueba la suscripción en el mismo proceso (lib/subscriptionCheck),
//      justo antes de enviar:
//        · activa                → renovó: no se avisa ni se marca.
//        · no verificable        → no se avisa; se reintenta mañana (margen).
//        · pago pendiente/pausa  → no se avisa; se reintenta mañana.
//        · inactiva              → se avisa.
//   2. Envía, EN ESTE ORDEN, alumno → profe → equipo (el del equipo dice qué
//      salió de los otros dos). Solo los que falten en este ciclo.
//   3. Guarda el resultado por destinatario. ended_notice_sent_at solo se pone
//      cuando ninguno quedó en error: un fallo NO cuenta como enviado.
//
// SIN EL SQL NO SE ENVÍA NADA: si faltan las columnas ended_notice_*, la vuelta
// real devuelve `migracionPendiente` sin mandar ningún email (sin ellas no hay
// forma de no repetir). El modo dry sí calcula la lista.

import type { SupabaseClient } from '@supabase/supabase-js';
import { madridToday } from '@/lib/subscriptionAccess';
import { verificarSuscripcion } from '@/lib/subscriptionCheck';
import { ENDING_PLANS_EMAIL } from '@/lib/emailNotifications';
import {
  findEndedPlans, endedWindow, mergeChannels, cycleDone, isRenewalInProgress,
  type EndedPlan, type EndedChannels, type EndedChannel, type EndedChannelResult,
  type EndedStudentRow, type EndedAssignmentRow, type EndedTeacherRow, type EndedExclusion,
} from '@/lib/endedPlans';
import {
  emailAlumno, emailProfe, emailEquipo, enviarEmail, planDeEjemplo, ENDED_REPLY_TO,
  type EndedEmail,
} from '@/lib/endedPlanEmails';

const LABEL = 'fin de plan';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const BASE_COLS = 'id, name, email, phone, product_type, product_name, plan, manual_active_until, is_test, is_oritalk, company_plan_months, woo_product_id, ending_notice_for_date';
const NOTICE_COLS = 'ended_notice_sent_at, ended_notice_for_date, ended_notice_canales';

export interface EndedPlanItem {
  alumno: string;
  studentId: string;
  fin: string;
  plan: string | null;
  profe: string | null;
  /** Qué pasó con este alumno en esta vuelta. */
  resultado: 'avisado' | 'avisado_con_errores' | 'renovo' | 'no_verificado' | 'en_espera' | 'se_enviaria';
  estadoWoo?: string;
  canales?: EndedChannels;
  /** En dry: a quién iría cada email y con qué asunto. */
  vista?: Partial<Record<EndedChannel, { to: string; subject: string }>>;
}

export interface EndedPlanReport {
  ok: boolean;
  dry: boolean;
  today: string;
  ventana: { desde: string; hasta: string };
  migracionPendiente: boolean;
  candidatos: number;
  avisados: number;
  items: EndedPlanItem[];
  excluidos: EndedExclusion[];
  errores: string[];
}

function toStudent(r: Row): EndedStudentRow {
  return {
    id: String(r.id), name: String(r.name ?? ''), email: r.email ?? null, phone: r.phone ?? null,
    productType: r.product_type ?? null, productName: r.product_name ?? null, plan: r.plan ?? null,
    manualActiveUntil: r.manual_active_until ?? null, isTest: r.is_test === true, isOritalk: r.is_oritalk === true,
    companyPlanMonths: r.company_plan_months ?? null, wooProductId: r.woo_product_id ?? null,
    endingNoticeForDate: r.ending_notice_for_date ?? null,
    endedNoticeSentAt: r.ended_notice_sent_at ?? null,
    endedNoticeForDate: r.ended_notice_for_date ?? null,
    endedNoticeCanales: (r.ended_notice_canales ?? null) as EndedChannels | null,
  };
}

async function readAll(admin: SupabaseClient, table: string, cols: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from(table).select(cols).order('id').range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < 1000) return out;
  }
}

/** Los tres emails de este alumno, con su destinatario. */
function emailsDe(d: EndedPlan, info: Parameters<typeof emailEquipo>[1]): Record<EndedChannel, { to: string; email: EndedEmail }> {
  return {
    alumno: { to: d.studentEmail, email: emailAlumno(d) },
    profe: { to: d.teacher?.email ?? '', email: emailProfe(d) },
    equipo: { to: ENDING_PLANS_EMAIL, email: emailEquipo(d, info) },
  };
}

export async function runEndedPlanNotices(
  admin: SupabaseClient, opts: { dry?: boolean; today?: string } = {},
): Promise<EndedPlanReport> {
  const dry = !!opts.dry;
  const today = opts.today ?? madridToday();
  const report: EndedPlanReport = {
    ok: true, dry, today, ventana: { desde: '', hasta: '' }, migracionPendiente: false,
    candidatos: 0, avisados: 0, items: [], excluidos: [], errores: [],
  };

  // 1) Alumnos con fin de plan en la ventana. La ventana exacta la pone
  //    findEndedPlans; acá se filtra grueso para no traer los 225.
  const ventana = endedWindow(today);
  report.ventana = ventana;
  if (ventana.desde > ventana.hasta) return report;   // antes de la publicación: nada que mirar

  const leer = (cols: string) => admin.from('students').select(cols)
    .gte('manual_active_until', ventana.desde).lte('manual_active_until', ventana.hasta);
  let res = await leer(`${BASE_COLS}, ${NOTICE_COLS}`);
  if (res.error && (res.error.code === '42703' || res.error.code === 'PGRST204' || /ended_notice/.test(res.error.message))) {
    report.migracionPendiente = true;
    if (!dry) {
      console.warn(`[${LABEL}] Faltan las columnas ended_notice_*: corré supabase/migraciones/2026-11-12-aviso-plan-finalizado.sql. No se envía nada.`);
      report.ok = false;
      report.errores.push('Faltan las columnas ended_notice_* (SQL sin correr): no se envió nada.');
      return report;
    }
    res = await leer(BASE_COLS);
  }
  if (res.error) {
    report.ok = false;
    report.errores.push(`students: ${res.error.message}`);
    return report;
  }

  let assignments: EndedAssignmentRow[] = [];
  let teachers: EndedTeacherRow[] = [];
  try {
    const [a, t] = await Promise.all([
      readAll(admin, 'assignments', 'id, teacher_id, student_id, student_email, student_name, status, created_at'),
      readAll(admin, 'teachers', 'id, name, email, notification_email, is_test, archived_at'),
    ]);
    assignments = a.map(r => ({
      teacherId: String(r.teacher_id), studentId: r.student_id ?? null, studentEmail: r.student_email ?? null,
      studentName: r.student_name ?? null, status: r.status ?? null, createdAt: r.created_at ?? null,
    }));
    teachers = t.map(r => ({
      id: String(r.id), name: String(r.name ?? ''), email: r.email ?? null,
      notificationEmail: r.notification_email ?? null, isTest: r.is_test === true, archivedAt: r.archived_at ?? null,
    }));
  } catch (e) {
    // Sin asignaciones no se sabe quién es de prueba: mejor no avisar a nadie hoy.
    report.ok = false;
    report.errores.push(`No se pudieron leer asignaciones/profesores: ${e instanceof Error ? e.message : String(e)}`);
    return report;
  }

  const students = ((res.data ?? []) as unknown as Row[]).map(toStudent);
  const { candidatos, excluidos } = findEndedPlans({ students, assignments, teachers, today });
  report.candidatos = candidatos.length;
  report.excluidos = excluidos;

  // 2) Uno por uno (pocos al día).
  for (const d of candidatos) {
    const item: EndedPlanItem = {
      alumno: d.studentName, studentId: d.studentId, fin: d.endDate, plan: d.planName,
      profe: d.teacher?.name ?? null, resultado: 'se_enviaria',
    };
    report.items.push(item);

    const v = await verificarSuscripcion(d.studentEmail, LABEL);
    item.estadoWoo = v.status;
    if (v.active === true) { item.resultado = 'renovo'; continue; }
    if (v.active === null) { item.resultado = 'no_verificado'; continue; }
    if (isRenewalInProgress(v.status)) { item.resultado = 'en_espera'; continue; }

    const prev: EndedChannels = d.previos;
    const nuevo: EndedChannels = {};
    const info = () => ({ subStatus: v.status, alumno: nuevo.alumno ?? prev.alumno, profe: nuevo.profe ?? prev.profe });

    if (dry) {
      const m = emailsDe(d, info());
      item.vista = Object.fromEntries(d.pendientes.map(c => [c, { to: m[c].to || '(sin dirección: se omite)', subject: m[c].email.subject }]));
      continue;
    }

    // El orden importa: el del equipo cuenta qué pasó con los otros dos.
    for (const c of ['alumno', 'profe', 'equipo'] as const) {
      if (!d.pendientes.includes(c)) continue;
      const m = emailsDe(d, info())[c];
      const r: EndedChannelResult = await enviarEmail({
        to: m.to, email: m.email,
        replyTo: c === 'alumno' ? ENDED_REPLY_TO : undefined,
        idempotencyKey: `fin-plan-${c}-${d.studentId}-${d.endDate}`,
      });
      if (c === 'profe' && r.estado === 'omitido') r.error = 'El alumno no tiene profe (o el profe no tiene email).';
      nuevo[c] = r;
      if (r.estado === 'error') {
        console.error(`[${LABEL}] ${c} de ${d.studentName} (${d.studentId}) no salió: ${r.error}`);
        report.errores.push(`${d.studentName}: ${c}: ${r.error}`);
      }
    }

    const canales = mergeChannels(prev, nuevo);
    const done = cycleDone(canales);
    item.canales = canales;
    item.resultado = done ? 'avisado' : 'avisado_con_errores';
    if (canales.alumno?.estado === 'enviado') report.avisados++;

    const upd = {
      ended_notice_for_date: d.endDate,
      ended_notice_canales: canales,
      ended_notice_sent_at: done ? new Date().toISOString() : null,
    };
    let { error } = await admin.from('students').update(upd).eq('id', d.studentId);
    if (error) ({ error } = await admin.from('students').update(upd).eq('id', d.studentId));
    if (error) {
      // Los emails YA salieron. Mañana se reintentaría todo: la clave de
      // idempotencia de Resend (24 h) no siempre lo frena. Que quede a la vista.
      console.error(`[${LABEL}] Avisos enviados pero NO guardados para ${d.studentName} (${d.studentId}):`, error);
      report.errores.push(`${d.studentName}: enviado pero no guardado (${error.message}). Revisar antes de mañana.`);
    }
  }

  if (report.errores.length) report.ok = false;
  return report;
}

/**
 * ?prueba_fin=1&email=…: los tres emails con datos inventados, todos a `to`
 * (asunto con [PRUEBA]). No lee ni escribe la base.
 */
export async function sendEndedPlanSamples(to: string): Promise<Record<EndedChannel, EndedChannelResult & { subject: string }>> {
  const d = planDeEjemplo();
  const info = { subStatus: 'cancelled', alumno: { estado: 'enviado' as const }, profe: { estado: 'enviado' as const } };
  const m = { alumno: emailAlumno(d), profe: emailProfe(d), equipo: emailEquipo(d, info) };
  const out = {} as Record<EndedChannel, EndedChannelResult & { subject: string }>;
  for (const c of ['alumno', 'profe', 'equipo'] as const) {
    const email = { ...m[c], subject: `[PRUEBA] ${m[c].subject}` };
    const r = await enviarEmail({ to, email, replyTo: c === 'alumno' ? ENDED_REPLY_TO : undefined });
    out[c] = { ...r, subject: email.subject };
  }
  return out;
}
