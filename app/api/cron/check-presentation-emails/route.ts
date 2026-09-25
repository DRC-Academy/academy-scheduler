// Cron horario de recordatorios del ENLACE DE CLASE. Lo dispara GitHub Actions
// (.github/workflows/presentation-emails-cron.yml, "0 * * * *"), no vercel.json:
// el plan Hobby de Vercel no admite crons por hora. La ruta conserva su nombre
// histórico (era el recordatorio del email de presentación) porque el secret
// PRESENTATION_CRON_URL de GitHub guarda la URL completa.
//
// Desde la Fase 3 (sep/2026) vigila asignaciones ACTIVAS sin enlace definido
// (meet_link_set_at nulo, lib/meetLinkStatus) y creadas hace menos de 96 h. No
// penaliza aquí: la penalización 'enlace_tardio' se aplica al definir el enlace
// (PUT /api/assignments/[assignmentId]/meet-link).
//
// Umbrales (desde la asignación), con email + campanita:
//   ·  4 h → al PROFE.
//   · 12 h → al PROFE y al ADMIN.
//   · 24 h → al PROFE y al ADMIN.
// Qué toca en cada corrida lo decide lib/meetLinkReminders (puro, con tests).
//
// ANTI-DUPLICADOS, en tres capas:
//   1. Cada EMAIL se reserva antes de enviarse en daily_reminder_log con un id
//      único (drl_meetlink_<umbral>_<teacher|admin>_<asignación>_<profe>). Si
//      Resend falla, la reserva se borra y la corrida siguiente lo reintenta.
//   2. Las columnas presentation_reminder_{4h,12h,24h}_sent solo pasan a true
//      cuando TODOS los emails de ese umbral salieron bien. Si uno falla, el
//      umbral queda abierto; en la corrida siguiente el que ya salió está
//      reservado y no se repite.
//   3. Las campanitas usan un id determinista (upsert ignoreDuplicates).
//
// Seguridad: lib/cronAuth (sin CRON_SECRET la ruta queda CERRADA; comparación
// en tiempo constante) y cliente service role.

import type { SupabaseClient } from '@supabase/supabase-js';
import { requireCronSecret, requireAdminClient } from '@/lib/cronAuth';
import { madridToday } from '@/lib/subscriptionAccess';
import { planMeetLinkReminders, REMINDER_WINDOW_HOURS, type PlannedReminder, type ReminderRow } from '@/lib/meetLinkReminders';
import {
  fetchTeacher,
  sendMeetLinkReminder4h, sendMeetLinkReminder12h, sendMeetLinkReminder24h,
  sendMeetLinkAdminAlert12h, sendMeetLinkAdminAlert24h,
  type TeacherLike,
} from '@/lib/emailNotifications';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const LABEL = 'cron meet-links';

