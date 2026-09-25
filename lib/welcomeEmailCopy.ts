// Textos del email de bienvenida al alumno: dos variantes (lib/welcomeEmail),
// bienvenida y cambio de profesor. Un alumno tiene un solo profesor.
//
// Español de España, tuteo. Mismo sobre y mismo botón verde que los follow-ups
// del alumno (lib/studentFollowupEmails), sin el "responde a este correo" del
// pie porque aquí ya va en el cuerpo.
//
// Todo dato que viene de la base pasa por esc(): nombres y emails los teclea
// gente y no deben poder romper el HTML.

import { esc } from '@/lib/emailNotifications';
import { boton, enlaceDeRespaldo, p, primerNombre, studentEmailTemplate } from '@/lib/studentFollowupEmails';
import type { WelcomeVariant } from '@/lib/welcomeEmail';

export interface WelcomeCopyInput {
  variant: WelcomeVariant;
  studentName: string;
  teacherName: string;
  /** El email con el que el alumno entra al LMS (students.email normalizado). */
  lmsEmail: string;
  /** Pantalla de acceso del LMS. */
  lmsUrl: string;
  /**
   * Lo que le falta de la prueba de nivel, o null si ya lo hizo todo:
   *   · 'formulario' → formulario + prueba (el formulario la ofrece al final);
   *   · 'prueba'     → el formulario ya está, solo le falta la prueba.
   */
  pending: { kind: 'formulario' | 'prueba'; url: string } | null;
  /** Primera clase con este profesor, si el calendario ya la tiene. */
  firstClass: { label: string; hour: string } | null;
}

const h2 = (text: string) =>
  `<p style="margin:24px 0 8px; font-size:16px; font-weight:700; color:#1A1A1A;">${text}</p>`;

function bloqueAcceso(i: WelcomeCopyInput, titulo: string | null, intro: string): string {
  return [
    titulo ? h2(titulo) : '',
    p(intro),
    boton('Entrar en mi área', i.lmsUrl),
    p(`Para acceder, escribe este email: <strong>${esc(i.lmsEmail)}</strong>. Te llegará un enlace para entrar al momento, sin contraseña.`),
    enlaceDeRespaldo(i.lmsUrl),
  ].join('\n');
}

function bloquePendiente(pending: NonNullable<WelcomeCopyInput['pending']>, numero: string): string {
  const esFormulario = pending.kind === 'formulario';
  return [
    h2(esFormulario
      ? `${numero}Completa tu formulario inicial y la prueba de nivel`
      : `${numero}Haz tu prueba de nivel`),
    p(esFormulario
      ? 'Así tu profesor podrá preparar tus clases según tu nivel y tus objetivos. Te llevará unos minutos.'
      : 'Así tu profesor podrá preparar tus clases según tu nivel. Te llevará unos minutos.'),
    boton(esFormulario ? 'Completar formulario' : 'Hacer la prueba de nivel', pending.url),
    enlaceDeRespaldo(pending.url),
  ].join('\n');
}

function lineaPrimeraClase(i: WelcomeCopyInput): string {
  if (!i.firstClass) return '';
  return p(`Tu primera clase es el <strong>${esc(i.firstClass.label)} a las ${esc(i.firstClass.hour)}</strong> (hora peninsular española).`);
}

const DUDAS = p('Si tienes cualquier duda, responde a este correo y te ayudamos.');

export function buildWelcomeEmail(i: WelcomeCopyInput): { subject: string; html: string } {
  const nombre = esc(primerNombre(i.studentName) || i.studentName);
  const profesor = esc(i.teacherName);
  let subject: string;
  let body: string;

  if (i.variant === 'bienvenida') {
    subject = 'Ya tienes profesor en DRC Academy: estos son tus próximos pasos';
    const pasos = i.pending
      ? [
          p('Solo te quedan dos pasos para empezar:'),
          bloquePendiente(i.pending, '1. '),
          bloqueAcceso(i, '2. Entra en tu área de alumno', 'Ahí verás tu próxima clase, tu calendario y el botón para unirte a cada clase.'),
        ]
      : [
          p('Solo te queda un paso para empezar:'),
          bloqueAcceso(i, 'Entra en tu área de alumno', 'Ahí verás tu próxima clase, tu calendario y el botón para unirte a cada clase.'),
        ];
    body = [
      p(`Hola, ${nombre}:`),
      p(`¡Te damos la bienvenida a DRC Academy! Ya tienes profesor asignado: <strong>${profesor}</strong>.`),
      ...pasos,
      lineaPrimeraClase(i),
      DUDAS,
      p('¡Nos vemos en clase!<br />El equipo de DRC Academy'),
    ].join('\n');
  } else {
    subject = 'Tienes nuevo profesor en DRC Academy';
    body = [
      p(`Hola, ${nombre}:`),
      p(`Te escribimos para contarte que, a partir de ahora, tus clases serán con <strong>${profesor}</strong>.`),
      bloqueAcceso(i, null, 'Tu área de alumno sigue igual: ahí verás tu calendario y el botón para unirte a cada clase.'),
      i.pending ? bloquePendiente(i.pending, '') : '',
      lineaPrimeraClase(i),
      DUDAS,
      p('El equipo de DRC Academy'),
    ].join('\n');
  }

  const preview = i.variant === 'bienvenida'
    ? `Tu profesor es ${i.teacherName}. Te contamos cómo empezar.`
    : `Tus clases con ${i.teacherName}: cómo entrar en tu área de alumno.`;
  return { subject, html: studentEmailTemplate(body, preview, { inviteReplyInFooter: false }) };
}
