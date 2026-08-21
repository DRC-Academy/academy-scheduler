// ── ¿Este texto se le puede enseñar al alumno? ───────────────────────────────
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// La ficha de IA (`student_profiles`) está escrita PARA EL PROFESOR. Cuando el
// alumno no ha completado el formulario, la IA no se inventa una ficha: escribe
// notas de trabajo dirigidas al profesor, y esas notas caían enteras en la página
// pública de progreso. Un alumno real abría su enlace y leía, bajo el título
// "Tu objetivo":
//
//   "No especificado: el alumno respondió '1' a la pregunta sobre su motivación.
//    Conviene preguntárselo directamente al inicio de la primera clase."
//
// y, bajo "En qué estamos trabajando":
//
//   "Dado que la ficha está incompleta, la prioridad de las primeras clases es
//    doble: (1) completar el diagnóstico real (ocupación, objetivo…)"
//
// Son notas internas delante de un cliente que paga. Este módulo las corta.
//
// EL CRITERIO ES ASIMÉTRICO A PROPÓSITO. Esconder de más deja una tarjeta vacía,
// que simplemente no se pinta y no le cuesta nada a nadie. Enseñar de menos deja
// al descubierto cómo hablamos del alumno cuando no nos oye. Ante la duda, se
// esconde.
//
// ESTO NO ARREGLA EL ORIGEN. La ficha se sigue generando en tercera persona; lo
// que corresponde a largo plazo es que el prompt escriba aparte una versión para
// el alumno. Mientras tanto, esto es el cortafuegos.

/**
 * Marcas de que el texto habla DEL alumno (y no AL alumno) o de que confiesa que
 * faltan datos. Se evalúan sobre el texto normalizado (sin tildes, minúsculas).
 */
const INTERNAL_MARKERS: RegExp[] = [
  // Habla del alumno o del profesor en tercera persona.
  /\b(el|la|del|al)\s+alumn[oa]\b/,
  /\bl[oa]s\s+alumn[oa]s\b/,
  /\b(el|la|del|al)\s+(profesor|profesora|docente)\b/,
  // Se refiere a los papeles internos.
  /\b(la|su|una)\s+ficha\b/,
  /\bficha\s+(incompleta|vacia|sin)\b/,
  /\bdiagnostic[oa]\b/,
  /\bformulario\s+(inicial|sin|no)\b/,
  // Confiesa que no hay datos.
  /\bno\s+especificad[oa]\b/,
  /\bsin\s+especificar\b/,
  /\bno\s+se\s+puede\s+determinar\b/,
  /\bsin\s+determinar\b/,
  /\bfalta[n]?\s+(informacion|datos|dato)\b/,
  /\bno\s+hay\s+(informacion|datos)\b/,
  /\bno\s+respondio\b/,
  /\brespondio\s*["'‘’]?\s*\d/,
  // Le da instrucciones al profesor.
  /\bconviene\s+(pregunt|indagar|averiguar|confirmar)/,
  /\bhabria\s+que\s+pregunt/,
  /\bhay\s+que\s+pregunt/,
];

function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * True si el texto se le puede enseñar al alumno tal cual.
 *
 * El texto vacío devuelve false: no hay nada que enseñar, y así quien llame no
 * tiene que comprobar el vacío por su cuenta.
 */
export function isForStudent(text: string | null | undefined): boolean {
  const raw = (text ?? '').trim();
  if (!raw) return false;
  const t = normalize(raw);
  return !INTERNAL_MARKERS.some(re => re.test(t));
}

/** Se queda con las frases que sí puede leer el alumno. */
export function keepForStudent(items: string[]): string[] {
  return items.filter(isForStudent);
}

/** El texto si es publicable, o null. Pensado para decidir si se pinta una tarjeta. */
export function forStudentOrNull(text: string | null | undefined): string | null {
  return isForStudent(text) ? (text as string).trim() : null;
}
