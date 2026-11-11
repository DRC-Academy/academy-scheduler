// ── "Tu plan ha finalizado": los tres emails ──────────────────────────────────
//
// Alumno, profe y equipo (alumnos@). Los envía lib/endedPlanJob desde el cron
// check-ending-plans; sustituyen a los del zap "Aviso Intensivos profe + alumno".
//
// Plantilla PROPIA y no la de los demás correos (lib/studentFollowupEmails,
// lib/emailNotifications) por dos pedidos de Facundo para estos tres: tipografía
// Radio Canada (Gmail no carga fuentes web y cae en Arial; Apple Mail e iOS sí
// la muestran) y TODO el texto en negro, sin grises de apoyo.

import { resend, hasResendKey } from '@/lib/resend';
import type { EndedPlan, EndedChannelResult } from '@/lib/endedPlans';

export const ENDED_FROM = 'DRC Academy <notificaciones@drcacademy.com>';
/** A dónde contesta el alumno: notificaciones@ no lo lee nadie. */
export const ENDED_REPLY_TO = 'alumnos@drcacademy.com';

/** Botón "Renovar mi plan": abre WhatsApp con el mensaje ya escrito (el mismo del zap). */
export const WHATSAPP_RENOVAR =
  'https://api.whatsapp.com/send/?phone=353899409220&text=Hola!%20%F0%9F%91%8B%20Estoy%20interesado%20en%20comenzar%20a%20aprender%20ingl%C3%A9s%20%F0%9F%8E%93&type=phone_number&app_absent=0';

const VERDE = '#1E9E3A';
const AMARILLO = '#FFC400';
const TEXTO = '#1A1A1A';
const FONDO = '#F7F7F5';
const LINEA = '#E0E0DA';
const FUENTE = `'Radio Canada', Arial, Helvetica, sans-serif`;

export interface EndedEmail { subject: string; html: string; text: string }

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** '2026-11-17' → '17 de noviembre de 2026'. */
export function fechaLarga(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} de ${MESES[m - 1]} de ${y}`;
}

const nombrePila = (n: string | null | undefined): string => (n ?? '').trim().split(/\s+/)[0] || '';

const p = (html: string) => `<p style="margin:0 0 16px; color:${TEXTO};">${html}</p>`;

function plantilla(contenido: string, preheader: string, subtitulo: string, pie: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="https://fonts.googleapis.com/css2?family=Radio+Canada:wght@400;600;700&display=swap" rel="stylesheet" />
</head>
<body style="margin:0; padding:0; background-color:${FONDO}; font-family:${FUENTE}; color:${TEXTO};">
<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${FONDO}; padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden;">
      <tr><td align="center" style="background-color:${VERDE}; padding:24px; font-family:${FUENTE};">
        <h1 style="color:#ffffff; margin:0; font-size:22px; font-weight:700;">DRC Academy</h1>
        <p style="color:#ffffff; margin:4px 0 0; font-size:14px;">${esc(subtitulo)}</p>
      </td></tr>
      <tr><td style="height:4px; background-color:${AMARILLO}; line-height:4px; font-size:0;">&nbsp;</td></tr>
      <tr><td style="padding:32px 24px; font-size:16px; line-height:1.65; color:${TEXTO}; font-family:${FUENTE};">${contenido}</td></tr>
      <tr><td align="center" style="padding:16px 24px; border-top:1px solid ${LINEA}; font-family:${FUENTE};">
        <p style="color:${TEXTO}; font-size:13px; margin:0; line-height:1.5;">${pie}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Bloque etiqueta/valor con el borde amarillo. Las filas vacías no se pintan. */
function datos(filas: Array<[string, string | null | undefined]>): string {
  const v = filas.filter(([, x]) => x != null && String(x).trim() !== '');
  if (v.length === 0) return '';
  const pad = (i: number, lado: 'top' | 'bottom') => (lado === 'top' ? (i === 0 ? 14 : 4) : (i === v.length - 1 ? 14 : 4));
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px; background-color:${FONDO}; border-left:4px solid ${AMARILLO}; border-radius:8px;">
${v.map(([k, x], i) => `  <tr>
    <td style="padding:${pad(i, 'top')}px 12px ${pad(i, 'bottom')}px 16px; font-size:15px; color:${TEXTO}; white-space:nowrap; vertical-align:top;">${esc(k)}</td>
    <td style="padding:${pad(i, 'top')}px 16px ${pad(i, 'bottom')}px 0; font-size:15px; color:${TEXTO}; font-weight:700;">${esc(x)}</td>
  </tr>`).join('\n')}
</table>`;
}

