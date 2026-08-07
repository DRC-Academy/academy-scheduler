// Emails de notificación a los profesores (Resend).
//
// SOLO SERVIDOR: usa RESEND_API_KEY, que no tiene prefijo NEXT_PUBLIC. No
// importar desde componentes cliente — para disparar un email desde el cliente
// está /api/emails (ver app/api/emails/route.ts).
//
// Todas las funciones son best-effort: capturan sus errores y devuelven
// true/false. Un fallo de email NUNCA debe romper el flujo que lo invoca.

import { resend, hasResendKey } from '@/lib/resend';
import { supabase } from '@/lib/supabase';
import { MILESTONE_SLIDES } from '@/lib/milestones';
import {
  AVOID_ITEMS, ESCALATED_GUARDRAIL, NATURAL_REMINDER, protocolFor, usableAction,
  type InterventionSuggestion,
} from '@/lib/interventions';
import type { RiskSignal } from '@/lib/aiTypes';
import { cleanAiText } from '@/lib/textCleanup';
import { longDateEs, retentionLine, type EndingPlan } from '@/lib/endingPlans';

const FROM = 'DRC Academy <notificaciones@drcacademy.com>';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || 'https://academy-scheduler-aqpt.vercel.app';
const PAGOS_EMAIL = 'pagos@drcacademy.com';
// Destinatario de los avisos al admin (recordatorios de emails de presentación).
// Configurable por entorno; si no está, cae en la dirección de pagos de DRC.
const ADMIN_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL?.trim() || PAGOS_EMAIL;

// ── Preferencias ──────────────────────────────────────────────────────────────
export type EmailPrefKey =
  | 'new_student' | 'form_completed' | 'presentation_reminder'
  | 'milestones' | 'bonus' | 'circulars';

export interface TeacherLike {
  id?: string;
  name: string;
  email?: string | null;
  notificationEmail?: string | null;
  emailPreferences?: Partial<Record<EmailPrefKey, boolean>> | null;
}

/** Opt-out: si la preferencia no está guardada, se asume activada. */
export function wantsEmail(teacher: TeacherLike, key: EmailPrefKey): boolean {
  return teacher.emailPreferences?.[key] !== false;
}

export function destinationFor(teacher: TeacherLike): string {
  return (teacher.notificationEmail?.trim() || teacher.email?.trim() || '');
}

/** Carga un profesor desde la base (para los disparos server-side por id). */
export async function fetchTeacher(teacherId: string): Promise<TeacherLike | null> {
  const { data, error } = await supabase
    .from('teachers')
    .select('id, name, email, notification_email, email_preferences')
    .eq('id', teacherId)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error('[emailNotifications] Error al leer el profesor:', error);
    return null;
  }
  return {
    id: data.id,
    name: data.name,
    email: data.email,
    notificationEmail: data.notification_email,
    emailPreferences: normalizePrefs(data.email_preferences),
  };
}

/** email_preferences puede llegar como jsonb (objeto) o como string JSON. */
export function normalizePrefs(v: unknown): Partial<Record<EmailPrefKey, boolean>> | null {
  if (!v) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v as Partial<Record<EmailPrefKey, boolean>>;
}

// ── Plantilla base ────────────────────────────────────────────────────────────
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Envoltorio común de todos los emails.
 *
 * Usa tablas en vez de <div> con max-width: Outlook de escritorio renderiza con
 * el motor de Word e ignora max-width, así que un layout de divs se desborda a
 * pantalla completa. El diseño (cabecera verde, cuerpo, pie) es el mismo.
 */
