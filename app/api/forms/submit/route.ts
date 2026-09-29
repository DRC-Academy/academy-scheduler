// Procesa las respuestas del formulario inicial del alumno.
// PÚBLICO: no requiere login, solo un token válido.
//
// Desde el 28/09/2026 responde en uno o dos segundos: guarda las respuestas,
// prepara la prueba de nivel y contesta. La ficha de la IA (~20 s) se genera
// DESPUÉS de responder, con `after()`, y el aviso al profe sale cuando está
// hecha. Antes el alumno esperaba esos 20 s en "Enviando…"; si en ese rato se le
// cortaba la conexión, sus respuestas quedaban guardadas pero él no se enteraba,
// y al reintentar recibía un error.
//
// Es IDEMPOTENTE: si el formulario ya estaba completado (doble envío, reintento
// tras un corte), no es un error: se devuelve la misma pantalla final.

import { after } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  formatResponsesForAI, firstUnansweredRequired, resolveFormVariant, questionsOf,
  type FormResponses,
} from '@/lib/formQuestions';
import { generateFicha } from '@/lib/analyzeForm';
import { fichaToColumns } from '@/lib/aiTypes';
import { fetchTeacher, sendFormCompletedEmail } from '@/lib/emailNotifications';
import { finalTestFor } from '@/lib/formFinalScreen';

// La ficha de la IA corre en `after()`, que vive dentro de este mismo límite.
// generateFicha tiene su propio timeout de 45 s, por debajo.
export const maxDuration = 60;

interface Body {
  token?: string;
  responses?: FormResponses;
}

