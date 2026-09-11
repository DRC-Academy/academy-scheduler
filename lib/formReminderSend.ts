// Envío de UN recordatorio de follow-up (formulario o prueba de nivel) a un
// alumno. SOLO SERVIDOR.
//
// Lo comparten los dos sitios desde los que sale un recordatorio:
//   · el cron diario (app/api/cron/form-reminders), que decide a quién le toca
//     por la cadencia de lib/formReminders;
//   · el botón "Recordar" del panel admin (app/api/forms/remind), que lo manda a
//     mano fuera de esa cadencia.
// Los dos hacen exactamente lo mismo una vez decidido el alumno y el paso:
// reservar el contador → resolver el enlace → enviar → espejo en students →
// renovar la vigencia del enlace. Si cambia una de esas piezas, cambia aquí.
//
// ANTI-DUPLICADO — "reservar y luego enviar", como el cron de transcripts. Antes
// de escribir un correo se incrementa el contador del token con un UPDATE
// condicionado al valor anterior (.eq(count, e.count)). Ese update es atómico:
// si dos corridas (o dos clics) se solapan, solo una encuentra el valor esperado
// y la otra se salta al alumno. Si el envío falla, el contador se devuelve a su
// sitio para que se reintente.

import { supabase } from '@/lib/supabase';
import { getOrCreateTestSession } from '@/lib/levelTest/createSession';
import type { PendingEntry } from '@/lib/formReminders';
import { sendFollowupEmail } from '@/lib/studentFollowupEmails';

/** Espera entre envíos: Resend corta a 2 req/s. */
export const PAUSA_MS = 600;

/** Días de vida que le quedan al enlace por debajo de los cuales se renueva. */
const RENOVAR_SI_QUEDAN_MENOS_DE = 14;
const NUEVA_VIGENCIA_DIAS = 30;

export type MotivoFallo = 'reserva' | 'ya_tomado' | 'sin enlace' | 'envío';

export type ResultadoEnvio = { ok: true } | { ok: false; motivo: MotivoFallo };

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Manda el recordatorio `step` al alumno de la entrada. `step` puede repetir el
 * último (3º) cuando el envío es manual y ya se agotaron: el contador se queda
 * en 3 y solo se mueve la fecha del último envío.
 */
export async function enviarRecordatorio(e: PendingEntry, step: 1 | 2 | 3, base: string, now: number): Promise<ResultadoEnvio> {
  const col = e.sequence === 'formulario' ? 'form_reminder' : 'test_reminder';
  const ahoraIso = new Date(now).toISOString();

  // 1) Reservar el paso. Condicionado al contador que leímos: si otra corrida se
  //    adelantó, este update no toca ninguna fila y nos saltamos al alumno.
  const { data: reservado, error: resErr } = await supabase
    .from('form_tokens')
    .update({ [`${col}_count`]: step, [`${col}_last_sent`]: ahoraIso })
    .eq('id', e.token.id)
    .eq(`${col}_count`, e.count)
    .select('id');

  if (resErr) {
    console.error('[form-reminders] Error al reservar el recordatorio:', resErr);
    return { ok: false, motivo: 'reserva' };
  }
  if (!reservado || reservado.length === 0) return { ok: false, motivo: 'ya_tomado' };

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
      else console.error('[form-reminders] No se pudo preparar el test:', sesErr);
    } catch (err) {
      console.error('[form-reminders] Excepción al preparar el test:', err);
    }
  }

  if (!enlace) {
    await revertir(e, col);
    return { ok: false, motivo: 'sin enlace' };
  }

  // 3) Enviar.
  const ok = await sendFollowupEmail(
    e.sequence, step,
    { studentName: e.token.student_name || e.student.name, teacherName: e.token.teacher_name, url: enlace },
    e.email,
    e.variant,
  );
  if (!ok) {
    await revertir(e, col);
    return { ok: false, motivo: 'envío' };
  }

  // 4) Espejo en students (form_reminder_*), que leen otras vistas.
  const { error: espErr } = await supabase
    .from('students')
    .update({
      form_reminder_count:     step,
      form_reminder_last_sent: ahoraIso,
      form_reminder_stage:     e.sequence,
    })
    .eq('id', e.student.id);
  if (espErr) console.error('[form-reminders] Error al actualizar el espejo en students:', espErr);

  // 5) Que el enlace siga vivo hasta el final de la secuencia. Los tokens
  //    caducan a los 30 días y hay alumnos a los que empezamos a perseguir en
  //    el día 25: sin esto les mandaríamos un enlace que muere antes del
  //    último recordatorio. Solo se renueva el de quien está recibiendo correo.
  if (e.sequence === 'formulario') await renovarVigencia(e, now);

  return { ok: true };
}

/** Devuelve el contador a su sitio cuando el correo no llegó a salir. */
async function revertir(e: PendingEntry, col: string): Promise<void> {
  const { error } = await supabase
    .from('form_tokens')
    .update({ [`${col}_count`]: e.count, [`${col}_last_sent`]: e.lastSent })
    .eq('id', e.token.id);
  if (error) console.error('[form-reminders] Error al revertir la reserva:', error);
}

async function renovarVigencia(e: PendingEntry, now: number): Promise<void> {
  const vence = e.token.expires_at ? new Date(e.token.expires_at).getTime() : 0;
  const quedan = (vence - now) / 86_400_000;
  if (vence && quedan >= RENOVAR_SI_QUEDAN_MENOS_DE) return;

  const nuevo = new Date(now + NUEVA_VIGENCIA_DIAS * 86_400_000).toISOString();
  const { error } = await supabase.from('form_tokens').update({ expires_at: nuevo }).eq('id', e.token.id);
  if (error) console.error('[form-reminders] Error al renovar la vigencia del enlace:', error);
}