export function baseEmailTemplate(content: string, previewText?: string): string {
  const preview = previewText
    ? `<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${esc(previewText)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0; padding:0; background-color:#F7F7F5; font-family:Arial, Helvetica, sans-serif; color:#1A1A1A;">
${preview}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F7F7F5; padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden;">
      <tr>
        <td align="center" style="background-color:#1E9E3A; padding:24px;">
          <h1 style="color:#ffffff; margin:0; font-size:20px; font-weight:600;">DRC Academy</h1>
          <p style="color:rgba(255,255,255,0.85); margin:4px 0 0; font-size:13px;">Plataforma de gestión interna</p>
        </td>
      </tr>
      <tr><td style="padding:32px 24px; font-size:15px; line-height:1.65; color:#1A1A1A;">${content}</td></tr>
      <tr>
        <td align="center" style="padding:16px 24px; border-top:1px solid #E0E0DA;">
          <p style="color:#888880; font-size:12px; margin:0; line-height:1.5;">
            Este es un mensaje automático de DRC Gestión.<br />No es necesario responder a este correo.
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Botón CTA verde (tabla: los <a> con padding fallan en Outlook). */
export function ctaButton(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr><td align="center" bgcolor="#1E9E3A" style="border-radius:8px;">
    <a href="${esc(href)}" target="_blank" style="display:inline-block; padding:12px 24px; font-size:14px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:8px;">${esc(label)}</a>
  </td></tr>
</table>`;
}