const NO_DISPONIBLE = 'Este enlace ya no está disponible. Pide uno nuevo a tu profe.';

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

  // 1) Buscar el token.
  const { data: tk, error: tkErr } = await supabase
    .from('form_tokens')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (tkErr) {
    console.error('[submit] Error al leer el token:', tkErr);
    return Response.json({ error: 'Error del servidor. Inténtalo de nuevo.' }, { status: 500 });
  }
  if (!tk) {
    return Response.json({ error: 'Este link no es válido.' }, { status: 404 });
  }

  // Historial de un "Regenerar todo": este enlace ya no guarda nada. La página
  // lleva al formulario nuevo al abrirse; esto cubre una pestaña que se quedó
  // abierta desde antes.
  if (tk.superseded_at) {
    return Response.json({ error: 'Tienes un enlace nuevo para el formulario. Vuelve a abrir este enlace y te llevamos a él.', replaced: true }, { status: 410 });
  }

  // Ya completado (segundo envío, reintento tras un corte…): no es un error.
  // Las respuestas del primer envío son las que valen; no se vuelven a guardar.
  if (tk.status === 'completed') {
    return Response.json({ success: true, alreadyDone: true, test: await finalTestFor(tk, request) });
  }
  if (tk.status !== 'pending') {
    return Response.json({ error: NO_DISPONIBLE }, { status: 410 });
  }
  if (tk.expires_at && new Date(tk.expires_at).getTime() < Date.now()) {
    await supabase.from('form_tokens').update({ status: 'expired' }).eq('id', tk.id);
    return Response.json({ error: NO_DISPONIBLE }, { status: 410 });
  }

  // 2) Validación de obligatorias del lado servidor (defensa en profundidad).
  //    Va DESPUÉS de leer el token (hace falta su plan para saber qué formulario
  //    contestó) y ANTES de marcarlo completado, para que un envío inválido no
  //    queme el link del alumno.
  const variant = resolveFormVariant({ plan: tk.plan });
  const questions = questionsOf(variant);
  const missing = firstUnansweredRequired(responses, questions);
  if (missing) {
    return Response.json({ error: `Falta responder: ${missing.title}` }, { status: 400 });
  }

  const now = new Date().toISOString();

  // 3) Marcar el token como completado. El filtro por 'pending' + select dice si
  //    ESTE envío fue el que lo cerró: si llegan dos a la vez, solo uno guarda.
  const { data: closed, error: updErr } = await supabase
    .from('form_tokens')
    // `responses` también en el token: la ficha guarda solo las ÚLTIMAS, y tras
    // un "Regenerar todo" las anteriores tienen que seguir como historial.
    .update({ status: 'completed', completed_at: now, responses })
    .eq('id', tk.id)
    .eq('status', 'pending')
    .select('id');
  if (updErr) {
    console.error('[submit] Error al marcar el token completado:', updErr);
    return Response.json({ error: 'Error del servidor. Inténtalo de nuevo.' }, { status: 500 });
  }
  if (!closed || closed.length === 0) {
    // Otro envío simultáneo se adelantó: ese guarda, este solo muestra el final.
    return Response.json({ success: true, alreadyDone: true, test: await finalTestFor(tk, request) });
  }

  // 4) Guardar las respuestas YA, sin esperar a la IA. Son irreemplazables: si la
  //    ficha falla después, se regenera desde ellas ("🤖 Generar ficha").
  //    La ficha se guarda en COLUMNAS SEPARADAS (initial_diagnosis, …), que es
  //    como está definida la tabla.
  const baseRow = {
    student_name:      tk.student_name,   // la tabla puede tener student_name NOT NULL
    teacher_id:        tk.teacher_id || null,
    form_token_id:     tk.id,
    form_responses:    responses,
    form_completed_at: now,
  };
  const saveProfile = async (extra: Record<string, unknown>) => {
    const row = { ...baseRow, ...extra, updated_at: new Date().toISOString() };
    let err = (await supabase.from('student_profiles').upsert(
      { id: tk.student_id || `sp_${tk.id}`, student_id: tk.student_id || null, ...row },
      { onConflict: 'id' },
    )).error;
    // Si falla por la FK de student_id (el alumno no existe en 'students', p. ej.
    // un vínculo por nombre), guardamos la ficha SIN vincular para no perderla.
    if (err?.code === '23503') {
      err = (await supabase.from('student_profiles').upsert(
        { id: `sp_${tk.id}`, student_id: null, ...row },
        { onConflict: 'id' },
      )).error;
    }
    return err;
  };

  const profErr = await saveProfile({ ai_status: 'pending' });
  if (profErr) {
    // El token ya quedó completado. Registramos y seguimos: el alumno no debe
    // ver un error después de enviar sus respuestas. El paso de la IA vuelve a
    // intentar el guardado con la ficha completa.
    console.error('[submit] Error al guardar student_profiles:', profErr);
  }

  // 5) Después de responder: ficha de la IA y, cuando está hecha, aviso al profe.
  after(async () => {
    const ficha = await generateFicha({
      studentName: tk.student_name,
      teacherName: tk.teacher_name,
      plan: tk.plan,
      level: tk.level,
      responsesText: formatResponsesForAI(responses, questions),
    });
    if (ficha.status !== 'ready') {
      console.error(`[submit] Ficha de ${tk.student_name} sin generar (${ficha.status}); se puede regenerar desde la ficha del alumno.`);
    }
    const fichaErr = await saveProfile({
      ai_status: ficha.status,
      ...(ficha.data ? fichaToColumns(ficha.data) : {}),
    });
    if (fichaErr) console.error('[submit] Error al guardar la ficha de la IA:', fichaErr);

    // El aviso sale haya ido bien la IA o no: el formulario está hecho.
    if (tk.teacher_id) {
      const { error: notifErr } = await supabase.from('notifications').insert({
        id:          `notif_form_${Date.now()}`,
        target_user: tk.teacher_id,
        target_role: null,
        title:       `✅ ${tk.student_name} completó el formulario`,
        body:        'La ficha inicial y la primera clase ya están listas para revisar en la ficha del alumno.',
        type:        'form_completed',
        read_by:     [],
        created_at:  new Date().toISOString(),
        created_by:  'formulario',
      });
      if (notifErr) console.error('[submit] Error al crear la notificación:', notifErr);

      // Aviso por email al profesor. Best-effort.
      const teacher = await fetchTeacher(tk.teacher_id);
      if (teacher) await sendFormCompletedEmail(teacher, tk.student_name);
    }
  });

  // 6) La prueba de nivel para la pantalla final (la vigente, o una nueva).
  return Response.json({ success: true, test: await finalTestFor(tk, request) });
}
