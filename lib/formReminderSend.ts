// Envío de UN follow-up de la prueba de nivel (formulario + prueba) a un
// alumno. SOLO SERVIDOR.
//
// Lo comparten los dos sitios desde los que sale un correo:
//   · el cron diario (app/api/cron/followups-nivel), que decide a quién le toca
//     por la cadencia de lib/formReminders;
//   · el botón "Recordar" del panel admin (app/api/forms/remind), que lo manda a
//     mano fuera de esa cadencia.
// Los dos hacen exactamente lo mismo una vez decidido el alumno y el número de
// envío: reservar la fila → resolver el enlace → enviar → completar la fila →
// espejos → renovar la vigencia del enlace. Si cambia una de esas piezas,
// cambia aquí.
//
// ANTI-DUPLICADO — "reservar y luego enviar". Antes de escribir un correo se
// INSERTA la fila en level_test_followups con status 'reservado'. El índice
// único (student_id, numero_envio) hace que, si dos corridas (o dos clics) se
// solapan, solo una consiga insertar y la otra se salte al alumno. Si el envío
// falla, la fila se borra para que se reintente. Es el mismo patrón que el
// recordatorio diario de transcripts (daily_reminder_log).
//
// EL CLIENTE. El cron pasa el cliente ADMIN de Supabase (service role); el
// botón del panel usa el cliente anon, como el resto del panel. Por eso el
// cliente entra por parámetro.

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as anonClient } from '@/lib/supabase';
import { getOrCreateTestSession } from '@/lib/levelTest/createSession';
import { etapaDe, diaRelativoDe, type PendingEntry } from '@/lib/formReminders';
import { sendFollowupEmail } from '@/lib/studentFollowupEmails';

/** Espera entre envíos: Resend corta a 2 req/s. */
export const PAUSA_MS = 600;

/** Días de vida que le quedan al enlace por debajo de los cuales se renueva. */
const RENOVAR_SI_QUEDAN_MENOS_DE = 14;
const NUEVA_VIGENCIA_DIAS = 30;

export type MotivoFallo = 'reserva' | 'ya_tomado' | 'sin enlace' | 'envío';

export type ResultadoEnvio = { ok: true; resendId: string | null } | { ok: false; motivo: MotivoFallo };

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Manda el envío número `step` al alumno de la entrada. `step` puede pasar del
 * tope de 13 cuando el envío es manual: el cron nunca lo hace, el equipo sí.
 */
