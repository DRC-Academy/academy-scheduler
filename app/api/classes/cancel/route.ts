// Cancelación de una clase por el profesor (Bloque 4.4). SOLO efectos externos:
//  · Email al ALUMNO avisando del cambio (Resend, servidor).
//  · Notificación in-app al admin con el motivo y las horas de antelación.
// El class_record y la penalización (si aplica) se registran en el cliente vía
// registerClassRecord (que ya dispara los efectos de falta del Bloque 4).

import { supabase } from '@/lib/supabase';
import { sendClassCancelledEmail } from '@/lib/emailNotifications';

interface Body {
  studentEmail?: string;
  studentName?: string;
  teacherName?: string;
  teacherId?: string;
  dateLabel?: string;
  timeLabel?: string;
  hoursNotice?: number;
  reason?: string;
  withNotice?: boolean;   // true = >24h (preaviso), false = <24h (falta)
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'JSON inválido' }, { status: 400 }); }

  const studentName = body.studentName?.trim() || 'el alumno';
  const dateLabel = body.dateLabel?.trim() || '';
  const timeLabel = body.timeLabel?.trim() || '';

  // 1) Email al alumno (best-effort).
  let emailSent = false;
  if (body.studentEmail?.trim()) {
    emailSent = await sendClassCancelledEmail({
      studentEmail: body.studentEmail.trim(),
      studentName,
      teacherName: body.teacherName?.trim() || 'tu profesor/a',
      dateLabel, timeLabel,
    });
  }

  // 2) Notificación in-app al admin (incidencia si fue sin preaviso <24h).
  const incidencia = body.withNotice === false;
  const horas = Number.isFinite(body.hoursNotice) ? Math.round(body.hoursNotice as number) : null;
  await supabase.from('notifications').insert({
    id:          `notif_cancel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    target_user: null, target_role: 'admin',
    title:       `${incidencia ? '🔴 Incidencia — ' : ''}Clase cancelada · ${body.teacherName?.trim() || 'Profesor'}`,
    body:        `${studentName} · ${dateLabel} ${timeLabel}` +
                 `${horas != null ? ` · ${horas}h de antelación` : ''}` +
                 `${incidencia ? ' (sin preaviso, registrada como falta)' : ' (con preaviso)'}.` +
                 `${body.reason?.trim() ? `\nMotivo: ${body.reason.trim()}` : ''}`,
    type:        incidencia ? 'clase_cancelada_incidencia' : 'clase_cancelada_preaviso',
    read_by:     [], created_at: new Date().toISOString(), created_by: 'sistema',
  });

  return Response.json({ ok: true, emailSent });
}
