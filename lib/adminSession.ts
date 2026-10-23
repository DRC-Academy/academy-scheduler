// ── Sesión mínima de ADMIN en el servidor ─────────────────────────────────────
//
// La app todavía no tiene login de servidor: el usuario vive en localStorage y
// las rutas /api/admin/* no piden nada (ver la sesión de seguridad pendiente).
// Para lo que devuelve datos personales de alumnos —el "Registro para disputas"—
// eso no basta, así que aquí hay una sesión pequeña SOLO para admin:
//
//   · POST /api/admin/session { username, password } comprueba en el servidor que
//     el usuario existe en app_users con rol 'admin' y deja una cookie httpOnly
//     con un token firmado (HMAC-SHA256) que caduca a las ADMIN_SESSION_HOURS.
//   · Las rutas protegidas llaman a requireAdminSession: sin token válido, 401.
//   · DELETE /api/admin/session la borra (cerrar sesión).
//
// El login de los profesores no cambia: el admin la pide al iniciar sesión
// (lib/AuthContext) y, si no la tiene, la propia pantalla la pide otra vez.
//
// Clave de firma: ADMIN_SESSION_SECRET si existe; si no, una derivada de
// SUPABASE_SERVICE_ROLE_KEY (que ya es secreta y solo vive en el servidor). Así
// no hace falta una variable nueva en Vercel para que funcione. Sin ninguna de
// las dos, no se emite ni se acepta ningún token.

import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export const ADMIN_SESSION_COOKIE = 'drc_admin_session';
export const ADMIN_SESSION_HOURS = 12;

const NO_STORE = { 'Cache-Control': 'no-store' };

function signingKey(): Buffer | null {
  const own = process.env.ADMIN_SESSION_SECRET?.trim();
  if (own) return Buffer.from(own, 'utf8');
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!srk) return null;
  return createHmac('sha256', srk).update('drc-admin-session-v1').digest();
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/** Token `<payload>.<firma>`. Puro: la clave y el reloj entran por parámetro. */
export function createAdminTokenWith(key: Buffer, userId: string, nowMs: number): string {
  const payload = b64url(JSON.stringify({ sub: userId, role: 'admin', exp: nowMs + ADMIN_SESSION_HOURS * 3_600_000 }));
  return `${payload}.${sign(key, payload)}`;
}

/** El id del admin si el token es auténtico y no caducó; si no, null. */
export function verifyAdminTokenWith(key: Buffer, token: string | null | undefined, nowMs: number): { userId: string } | null {
  if (!token) return null;
  const [payload, firma, sobra] = token.split('.');
  if (!payload || !firma || sobra !== undefined) return null;
  const esperada = Buffer.from(sign(key, payload));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown; role?: unknown; exp?: unknown };
    if (data.role !== 'admin' || typeof data.sub !== 'string' || !data.sub) return null;
    if (typeof data.exp !== 'number' || data.exp <= nowMs) return null;
    return { userId: data.sub };
  } catch {
    return null;
  }
}

/** Valor de una cookie de la petición. */
export function cookieOf(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const isHttps = (request: Request) => {
  try { return new URL(request.url).protocol === 'https:'; } catch { return false; }
};

/** Cabecera Set-Cookie de una sesión nueva. */
export function sessionCookie(request: Request, token: string): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${ADMIN_SESSION_HOURS * 3600}`,
    ...(isHttps(request) ? ['Secure'] : []),
  ].join('; ');
}

/** Cabecera Set-Cookie que borra la sesión. */
export function clearSessionCookie(request: Request): string {
  return [`${ADMIN_SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(isHttps(request) ? ['Secure'] : [])].join('; ');
}

/** Emite el token de un admin ya comprobado, o null sin clave de firma. */
export function createAdminToken(userId: string, nowMs = Date.now()): string | null {
  const key = signingKey();
  return key ? createAdminTokenWith(key, userId, nowMs) : null;
}

/** `{ userId }` si la petición trae una sesión de admin válida; si no, la Response 401. */
export function requireAdminSession(request: Request): { userId: string; error: null } | { userId: null; error: Response } {
  const key = signingKey();
  const ok = key ? verifyAdminTokenWith(key, cookieOf(request, ADMIN_SESSION_COOKIE), Date.now()) : null;
  if (ok) return { userId: ok.userId, error: null };
  return {
    userId: null,
    error: Response.json({ error: 'Sesión de admin no válida o caducada.', code: 'admin_session' }, { status: 401, headers: NO_STORE }),
  };
}

/**
 * ¿Usuario y contraseña de un ADMIN? Devuelve su id o null. Misma comparación
 * que el login de la app (lib/db.dbAuthenticate: usuario sin distinguir
 * mayúsculas, contraseña exacta), pero en el servidor y exigiendo rol admin.
 */
export async function checkAdminCredentials(admin: SupabaseClient, username: string, password: string): Promise<string | null> {
  const u = username.trim();
  if (!u || !password) return null;
  const { data, error } = await admin.from('app_users')
    .select('id, username, password, role')
    .ilike('username', u.replace(/[\\%_]/g, m => `\\${m}`))
    .limit(5);
  if (error || !data) return null;
  const row = (data as Array<{ id: string; username: string; password: string; role: string }>)
    .find(r => r.username.trim().toLowerCase() === u.toLowerCase());
  if (!row || row.role !== 'admin' || typeof row.password !== 'string') return null;
  const a = Buffer.from(row.password), b = Buffer.from(password);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row.id;
}
