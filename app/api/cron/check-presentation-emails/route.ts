// Cron horario (vercel.json → "0 * * * *"): recordatorios escalonados del email
// de presentación pendiente. No penaliza scoring aquí (eso ocurre al enviarlo, en
// /api/assignments/[id]/presentation-sent); solo avisa.
//
// Umbrales (desde la asignación):
//   ·  4 h → email + aviso in-app al PROFE.
//   · 12 h → email + aviso in-app al PROFE, y email + aviso in-app al ADMIN.
//   · 24 h → email + aviso in-app al PROFE, y email + aviso in-app al ADMIN.
//
// Anti-duplicados: cada umbral se marca en una columna booleana de la asignación
// (presentation_reminder_{4h,12h,24h}_sent). Se comprueba false antes de enviar y
// se marca true después, así ningún aviso se repite en corridas sucesivas. Las
// notificaciones in-app usan además un id determinista (upsert ignoreDuplicates)
// para cerrar la carrera entre dos corridas simultáneas.

import { supabase } from '@/lib/supabase';
import {
  hoursSinceAssigned,
  PRESENTATION_WARNING_HOURS,
  PRESENTATION_AT_RISK_HOURS,
  PRESENTATION_DEADLINE_HOURS,
} from '@/lib/presentationEmailUtils';
import {
  fetchTeacher,
  sendPresentationReminder4h, sendPresentationReminder12h, sendPresentationReminder24h,
  sendPresentationAdminAlert12h, sendPresentationAdminAlert24h,
  type TeacherLike,
} from '@/lib/emailNotifications';

export const dynamic = 'force-dynamic';

interface AsgnRow {
  id: string;
  teacher_id: string;
  teacher_name: string;
  student_name: string;
  created_at: string;
  presentation_email_sent: boolean | null;
  presentation_reminder_4h_sent: boolean | null;
  presentation_reminder_12h_sent: boolean | null;
  presentation_reminder_24h_sent: boolean | null;
}

interface NotifCandidate {
  id: string;
  target_user: string | null;
  target_role: string | null;
  title: string;
  body: string;
  type: string;
}

type EmailJob =
  | { kind: 'teacher_4h';  teacherId: string; studentName: string }
  | { kind: 'teacher_12h'; teacherId: string; studentName: string }
  | { kind: 'teacher_24h'; teacherId: string; studentName: string }
  | { kind: 'admin_12h';   teacherName: string; studentName: string }
  | { kind: 'admin_24h';   teacherName: string; studentName: string };

// Columnas a marcar true por asignación (los umbrales que dispararon en esta corrida).
type FlagPatch = { presentation_reminder_4h_sent?: boolean; presentation_reminder_12h_sent?: boolean; presentation_reminder_24h_sent?: boolean };