/** Bloque de datos etiqueta/valor. */
function dataRows(rows: Array<[string, string | null | undefined]>): string {
  const visible = rows.filter(([, v]) => v != null && String(v).trim() !== '');
  if (visible.length === 0) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;">
${visible.map(([k, v]) => `  <tr>
    <td style="padding:5px 12px 5px 0; font-size:14px; color:#888880; white-space:nowrap; vertical-align:top;">${esc(k)}</td>
    <td style="padding:5px 0; font-size:14px; color:#1A1A1A; font-weight:600;">${esc(v)}</td>
  </tr>`).join('\n')}
</table>`;
}

const p = (text: string) => `<p style="margin:0 0 16px;">${text}</p>`;

// ── Envío ─────────────────────────────────────────────────────────────────────
// Los avisos ya NO son opt-out: todos los emails se envían siempre (los
// profesores no pueden desactivarlos). Por eso `send` ya no consulta preferencias.
async function send(
  label: string, teacher: TeacherLike,
  subject: string, html: string,
): Promise<boolean> {
  const to = destinationFor(teacher);
  if (!to) {
    console.error(`[EMAIL] ${label}: el profesor ${teacher.name} no tiene email de destino.`);
    return false;
  }

  return sendToAddress(label, to, subject, html);
}

/** Envío directo a una dirección (avisos al admin, que no es un profesor). */
async function sendToAddress(label: string, to: string, subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  console.log('[EMAIL] Intentando enviar email:', {
    label,
    to,
    subject,
    from: FROM,
    resendKeyExists: Boolean(key),
    resendKeyPrefix: key?.substring(0, 10),
    usingPlaceholder: !hasResendKey(),
  });

  try {
    // Ojo: el SDK de Resend NO lanza en errores de API (clave inválida, dominio
    // sin verificar, rate limit): los devuelve en `error`. Un try/catch a secas
    // los daría por enviados. Por eso se comprueba `error` explícitamente.
    const { data, error } = await resend.emails.send({ from: FROM, to, subject, html });

    if (error) {
      console.error(`[EMAIL] ${label}: Resend devolvió error:`, {
        name: error.name, message: error.message, to,
      });
      return false;
    }
    console.log(`[EMAIL] ${label}: enviado correctamente:`, { id: data?.id, to });
    return true;
  } catch (err) {
    console.error(`[EMAIL] ${label}: excepción al enviar:`, err);
    return false;
  }
}

const fmtDate = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
};

// ═══ A) Nuevo alumno asignado ═════════════════════════════════════════════════
export interface NewStudentInfo {
  studentName: string;
  studentEmail?: string | null;
  plan?: string | null;
  level?: string | null;
  slots?: Array<{ day: string; hour: string }> | null;
  startDate?: string | null;
}

export async function sendNewStudentEmail(teacher: TeacherLike, info: NewStudentInfo): Promise<boolean> {
  const subject = `Nuevo alumno asignado: ${info.studentName}`;
  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p('Se te ha asignado un nuevo alumno.') +
    dataRows([
      ['Alumno', info.studentName],
      ['Plan', info.plan],
      ['Nivel', info.level],
      ['Horarios', info.slots?.length ? info.slots.map(s => `${s.day} ${s.hour}`).join(' · ') : null],
      ['Email de contacto', info.studentEmail],
      ['Fecha de inicio', fmtDate(info.startDate)],
    ]) +
    p('Recuerda enviarle el email de presentación lo antes posible.') +
    p('Accede a DRC Gestión para ver todos los detalles y enviar el formulario inicial.') +
    ctaButton('Ver en DRC Gestión', `${APP_URL}/mis-alumnos`),
    `${info.studentName} · ${info.plan ?? ''}`,
  );
  return send('sendNewStudentEmail', teacher, subject, html);
}

// ═══ A.2) Cancelación de una clase — email AL ALUMNO (Bloque 4.4) ═══════════════
export async function sendClassCancelledEmail(args: {
  studentEmail: string; studentName: string; teacherName: string;
  dateLabel: string; timeLabel: string;
}): Promise<boolean> {
  const subject = `Cambio en tu clase del ${args.dateLabel} · DRC Academy`;
  const html = baseEmailTemplate(
    p(`Hola ${esc(args.studentName)},`) +
    p(`Te escribimos para informarte de que tu clase del <strong>${esc(args.dateLabel)}</strong> a las <strong>${esc(args.timeLabel)}</strong> no podrá realizarse.`) +
    p(`Tu profesor/a ${esc(args.teacherName)} se pondrá en contacto contigo para reprogramarla lo antes posible.`) +
    p('Disculpa las molestias.') +
    p('Un saludo,<br/>El equipo de DRC Academy'),
    `Cambio en tu clase del ${args.dateLabel}`,
  );
  return sendToAddress('sendClassCancelledEmail', args.studentEmail, subject, html);
}

// ═══ A.3) Intervención recomendada sobre una alerta de riesgo ═════════════════
//
// Es el ÚNICO email ligado a las señales de riesgo: las alertas de riesgo en sí
// (amarillo/rojo) siguen sin enviarse por correo, solo generan aviso interno.
// Este sale cuando hay una sugerencia de intervención concreta que dar, con el
// mismo contenido que la notificación de la campanita.
export async function sendInterventionEmail(
  teacher: TeacherLike,
  info: {
    studentName: string; suggestion: InterventionSuggestion; classNumber?: number | null;
    /** Qué se detectó en la clase. Abre el email: primero el porqué, luego los pasos. */
    context?: string | null;
    /** Decide qué protocolo de respaldo usar si la IA no dejó pasos ejecutables. */
    risk?: RiskSignal;
  },
): Promise<boolean> {
  const s = info.suggestion;
  const escalate = s.escalateToSupport;
  const context = (info.context ?? '').trim();
  const risk: RiskSignal = info.risk ?? (escalate ? 'rojo' : 'amarillo');

  // Los PASOS, numerados y SIEMPRE presentes: si la IA no dejó ninguno
  // ejecutable, entra el protocolo de respaldo. Antes el email llevaba solo
  // `action` en una línea, y en los casos escalados esa línea decía "escala el
  // caso a soporte": un correo cuyo contenido era que no hiciera nada.
  const lista = protocolFor(s.steps, risk).steps;
  const stepsBlock = `<div style="margin:0 0 16px; padding:14px 16px; border:1px solid #E0E0DA; border-radius:8px; background-color:#FFFFFF;">
  <div style="font-size:12px; font-weight:700; color:#1E9E3A; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">En esta clase</div>
  <ol style="margin:0; padding-left:18px; font-size:14px; line-height:1.65; color:#1A1A1A;">${
    lista.map(t => `<li style="margin-bottom:6px;">${esc(t)}</li>`).join('')
  }</ol>
</div>`;
  // La acción solo se muestra si dice algo que el profesor pueda hacer y no
  // repite el contexto que va justo encima.
  const accion = usableAction(s.action, context);
  const subject = escalate
    ? `Escalar a soporte · ${info.studentName}`
    : `Seguimiento recomendado · ${info.studentName}`;

  const banner = (bg: string, border: string, color: string, title: string, text: string) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;">
  <tr><td style="background-color:${bg}; border-left:4px solid ${border}; border-radius:8px; padding:14px 16px;">
    <div style="font-size:12px; font-weight:700; color:${color}; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:6px;">${esc(title)}</div>
    <div style="font-size:15px; line-height:1.6; color:#1A1A1A;">${esc(text)}</div>
  </td></tr>
</table>`;

  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(`<strong>${esc(info.studentName)}</strong> ha mostrado señales de riesgo en su última clase${info.classNumber != null ? ` (clase ${info.classNumber})` : ''}.`) +
    (context ? p(`<strong>En la última clase:</strong> ${esc(context)}`) : '') +
    (accion ? banner('#FFF9E0', '#FFC400', '#8A6A00', 'Intervención recomendada', accion) : '') +
    stepsBlock +
    // Guardarraíl del caso escalado: va DESPUÉS del protocolo, nunca en su lugar.
    (escalate ? banner('#FFF9E0', '#FFC400', '#8A6A00', 'Ten en cuenta', ESCALATED_GUARDRAIL) : '') +
    (s.reconnectHook ? p(`<strong>Oportunidad:</strong> ${esc(s.reconnectHook)}`) : '') +
    p(`<em>${esc(NATURAL_REMINDER)}</em>`) +
    `<div style="margin:0 0 16px; padding:12px 14px; border:1px solid #E0E0DA; border-radius:8px;">
  <div style="font-size:12px; font-weight:700; color:#888880; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;">Qué evitar</div>
  <ul style="margin:0; padding-left:18px; font-size:13.5px; line-height:1.6; color:#5A5A55;">${AVOID_ITEMS.map(t => `<li style="margin-bottom:4px;">${esc(t)}</li>`).join('')}</ul>
</div>` +
    ctaButton('Ver la ficha del alumno', `${APP_URL}/mis-alumnos`),
    `${info.studentName} · ${escalate ? 'escalar a soporte' : 'seguimiento recomendado'}`,
  );

  return send('sendInterventionEmail', teacher, subject, html);
}

