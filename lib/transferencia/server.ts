// Transferencia de alumno desde el SERVIDOR (service key). SOLO SERVIDOR.
//
// Usa el mismo núcleo que el modal (lib/transferencia/core.ts) con dos
// diferencias: el cliente es el de service key, así que la transferencia queda
// en transfer_requests, y los correos se mandan directamente con Resend, sin
// fetch relativo ni llamadas HTTP a la propia app (que es por lo que el script se
// quedaba sin el correo al profesor nuevo).
//
// Todavía no lo expone ninguna ruta. Fuera de Next (scripts) hay que arrancar
// node con --conditions=react-server para que 'server-only' no lance.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { sendNewStudentEmail } from '@/lib/emailNotifications';
import { sendWelcomeForAssignment } from '@/lib/welcomeEmailSend';
import { PUBLIC_APP_URL } from '@/lib/appUrl';
import {
  transferirAlumnoCore,
  type TransferenciaDeps, type TransferenciaParams, type TransferenciaResultado,
} from '@/lib/transferencia/core';

/** Dependencias de servidor: Resend directo, con el cliente de service key. */
export function depsServidor(admin: SupabaseClient, base: string = PUBLIC_APP_URL): TransferenciaDeps {
  return {
    async enviarEmailProfeNuevo(d) {
      // El correo va a notification_email si el profesor lo tiene, como siempre.
      const { data, error } = await admin.from('teachers')
        .select('id, name, email, notification_email').eq('id', d.teacherId).maybeSingle();
      if (error) throw new Error(`no se pudo leer el profesor ${d.teacherId}: ${error.message}`);
      const t = (data ?? { id: d.teacherId, name: d.teacherName, email: d.teacherEmail, notification_email: null }) as
        { id: string; name: string; email: string | null; notification_email: string | null };
      return sendNewStudentEmail(
        { id: t.id, name: t.name, email: t.email, notificationEmail: t.notification_email },
        { studentName: d.studentName, studentEmail: d.studentEmail, plan: d.plan, level: d.level, slots: d.slots, startDate: d.startDate },
      );
    },
    async enviarBienvenidaAlumno(assignmentId) {
      // Que la omita (apagada, fuera de ventana, ya enviada…) no es un fallo; un error sí.
      const r = await sendWelcomeForAssignment(admin, assignmentId, 'cambio_profesor', base);
      if ('error' in r) throw new Error(r.error);
    },
  };
}

/** Transfiere un alumno con la service key. LANZA TransferenciaError si no se hizo. */
export async function transferirAlumnoServidor(params: TransferenciaParams): Promise<TransferenciaResultado> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY: no se puede transferir desde el servidor.');
  return transferirAlumnoCore(admin, params, depsServidor(admin));
}
