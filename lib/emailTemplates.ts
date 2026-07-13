// Plantillas de email (HTML con estilos inline — los clientes de correo no
// soportan CSS externo). Branding DRC: verde #1E9E3A, fondo #F7F7F5.

const LOGO_URL = 'https://academy-scheduler-aqpt.vercel.app/drc-logo.png';

// Escapa texto para insertarlo de forma segura dentro del HTML.
function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function cancellationEmailTemplate(
  teacherName: string,
  studentName: string,
): { subject: string; html: string } {
  const t = esc(teacherName);
  const s = esc(studentName);

  const subject = `${studentName} ha cancelado su plan`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(subject)}</title>
</head>
<body style="margin:0; padding:0; background-color:#F7F7F5; font-family:'Radio Canada', Arial, Helvetica, sans-serif; color:#1A1A1A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F7F7F5; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,0.06);">
          <!-- Header -->
          <tr>
            <td align="center" style="padding:28px 32px 8px 32px; background-color:#ffffff;">
              <img src="${LOGO_URL}" alt="DRC Academy" height="40" style="height:40px; width:auto; display:block; margin-bottom:8px;" />
              <div style="font-size:20px; font-weight:700; color:#1E9E3A;">DRC Academy</div>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:16px 40px 32px 40px; font-size:15px; line-height:1.65; color:#1A1A1A;">
              <p style="margin:0 0 16px 0;">Hola ${t},</p>
              <p style="margin:0 0 16px 0;">Te escribimos para informarte que <strong>${s}</strong> ha cancelado su plan con la academia.</p>
              <p style="margin:0 0 16px 0;">Por este motivo, ya no continuará con sus clases y ha sido eliminado automáticamente de tu calendario en DRC Gestión.</p>
              <p style="margin:0 0 16px 0;">Si tenías algún material o seguimiento pendiente con este alumno, te recomendamos guardarlo antes de continuar.</p>
              <p style="margin:0 0 16px 0;">¡Gracias por tu dedicación y por acompañar a cada alumno en su proceso! Si en algún momento <strong>${s}</strong> decide retomar sus clases, te avisaremos para que puedas continuar con él/ella.</p>
              <p style="margin:16px 0 0 0;">Un saludo,<br />El equipo de DRC Academy 🌍</p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:18px 40px 28px 40px; border-top:1px solid #ECECEC;">
              <p style="margin:0; font-size:12px; line-height:1.5; color:#8A8A8A;">Este es un mensaje automático de DRC Gestión. No es necesario responder a este correo.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}