// ═══ B) Formulario completado ═════════════════════════════════════════════════
export async function sendFormCompletedEmail(teacher: TeacherLike, studentName: string): Promise<boolean> {
  const subject = `${studentName} completó el formulario inicial`;
  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(`<strong>${esc(studentName)}</strong> ha completado el formulario inicial.`) +
    p('La ficha del alumno y la primera clase han sido generadas automáticamente por la IA.') +
    p('Puedes revisarlas en DRC Gestión antes de vuestra primera clase.') +
    ctaButton('Ver ficha del alumno', `${APP_URL}/mis-alumnos`),
    `Ficha de ${studentName} lista`,
  );
  return send('sendFormCompletedEmail', teacher, subject, html);
}

// ═══ C) Email de presentación pendiente (12 h) ════════════════════════════════
export async function sendPresentationEmailReminder(
  teacher: TeacherLike, studentName: string, hoursElapsed: number,
): Promise<boolean> {
  const subject = `Recordatorio: email de presentación pendiente · ${studentName}`;
  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(`Han pasado <strong>${Math.round(hoursElapsed)} horas</strong> desde que se te asignó <strong>${esc(studentName)}</strong> y aún no has enviado el email de presentación.`) +
    p('Los alumnos que reciben una bienvenida rápida tienen mayor retención. Te recomendamos enviarlo cuanto antes.') +
    p('Recuerda que tienes hasta 24 horas para enviarlo sin que afecte a tu scoring.') +
    ctaButton('Ir a DRC Gestión', APP_URL),
    `${studentName} lleva ${Math.round(hoursElapsed)} h sin bienvenida`,
  );
  return send('sendPresentationEmailReminder', teacher, subject, html);
}

// ═══ D) Email de presentación fuera de tiempo (24 h) ══════════════════════════
export async function sendPresentationEmailOverdue(teacher: TeacherLike, studentName: string): Promise<boolean> {
  const subject = `Email de presentación no enviado · ${studentName}`;
  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(`Han pasado más de <strong>24 horas</strong> desde que se te asignó <strong>${esc(studentName)}</strong> y aún no has enviado el email de presentación.`) +
    p('Cuando lo envíes se registrarán <strong>-5 puntos</strong> en tu scoring.') +
    p('Te recomendamos enviarlo lo antes posible.') +
    ctaButton('Enviar ahora', APP_URL),
    `${studentName} sin bienvenida (+24 h)`,
  );
  return send('sendPresentationEmailOverdue', teacher, subject, html);
}

