// Emails AL ALUMNO del flujo "No puedo dar esta clase" y del cambio pedido por
// el alumno. SOLO SERVIDOR.
//
// Escritos en primera persona del profesor, tuteo y español de España. Llevan el
// pie "No respondas a este email, es automático" y se envían SIN reply-to: el
// alumno responde desde el LMS (el botón), no por correo.
//
// Best-effort como el resto de emails del proyecto: devuelven true/false y nunca
// lanzan.

import 'server-only';

import { resend } from '@/lib/resend';
import { esc } from '@/lib/emailNotifications';
import { FROM, studentEmailTemplate, boton, p, enlaceDeRespaldo, primerNombre } from '@/lib/studentFollowupEmails';
import { claseDe, cuandoEs, fechaLarga, normalizeHour, type Slot } from '@/lib/classRecoveries';
import { lmsUrlServer } from '@/lib/lmsUrl';

/** Enlace del botón: la pantalla "Mis clases" del LMS con la recuperación abierta. */
export function recoveryLink(recoveryId: string): string {
  return `${lmsUrlServer()}/mis-clases?recuperacion=${encodeURIComponent(recoveryId)}`;
}

/** "el lunes 12 de octubre a las 17:00 o el martes 13 de octubre a las 19:00" */
function opciones(slots: Slot[]): string {
  return slots.map(cuandoEs).join(' o ');
}

export interface CancellationEmailInput {
  studentName: string;
  teacherName: string;
  original: { date: string; hour: string };
  todayIso: string;
  /** Una entrada por trozo a recuperar (2 en una sesión partida), con su id. */
  parts: Array<{ recoveryId: string; proposals: Slot[] }>;
  /** "Ya lo acordé con el alumno": la fecha ya está fijada. */
  agreed: boolean;
}

export function buildCancellationEmail(i: CancellationEmailInput): { subject: string; html: string } {
  const nombre = primerNombre(i.studentName) || i.studentName;
  const profe = primerNombre(i.teacherName) || i.teacherName;
  const clase = claseDe(i.original.date, i.todayIso);
  const firma = p(`Un abrazo,<br />${esc(profe)}`);

  if (i.agreed) {
    const cuando = i.parts.map(pt => cuandoEs(pt.proposals[0])).join(' y ');
    return {
      subject: `Tu clase se recupera ${cuando}`,
      html: studentEmailTemplate(
        p(`Hola ${esc(nombre)},`) +
        p(`he tenido que cancelar ${esc(clase)}. Como acordamos, la recuperamos ${esc(cuando)}.`) +
        p('Ya la tienes en tu calendario de clases.') +
        firma,
        `Recuperamos ${clase} ${cuando}`,
        { noReply: true },
      ),
    };
  }

  const link = recoveryLink(i.parts[0].recoveryId);
  const propuesta = i.parts.length === 1
    ? `Te propongo ${opciones(i.parts[0].proposals)}.`
    : `Como era una clase de dos horas, te propongo recuperarla en dos días: para la primera hora, ${opciones(i.parts[0].proposals)}; y para la segunda, ${opciones(i.parts[1].proposals)}.`;
  return {
    subject: `He tenido que cancelar ${clase}`,
    html: studentEmailTemplate(
      p(`Hola ${esc(nombre)},`) +
      p(`he tenido que cancelar ${esc(clase)} por un imprevisto. ${esc(propuesta)}`) +
      p('Elige aquí la que prefieras:') +
      boton('Elegir fecha', link) +
      p('Si ninguna te viene bien, desde el mismo enlace puedes proponerme otros horarios.') +
      firma +
      enlaceDeRespaldo(link),
      `He tenido que cancelar ${clase}: elige cuándo la recuperamos`,
      { noReply: true },
    ),
  };
}

/** El alumno eligió (o el profe aceptó) una fecha: confirmación al alumno. */
export function buildConfirmedEmail(i: {
  studentName: string; teacherName: string; original: { date: string; hour: string }; chosen: { date: string; hour: string };
}): { subject: string; html: string } {
  const nombre = primerNombre(i.studentName) || i.studentName;
  const cuando = cuandoEs(i.chosen);
  return {
    subject: `Recuperación confirmada: ${cuando}`,
    html: studentEmailTemplate(
      p(`Hola ${esc(nombre)},`) +
      p(`queda confirmada la recuperación de la clase del ${esc(fechaLarga(i.original.date))}: nos vemos ${esc(cuando)}.`) +
      p(`Un abrazo,<br />${esc(primerNombre(i.teacherName) || i.teacherName)}`),
      `Recuperación confirmada ${cuando}`,
      { noReply: true },
    ),
  };
}

/**
 * Control del "El alumno pidió cambiarla": hoy esos cambios no le llegaban al
 * alumno. Si no lo pidió él, nos escribe.
 */
export function buildRescheduleControlEmail(i: {
  studentName: string; teacherName: string; originalDate: string; originalHour: string;
  newDates: Array<{ date: string; hour: string }>;
}): { subject: string; html: string } {
  const nombre = primerNombre(i.studentName) || i.studentName;
  const profe = primerNombre(i.teacherName) || i.teacherName;
  const orig = cuandoEs({ date: i.originalDate, hour: i.originalHour }).replace(/^el /, '');
  const nuevas = i.newDates.map(d => cuandoEs(d).replace(/^el /, '')).join(' y al ');
  return {
    subject: 'Hemos registrado un cambio en tu clase',
    html: studentEmailTemplate(
      p(`Hola ${esc(nombre)},`) +
      p(`${esc(profe)} ha registrado que pediste cambiar tu clase del ${esc(orig)} al ${esc(nuevas)}.`) +
      p('Si no lo pediste tú, escríbenos a <a href="mailto:alumnos@drcacademy.com" style="color:#1E9E3A;">alumnos@drcacademy.com</a>.'),
      'Cambio registrado en tu clase',
      { noReply: true },
    ),
  };
}

/**
 * Envío sin reply-to. `cc` (el email de la asignación, si es otro) es opcional.
 * `idempotencyKey`: Resend no envía dos veces la misma clave (reintentos, doble clic).
 */
export async function sendStudentEmail(
  label: string, to: string, subject: string, html: string, cc?: string | null, idempotencyKey?: string,
): Promise<boolean> {
  try {
    const { data, error } = await resend.emails.send({
      from: FROM, to, subject, html,
      ...(cc && cc !== to ? { cc } : {}),
    }, idempotencyKey ? { idempotencyKey } : undefined);
    if (error) {
      console.error(`[EMAIL] ${label}: Resend devolvió error:`, { name: error.name, message: error.message, to });
      return false;
    }
    console.log(`[EMAIL] ${label}: enviado:`, { id: data?.id, to });
    return true;
  } catch (err) {
    console.error(`[EMAIL] ${label}: excepción al enviar:`, err);
    return false;
  }
}

/** "17:00" para textos cortos. */
export const horaCorta = (h: string) => normalizeHour(h) ?? h;
