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

const FROM = 'DRC Academy <notificaciones@drcacademy.com>';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || 'https://academy-scheduler-aqpt.vercel.app';
const PAGOS_EMAIL = 'pagos@drcacademy.com';

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
async function send(
  label: string, teacher: TeacherLike, pref: EmailPrefKey,
  subject: string, html: string,
): Promise<boolean> {
  const to = destinationFor(teacher);
  if (!to) {
    console.error(`[EMAIL] ${label}: el profesor ${teacher.name} no tiene email de destino.`);
    return false;
  }
  if (!wantsEmail(teacher, pref)) {
    console.log(`[EMAIL] ${label}: omitido — ${teacher.name} desactivó "${pref}".`);
    return false;
  }

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
  return send('sendNewStudentEmail', teacher, 'new_student', subject, html);
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
  return send('sendFormCompletedEmail', teacher, 'form_completed', subject, html);
}

// ═══ C) Email de presentación pendiente (12 h) ════════════════════════════════
export async function sendPresentationEmailReminder(
  teacher: TeacherLike, studentName: string, hoursElapsed: number,
): Promise<boolean> {
  const subject = `Recordatorio: email de presentación pendiente — ${studentName}`;
  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(`Han pasado <strong>${Math.round(hoursElapsed)} horas</strong> desde que se te asignó <strong>${esc(studentName)}</strong> y aún no has enviado el email de presentación.`) +
    p('Los alumnos que reciben una bienvenida rápida tienen mayor retención. Te recomendamos enviarlo cuanto antes.') +
    p('Recuerda que tienes hasta 24 horas para enviarlo sin que afecte a tu scoring.') +
    ctaButton('Ir a DRC Gestión', APP_URL),
    `${studentName} lleva ${Math.round(hoursElapsed)} h sin bienvenida`,
  );
  return send('sendPresentationEmailReminder', teacher, 'presentation_reminder', subject, html);
}

// ═══ D) Email de presentación fuera de tiempo (24 h) ══════════════════════════
export async function sendPresentationEmailOverdue(teacher: TeacherLike, studentName: string): Promise<boolean> {
  const subject = `Email de presentación no enviado — ${studentName}`;
  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(`Han pasado más de <strong>24 horas</strong> desde que se te asignó <strong>${esc(studentName)}</strong> y aún no has enviado el email de presentación.`) +
    p('Cuando lo envíes se registrarán <strong>-5 puntos</strong> en tu scoring.') +
    p('Te recomendamos enviarlo lo antes posible.') +
    ctaButton('Enviar ahora', APP_URL),
    `${studentName} sin bienvenida (+24 h)`,
  );
  return send('sendPresentationEmailOverdue', teacher, 'presentation_reminder', subject, html);
}

// ═══ F/G/H) Hitos de clase ════════════════════════════════════════════════════
export type MilestoneNumber = 15 | 30 | 50;

const MILESTONE_COPY: Record<MilestoneNumber, { subject: (s: string) => string; intro: string; bullets: string[] }> = {
  15: {
    subject: s => `Clase 15 con ${s} — acción requerida`,
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
    `${studentName} — clase ${milestone}`,
  );
  return send('sendMilestoneEmail', teacher, 'milestones', c.subject(studentName), html);
}

// ═══ I) Bono de 6 meses ═══════════════════════════════════════════════════════
export async function sendBonusAvailableEmail(teacher: TeacherLike, studentName: string): Promise<boolean> {
  const subject = `Bono de retención disponible — ${studentName}`;
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
  return send('sendBonusAvailableEmail', teacher, 'bonus', subject, html);
}

// ═══ J) Circular del admin ════════════════════════════════════════════════════
export async function sendCircularEmail(
  teacher: TeacherLike, notification: { title: string; body: string },
): Promise<boolean> {
  const html = baseEmailTemplate(
    p(`Hola ${esc(teacher.name)},`) +
    p(esc(notification.body).replace(/\n/g, '<br />')) +
    p('Este mensaje ha sido enviado por el equipo de DRC Academy.'),
    notification.title,
  );
  return send('sendCircularEmail', teacher, 'circulars', notification.title, html);
}
