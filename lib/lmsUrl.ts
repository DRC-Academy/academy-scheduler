// URL del LMS (DRC Práctica). Única fuente para los enlaces que llevan al alumno
// a su área: el botón de la ficha de progreso y el email de bienvenida.
//
// DOS VARIABLES, Y NO ES CAPRICHO. `process.env.LMS_URL` solo existe en el
// servidor: en un componente de cliente llega como undefined, porque Next solo
// incrusta en el bundle las variables con prefijo NEXT_PUBLIC_. Por eso:
//   · servidor (emails, rutas)  → LMS_URL
//   · navegador (componentes)   → NEXT_PUBLIC_LMS_URL
// Las dos caen en el mismo respaldo si faltan.
//
// lib/lmsDiploma NO usa esto a propósito: allí, sin LMS_URL (y sin su secreto)
// la barra del diploma se apaga, y un respaldo la encendería contra un LMS que
// quizá no es el configurado.

/** Dominio público del LMS. Respaldo si la variable no está puesta. */
export const LMS_FALLBACK_URL = 'https://drc-lms.vercel.app';

const limpiar = (raw: string | undefined): string | null => {
  const t = (raw ?? '').trim().replace(/\/+$/, '');
  if (!t) return null;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
};

/** URL del LMS para código de SERVIDOR (sin barra final). */
export function lmsUrlServer(): string {
  return limpiar(process.env.LMS_URL) ?? LMS_FALLBACK_URL;
}

/**
 * URL del LMS para el NAVEGADOR (sin barra final). La referencia a
 * process.env.NEXT_PUBLIC_LMS_URL tiene que ir escrita literal para que Next la
 * sustituya al compilar.
 */
export const LMS_PUBLIC_URL: string = limpiar(process.env.NEXT_PUBLIC_LMS_URL) ?? LMS_FALLBACK_URL;

/** Pantalla de acceso del LMS: el alumno escribe su email y recibe el enlace. */
export function lmsAccesoUrl(): string {
  return `${lmsUrlServer()}/acceso`;
}