// ═══ E) Recordatorios escalonados del email de presentación ═══════════════════
// Tres umbrales, disparados por el cron con anti-duplicados en columnas
// (presentation_reminder_{4h,12h,24h}_sent). El copy es fijo por especificación.

// 4 h — recordatorio al profesor.
export async function sendPresentationReminder4h(teacher: TeacherLike, studentName: string): Promise<boolean> {
  const subject = `Recordatorio: email pendiente · ${studentName}`;
  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(`Llevas <strong>4 horas</strong> sin enviar el email de presentación a <strong>${esc(studentName)}</strong>. Los alumnos que reciben bienvenida pronto tienen mayor retención.`) +
    ctaButton('Enviar ahora', APP_URL),
    `${studentName} sigue sin email de bienvenida`,
  );
  return send('sendPresentationReminder4h', teacher, subject, html);
}

// 12 h — aviso urgente al profesor.
export async function sendPresentationReminder12h(teacher: TeacherLike, studentName: string): Promise<boolean> {
  const subject = `Urgente: email pendiente · ${studentName}`;
  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(`Llevas <strong>12 horas</strong> sin enviar el email de presentación a <strong>${esc(studentName)}</strong>. Te quedan menos de 12 horas para enviarlo sin afectar tu scoring.`) +
    ctaButton('Enviar ahora', APP_URL),
    `${studentName} · quedan menos de 12 h`,
  );
  return send('sendPresentationReminder12h', teacher, subject, html);
}

// 24 h — email fuera de plazo (al enviarlo se descuentan -5 puntos).
export async function sendPresentationReminder24h(teacher: TeacherLike, studentName: string): Promise<boolean> {
  const subject = `Email fuera de plazo · ${studentName}`;
  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(`Han pasado más de <strong>24 horas</strong> sin enviar el email de presentación a <strong>${esc(studentName)}</strong>. Cuando lo envíes se descontarán <strong>-5 puntos</strong> de tu scoring.`) +
    ctaButton('Enviar ahora', APP_URL),
    `${studentName} · email fuera de plazo`,
  );
  return send('sendPresentationReminder24h', teacher, subject, html);
}

// 12 h — aviso al admin.
export async function sendPresentationAdminAlert12h(teacherName: string, studentName: string): Promise<boolean> {
  const subject = `Alerta: ${teacherName} · email sin enviar 12h`;
  const html = baseEmailTemplate(
    p(`<strong>${esc(teacherName)}</strong> lleva 12h sin enviar el email de presentación a <strong>${esc(studentName)}</strong>.`) +
    ctaButton('Ver en DRC Gestión', `${APP_URL}/admin`),
    `${teacherName} · email sin enviar 12 h`,
  );
  return sendToAddress('sendPresentationAdminAlert12h', ADMIN_EMAIL, subject, html);
}

// 24 h — aviso al admin (fuera de plazo).
export async function sendPresentationAdminAlert24h(teacherName: string, studentName: string): Promise<boolean> {
  const subject = `🔴 ${teacherName} · email fuera de plazo`;
  const html = baseEmailTemplate(
    p(`<strong>${esc(teacherName)}</strong> no envió el email de presentación a <strong>${esc(studentName)}</strong> en 24 horas.`) +
    ctaButton('Ver en DRC Gestión', `${APP_URL}/admin`),
    `${teacherName} · email fuera de plazo`,
  );
  return sendToAddress('sendPresentationAdminAlert24h', ADMIN_EMAIL, subject, html);
}

// ═══ F/G/H) Hitos de clase ════════════════════════════════════════════════════
export type MilestoneNumber = 15 | 30 | 50;

const MILESTONE_COPY: Record<MilestoneNumber, { subject: (s: string) => string; intro: string; bullets: string[] }> = {
  15: {
    subject: s => `Clase 15 con ${s} · acción requerida`,
    intro: '{S} está llegando a la clase 15.',
    bullets: ['Grabar la sesión con Fathom', 'Subir el enlace al Excel correspondiente', 'Aprovechar para pedir una reseña en Trustpilot'],
  },
  30: {
    subject: s => `Clase 30 con ${s}`,
    intro: '{S} llega a la clase 30. Un logro importante para ambos.',
    bullets: ['Graba la sesión con Fathom', 'Sube el enlace al Excel correspondiente'],
  },
  50: {
    subject: s => `Clase 50 con ${s}`,
    intro: '{S} llega a la clase 50. Un hito extraordinario.',
    bullets: ['Graba la sesión con Fathom', 'Sube el enlace al Excel correspondiente'],
  },
};

