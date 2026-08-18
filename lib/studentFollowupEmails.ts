// Correos de follow-up AL ALUMNO (no al profesor): los recordatorios del
// formulario inicial y de la prueba de nivel.
//
// SOLO SERVIDOR: usa RESEND_API_KEY. Best-effort, como el resto de emails del
// proyecto: devuelve true/false y nunca lanza.
//
// Por qué no reutiliza baseEmailTemplate de lib/emailNotifications: esa plantilla
// está escrita para el equipo. Su pie dice "mensaje automático de DRC Gestión, no
// es necesario responder", y DRC Gestión es el nombre interno de la herramienta,
// que el alumno no conoce. Aquí el pie invita justo a lo contrario (el tercer
// recordatorio le pide que responda si tiene dudas). La cabecera verde, el fondo
// y el botón sí son los mismos, y el layout sigue siendo de tablas por lo mismo
// de siempre: Outlook de escritorio ignora max-width en <div>.

import { resend } from '@/lib/resend';
import { esc } from '@/lib/emailNotifications';
import { STEP_LABEL, type Sequence } from '@/lib/formReminders';

const FROM = 'DRC Academy <notificaciones@drcacademy.com>';

// A dónde contesta el alumno si responde al correo. El remitente
// (notificaciones@) es un buzón que nadie lee, así que las respuestas se
// redirigen al de alumnos.
const REPLY_TO = process.env.STUDENT_REPLY_TO_EMAIL?.trim() || 'alumnos@drcacademy.com';

const VERDE = '#1E9E3A';
const AMARILLO = '#FFC400';
const FONDO = '#F7F7F5';

