// Procesa las respuestas del formulario inicial del alumno.
// PÚBLICO: no requiere login, solo un token válido en estado 'pending'.

import { supabase } from '@/lib/supabase';
import { formatResponsesForAI, firstUnansweredRequired, type FormResponses } from '@/lib/formQuestions';
import { generateFicha } from '@/lib/analyzeForm';

interface Body {
  token?: string;
  responses?: FormResponses;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const token = body.token?.trim();
  const responses = body.responses;
  if (!token || !responses || typeof responses !== 'object') {
    return Response.json({ error: 'Faltan datos (token, responses).' }, { status: 400 });
  }

  // Validación de obligatorias del lado servidor (defensa en profundidad).
  const missing = firstUnansweredRequired(responses);
  if (missing) {
    return Response.json({ error: `Falta responder: ${missing.title}` }, { status: 400 });
  }

  // 1) Buscar el token y validar que esté disponible.
  const { data: tk, error: tkErr } = await supabase
    .from('form_tokens')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (tkErr) {
    console.error('[submit] Error al leer el token:', tkErr);
    return Response.json({ error: 'Error del servidor. Intentá de nuevo.' }, { status: 500 });
  }
  if (!tk) {
    return Response.json({ error: 'Este link no es válido.' }, { status: 404 });
  }
  if (tk.status !== 'pending') {
    return Response.json({ error: 'Este formulario ya fue completado o expiró.' }, { status: 409 });
  }
  if (tk.expires_at && new Date(tk.expires_at).getTime() < Date.now()) {
    await supabase.from('form_tokens').update({ status: 'expired' }).eq('id', tk.id);
    return Response.json({ error: 'Este link ya expiró.' }, { status: 410 });
  }

  const now = new Date().toISOString();

  // 2) Marcar el token como completado.
  const { error: updErr } = await supabase
    .from('form_tokens')
    .update({ status: 'completed', completed_at: now })
    .eq('id', tk.id)
    .eq('status', 'pending');   // evita doble envío concurrente
  if (updErr) {
    console.error('[submit] Error al marcar el token completado:', updErr);
    return Response.json({ error: 'Error del servidor. Intentá de nuevo.' }, { status: 500 });
  }

  // 3) Formatear respuestas + generar la ficha con IA (best-effort).
  const responsesText = formatResponsesForAI(responses);
  const ficha = await generateFicha({
    studentName: tk.student_name,
    teacherName: tk.teacher_name,
    plan: tk.plan,
    level: tk.level,
    responsesText,
  });

  // 4) Crear/actualizar la ficha del alumno.
  const baseRow = {
    student_name:   tk.student_name,   // la tabla puede tener student_name NOT NULL
    form_token_id:  tk.id,
    form_responses: responses,
    ai_ficha:       ficha.ficha,
    ai_status:      ficha.status,
    updated_at:     now,
  };
  let profErr = (await supabase.from('student_profiles').upsert(
    { id: tk.student_id || `sp_${tk.id}`, student_id: tk.student_id || null, ...baseRow },
    { onConflict: 'id' },
  )).error;

  // Si falla por la FK de student_id (el alumno no existe en 'students', p. ej.
  // un vínculo por nombre), guardamos la ficha SIN vincular para no perderla.
  if (profErr?.code === '23503') {
    profErr = (await supabase.from('student_profiles').upsert(
      { id: `sp_${tk.id}`, student_id: null, ...baseRow },
      { onConflict: 'id' },
    )).error;
  }
  if (profErr) {
    // La ficha no se pudo guardar, pero el token ya quedó completado. Registramos
    // y seguimos: el alumno no debe ver un error después de enviar sus respuestas.
    console.error('[submit] Error al guardar student_profiles:', profErr);
  }

  // 5) Notificar al profesor.
  if (tk.teacher_id) {
    const { error: notifErr } = await supabase.from('notifications').insert({
      id:          `notif_form_${Date.now()}`,
      target_user: tk.teacher_id,
      target_role: null,
      title:       `✅ ${tk.student_name} completó el formulario`,
      body:        'La ficha inicial y la primera clase ya están listas para revisar en la ficha del alumno.',
      type:        'form_completed',
      read_by:     [],
      created_at:  now,
      created_by:  'formulario',
    });
    if (notifErr) console.error('[submit] Error al crear la notificación:', notifErr);
  }

  return Response.json({ success: true });
}
