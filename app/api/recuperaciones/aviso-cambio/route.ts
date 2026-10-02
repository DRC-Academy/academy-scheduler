// "El alumno pidió cambiarla" — email de CONTROL al alumno: hoy los cambios que
// registra el profesor no le llegan, y si no los pidió él, tiene que poder
// decirlo. Solo profesores beta.
//
// Protección: solo envía si existe la constancia del cambio de ese profesor y
// alumno para esa fecha, creada hace menos de 15 minutos; y Resend no repite el
// mismo envío (clave de idempotencia por constancia).
//
// POST { teacherId, assignmentId, originalDate, originalHour, newDates: [{date, hour}] }

import { supabase } from '@/lib/supabase';
import { isRecoveryBetaTeacher, normalizeHour } from '@/lib/classRecoveries';
import { buildRescheduleControlEmail, sendStudentEmail } from '@/lib/classRecoveryEmails';
import { normEmail } from '@/lib/email';
import { nkName } from '@/lib/sessions';
import { readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  teacherId?: string; assignmentId?: string; originalDate?: string; originalHour?: string;
  newDates?: Array<{ date: string; hour: string }>;
}

export async function POST(request: Request): Promise<Response> {
  const b = await readJson<Body>(request);
  if (!b?.teacherId || !b.assignmentId || !b.originalDate || !b.newDates?.length) {
    return Response.json({ error: 'datos_invalidos' }, { status: 400 });
  }
  if (!isRecoveryBetaTeacher(b.teacherId)) return Response.json({ error: 'no_beta' }, { status: 403 });

  const { data: a } = await supabase.from('assignments')
    .select('id, teacher_id, student_id, student_name, student_email').eq('id', b.assignmentId).maybeSingle();
  if (!a || a.teacher_id !== b.teacherId) return Response.json({ error: 'no_encontrada' }, { status: 404 });

  const hace15 = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: recs } = await supabase.from('class_records')
    .select('id, student_name, created_at').eq('teacher_id', b.teacherId).eq('class_date', b.originalDate)
    .eq('class_type', 'reprogramada').gte('created_at', hace15);
  const rec = (recs ?? []).find(r => nkName(r.student_name) === nkName(a.student_name));
  if (!rec) return Response.json({ error: 'sin_constancia' }, { status: 409 });

  const [{ data: s }, { data: t }] = await Promise.all([
    a.student_id ? supabase.from('students').select('email').eq('id', a.student_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from('teachers').select('name').eq('id', b.teacherId).maybeSingle(),
  ]);
  const to = normEmail((s as { email?: string } | null)?.email) || normEmail(a.student_email);
  if (!to) return Response.json({ sent: false, reason: 'sin_email' });
  const otro = normEmail(a.student_email);
  const cc = otro && otro !== to ? otro : null;

  const { subject, html } = buildRescheduleControlEmail({
    studentName: a.student_name, teacherName: (t as { name?: string } | null)?.name ?? 'Tu profesor',
    originalDate: b.originalDate, originalHour: normalizeHour(b.originalHour) ?? b.originalHour ?? '',
    newDates: b.newDates.map(d => ({ date: d.date, hour: normalizeHour(d.hour) ?? d.hour })),
  });
  const sent = await sendStudentEmail('cambio_pedido_por_alumno', to, subject, html, cc, `cambio_alumno_${rec.id}`);
  return Response.json({ sent });
}
