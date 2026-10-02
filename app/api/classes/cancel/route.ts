// Cancelación de una clase por el profesor (Bloque 4.4) — flujo de SIEMPRE, el de
// los profesores que no están en la beta de "No puedo dar esta clase". SOLO
// efectos externos:
//  · Email al ALUMNO avisando del cambio (Resend, servidor).
//  · Notificación in-app al admin con el motivo y las horas de antelación.
// El class_record y la penalización (si aplica) se registran en el cliente vía
// registerClassRecord (que ya dispara los efectos de falta del Bloque 4).
//
// PROTECCIÓN (oct/2026). Antes esta ruta mandaba un email a cualquier dirección
// que le pasaran, sin comprobar nada. Ahora solo actúa si existe de verdad una
// cancelación de ESE profesor y ESE alumno para ESA fecha, creada hace menos de
// 15 minutos, y una sola vez por cancelación: el aviso al admin lleva un id fijo
// (notif_cancel_<constancia>) y si ya existía, no se repite nada.

import { supabase } from '@/lib/supabase';
import { sendClassCancelledEmail } from '@/lib/emailNotifications';
import { nkName } from '@/lib/sessions';

interface Body {
  studentEmail?: string;
  studentName?: string;
  teacherName?: string;
  teacherId?: string;
  /** 'YYYY-MM-DD' de la clase cancelada: con esto se busca la constancia. */
  classDate?: string;
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

  const teacherId = body.teacherId?.trim();
  const studentName = body.studentName?.trim() || '';
  const classDate = body.classDate?.trim() || '';
  if (!teacherId || !studentName || !/^\d{4}-\d{2}-\d{2}$/.test(classDate)) {
    return Response.json({ error: 'datos_invalidos' }, { status: 400 });
  }

  // La cancelación tiene que existir y ser reciente.
  const hace15 = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: recs } = await supabase.from('class_records')
    .select('id, student_name, class_type, created_at')
    .eq('teacher_id', teacherId).eq('class_date', classDate)
    .in('class_type', ['cancelada_por_profesor', 'cancelada_con_preaviso'])
    .gte('created_at', hace15);
  const record = (recs ?? []).find(r => nkName(r.student_name) === nkName(studentName));
  if (!record) return Response.json({ error: 'sin_cancelacion' }, { status: 409 });

  const dateLabel = body.dateLabel?.trim() || classDate;
  const timeLabel = body.timeLabel?.trim() || '';

  // 1) Aviso al admin con id fijo: si ya existía, esta cancelación ya se procesó.
  const incidencia = record.class_type === 'cancelada_por_profesor';
  const horas = Number.isFinite(body.hoursNotice) ? Math.round(body.hoursNotice as number) : null;
  const { error: nErr } = await supabase.from('notifications').insert({
    id:          `notif_cancel_${record.id}`,
    target_user: null, target_role: 'admin',
    title:       `${incidencia ? '🔴 Incidencia — ' : ''}Clase cancelada · ${body.teacherName?.trim() || 'Profesor'}`,
    body:        `${studentName} · ${dateLabel} ${timeLabel}` +
                 `${horas != null ? ` · ${horas}h de antelación` : ''}` +
                 `${incidencia ? ' (sin preaviso, registrada como falta)' : ' (con preaviso)'}.` +
                 `${body.reason?.trim() ? `\nMotivo: ${body.reason.trim()}` : ''}`,
    type:        incidencia ? 'clase_cancelada_incidencia' : 'clase_cancelada_preaviso',
    read_by:     [], created_at: new Date().toISOString(), created_by: 'sistema',
  });
  if (nErr?.code === '23505') return Response.json({ ok: true, emailSent: false, duplicado: true });

  // 2) Email al alumno (best-effort).
  let emailSent = false;
  if (body.studentEmail?.trim()) {
    emailSent = await sendClassCancelledEmail({
      studentEmail: body.studentEmail.trim(),
      studentName,
      teacherName: body.teacherName?.trim() || 'tu profesor/a',
      dateLabel, timeLabel,
    });
  }

  return Response.json({ ok: true, emailSent });
}