export async function GET(request: Request): Promise<Response> {
  const denied = requireCronSecret(request, LABEL);
  if (denied) return denied;
  const { admin, error: adminError } = requireAdminClient(LABEL);
  if (adminError) return adminError;

  const now = Date.now();
  const desde = new Date(now - REMINDER_WINDOW_HOURS * 3_600_000).toISOString();

  // Activas, sin enlace definido y recientes. El filtro de 96 h va en la propia
  // consulta: las asignaciones viejas ni se leen.
  const { data, error } = await admin
    .from('assignments')
    .select('id, teacher_id, teacher_name, student_name, created_at, presentation_reminder_4h_sent, presentation_reminder_12h_sent, presentation_reminder_24h_sent')
    .is('meet_link_set_at', null)
    .or('status.is.null,status.eq.active')
    .gte('created_at', desde);

  if (error) {
    console.error(`[${LABEL}] Error al leer asignaciones:`, error);
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }

  const rows = (data ?? []) as ReminderRow[];
  const plan = planMeetLinkReminders(rows, now);
  if (plan.length === 0) return Response.json({ ok: true, pending: rows.length, planned: 0, emailed: 0 });

  const teachers = new Map<string, TeacherLike | null>();
  const teacherOf = async (id: string) => {
    if (!teachers.has(id)) teachers.set(id, await fetchTeacher(id));
    return teachers.get(id) ?? null;
  };

  let emailed = 0;
  let completed = 0;
  const failed: string[] = [];

  for (const r of plan) {
    await insertNotifications(admin, r, new Date(now).toISOString());

    let allOk = true;
    for (const e of r.emails) {
      const reserved = await claim(admin, e.claimId, r.teacherId);
      if (reserved === 'taken') continue;          // ya salió en una corrida anterior
      if (reserved === 'error') { allOk = false; continue; }

      const ok = await sendOne(r, e.to, teacherOf);
      if (ok) {
        emailed++;
      } else {
        allOk = false;
        await release(admin, e.claimId);
      }
    }

    if (!allOk) {
      failed.push(`${r.studentName} (${r.threshold})`);
      continue;                                     // el umbral queda abierto: se reintenta
    }
    const patch = Object.fromEntries(r.flags.map(f => [f, true]));
    const { error: updErr } = await admin.from('assignments').update(patch).eq('id', r.assignmentId);
    if (updErr) console.error(`[${LABEL}] Error al marcar recordatorios de ${r.assignmentId}:`, updErr);
    else completed++;
  }

  return Response.json({ ok: true, pending: rows.length, planned: plan.length, emailed, completed, failed });
}

async function insertNotifications(admin: SupabaseClient, r: PlannedReminder, createdAt: string): Promise<void> {
  const rows = r.notifications.map(n => ({ ...n, read_by: [], created_at: createdAt, created_by: 'sistema' }));
  const { error } = await admin.from('notifications').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
  if (error) console.error(`[${LABEL}] Error al insertar notificaciones:`, error);
}

/** Reserva un email. 'claimed' = hay que enviarlo; 'taken' = ya se envió; 'error' = no se pudo reservar. */
async function claim(admin: SupabaseClient, id: string, teacherId: string): Promise<'claimed' | 'taken' | 'error'> {
  const { data, error } = await admin
    .from('daily_reminder_log')
    .upsert({ id, teacher_id: teacherId, reminder_date: madridToday(), classes_count: 0, sent_at: new Date().toISOString() },
      { onConflict: 'id', ignoreDuplicates: true })
    .select('id');
  if (error) {
    console.error(`[${LABEL}] No se pudo reservar ${id}:`, error);
    return 'error';
  }
  return (data?.length ?? 0) > 0 ? 'claimed' : 'taken';
}

async function release(admin: SupabaseClient, id: string): Promise<void> {
  const { error } = await admin.from('daily_reminder_log').delete().eq('id', id);
  if (error) console.error(`[${LABEL}] No se pudo liberar la reserva ${id}:`, error);
}

/** Envía un email del plan. Nunca lanza: un fallo cuenta como false. */
async function sendOne(
  r: PlannedReminder, to: 'teacher' | 'admin', teacherOf: (id: string) => Promise<TeacherLike | null>,
): Promise<boolean> {
  try {
    if (to === 'admin') {
      return r.threshold === '12h'
        ? await sendMeetLinkAdminAlert12h(r.teacherName, r.studentName, r.hours)
        : await sendMeetLinkAdminAlert24h(r.teacherName, r.studentName, r.hours);
    }
    const teacher = await teacherOf(r.teacherId);
    if (!teacher) return false;
    return r.threshold === '4h'  ? await sendMeetLinkReminder4h(teacher, r.studentName)
         : r.threshold === '12h' ? await sendMeetLinkReminder12h(teacher, r.studentName)
         :                         await sendMeetLinkReminder24h(teacher, r.studentName);
  } catch (err) {
    console.error(`[${LABEL}] Fallo al enviar email:`, err);
    return false;
  }
}
