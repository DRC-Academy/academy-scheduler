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
import { etapaDe, stepLabel, type Sequence, type CopyVariant } from '@/lib/formReminders';

export const FROM = 'DRC Academy <notificaciones@drcacademy.com>';

// A dónde contesta el alumno si responde al correo. El remitente
// (notificaciones@) es un buzón que nadie lee, así que las respuestas se
// redirigen al de alumnos.
export const REPLY_TO = process.env.STUDENT_REPLY_TO_EMAIL?.trim() || 'alumnos@drcacademy.com';

const VERDE = '#1E9E3A';
const AMARILLO = '#FFC400';
const FONDO = '#F7F7F5';

/**
 * Envoltorio de los correos al alumno.
 *
 * `inviteReplyInFooter: false` quita del pie el "responde a este correo": la
 * bienvenida (lib/welcomeEmailCopy) ya lo dice en el cuerpo y repetido queda raro.
 */
export function studentEmailTemplate(
  content: string, previewText: string,
  opts: { inviteReplyInFooter?: boolean } = {},
): string {
  const pie = opts.inviteReplyInFooter === false
    ? 'DRC Academy'
    : 'Si tienes cualquier duda, responde a este correo y te ayudamos.<br />DRC Academy';
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
            ${pie}
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
export function boton(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0;" align="center">
  <tr><td align="center" bgcolor="${VERDE}" style="border-radius:8px;">
    <a href="${esc(href)}" target="_blank" style="display:inline-block; padding:14px 30px; font-size:15px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:8px;">${esc(label)}</a>
  </td></tr>
</table>`;
}

export const p = (text: string) => `<p style="margin:0 0 16px;">${text}</p>`;

/** El enlace también en texto, por si el botón no se pinta o no se puede pulsar. */
export function enlaceDeRespaldo(url: string): string {
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

// ── Los tres textos, por etapa ────────────────────────────────────────────────
//
// Un solo template y tres tonos según la etapa de la cadencia (lib/formReminders):
//   · 'recordatorio' (días 1, 2 y 3): recordatorio amable, asunto distinto por día.
//   · 'espera'       (días 6 y 9):   "te estamos esperando": sin el nivel el
//                                    profesor no puede preparar la primera clase.
//   · 'semanal'      (día 16 en adelante): breve, "cuando quieras, aquí tienes tu enlace".
//
// Lo que le FALTA al alumno (`sequence`) solo cambia una frase: "tu formulario y
// tu prueba de nivel" o "tu prueba de nivel". El botón lleva siempre a la URL
// pública (lib/appUrl), nunca a la de deployment de Vercel.
//
// Textos aprobados por Facundo el 16/09/2026. Español de España, tuteo.

/** Qué le falta, en palabras, para meterlo en la frase. */
function pendienteDe(sequence: Sequence): { min: string; may: string } {
  return sequence === 'formulario'
    ? { min: 'tu formulario y tu prueba de nivel', may: 'Tu formulario y tu prueba de nivel siguen pendientes' }
    : { min: 'tu prueba de nivel', may: 'Tu prueba de nivel sigue pendiente' };
}

function recordatorioCopy(step: number, sequence: Sequence, input: FollowupEmailInput, variant: CopyVariant): Copy {
  const nombre = esc(primerNombre(input.studentName));
  const nombreAsunto = primerNombre(input.studentName);
  const profe = input.teacherName?.trim() ? esc(input.teacherName.trim()) : null;
  const { min } = pendienteDe(sequence);

  // Asunto distinto por día (1, 2 y 3). A partir del 3º, el del tercer día.
  const subject = step === 1 ? `${nombreAsunto}, te falta un paso para empezar tus clases`
    : step === 2 ? `Tu prueba de nivel sigue pendiente, ${nombreAsunto}`
    : `Unos minutos y empezamos, ${nombreAsunto}`;

  // Veterano: lleva semanas de clase y nunca recibió el enlace. "Hemos visto que
  // todavía no has completado" sonaría a que no sabemos quién es.
  const apertura = variant === 'veterano'
    ? p('Llevas ya unas semanas de clase con nosotros y hay algo que todavía no te hemos pedido: tu ficha de alumno y tu prueba de nivel.')
    : p(`Hemos visto que todavía no has completado ${min}.`);

  return {
    subject,
    html: studentEmailTemplate(
      p(`¡Hola ${nombre}!`) +
      apertura +
      p(`Solo te llevará unos minutos y es lo que nos permite saber en qué punto estás para preparar tus clases a tu medida${profe ? `, con ${profe}` : ''}.`) +
      boton('Completar mi prueba de nivel', input.url) +
      enlaceDeRespaldo(input.url),
      `Te falta completar ${min}.`,
    ),
  };
}

function esperaCopy(sequence: Sequence, input: FollowupEmailInput, variant: CopyVariant): Copy {
  const nombre = esc(primerNombre(input.studentName));
  const profe = input.teacherName?.trim() ? esc(input.teacherName.trim()) : null;
  const { may } = pendienteDe(sequence);
  const quien = profe ?? 'tu profesor';
  // Veterano: ya está en clase, así que no hay "primera clase" que preparar.
  const consecuencia = variant === 'veterano'
    ? `sin tu nivel ${quien} no puede ajustar tus clases a tu nivel real: no sabemos en qué punto estás ni por dónde seguir.`
    : `sin tu nivel ${quien} no puede prepararte la primera clase: no sabemos en qué punto estás ni por dónde empezar.`;

  return {
    subject: `Te estamos esperando, ${primerNombre(input.studentName)}`,
    html: studentEmailTemplate(
      p(`¡Hola de nuevo, ${nombre}!`) +
      p(`${may}, y ${consecuencia}`) +
      p('Son unos minutos. En cuanto la termines, tu profesor recibe el resultado y se pone con tu primera clase.') +
      boton('Hacer mi prueba de nivel ahora', input.url) +
      enlaceDeRespaldo(input.url),
      'Sin tu nivel, tu profesor no puede prepararte la primera clase.',
    ),
  };
}

function semanalCopy(input: FollowupEmailInput): Copy {
  const nombre = esc(primerNombre(input.studentName));
  return {
    subject: 'Tu enlace a la prueba de nivel',
    html: studentEmailTemplate(
      p(`Hola ${nombre},`) +
      p('Cuando quieras, aquí tienes tu enlace a la prueba de nivel. Son unos minutos y en cuanto la completes empezamos con tus clases.') +
      boton('Hacer mi prueba de nivel', input.url) +
      // Si contesta pidiendo que paremos, el equipo marca "No enviar más" en el
      // admin (pestaña Tests de nivel). Ver README, sección de crons.
      p('Si prefieres que no te escribamos más, responde a este correo y lo dejamos aquí.') +
      enlaceDeRespaldo(input.url),
      'Cuando quieras, aquí tienes tu enlace a la prueba de nivel.',
    ),
  };
}

/**
 * El texto que le toca a este envío. La etapa la decide el número de envío
 * (lib/formReminders.etapaDe); `sequence` solo cambia qué le falta.
 */
export function followupCopy(
  sequence: Sequence, step: number, input: FollowupEmailInput, variant: CopyVariant = 'estandar',
): Copy {
  switch (etapaDe(step)) {
    case 'recordatorio': return recordatorioCopy(step, sequence, input, variant);
    case 'espera':       return esperaCopy(sequence, input, variant);
    default:             return semanalCopy(input);
  }
}

/**
 * Envía el follow-up. `{ ok: true, id }` si Resend lo aceptó (el id se guarda en
 * level_test_followups.resend_id).
 *
 * Ojo: el SDK de Resend NO lanza cuando la API falla (clave inválida, dominio sin
 * verificar, rate limit): lo devuelve en `error`. Por eso se comprueba explícito.
 */
export async function sendFollowupEmail(
  sequence: Sequence, step: number, input: FollowupEmailInput, to: string,
  variant: CopyVariant = 'estandar',
): Promise<{ ok: boolean; id: string | null }> {
  const { subject, html } = followupCopy(sequence, step, input, variant);
  const label = `followup_${sequence}_${variant}_${step}`;

  try {
    const { data, error } = await resend.emails.send({
      from: FROM, to, subject, html, replyTo: REPLY_TO,
    });
    if (error) {
      console.error(`[EMAIL] ${label}: Resend devolvió error:`, { name: error.name, message: error.message, to });
      return { ok: false, id: null };
    }
    console.log(`[EMAIL] ${label} (${stepLabel(step)}) enviado:`, { id: data?.id, to });
    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    console.error(`[EMAIL] ${label}: excepción al enviar:`, err);
    return { ok: false, id: null };
  }
}
