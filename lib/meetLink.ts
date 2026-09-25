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

/**
 * Normaliza y valida. Devuelve la URL lista para guardar, o el mensaje de error
 * en español para enseñarle al profesor.
 */
export function validateMeetLink(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const url = normalizeMeetUrl(raw);
  if (!url) return { ok: false, error: 'Escribe el enlace de la clase.' };
  if (/\s/.test(url)) return { ok: false, error: MEET_LINK_ERROR };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: MEET_LINK_ERROR };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, error: MEET_LINK_ERROR };
  if (!isAllowedMeetHost(parsed.hostname)) return { ok: false, error: MEET_LINK_ERROR };
  return { ok: true, url };
}
