// Textos del cambio de horario. Módulo PURO (sin Resend ni Supabase): lo usan el
// núcleo (campanita), el correo al profesor y el correo al alumno.
//
// Profesor: el aviso describe el hecho sin tutear ni vosear ("Ana cambió…"), y
// el correo sigue el registro de los correos a profesores de
// lib/emailNotifications.ts (tú).
// Alumno: español de España, tú, cálido, con la aclaración de que las horas son
// de España peninsular.

import { fechaLarga } from '@/lib/classRecoveries';
import { primerNombre } from '@/lib/nombres';

export interface SesionTexto { dia: string; hora: string; duracion: number }

export interface DatosCambioTexto {
  alumno: string;
  profesor: string;
  modo: 'puntual' | 'fijo';
  antes: SesionTexto;
  despues: SesionTexto;
  /** PUNTUAL: la clase que se mueve. */
  fechaOriginal: string | null;
  /** PUNTUAL: la fecha nueva. FIJO: la primera clase con el horario nuevo. */
  fechaNueva: string | null;
}

const finDe = (s: SesionTexto) => `${String(parseInt(s.hora, 10) + s.duracion).padStart(2, '0')}:00`;

/** "los martes de 15:00 a 17:00" */
export function horarioFijo(s: SesionTexto): string {
  const plural = s.dia === 'Sábado' ? 'sábados' : `${s.dia.toLowerCase()}`;
  return `los ${plural} de ${s.hora} a ${finDe(s)}`;
}

/** "el martes 13 de octubre de 15:00 a 17:00" */
export function claseConcreta(fecha: string, s: SesionTexto): string {
  return `el ${fechaLarga(fecha)} de ${s.hora} a ${finDe(s)}`;
}

/** Campanita (y asunto/cuerpo del correo) para el PROFESOR. */
export function avisoProfesor(d: DatosCambioTexto): { title: string; body: string } {
  if (d.modo === 'fijo') {
    return {
      title: `🔁 ${d.alumno} cambió su horario fijo`,
      body: `${d.alumno} cambió su horario desde la plataforma: pasa de ${horarioFijo(d.antes)} a ${horarioFijo(d.despues)}`
          + `${d.fechaNueva ? `. La primera clase con el horario nuevo es el ${fechaLarga(d.fechaNueva)}` : ''}. `
          + 'El calendario ya está actualizado.',
    };
  }
  return {
    title: `📅 ${d.alumno} movió una clase`,
    body: `${d.alumno} movió solo la clase del ${fechaLarga(d.fechaOriginal ?? '')} (de ${d.antes.hora} a ${finDe(d.antes)}) `
        + `al ${fechaLarga(d.fechaNueva ?? '')} (de ${d.despues.hora} a ${finDe(d.despues)}). El resto de su horario no cambia. `
        + 'El calendario ya lo muestra como recuperación.',
  };
}

/**
 * Correo de confirmación al ALUMNO: asunto, texto de vista previa y párrafos en
 * HTML. Los nombres pasan por `esc` (lo pasa quien envía, para no traer aquí el
 * módulo de correo); el resto del texto es propio.
 */
export function correoAlumno(d: DatosCambioTexto, esc: (s: unknown) => string = String): { subject: string; preview: string; parrafos: string[] } {
  const nombre = esc(primerNombre(d.alumno) || d.alumno);
  const profe = esc(primerNombre(d.profesor) || d.profesor);
  if (d.modo === 'fijo') {
    return {
      subject: 'Tu nuevo horario de clases',
      preview: `Tus clases pasan a ser ${horarioFijo(d.despues)}`,
      parrafos: [
        `Hola ${nombre},`,
        `¡Hecho! Tus clases de ${horarioFijo(d.antes)} pasan a ser ${horarioFijo(d.despues)}.`
          + (d.fechaNueva ? ` La primera con el horario nuevo será el ${fechaLarga(d.fechaNueva)}.` : ''),
        `${profe} ya lo tiene en su calendario, así que no tienes que hacer nada más.`,
        'Las horas son de España peninsular.',
        'Un abrazo,<br />El equipo de DRC Academy',
      ],
    };
  }
  return {
    subject: `Hemos movido tu clase del ${fechaLarga(d.fechaOriginal ?? '')}`,
    preview: `Tu clase pasa al ${fechaLarga(d.fechaNueva ?? '')} a las ${d.despues.hora}`,
    parrafos: [
      `Hola ${nombre},`,
      `¡Listo! Tu clase del ${fechaLarga(d.fechaOriginal ?? '')} de ${d.antes.hora} a ${finDe(d.antes)} se mueve, solo esa vez, `
        + `al ${fechaLarga(d.fechaNueva ?? '')} de ${d.despues.hora} a ${finDe(d.despues)}.`,
      `El resto de tus clases siguen igual. ${profe} ya lo tiene en su calendario.`,
      'Las horas son de España peninsular.',
      'Un abrazo,<br />El equipo de DRC Academy',
    ],
  };
}
