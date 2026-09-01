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
  sendCircularBatch, sendBonusAvailableEmail, type MilestoneNumber, type TeacherLike,
} from '@/lib/emailNotifications';

interface Body {
  type?: 'new_student' | 'milestone' | 'circular' | 'bonus';
  teacherId?: string;
  /** Circular a todo el equipo: el fan-out se hace aquí, no en el navegador. */
  allTeachers?: boolean;
  /** Con `allTeachers`: ids que NO reciben la circular ("todos excepto"). */
  excludeTeacherIds?: string[];
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
    const count = await sendCircularToAll(
      { title: body.title, body: body.body },
      body.excludeTeacherIds ?? [],
    );
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

/**
 * Envía la circular a todos los profesores. Devuelve cuántos salieron.
 *
 * Usa resend.batch.send(): UNA petición con todos los correos. La versión
 * anterior mandaba tandas de 5 en paralelo y Resend limita a 2 peticiones por
 * segundo, así que las que excedían el límite volvían con `rate_limit_exceeded`
 * y esos profesores no recibían nada. El batch no tiene ese problema y además
 * es una sola llamada (cabe de sobra: el límite del batch son 100 emails).
 */
async function sendCircularToAll(
  notification: { title: string; body: string },
  excludeTeacherIds: string[] = [],
): Promise<number> {
  // `select('*')` y no la lista de columnas: hace falta leer `archived_at` para
  // descartar a los profesores dados de baja, y nombrarla explícitamente haría
  // fallar la consulta entera (42703) mientras la migración no esté corrida —
  // dejando sin circular a TODA la plantilla. Con `*` la columna ausente llega
  // como undefined y no descarta a nadie.
  const { data, error } = await supabase.from('teachers').select('*');

  if (error || !data) {
    console.error('[api/emails] No se pudieron leer los profesores:', error);
    return 0;
  }

  // El descarte se hace AQUÍ, con la lista real de la base, y no en el navegador:
  // el aviso in-app y el correo tienen que salir con la misma lista o un profesor
  // excluido recibiría el email de algo que no ve en la plataforma.
  const excluidos = new Set(excludeTeacherIds);
  // Los dados de baja no reciben circulares: ya no están en la academia.
  const destinatarios = data.filter(t => !excluidos.has(t.id) && !t.archived_at);
  if (excluidos.size > 0) {
    console.log(`[api/emails] Circular con exclusiones: ${destinatarios.length} de ${data.length} profesores.`);
  }

  const teachers: TeacherLike[] = destinatarios.map(t => ({
    id: t.id, name: t.name, email: t.email,
    notificationEmail: t.notification_email,
    emailPreferences: normalizePrefs(t.email_preferences),
  }));

  return sendCircularBatch(teachers, notification);
}
