// Disparador de emails desde el cliente.
//
// Existe porque RESEND_API_KEY es server-only: el panel de admin, el conteo de
// clases y la asignación de alumnos corren en el navegador y no pueden llamar a
// Resend directamente. Los flujos que ya son server-side (/api/forms/submit, el
// cron) importan lib/emailNotifications sin pasar por aquí.
//
// Siempre responde 200: un email es best-effort y quien llama no debe romperse
// porque falle. El resultado va en el cuerpo (`sent`).

import { supabase } from '@/lib/supabase';
import {
  fetchTeacher, normalizePrefs, sendNewStudentEmail, sendMilestoneEmail, sendCircularEmail,
  sendBonusAvailableEmail, type MilestoneNumber, type TeacherLike,
} from '@/lib/emailNotifications';

interface Body {
  type?: 'new_student' | 'milestone' | 'circular' | 'bonus';
  teacherId?: string;
  /** Circular a todo el equipo: el fan-out se hace aquí, no en el navegador. */
  allTeachers?: boolean;
  studentName?: string;
  // new_student
  studentEmail?: string | null;
  plan?: string | null;
  level?: string | null;
  slots?: Array<{ day: string; hour: string }> | null;
  startDate?: string | null;
  // milestone
  milestone?: number;
  // circular
  title?: string;
  body?: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ sent: false, error: 'JSON inválido' }, { status: 400 });
  }

  if (!body.type) {
    return Response.json({ sent: false, error: 'Falta el tipo.' }, { status: 400 });
  }

  // Circular a todo el equipo.
  if (body.type === 'circular' && body.allTeachers) {
    if (!body.title || !body.body) {
      return Response.json({ sent: false, error: 'Faltan title y body.' }, { status: 400 });
    }
    const count = await sendCircularToAll({ title: body.title, body: body.body });
    return Response.json({ sent: count > 0, count });
  }

  if (!body.teacherId) {
    return Response.json({ sent: false, error: 'Falta teacherId.' }, { status: 400 });
  }

  const teacher = await fetchTeacher(body.teacherId);
  if (!teacher) {
    console.error(`[api/emails] Profesor no encontrado: ${body.teacherId}`);
    return Response.json({ sent: false, error: 'Profesor no encontrado.' });
  }

  let sent = false;
  try {
    switch (body.type) {
      case 'new_student':
        if (!body.studentName) break;
        sent = await sendNewStudentEmail(teacher, {
          studentName: body.studentName,
          studentEmail: body.studentEmail,
          plan: body.plan,
          level: body.level,
          slots: body.slots,
          startDate: body.startDate,
        });
        break;

      case 'milestone': {
        const m = body.milestone;
        if (!body.studentName || (m !== 15 && m !== 30 && m !== 50)) break;
        sent = await sendMilestoneEmail(teacher, body.studentName, m as MilestoneNumber);
        break;
      }

      case 'bonus':
        if (!body.studentName) break;
        sent = await sendBonusAvailableEmail(teacher, body.studentName);
        break;

      case 'circular':
        if (!body.title || !body.body) break;
        sent = await sendCircularEmail(teacher, { title: body.title, body: body.body });
        break;
    }
  } catch (err) {
    console.error('[api/emails] Fallo inesperado:', err);
  }

  return Response.json({ sent });
}

/** Envía la circular a todos los profesores. Devuelve cuántos salieron. */
async function sendCircularToAll(notification: { title: string; body: string }): Promise<number> {
  const { data, error } = await supabase
    .from('teachers')
    .select('id, name, email, notification_email, email_preferences');

  if (error || !data) {
    console.error('[api/emails] No se pudieron leer los profesores:', error);
    return 0;
  }

  const teachers: TeacherLike[] = data.map(t => ({
    id: t.id, name: t.name, email: t.email,
    notificationEmail: t.notification_email,
    emailPreferences: normalizePrefs(t.email_preferences),
  }));

  // En tandas: 30 envíos a la vez pueden chocar con el rate limit de Resend, y
  // secuencial tardaría demasiado para una request.
  const CHUNK = 5;
  let sent = 0;
  for (let i = 0; i < teachers.length; i += CHUNK) {
    const results = await Promise.all(
      teachers.slice(i, i + CHUNK).map(t =>
        sendCircularEmail(t, notification).catch(err => {
          console.error(`[api/emails] Circular fallida para ${t.name}:`, err);
          return false;
        }),
      ),
    );
    sent += results.filter(Boolean).length;
  }
  return sent;
}
