// Cambio de horario desde el SERVIDOR (service key). SOLO SERVIDOR.
//
// Mismo núcleo (lib/cambioHorario/core.ts) con los correos mandados directamente
// con Resend. Lo usan las rutas /api/lms/autoservicio/*. Fuera de Next (scripts)
// hay que arrancar node con --conditions=react-server.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { resend } from '@/lib/resend';
import { esc, sendStudentScheduleChangedEmail } from '@/lib/emailNotifications';
import { FROM, REPLY_TO, p, studentEmailTemplate } from '@/lib/studentFollowupEmails';
import { avisoProfesor, correoAlumno } from '@/lib/cambioHorario/textos';
import {
  cambiarHorarioCore,
  type CambioHorarioDeps, type CambioHorarioParams, type CambioHorarioResultado, type DatosAvisoCambio,
} from '@/lib/cambioHorario/core';

/** Correo de confirmación al alumno: a students.email, en copia el de la asignación si es otro, respuestas a alumnos@. */
export async function enviarCorreoAlumnoCambio(d: DatosAvisoCambio): Promise<boolean> {
  if (!d.studentEmail) {
    console.error(`[EMAIL] cambio de horario: ${d.alumno} no tiene email en su ficha (students.email).`);
    return false;
  }
  // Los nombres van escapados (esc); el resto es texto propio con algún <br />.
  const c = correoAlumno(d, esc);
  const html = studentEmailTemplate(c.parrafos.map(x => p(x)).join(''), c.preview, { inviteReplyInFooter: true });
  try {
    const { data, error } = await resend.emails.send({
      from: FROM, to: d.studentEmail, replyTo: REPLY_TO, subject: c.subject, html,
      ...(d.ccEmail ? { cc: d.ccEmail } : {}),
    });
    if (error) {
      console.error('[EMAIL] cambio de horario (alumno): Resend devolvió error:', { name: error.name, message: error.message, to: d.studentEmail });
      return false;
    }
    console.log('[EMAIL] cambio de horario (alumno): enviado', { id: data?.id, to: d.studentEmail });
    return true;
  } catch (err) {
    console.error('[EMAIL] cambio de horario (alumno): excepción al enviar:', err);
    return false;
  }
}

/** Dependencias de servidor: Resend directo, con el cliente de service key. */
export function depsServidorCambio(admin: SupabaseClient): CambioHorarioDeps {
  return {
    async enviarEmailProfesor(d) {
      const { data, error } = await admin.from('teachers')
        .select('id, name, email, notification_email').eq('id', d.teacherId).maybeSingle();
      if (error || !data) throw new Error(`no se pudo leer el profesor ${d.teacherId}: ${error?.message ?? 'no existe'}`);
      const t = data as { id: string; name: string; email: string | null; notification_email: string | null };
      return sendStudentScheduleChangedEmail(
        { id: t.id, name: t.name, email: t.email, notificationEmail: t.notification_email },
        avisoProfesor(d),
      );
    },
    enviarEmailAlumno: enviarCorreoAlumnoCambio,
  };
}

/** Cambia el horario con la service key. LANZA CambioHorarioError si no se hizo. */
export async function cambiarHorarioServidor(params: CambioHorarioParams): Promise<CambioHorarioResultado> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY: no se puede cambiar el horario desde el servidor.');
  return cambiarHorarioCore(admin, params, depsServidorCambio(admin));
}