export async function sendMilestoneEmail(
  teacher: TeacherLike, studentName: string, milestone: MilestoneNumber,
): Promise<boolean> {
  const c = MILESTONE_COPY[milestone];
  if (!c) return false;
  // Los links salen de lib/milestones.ts: una sola fuente de verdad con la app.
  const slides = MILESTONE_SLIDES[milestone];

  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(c.intro.replace('{S}', `<strong>${esc(studentName)}</strong>`)) +
    p('En esta clase es importante:') +
    `<ul style="margin:0 0 16px; padding-left:20px;">${c.bullets.map(b => `<li style="margin-bottom:6px;">${esc(b)}</li>`).join('')}</ul>` +
    p(`Las diapositivas de la clase ${milestone} están disponibles en DRC Gestión.`) +
    (slides ? ctaButton(`Ver diapositivas de clase ${milestone}`, slides) : ''),
    `${studentName} · clase ${milestone}`,
  );
  return send('sendMilestoneEmail', teacher, c.subject(studentName), html);
}

// ═══ I) Bono de 6 meses ═══════════════════════════════════════════════════════
export async function sendBonusAvailableEmail(teacher: TeacherLike, studentName: string): Promise<boolean> {
  const subject = `Bono de retención disponible · ${studentName}`;
  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(`<strong>${esc(studentName)}</strong> lleva 6 meses contigo. Tienes derecho a solicitar el bono de retención.`) +
    p('Para solicitarlo, escribe a:') +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;">
  <tr><td align="center" style="background-color:#FFF9E0; border:1px solid #FFC400; border-radius:8px; padding:14px;">
    <a href="mailto:${PAGOS_EMAIL}" style="font-size:16px; font-weight:600; color:#1E9E3A; text-decoration:none;">${PAGOS_EMAIL}</a>
  </td></tr>
</table>` +
    p('Indica el nombre del alumno y la fecha de inicio de la suscripción.'),
    `Bono disponible por ${studentName}`,
  );
  return send('sendBonusAvailableEmail', teacher, subject, html);
}

// ═══ K) Recordatorio diario: transcripts pendientes ═══════════════════════════
//
// Lo dispara el cron de fin de día (app/api/cron/daily-transcript-reminder) con
// las clases que HOY entraron a finanzas por el ingreso pero siguen sin
// transcript: están en "pendiente" y todavía no se cobran.
//
// UN email por profesor con TODAS sus clases del día, nunca uno por clase.

export interface PendingTranscriptClass {
  studentName: string;
  /** Hora de la clase ("17:00" o "17:00 - 19:00" si fue sesión de 2h). */
  hours?: string;
  /**
   * El equipo rechazó el transcript que subió: no es que falte, es que hay que
   * subir otro. Se dice en la propia línea del alumno para no acusarlo de no
   * haberlo subido cuando sí lo hizo.
   */
  rejected?: boolean;
}

/**
 * El texto del correo es fijo y está escrito sin guiones como conectores, pero
 * pasa igual por cleanAiText: si alguien edita la copia más adelante y mete un
 * "y así — ya está", se limpia solo en vez de llegar así al profesor.
 *
 * Los NOMBRES no se limpian: un nombre no es prosa y "Pérez-López" tiene que
 * salir tal cual.
 */
const copy = (s: string): string => cleanAiText(s);

export async function sendDailyTranscriptReminder(
  teacher: TeacherLike, classes: PendingTranscriptClass[],
): Promise<boolean> {
  if (classes.length === 0) return false;   // sin clases pendientes no se escribe

  const subject = 'Recuerda subir los transcripts de hoy';
  const varias = classes.length > 1;
  // Si TODAS son rechazadas, el profesor sí subió algo: la frase no puede decir
  // que no lo ha subido.
  const todasRechazadas = classes.every(c => c.rejected);
  const falta = todasRechazadas ? 'no has subido un transcript válido' : 'no has subido el transcript';
  const nota = (c: PendingTranscriptClass) =>
    c.rejected ? ' <span style="color:#9a6516;">· el equipo pidió otro transcript</span>' : '';

  // Un alumno → en la misma frase. Varios → lista con viñetas en amarillo DRC.
  const lista = varias
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;">
  <tr><td style="background-color:#FFF9E0; border-left:4px solid #FFC400; border-radius:8px; padding:14px 18px;">
${classes.map(c => `    <div style="font-size:14px; color:#1A1A1A; padding:3px 0;">• <strong>${esc(c.studentName)}</strong>${c.hours ? ` <span style="color:#888880;">· ${esc(c.hours)}</span>` : ''}${nota(c)}</div>`).join('\n')}
  </td></tr>
</table>`
    : '';

  const intro = varias
    ? copy(`Hoy has dado clase con estos alumnos y todavía ${falta} de esas clases:`)
    : `${copy('Hoy has dado clase con')} <strong>${esc(classes[0].studentName)}</strong>${classes[0].hours ? ` (${esc(classes[0].hours)})` : ''} ${copy(`y todavía ${falta} de esa clase.`)}`;

  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)}:`) +
    p(intro) +
    lista +
    p(copy('Recuerda que para que la clase quede aprobada y puedas cobrarla, tienes que subir el transcript. Si se te ha olvidado, entra en Fathom, copia el transcript de la clase y pégalo en la ficha del alumno.')) +
    p(copy('Es rápido y así te aseguras de que todas tus clases queden registradas y se te paguen.')) +
    ctaButton('Subir transcript', `${APP_URL}/mis-clases`) +
    p(`${copy('Un saludo,')}<br />${copy('Equipo DRC Academy')}`),
    varias
      ? `${classes.length} clases de hoy sin transcript`
      : `La clase con ${classes[0].studentName} sigue sin transcript`,
  );

  return send('sendDailyTranscriptReminder', teacher, subject, html);
}

// ═══ J) Circular del admin ════════════════════════════════════════════════════
function circularHtml(teacher: TeacherLike, notification: { title: string; body: string }): string {
  return baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(esc(notification.body).replace(/\n/g, '<br />')) +
    p('Este mensaje ha sido enviado por el equipo de DRC Academy.'),
    notification.title,
  );
}

export async function sendCircularEmail(
  teacher: TeacherLike, notification: { title: string; body: string },
): Promise<boolean> {
  return send('sendCircularEmail', teacher, notification.title, circularHtml(teacher, notification));
}

/**
 * Circular a varios profesores en UNA sola petición (Resend batch, máx. 100).
 *
 * Enviar uno a uno en paralelo choca con el rate limit de Resend (2 req/s): las
 * peticiones que lo exceden vuelven con `rate_limit_exceeded` y esos profesores
 * se quedan sin el correo. El batch va en una única llamada.
 */
export async function sendCircularBatch(
  teachers: TeacherLike[], notification: { title: string; body: string },
): Promise<number> {
  const destinatarios = teachers
    .map(t => ({ teacher: t, to: destinationFor(t) }))
    .filter(({ teacher, to }) => {
      if (!to) {
        console.error(`[EMAIL] circular: ${teacher.name} no tiene email de destino.`);
        return false;
      }
      return true;
    });

  if (destinatarios.length === 0) return 0;

  console.log('[EMAIL] Enviando circular en batch:', {
    total: destinatarios.length,
    subject: notification.title,
    resendKeyExists: Boolean(process.env.RESEND_API_KEY),
    usingPlaceholder: !hasResendKey(),
  });

  try {
    const { data, error } = await resend.batch.send(
      destinatarios.map(({ teacher, to }) => ({
        from: FROM,
        to,
        subject: notification.title,
        html: circularHtml(teacher, notification),
      })),
    );

    if (error) {
      console.error('[EMAIL] circular: Resend devolvió error en el batch:', {
        name: error.name, message: error.message,
      });
      return 0;
    }
    const enviados = data?.data?.length ?? destinatarios.length;
    console.log(`[EMAIL] circular: ${enviados} email(s) aceptados por Resend.`);
    return enviados;
  } catch (err) {
    console.error('[EMAIL] circular: excepción en el batch:', err);
    return 0;
  }
}

// ═══ J) Fin de plan: aviso INTERNO al equipo de ventas ════════════════════════
//
// Un SOLO email por corrida con todos los alumnos que entran en la ventana, no
// uno por alumno. Son pocos (mirando las fechas reales, uno o dos por semana) y
// varios correos sueltos el mismo día se pisan en la bandeja: la lista junta se
// lee de un vistazo y se prioriza mejor, que es justo lo que tiene que hacer
// ventas con esto.
//
// No lleva teléfono a propósito: `students.phone` está vacío en los 184 alumnos
// y el que devuelve WooCommerce solo llega para las suscripciones, nunca para
// los intensivos, que son la mayoría de esta lista. Prometer una columna que
// saldría en blanco es peor que no ponerla.

/** Enlace a la ficha del alumno DENTRO de "Alumnos", que es la que admin y
 *  setter pueden abrir (/mis-alumnos es del profesor). El buscador de la página
 *  deja al alumno solo en pantalla, con su progreso y su riesgo a la vista. */
export function studentFichaUrl(plan: Pick<EndingPlan, 'studentEmail' | 'studentName'>): string {
  const q = plan.studentEmail || plan.studentName;
  return `${APP_URL}/students?q=${encodeURIComponent(q)}`;
}

function endingPlanBlock(plan: EndingPlan): string {
  const dias = plan.daysLeft === 0 ? 'hoy'
    : plan.daysLeft === 1 ? 'en 1 día'
    : `en ${plan.daysLeft} días`;

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px; border-left:3px solid #FFC400; background:#F7F7F5; border-radius:6px;">
  <tr><td style="padding:14px 16px;">
    <p style="margin:0 0 10px; font-size:15px;">
      <strong>${esc(plan.studentName)}</strong> termina su plan ${esc(dias)} (${esc(longDateEs(plan.endDate))}).
    </p>
${dataRows([
  ['Tipo de plan', plan.planLabel],
  ['Cómo viene',   retentionLine(plan)],
])}
    <a href="${esc(studentFichaUrl(plan))}" target="_blank" style="font-size:14px; font-weight:600; color:#1E9E3A; text-decoration:none;">Ver la ficha de ${esc(plan.studentName.split(' ')[0])} &rsaquo;</a>
  </td></tr>
</table>`;
}

