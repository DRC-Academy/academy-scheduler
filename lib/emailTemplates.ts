// Plantilla del email de cancelación.
//
// Usa el mismo envoltorio que el resto de avisos (lib/emailNotifications) para
// que todos los correos se vean igual: cabecera verde DRC, cuerpo y pie común.

import { baseEmailTemplate, esc } from '@/lib/emailNotifications';

export function cancellationEmailTemplate(
  teacherName: string,
  studentName: string,
): { subject: string; html: string } {
  const t = esc(teacherName);
  const s = esc(studentName);
  const subject = `${studentName} ha cancelado su plan`;

  const html = baseEmailTemplate(
    `<p style="margin:0 0 16px;">Hola ${t},</p>
     <p style="margin:0 0 16px;">Te escribimos para informarte que <strong>${s}</strong> ha cancelado su plan con la academia.</p>
     <p style="margin:0 0 16px;">Por este motivo, ya no continuará con sus clases y ha sido eliminado automáticamente de tu calendario en DRC Gestión.</p>
     <p style="margin:0 0 16px;">Si tenías algún material o seguimiento pendiente con este alumno, te recomendamos guardarlo antes de continuar.</p>
     <p style="margin:0 0 16px;">Gracias por tu dedicación y por acompañar a cada alumno en su proceso. Si en algún momento <strong>${s}</strong> decide retomar sus clases, te avisaremos para que puedas continuar con él o ella.</p>
     <p style="margin:16px 0 0;">Un saludo,<br />El equipo de DRC Academy</p>`,
    subject,
  );

  return { subject, html };
}