function boton(texto: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px auto;" align="center">
  <tr><td align="center" bgcolor="${VERDE}" style="border-radius:8px;">
    <a href="${esc(href)}" target="_blank" style="display:inline-block; padding:14px 32px; font-family:${FUENTE}; font-size:16px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:8px;">${esc(texto)}</a>
  </td></tr>
</table>`;
}

const lineas = (filas: Array<[string, string | null | undefined]>) =>
  filas.filter(([, x]) => x != null && String(x).trim() !== '').map(([k, x]) => `${k}: ${x}`).join('\n');

// ── Los tres ──────────────────────────────────────────────────────────────────

export function emailAlumno(d: EndedPlan): EndedEmail {
  const filas: Array<[string, string | null | undefined]> = [
    ['Plan', d.planName], ['Tu profe', d.teacher?.name], ['Fecha de fin', fechaLarga(d.endDate)],
  ];
  const plan = d.planName ? `Tu plan <strong>${esc(d.planName)}</strong>` : 'Tu plan';
  const seguir = `Si quieres seguir avanzando${d.teacher?.name ? ` con ${esc(d.teacher.name)}` : ''}, escríbenos por WhatsApp y te ayudamos a renovar tu plan.`;
  const html = plantilla(
    p(`Hola ${esc(nombrePila(d.studentName))},`) +
    p(`${plan} en DRC Academy ha finalizado. Gracias por confiar en nosotros para aprender inglés.`) +
    datos(filas) +
    p(seguir) +
    boton('Renovar mi plan', WHATSAPP_RENOVAR) +
    p('Un saludo,<br />El equipo de DRC Academy'),
    'Tu plan ha finalizado. Si quieres seguir avanzando, te ayudamos a renovarlo.',
    'Tu academia de inglés',
    'Si tienes cualquier duda, responde a este correo y te ayudamos.<br />DRC Academy',
  );
  const text = [
    `Hola ${nombrePila(d.studentName)},`, '',
    `${d.planName ? `Tu plan ${d.planName}` : 'Tu plan'} en DRC Academy ha finalizado. Gracias por confiar en nosotros para aprender inglés.`, '',
    lineas(filas), '',
    seguir.replace(/<[^>]+>/g, ''),
    `Renovar mi plan: ${WHATSAPP_RENOVAR}`, '',
    'Un saludo,', 'El equipo de DRC Academy',
  ].join('\n');
  return { subject: 'Tu plan ha finalizado', html, text };
}

export function emailProfe(d: EndedPlan): EndedEmail {
  const filas: Array<[string, string | null | undefined]> = [
    ['Alumno', d.studentName], ['Plan', d.planName], ['Fecha de fin', fechaLarga(d.endDate)],
  ];
  const html = plantilla(
    p(`Hola ${esc(nombrePila(d.teacher?.name))},`) +
    p(`Te avisamos de que el plan de <strong>${esc(d.studentName)}</strong> ha finalizado y, por ahora, no lo ha renovado.`) +
    datos(filas) +
    p(`Ya le hemos escrito para ofrecerle renovar. Si te comenta algo en clase o tienes dudas, escríbenos a <a href="mailto:alumnos@drcacademy.com" style="color:${VERDE}; font-weight:700;">alumnos@drcacademy.com</a>.`) +
    p('Un saludo,<br />El equipo de DRC Academy'),
    `El plan de ${d.studentName} ha finalizado.`,
    'Plataforma de gestión interna',
    'Este es un mensaje automático de DRC Gestión.',
  );
  const text = [
    `Hola ${nombrePila(d.teacher?.name)},`, '',
    `Te avisamos de que el plan de ${d.studentName} ha finalizado y, por ahora, no lo ha renovado.`, '',
    lineas(filas), '',
    'Ya le hemos escrito para ofrecerle renovar. Si te comenta algo en clase o tienes dudas, escríbenos a alumnos@drcacademy.com.', '',
    'Un saludo,', 'El equipo de DRC Academy',
  ].join('\n');
  return { subject: `Plan de ${d.studentName} finalizado`, html, text };
}

/** Estado de check-subscription en palabras. */
export function estadoWoo(status: string | null | undefined): string {
  switch (status) {
    case 'cancelled': return 'suscripción cancelada';
    case 'expired': return 'suscripción vencida';
    case 'pending-cancel': return 'cancelación pedida';
    case 'not_found': return 'sin suscripción en Woo';
    case 'one_time_no_access': return 'pago único sin acceso vigente';
    case null: case undefined: case '': return 'sin datos';
    default: return status;
  }
}

/** Qué se avisó, para la última línea del email al equipo. */
function resumenAvisos(alumno?: EndedChannelResult, profe?: EndedChannelResult): string {
  const ok = (r?: EndedChannelResult) => r?.estado === 'enviado';
  if (ok(alumno) && ok(profe)) return 'Se ha enviado el aviso al alumno y a su profe.';
  const partes: string[] = [];
  partes.push(ok(alumno) ? 'Se ha enviado el aviso al alumno.' : `El aviso al alumno NO ha salido${alumno?.error ? ` (${alumno.error})` : ''}.`);
  if (profe?.estado === 'omitido') partes.push('No tiene profe asignado al que avisar.');
  else partes.push(ok(profe) ? 'Su profe también está avisado.' : `El aviso a su profe NO ha salido${profe?.error ? ` (${profe.error})` : ''}.`);
  return partes.join(' ');
}

export function emailEquipo(d: EndedPlan, info: { subStatus?: string | null; alumno?: EndedChannelResult; profe?: EndedChannelResult }): EndedEmail {
  const filas: Array<[string, string | null | undefined]> = [
    ['Alumno', d.studentName], ['Email', d.studentEmail], ['Teléfono', d.studentPhone || 'no lo tenemos'],
    ['Plan', d.planName ?? 'sin nombre de plan'], ['Profe', d.teacher?.name ?? 'sin profe asignado'],
    ['Fecha de fin', fechaLarga(d.endDate)], ['Estado en Woo', estadoWoo(info.subStatus)],
    ['Aviso de 7 días', d.sevenDayNotice ? 'sí, enviado' : 'no'],
  ];
  const intro = `El plan de <strong>${esc(d.studentName)}</strong> terminó el ${esc(fechaLarga(d.endDate))} y, al comprobarlo hoy, sigue sin renovar.`;
  const resumen = resumenAvisos(info.alumno, info.profe);
  const html = plantilla(
    p(intro) + datos(filas) + p(esc(resumen)),
    `${d.studentName}: plan finalizado sin renovar.`,
    'Plataforma de gestión interna',
    'Este es un mensaje automático de DRC Gestión.',
  );
  const text = [intro.replace(/<[^>]+>/g, ''), '', lineas(filas), '', resumen].join('\n');
  return { subject: `Plan de ${d.studentName} ha finalizado`, html, text };
}

// ── Envío ─────────────────────────────────────────────────────────────────────

/**
 * Un email por Resend. Nunca lanza. `idempotencyKey`: si la misma vuelta se
 * repite (p. ej. dos llamadas casi a la vez), Resend no lo manda dos veces.
 */
export async function enviarEmail(args: {
  to: string; email: EndedEmail; replyTo?: string; idempotencyKey?: string;
}): Promise<EndedChannelResult> {
  const to = args.to.trim();
  if (!to) return { estado: 'omitido', error: 'Sin dirección de email.' };
  if (!hasResendKey()) return { estado: 'error', to, error: 'Falta RESEND_API_KEY en Vercel.' };
  try {
    const { error } = await resend.emails.send(
      {
        from: ENDED_FROM, to, subject: args.email.subject, html: args.email.html, text: args.email.text,
        ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      },
      args.idempotencyKey ? { idempotencyKey: args.idempotencyKey.slice(0, 256) } : undefined,
    );
    if (error) return { estado: 'error', to, error: `Resend: ${error.message}` };
    return { estado: 'enviado', to, at: new Date().toISOString() };
  } catch (e) {
    return { estado: 'error', to, error: `Resend: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Datos inventados para ?prueba_fin=1. */
export function planDeEjemplo(): EndedPlan {
  return {
    studentId: 'prueba', studentName: 'Lucía Fernández Ruiz', studentEmail: 'lucia@example.com',
    studentPhone: '+34600111222', endDate: '2026-11-17', planName: 'Intensivo FCE',
    teacher: { id: 'prueba', name: 'Laura', email: '' }, sevenDayNotice: true,
    pendientes: ['alumno', 'profe', 'equipo'], previos: {},
  };
}