export async function enviarRecordatorio(
  e: PendingEntry, step: number, base: string, now: number,
  client: SupabaseClient = anonClient,
): Promise<ResultadoEnvio> {
  const ahoraIso = new Date(now).toISOString();

  // 1) Reservar la fila. Con el índice único, el segundo que llegue falla con
  //    23505 y se salta al alumno: nunca dos correos del mismo número.
  const { data: reservado, error: resErr } = await client
    .from('level_test_followups')
    .insert({
      student_id:   e.student.id,
      token_id:     e.token.id,
      email:        e.email,
      email_alt:    e.emailAlt,
      numero_envio: step,
      dia_relativo: diaRelativoDe(step),
      etapa:        etapaDe(step),
      sent_at:      ahoraIso,
      status:       'reservado',
    })
    .select('id')
    .single();

  if (resErr) {
    if (resErr.code === '23505') return { ok: false, motivo: 'ya_tomado' };
    if (resErr.code === '42P01') {
      console.error('[followups-nivel] Falta la tabla level_test_followups: corré supabase-plazo-24h-followups.sql.');
    } else {
      console.error('[followups-nivel] Error al reservar el envío:', resErr);
    }
    return { ok: false, motivo: 'reserva' };
  }
  const filaId = reservado?.id as string | undefined;

  // 2) El enlace. Para el test puede haber que crear una sesión nueva (la
  //    anterior caduca a los 7 días y muchas ya están vencidas).
  let enlace: string | null = null;
  if (e.sequence === 'formulario') {
    enlace = `${base}/formulario/${e.token.token}`;
  } else {
    try {
      const { token: testToken, error: sesErr } = await getOrCreateTestSession({
        studentId:    e.token.student_id || undefined,
        studentName:  e.token.student_name,
        studentEmail: e.email,
        candidateEmail: e.email,
        teacherId:    e.token.teacher_id || undefined,
        teacherName:  e.token.teacher_name || undefined,
        assignmentId: e.token.assignment_id || undefined,
        plan:         e.token.plan || undefined,
        level:        e.token.level || undefined,
      });
      if (testToken) enlace = `${base}/test/${testToken}`;
      else console.error('[followups-nivel] No se pudo preparar el test:', sesErr);
    } catch (err) {
      console.error('[followups-nivel] Excepción al preparar el test:', err);
    }
  }

  if (!enlace) {
    await liberar(client, filaId);
    return { ok: false, motivo: 'sin enlace' };
  }

  // 3) Enviar.
  const envio = await sendFollowupEmail(
    e.sequence, step,
    { studentName: e.token.student_name || e.student.name, teacherName: e.token.teacher_name, url: enlace },
    e.email,
    e.variant,
  );
  if (!envio.ok) {
    await liberar(client, filaId);
    return { ok: false, motivo: 'envío' };
  }

  // 4) Completar la fila con el id de Resend.
  if (filaId) {
    const { error } = await client
      .from('level_test_followups')
      .update({ status: 'sent', resend_id: envio.id ?? null, sent_at: ahoraIso })
      .eq('id', filaId);
    if (error) console.error('[followups-nivel] Error al completar el registro del envío:', error);
  }

  // 5) Espejos: students (lo pintan otras vistas) y el contador del token
  //    (compatibilidad con lo que había). Best-effort los dos.
  const col = e.sequence === 'formulario' ? 'form_reminder' : 'test_reminder';
  const [esp, tok] = await Promise.all([
    client.from('students').update({
      form_reminder_count:     step,
      form_reminder_last_sent: ahoraIso,
      form_reminder_stage:     e.sequence,
    }).eq('id', e.student.id),
    client.from('form_tokens').update({
      [`${col}_count`]: step, [`${col}_last_sent`]: ahoraIso,
    }).eq('id', e.token.id),
  ]);
  if (esp.error) console.error('[followups-nivel] Error al actualizar el espejo en students:', esp.error);
  if (tok.error) console.error('[followups-nivel] Error al actualizar el espejo en form_tokens:', tok.error);

  // 6) Que el enlace siga vivo hasta el final de la secuencia. Los tokens
  //    caducan a los 30 días y la serie dura 65: sin esto se mandaría un enlace
  //    muerto a partir de la quinta semana. Solo se renueva el de quien está
  //    recibiendo correo.
  await renovarVigencia(client, e, now);

  return { ok: true, resendId: envio.id ?? null };
}

/** Borra la reserva cuando el correo no llegó a salir. */
async function liberar(client: SupabaseClient, filaId: string | undefined): Promise<void> {
  if (!filaId) return;
  const { error } = await client.from('level_test_followups').delete().eq('id', filaId);
  if (error) console.error('[followups-nivel] Error al liberar la reserva:', error);
}

async function renovarVigencia(client: SupabaseClient, e: PendingEntry, now: number): Promise<void> {
  const vence = e.token.expires_at ? new Date(e.token.expires_at).getTime() : 0;
  const quedan = (vence - now) / 86_400_000;
  if (vence && quedan >= RENOVAR_SI_QUEDAN_MENOS_DE) return;

  const nuevo = new Date(now + NUEVA_VIGENCIA_DIAS * 86_400_000).toISOString();
  const { error } = await client.from('form_tokens').update({ expires_at: nuevo }).eq('id', e.token.id);
  if (error) console.error('[followups-nivel] Error al renovar la vigencia del enlace:', error);
}
