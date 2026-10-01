// "Enviar al profesor" de la pestaña Testimoniales del admin.
//
// Crea (o renueva, si es un reenvío) un aviso por profesor implicado en la
// pareja —cada uno el de SU grabación— en testimonial_recording_requests,
// inserta su aviso en la campanita y le manda el email. Va en el servidor porque
// la clave de Resend solo existe aquí.
//
// Auth del panel en el cliente, igual que el resto de /api/admin. Solo avisa de
// parejas en 'detectado' que la IA confirmó como mejora real, y nunca vuelve a
// pedir una grabación que el profesor ya marcó como subida.
//
// POST { candidateId }

import { supabase } from '@/lib/supabase';
import { fetchTeacher, sendTestimonialRecordingEmail } from '@/lib/emailNotifications';
import { requestsForPair, recordingItems, requestCopy, type PairForRequest, type RecordingSide } from '@/lib/testimonialRequests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

export interface NotifyResult {
  teacherId: string;
  outcome: 'enviado' | 'reenviado' | 'ya_subida' | 'error';
  emailSent?: boolean;
  error?: string;
}

const side = (c: Row, p: 'before' | 'after') => ({
  teacherId: c[`${p}_teacher_id`] ?? null, classNumber: c[`${p}_class_number`] ?? null,
  classDate: c[`${p}_class_date`] ?? null, excerptAt: c[`${p}_excerpt_at`] ?? null, fathomUrl: c[`${p}_fathom_url`] ?? null,
});

export async function POST(request: Request): Promise<Response> {
  let body: { candidateId?: string } = {};
  try { body = await request.json(); } catch { /* vacío */ }
  if (!body.candidateId) return Response.json({ error: 'Falta candidateId.' }, { status: 400 });

  const { data: c, error } = await supabase.from('testimonial_candidates').select('*').eq('id', body.candidateId).maybeSingle();
  if (error || !c) return Response.json({ error: 'No se encontró la pareja.' }, { status: 404 });
  if (c.status === 'descartado') return Response.json({ error: 'La pareja está descartada.' }, { status: 409 });
  if (c.ai_review_status !== 'ready' || c.ai_is_real !== true) {
    return Response.json({ error: 'La IA todavía no ha confirmado que la mejora sea real.' }, { status: 409 });
  }

  const pair: PairForRequest = { studentName: c.student_name, before: side(c, 'before'), after: side(c, 'after') };
  const studentName = c.student_name ?? 'tu alumno';
  const porProfe = requestsForPair(pair);
  if (porProfe.length === 0) return Response.json({ error: 'Ninguna de las dos clases tiene profesor asignado.' }, { status: 409 });

  const { data: previas, error: prevErr } = await supabase.from('testimonial_recording_requests')
    .select('id, teacher_id, uploaded_at, times_notified').eq('candidate_id', c.id);
  if (prevErr) {
    const sinTabla = prevErr.code === '42P01' || prevErr.code === 'PGRST205';
    return Response.json({ error: sinTabla ? 'Falta correr supabase-testimoniales-avisos.sql.' : prevErr.message }, { status: 500 });
  }

  const results: NotifyResult[] = [];
  for (const { teacherId, sides } of porProfe) {
    const prev = (previas ?? []).find((r: Row) => r.teacher_id === teacherId) as Row | undefined;
    if (prev?.uploaded_at) { results.push({ teacherId, outcome: 'ya_subida' }); continue; }
    try {
      results.push(await avisar({ candidateId: c.id, teacherId, sides, prev, pair, studentName }));
    } catch (err) {
      results.push({ teacherId, outcome: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return Response.json({ results });
}

async function avisar(a: {
  candidateId: string; teacherId: string; sides: RecordingSide[]; prev?: Row;
  pair: PairForRequest; studentName: string;
}): Promise<NotifyResult> {
  const items = recordingItems(a.pair, a.sides);
  // El profesor se carga ANTES: el aviso abre con su nombre ("Ignacio, sube la clase del…").
  const teacher = await fetchTeacher(a.teacherId).catch(() => null);
  const { title, body } = requestCopy(a.studentName, items, teacher?.name);
  const now = new Date().toISOString();

  // 1) Campanita. El tipo propio le da el icono 🎬 y lo distingue en el panel.
  const notificationId = `notif_tgrab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const { error: nErr } = await supabase.from('notifications').insert({
    id: notificationId, target_user: a.teacherId, target_role: null,
    title, body, type: 'testimonial_grabacion', read_by: [], created_at: now, created_by: 'admin',
  });
  if (nErr) throw new Error(`No se pudo crear el aviso: ${nErr.message}`);

  // 2) Email. Si falla, el aviso de la campanita ya está: se anota y se sigue.
  let emailSent = false;
  try {
    if (teacher) emailSent = await sendTestimonialRecordingEmail(teacher, { studentName: a.studentName, items });
  } catch (err) {
    console.error('[testimonial-notify] Email fallido:', err);
  }

  // 3) Registro: lo que ve el admin como "Notificación enviada al profesor".
  if (a.prev) {
    const { error } = await supabase.from('testimonial_recording_requests').update({
      notified_at: now, notification_id: notificationId, email_sent: emailSent, sides: a.sides,
      times_notified: Number(a.prev.times_notified ?? 1) + 1, updated_at: now,
    }).eq('id', a.prev.id);
    if (error) throw new Error(error.message);
    return { teacherId: a.teacherId, outcome: 'reenviado', emailSent };
  }
  const { error } = await supabase.from('testimonial_recording_requests').insert({
    id: `trr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    candidate_id: a.candidateId, teacher_id: a.teacherId, sides: a.sides,
    notified_at: now, notification_id: notificationId, email_sent: emailSent,
  });
  if (error) throw new Error(error.message);
  return { teacherId: a.teacherId, outcome: 'enviado', emailSent };
}