export async function GET(request: Request): Promise<Response> {
  // Autorización opcional: si hay CRON_SECRET configurado, exigir el bearer que
  // envía Vercel Cron. Sin CRON_SECRET, el endpoint queda abierto (dev/manual).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: 'No autorizado' }, { status: 401 });
    }
  }

  // Asignaciones con el email de presentación pendiente.
  const { data, error } = await supabase
    .from('assignments')
    .select('id, teacher_id, teacher_name, student_name, created_at, presentation_email_sent, presentation_reminder_4h_sent, presentation_reminder_12h_sent, presentation_reminder_24h_sent')
    .or('presentation_email_sent.eq.false,presentation_email_sent.is.null');

  if (error) {
    console.error('[cron presentation-emails] Error al leer asignaciones:', error);
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }

  const pending = (data ?? []) as AsgnRow[];
  const now = Date.now();
  const createdAtIso = new Date(now).toISOString();

  // Ventana de recencia: solo alertamos por asignaciones recientes. Cubre con
  // margen el último umbral (24 h) sin nagear por las asignaciones que ya existían
  // antes de esta función (esas siguen viéndose "fuera de tiempo" en los badges de
  // la UI, pero no generan avisos nuevos).
  const ALERT_WINDOW_HOURS = 96;

  const candidates: NotifCandidate[] = [];
  const emailJobs: EmailJob[] = [];
  const flagUpdates = new Map<string, FlagPatch>();

  for (const a of pending) {
    const h = hoursSinceAssigned(a.created_at, now);
    if (h > ALERT_WINDOW_HOURS) continue;   // asignación vieja → no genera alertas

    // 4 h → email + in-app al profe.
    if (h >= PRESENTATION_WARNING_HOURS && !a.presentation_reminder_4h_sent) {
      candidates.push({
        id: `presalert_4h_teacher_${a.id}`,
        target_user: a.teacher_id, target_role: null,
        title: `📧 Recordatorio — Email de ${a.student_name}`,
        body: `Llevas 4h sin enviar el email de presentación a ${a.student_name}. ¡Los alumnos que reciben bienvenida pronto tienen mayor retención!`,
        type: 'presentation_email_reminder',
      });
      emailJobs.push({ kind: 'teacher_4h', teacherId: a.teacher_id, studentName: a.student_name });
      markFlag(flagUpdates, a.id, { presentation_reminder_4h_sent: true });
    }

    // 12 h → email + in-app al profe Y al admin.
    if (h >= PRESENTATION_AT_RISK_HOURS && !a.presentation_reminder_12h_sent) {
      candidates.push({
        id: `presalert_12h_teacher_${a.id}`,
        target_user: a.teacher_id, target_role: null,
        title: `⚠️ Urgente — Email de ${a.student_name}`,
        body: `Llevas 12h sin enviar el email de presentación a ${a.student_name}. Te quedan menos de 12 horas para enviarlo sin afectar tu scoring.`,
        type: 'presentation_email_warning_teacher',
      });
      candidates.push({
        id: `presalert_12h_admin_${a.id}`,
        target_user: null, target_role: 'admin',
        title: `⚠️ Email pendiente — ${a.teacher_name}`,
        body: `${a.teacher_name} lleva 12h sin enviar el email de presentación a ${a.student_name}.`,
        type: 'presentation_email_warning',
      });
      emailJobs.push({ kind: 'teacher_12h', teacherId: a.teacher_id, studentName: a.student_name });
      emailJobs.push({ kind: 'admin_12h', teacherName: a.teacher_name, studentName: a.student_name });
      markFlag(flagUpdates, a.id, { presentation_reminder_12h_sent: true });
    }

    // 24 h → email + in-app al profe Y al admin (fuera de plazo).
    if (h >= PRESENTATION_DEADLINE_HOURS && !a.presentation_reminder_24h_sent) {
      candidates.push({
        id: `presalert_24h_teacher_${a.id}`,
        target_user: a.teacher_id, target_role: null,
        title: '🔴 Email de presentación fuera de plazo',
        body: `No enviaste el email de presentación a ${a.student_name} en las primeras 24 horas. Cuando lo envíes se descontarán -5 puntos de tu scoring.`,
        type: 'presentation_email_overdue_teacher',
      });
      candidates.push({
        id: `presalert_24h_admin_${a.id}`,
        target_user: null, target_role: 'admin',
        title: `🔴 Email fuera de plazo — ${a.teacher_name}`,
        body: `${a.teacher_name} no envió el email de presentación a ${a.student_name} en 24 horas.`,
        type: 'presentation_email_overdue',
      });
      emailJobs.push({ kind: 'teacher_24h', teacherId: a.teacher_id, studentName: a.student_name });
      emailJobs.push({ kind: 'admin_24h', teacherName: a.teacher_name, studentName: a.student_name });
      markFlag(flagUpdates, a.id, { presentation_reminder_24h_sent: true });
    }
  }

  if (candidates.length === 0 && flagUpdates.size === 0) {
    return Response.json({ ok: true, pending: pending.length, inserted: 0, emailed: 0 });
  }

  // ── Notificaciones in-app (dedup determinista por si dos corridas se solapan) ──
  let inserted = 0;
  if (candidates.length > 0) {
    const rows = candidates.map(c => ({
      id:          c.id,
      target_user: c.target_user,
      target_role: c.target_role,
      title:       c.title,
      body:        c.body,
      type:        c.type,
      read_by:     [],
      created_at:  createdAtIso,
      created_by:  'sistema',
    }));
    const { error: insErr } = await supabase
      .from('notifications')
      .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    if (insErr) {
      console.error('[cron presentation-emails] Error al insertar notificaciones:', insErr);
    } else {
      inserted = rows.length;
    }
  }

  // ── Emails (best-effort) ──────────────────────────────────────────────────────
  const emailed = await sendPendingEmails(emailJobs);

  // ── Marcar los umbrales disparados para no repetirlos ─────────────────────────
  for (const [assignmentId, patch] of flagUpdates) {
    const { error: updErr } = await supabase.from('assignments').update(patch).eq('id', assignmentId);
    if (updErr) console.error('[cron presentation-emails] Error al marcar recordatorios:', updErr);
  }

  return Response.json({ ok: true, pending: pending.length, inserted, emailed });
}

function markFlag(map: Map<string, FlagPatch>, id: string, patch: FlagPatch): void {
  map.set(id, { ...(map.get(id) ?? {}), ...patch });
}

/**
 * Envía los emails de recordatorio. Los profesores se cachean: un profe con varios
 * alumnos pendientes aparece en varios jobs y no hace falta releerlo cada vez. Un
 * email fallido nunca aborta el resto del cron.
 */
async function sendPendingEmails(jobs: EmailJob[]): Promise<number> {
  if (jobs.length === 0) return 0;
  const cache = new Map<string, TeacherLike | null>();
  let sent = 0;

  async function teacherOf(id: string): Promise<TeacherLike | null> {
    if (!cache.has(id)) cache.set(id, await fetchTeacher(id));
    return cache.get(id) ?? null;
  }

  for (const j of jobs) {
    try {
      let ok = false;
      if (j.kind === 'teacher_4h' || j.kind === 'teacher_12h' || j.kind === 'teacher_24h') {
        const teacher = await teacherOf(j.teacherId);
        if (!teacher) continue;
        ok = j.kind === 'teacher_4h'  ? await sendPresentationReminder4h(teacher, j.studentName)
           : j.kind === 'teacher_12h' ? await sendPresentationReminder12h(teacher, j.studentName)
           :                            await sendPresentationReminder24h(teacher, j.studentName);
      } else {
        ok = j.kind === 'admin_12h'
          ? await sendPresentationAdminAlert12h(j.teacherName, j.studentName)
          : await sendPresentationAdminAlert24h(j.teacherName, j.studentName);
      }
      if (ok) sent++;
    } catch (err) {
      console.error('[cron presentation-emails] Fallo al enviar email:', err);
    }
  }
  return sent;
}
