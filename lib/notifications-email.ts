// Envío del correo de cancelación (server-side). Envuelve la llamada a Resend
// en try/catch: si el envío falla NUNCA debe romper el flujo que la invoca
// (webhook, limpieza de calendario). Devuelve true/false.

import { resend, hasResendKey } from '@/lib/resend';
import { cancellationEmailTemplate } from '@/lib/emailTemplates';

const FROM = 'DRC Academy <notificaciones@drcacademy.com>';

export async function sendCancellationEmail(
  teacherEmail: string,
  teacherName: string,
  studentName: string,
): Promise<boolean> {
  if (!teacherEmail) {
    console.error('[EMAIL] sendCancellationEmail: sin email de destino para', teacherName);
    return false;
  }

  const { subject, html } = cancellationEmailTemplate(teacherName, studentName);
  const key = process.env.RESEND_API_KEY;

  console.log('[EMAIL] Intentando enviar email:', {
    label: 'sendCancellationEmail',
    to: teacherEmail,
    subject,
    from: FROM,
    resendKeyExists: Boolean(key),
    resendKeyPrefix: key?.substring(0, 10),
    usingPlaceholder: !hasResendKey(),
  });

  try {
    // El SDK de Resend NO lanza en errores de API: los devuelve en `error`.
    const { data, error } = await resend.emails.send({ from: FROM, to: teacherEmail, subject, html });

    if (error) {
      console.error('[EMAIL] sendCancellationEmail: Resend devolvió error:', {
        name: error.name, message: error.message, to: teacherEmail,
      });
      return false;
    }
    console.log('[EMAIL] sendCancellationEmail: enviado correctamente:', { id: data?.id, to: teacherEmail });
    return true;
  } catch (err) {
    console.error('[EMAIL] sendCancellationEmail: excepción al enviar:', err);
    return false;
  }
}
