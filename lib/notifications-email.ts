// Envío de correos de notificación (server-side). Cada función envuelve la
// llamada a Resend en try/catch: si el envío falla NUNCA debe romper el flujo
// que la invoca (webhook, limpieza de calendario, etc.). Devuelve true/false.

import { resend } from '@/lib/resend';
import { cancellationEmailTemplate } from '@/lib/emailTemplates';

const FROM = 'DRC Academy <notificaciones@drcacademy.com>';

export async function sendCancellationEmail(
  teacherEmail: string,
  teacherName: string,
  studentName: string,
): Promise<boolean> {
  if (!teacherEmail) return false;
  try {
    const { subject, html } = cancellationEmailTemplate(teacherName, studentName);
    const { error } = await resend.emails.send({
      from:    FROM,
      to:      teacherEmail,
      subject,
      html,
    });
    if (error) {
      console.error('[sendCancellationEmail] Resend error:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[sendCancellationEmail] Fallo al enviar el email:', err);
    return false;
  }
}