/** Envoltorio de los correos al alumno. */
export function studentEmailTemplate(content: string, previewText: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0; padding:0; background-color:${FONDO}; font-family:Arial, Helvetica, sans-serif; color:#1A1A1A;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${esc(previewText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${FONDO}; padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden;">
      <tr>
        <td align="center" style="background-color:${VERDE}; padding:24px;">
          <h1 style="color:#ffffff; margin:0; font-size:20px; font-weight:600;">DRC Academy</h1>
          <p style="color:rgba(255,255,255,0.85); margin:4px 0 0; font-size:13px;">Tu academia de inglés</p>
        </td>
      </tr>
      <tr><td style="height:4px; background-color:${AMARILLO}; line-height:4px; font-size:0;">&nbsp;</td></tr>
      <tr><td style="padding:32px 24px; font-size:15px; line-height:1.65; color:#1A1A1A;">${content}</td></tr>
      <tr>
        <td align="center" style="padding:16px 24px; border-top:1px solid #E0E0DA;">
          <p style="color:#888880; font-size:12px; margin:0; line-height:1.5;">
            Si tienes cualquier duda, responde a este correo y te ayudamos.<br />DRC Academy
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Botón verde. Va en tabla porque los enlaces con padding fallan en Outlook. */
function boton(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0;" align="center">
  <tr><td align="center" bgcolor="${VERDE}" style="border-radius:8px;">
    <a href="${esc(href)}" target="_blank" style="display:inline-block; padding:14px 30px; font-size:15px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:8px;">${esc(label)}</a>
  </td></tr>
</table>`;
}

const p = (text: string) => `<p style="margin:0 0 16px;">${text}</p>`;

/** El enlace también en texto, por si el botón no se pinta o no se puede pulsar. */
function enlaceDeRespaldo(url: string): string {
  return `<p style="margin:0; font-size:12.5px; color:#888880; line-height:1.5;">
    Si el botón no funciona, copia y pega esta dirección en tu navegador:<br />
    <span style="color:#5A5A55; word-break:break-all;">${esc(url)}</span>
  </p>`;
}

export interface FollowupEmailInput {
  studentName: string;
  teacherName?: string | null;
  url: string;
}

interface Copy { subject: string; html: string }

/** Nombre de pila: los nombres llegan completos y en el saludo quedan fríos. */
export function primerNombre(nombre: string): string {
  const limpio = (nombre ?? '').trim().replace(/\s+/g, ' ');
  if (!limpio) return '';
  const primera = limpio.split(' ')[0];
  // Hay nombres cargados EN MAYÚSCULAS. "JOSÉ" en el saludo parece un grito.
  return primera === primera.toUpperCase() && primera.length > 1
    ? primera.charAt(0) + primera.slice(1).toLowerCase()
    : primera;
}

// ── Secuencia 1: el formulario sigue sin completarse ─────────────────────────
function formularioCopy(step: 1 | 2 | 3, input: FollowupEmailInput): Copy {
  const nombre = esc(primerNombre(input.studentName));
  const profe = input.teacherName?.trim() ? esc(input.teacherName.trim()) : null;

  if (step === 1) {
    return {
      subject: `${primerNombre(input.studentName)}, te falta un paso para empezar`,
      html: studentEmailTemplate(
        p(`¡Hola ${nombre}!`) +
        p('Hemos visto que empezaste tu registro pero todavía no has completado tu formulario y tu prueba de nivel.') +
        p(`Solo te llevará unos minutos y así podemos asignarte el profesor y el nivel que mejor te encajan${profe ? `. ${profe} ya te está esperando` : ''}.`) +
        boton('Completar mi formulario', input.url) +
        enlaceDeRespaldo(input.url),
        'Te falta completar tu formulario y tu prueba de nivel.',
      ),
    };
  }

  if (step === 2) {
    return {
      subject: 'Así preparamos tus clases a tu medida',
      html: studentEmailTemplate(
        p(`¡Hola de nuevo, ${nombre}!`) +
        p('Tu formulario y tu prueba de nivel siguen pendientes, y son justo lo que nos permite preparar tus clases a tu medida.') +
        p('Con tus respuestas sabemos en qué punto estás, qué quieres conseguir y cómo aprendes mejor. Con la prueba de nivel confirmamos tu nivel real, así no pierdes tiempo repasando lo que ya dominas ni empiezas por encima de donde estás.') +
        p(`Son unos minutos y podrás empezar tus clases cuanto antes${profe ? `, con ${profe}` : ''}.`) +
        boton('Completar ahora', input.url) +
        enlaceDeRespaldo(input.url),
        'Tus respuestas son las que nos permiten preparar tus clases a tu medida.',
      ),
    };
  }

  return {
    subject: 'Último recordatorio de tu prueba de nivel',
    html: studentEmailTemplate(
      p(`Hola ${nombre},`) +
      p('Este es nuestro último recordatorio.') +
      p('Completa tu formulario y tu prueba de nivel para no retrasar el inicio de tus clases. Es lo único que nos falta por tu parte.') +
      boton('Completar mi prueba de nivel', input.url) +
      p('Si tienes cualquier duda, responde a este email y te echamos una mano.') +
      enlaceDeRespaldo(input.url),
      'Último recordatorio: completa tu prueba de nivel para no retrasar tus clases.',
    ),
  };
}

// ── Secuencia 2: hizo el formulario pero le falta la prueba de nivel ─────────
function testCopy(step: 1 | 2 | 3, input: FollowupEmailInput): Copy {
  const nombre = esc(primerNombre(input.studentName));
  const profe = input.teacherName?.trim() ? esc(input.teacherName.trim()) : null;

  if (step === 1) {
    return {
      subject: `${primerNombre(input.studentName)}, te queda la prueba de nivel`,
      html: studentEmailTemplate(
        p(`¡Hola ${nombre}!`) +
        p('Gracias por completar tu formulario. Te queda un último paso: la prueba de nivel.') +
        p('Son unos minutos y al terminar sabrás al instante en qué nivel de inglés estás.') +
        boton('Hacer mi prueba de nivel', input.url) +
        enlaceDeRespaldo(input.url),
        'Solo te queda la prueba de nivel.',
      ),
    };
  }

  if (step === 2) {
    return {
      subject: 'Tu nivel exacto en unos minutos',
      html: studentEmailTemplate(
        p(`¡Hola ${nombre}!`) +
        p('Tu prueba de nivel sigue pendiente y es la que marca por dónde empiezan tus clases.') +
        p(`Con tu nivel confirmado${profe ? `, ${profe}` : ''} prepara la primera clase en tu punto exacto: ni repasando lo que ya sabes ni con material que todavía se te hace cuesta arriba.`) +
        boton('Hacer la prueba ahora', input.url) +
        enlaceDeRespaldo(input.url),
        'Tu prueba de nivel marca por dónde empiezan tus clases.',
      ),
    };
  }

  return {
    subject: 'Último recordatorio de tu prueba de nivel',
    html: studentEmailTemplate(
      p(`Hola ${nombre},`) +
      p('Este es nuestro último recordatorio.') +
      p('Completa tu prueba de nivel para no retrasar el inicio de tus clases. Es lo único que nos falta por tu parte.') +
      boton('Hacer mi prueba de nivel', input.url) +
      p('Si tienes cualquier duda, responde a este email y te echamos una mano.') +
      enlaceDeRespaldo(input.url),
      'Último recordatorio: completa tu prueba de nivel para no retrasar tus clases.',
    ),
  };
}

/** El texto que le toca a esta secuencia y este paso. */
export function followupCopy(sequence: Sequence, step: 1 | 2 | 3, input: FollowupEmailInput): Copy {
  return sequence === 'formulario' ? formularioCopy(step, input) : testCopy(step, input);
}

/**
 * Envía el recordatorio. true si Resend lo aceptó.
 *
 * Ojo: el SDK de Resend NO lanza cuando la API falla (clave inválida, dominio sin
 * verificar, rate limit): lo devuelve en `error`. Por eso se comprueba explícito.
 */
export async function sendFollowupEmail(
  sequence: Sequence, step: 1 | 2 | 3, input: FollowupEmailInput, to: string,
): Promise<boolean> {
  const { subject, html } = followupCopy(sequence, step, input);
  const label = `followup_${sequence}_${step}`;

  try {
    const { data, error } = await resend.emails.send({
      from: FROM, to, subject, html, replyTo: REPLY_TO,
    });
    if (error) {
      console.error(`[EMAIL] ${label}: Resend devolvió error:`, { name: error.name, message: error.message, to });
      return false;
    }
    console.log(`[EMAIL] ${label} (${STEP_LABEL[step]}) enviado:`, { id: data?.id, to });
    return true;
  } catch (err) {
    console.error(`[EMAIL] ${label}: excepción al enviar:`, err);
    return false;
  }
}