/**
 * Aviso interno de alumnos próximos a terminar su plan. Devuelve true solo si
 * Resend lo aceptó: el cron NO marca el aviso como enviado si esto da false, así
 * que un fallo de email hace que se reintente mañana en vez de perderse.
 */
export async function sendEndingPlansDigest(plans: EndingPlan[]): Promise<boolean> {
  if (plans.length === 0) return false;

  const subject = plans.length === 1
    ? `Alumno próximo a terminar su plan: ${plans[0].studentName}`
    : `${plans.length} alumnos próximos a terminar su plan`;

  const intro = plans.length === 1
    ? p('Este alumno termina su plan esta semana. Es el momento de ofrecerle continuidad.')
    : p(`Estos <strong>${plans.length} alumnos</strong> terminan su plan esta semana. Están ordenados por urgencia: el primero es el que menos tiempo tiene.`);

  const cierre = p(
    'Contacta por WhatsApp de forma personalizada usando lo que muestra su ficha (qué ha mejorado, en qué sigue flojo) ' +
    'para proponerle plan de mantenimiento (1h o 2h semanales) o un nuevo intensivo. ' +
    '<strong>Recuerda: sin suscripción activa no podrá recuperar clases pendientes.</strong>',
  );

  const html = baseEmailTemplate(
    intro + plans.map(endingPlanBlock).join('') + cierre +
    ctaButton('Ver Próximos a cancelar', `${APP_URL}/proximos-cancelar`),
    plans.length === 1
      ? `${plans[0].studentName} termina su plan en ${plans[0].daysLeft} días`
      : `${plans.length} alumnos terminan su plan esta semana`,
  );

  return sendToAddress('sendEndingPlansDigest', ADMIN_EMAIL, subject, html);
}
