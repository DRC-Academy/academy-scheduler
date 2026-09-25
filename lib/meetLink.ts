// Enlace de la clase (assignments.meet_link): normalización y validación.
//
// Lo usa la ruta PUT /api/assignments/[assignmentId]/meet-link, que es la única
// que escribe el enlace. La lista de dominios es LA MISMA que acepta el LMS al
// pintar el botón "Unirme a la clase": si aquí se aceptara algo que allí no, el
// profesor lo daría por bueno y el alumno se quedaría sin botón.
//
// Se valida el HOST, no el formato de la sala: una sala de Zoom personal, una de
// Teams o un Meet con parámetros son todos válidos y no merece la pena
// perseguirlos con expresiones regulares.

export const MEET_LINK_ERROR = 'Ese enlace no parece de una videollamada (Meet, Zoom, Teams…). Revísalo.';

/** Hosts exactos admitidos. */
const HOSTS_EXACTOS = new Set([
  'meet.google.com',
  'zoom.us',
  'teams.microsoft.com',
  'teams.live.com',
  'whereby.com',
  'meet.jit.si',
]);

/** Dominios que admiten además cualquier subdominio (us02web.zoom.us…). */
const DOMINIOS_CON_SUBDOMINIOS = ['zoom.us'];

/** Quita espacios y añade https:// si falta. No valida. */
export function normalizeMeetUrl(raw: string): string {
  const t = (raw ?? '').trim();
  if (!t) return t;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

/** true si el host es de una videollamada admitida. */
export function isAllowedMeetHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (HOSTS_EXACTOS.has(h)) return true;
  return DOMINIOS_CON_SUBDOMINIOS.some(d => h.endsWith(`.${d}`));
}

/** Valida UN enlace suelto (sin espacios). null si no es de videollamada. */
function checkSingle(raw: string): string | null {
  const url = normalizeMeetUrl(raw);
  if (!url || /\s/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!isAllowedMeetHost(parsed.hostname)) return null;
  return url;
}

// Algo con forma de enlace dentro de un texto: con o sin esquema, un dominio y
// opcionalmente una ruta. Los signos de cierre de frase se recortan después.
const CANDIDATO = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"'`]*)?/gi;

/**
 * El primer enlace de videollamada válido dentro de un texto, o null. Sirve
 * para cuando el profesor pega la invitación ENTERA de Zoom o de Meet ("Unirse
 * a la reunión: https://…", con ID, código y teléfonos): se queda solo con el
 * enlace y descarta el resto (calendar.google.com, números de teléfono…).
 */
export function extractMeetLink(text: string): string | null {
  for (const m of (text ?? '').matchAll(CANDIDATO)) {
    const limpio = m[0].replace(/[.,;:!?)\]}>»"']+$/, '');
    const ok = checkSingle(limpio);
    if (ok) return ok;
  }
  return null;
}

/**
 * Normaliza y valida. Devuelve la URL lista para guardar, o el mensaje de error
 * en español para enseñarle al profesor.
 *
 * Un enlace suelto se valida tal cual (un `ftp://meet.google.com/…` se rechaza).
 * Si lo pegado es un TEXTO (lleva espacios o saltos de línea), se extrae el
 * primer enlace de videollamada que contenga.
 */
export function validateMeetLink(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const t = (raw ?? '').trim();
  if (!t) return { ok: false, error: 'Escribe el enlace de la clase.' };
  const url = /\s/.test(t) ? extractMeetLink(t) : checkSingle(t);
  return url ? { ok: true, url } : { ok: false, error: MEET_LINK_ERROR };
}
