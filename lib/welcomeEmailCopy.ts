// Texto del email de bienvenida al alumno (lib/welcomeEmail).
//
// Es EL MISMO email de presentación que hasta sep/2026 copiaba y enviaba el
// profesor desde su Gmail (components/PresentationModal, buildPresentationBody):
// el profesor se presenta en primera persona y firma él. Ahora lo envía la
// plataforma, así que cambian dos cosas:
//   · el enlace de Meet (que en el momento de la asignación todavía no existe)
//     se sustituye por las instrucciones para entrar en el área de alumno del
//     LMS, que es donde el alumno verá el enlace y el botón para unirse;
//   · el formulario inicial y la prueba de nivel van con botón.
//
// Dos variantes: 'bienvenida' (alumno nuevo) y 'cambio' (profesor nuevo). En el
// cambio solo varían el asunto y la frase de presentación. Un alumno tiene un
// solo profesor.
//
// Todo dato que viene de la base pasa por esc(): nombres y emails los teclea
// gente y no deben poder romper el HTML.

import { esc } from '@/lib/emailNotifications';
import { boton, enlaceDeRespaldo, p, studentEmailTemplate } from '@/lib/studentFollowupEmails';
import { g, type Gender } from '@/lib/gender';
import type { WelcomeVariant } from '@/lib/welcomeEmail';

export interface WelcomeCopyInput {
  variant: WelcomeVariant;
  studentName: string;
  /** Género del alumno, solo para el "Bienvenido/a" del asunto. */
  studentGender: Gender;
  teacherName: string;
  /** Género del profesor: "elegido/a", "profesor/a" (lib/gender.resolveGender). */
  teacherGender: Gender;
  /** "nuestra preparación para el examen" / "nuestro programa intensivo" / "el aprendizaje del inglés". */
  planDescription: string;
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
  /** Primera clase con este profesor (hora de España), si el calendario ya la tiene. */
  firstClass: { label: string; hour: string } | null;
}

/** "19:00" → "20:00". Las clases se anuncian de una hora, como en el email original. */
function horaFin(hour: string): string {
  const [h, m] = hour.split(':').map(Number);
  return `${String((h + 1) % 24).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
}

function bloqueArea(i: WelcomeCopyInput): string {
  return [
    p('Todas nuestras clases las tendrás en tu área de alumno de DRC Academy: ahí verás tu calendario y el botón para unirte a cada clase por Meet. (Usaremos el mismo enlace para todas nuestras clases 🙂)'),
    boton('Entrar en mi área', i.lmsUrl),
    p(`Para acceder, escribe este email: <strong>${esc(i.lmsEmail)}</strong>. Te llegará un enlace para entrar al momento, sin contraseña.`),
    enlaceDeRespaldo(i.lmsUrl),
  ].join('\n');
}

function bloquePendiente(pending: NonNullable<WelcomeCopyInput['pending']>): string {
  if (pending.kind === 'formulario') {
    return [
      p('Y antes de nuestro primer encuentro, me gustaría conocerte un poco mejor 💚 Te dejo este breve formulario (son solo unos minutos) para preparar una clase 100% tuya desde el primer minuto:'),
      boton('Completar formulario', pending.url),
      p('Al terminarlo podrás hacer también un pequeño test de nivel: te dirá al instante en qué nivel de inglés te encuentras y nos vendrá muy bien para preparar tu primera clase, así que te recomiendo hacerlo 🙂'),
      enlaceDeRespaldo(pending.url),
    ].join('\n');
  }
  return [
    p('Y antes de nuestro primer encuentro, te recomiendo hacer este pequeño test de nivel: te dirá al instante en qué nivel de inglés te encuentras y nos vendrá muy bien para preparar tu primera clase 🙂'),
    boton('Hacer el test de nivel', pending.url),
    enlaceDeRespaldo(pending.url),
  ].join('\n');
}

export function buildWelcomeEmail(i: WelcomeCopyInput): { subject: string; html: string } {
  const alumno = esc(i.studentName);
  const profesor = esc(i.teacherName);
  const tg = i.teacherGender;
  const cargo = g(tg, 'profesor', 'profesora', 'profesor/a');

  const subject = i.variant === 'bienvenida'
    ? `¡${g(i.studentGender, 'Bienvenido', 'Bienvenida', 'Bienvenido/a')} a DRC Academy, ${i.studentName}!`
    : `Tu ${g(tg, 'nuevo profesor', 'nueva profesora', 'nuevo/a profesor/a')} en DRC Academy, ${i.studentName}`;

  const presentacion = i.variant === 'bienvenida'
    ? `¡Es un placer saludarte! Mi nombre es ${profesor} y he sido ${g(tg, 'elegido', 'elegida', 'elegido/a')} como tu ${cargo} en DRC Academy.`
    : `¡Es un placer saludarte! Mi nombre es ${profesor} y, a partir de ahora, seré tu ${cargo} en DRC Academy.`;

  const primeraClase = i.firstClass
    ? `Será un gusto conocerte en nuestra primera clase el ${esc(i.firstClass.label)} de ${esc(i.firstClass.hour)} a ${esc(horaFin(i.firstClass.hour))}h.`
    : 'Será un gusto conocerte en nuestra primera clase.';

  const body = [
    p(`¡Buenos días, ${alumno}!`),
    p(presentacion),
    p(primeraClase),
    p(`¡Juntos continuaremos con ${esc(i.planDescription)} y nos divertiremos en el proceso!`),
    bloqueArea(i),
    i.pending ? bloquePendiente(i.pending) : '',
    p('Si pudieras confirmar que has recibido este email, ¡te lo agradecería mucho!'),
    p(`¡Un saludo!<br />${profesor}`),
  ].join('\n');

  const preview = `${i.teacherName} será tu ${g(tg, 'profesor', 'profesora', 'profesor/a')} en DRC Academy.`;
  return { subject, html: studentEmailTemplate(body, preview, { inviteReplyInFooter: false }) };
}
