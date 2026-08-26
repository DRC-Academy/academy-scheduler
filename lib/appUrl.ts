// Única fuente de verdad de la URL pública de la app.
//
// POR QUÉ EXISTE — los enlaces que se le mandan al ALUMNO (formulario, prueba de
// nivel, progreso) se armaban con el origin de la petición
// (`new URL(request.url).origin`) o con `window.location.origin`. En Vercel eso
// es una trampa: cada deploy tiene además de la URL pública corta
// (academy-scheduler-aqpt.vercel.app) una URL de deployment larga
// (academy-scheduler-aqpt-XXXX-facupezzu-9302s-projects.vercel.app) que está
// detrás de Vercel Authentication. Si la profesora entraba por la larga —o el
// cron se invocaba contra ella—, el enlace heredaba ESE host: al alumno le
// aparecía "solicita acceso" y a la cuenta le llegaban emails de Access Request.
// El alumno no podía hacer su test.
//
// LA REGLA — el origin de la petición o del navegador SOLO se usa cuando es
// local (localhost, 127.0.0.1…), para poder probar en desarrollo. En cualquier
// otro sitio manda siempre la URL pública fija. Nunca al revés, y nunca
// process.env.VERCEL_URL, que es justamente la larga y protegida.
//
// Se configura con NEXT_PUBLIC_APP_URL. Si falta, se usa el dominio de
// producción que hay más abajo, así que un despiste en las variables de entorno
// no vuelve a romper los enlaces de los alumnos.

/** Dominio público de producción. Respaldo si NEXT_PUBLIC_APP_URL no está puesta. */
const FALLBACK = 'https://academy-scheduler-aqpt.vercel.app';

const stripSlash = (u: string): string => u.trim().replace(/\/+$/, '');

/** Lee la env var y la normaliza (sin barra final, con esquema). */
function fromEnv(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw || !raw.trim()) return null;
  const clean = stripSlash(raw);
  if (!clean) return null;
  return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
}

/** URL pública de la app, sin barra final. Es la base de TODO enlace que sale por email. */
export const PUBLIC_APP_URL: string = fromEnv() ?? FALLBACK;

/** ¿Este host es una máquina de desarrollo? Solo entonces se respeta el origin real. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
      || h.endsWith('.localhost') || h.endsWith('.local');
}

/**
 * Base para enlaces de cara al alumno desde el SERVIDOR (rutas de API, crons).
 * Devuelve el origin de la petición solo en local; fuera de local, la URL pública.
 */
export function publicBase(request?: { url?: string } | null): string {
  const url = request?.url;
  if (url) {
    try {
      const parsed = new URL(url);
      if (isLocalHost(parsed.hostname)) return stripSlash(parsed.origin);
    } catch {
      // URL rara: mejor la pública que un enlace roto.
    }
  }
  return PUBLIC_APP_URL;
}

/**
 * Base para enlaces de cara al alumno desde el NAVEGADOR (botones de copiar link).
 * Misma regla: el origin de la pestaña solo cuenta si la profesora está en local.
 */
export function publicBaseClient(): string {
  if (typeof window !== 'undefined' && window.location?.hostname
      && isLocalHost(window.location.hostname)) {
    return stripSlash(window.location.origin);
  }
  return PUBLIC_APP_URL;
}
