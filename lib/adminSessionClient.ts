// Lado navegador de la sesión de admin (lib/adminSession, app/api/admin/session).
// La cookie es httpOnly: el navegador no la ve ni la toca, solo la pide y la
// borra. Todo best-effort: un fallo aquí nunca rompe el login.

/** Pide la sesión de servidor. true si quedó abierta. */
export async function openAdminSession(username: string, password: string): Promise<boolean> {
  try {
    const res = await fetch('/api/admin/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function closeAdminSession(): void {
  fetch('/api/admin/session', { method: 'DELETE' }).catch(() => { /* best-effort */ });
}

/**
 * fetch a una ruta protegida. Si responde 401 (admin que inició sesión antes de
 * que existiera la sesión de servidor, o la sesión caducó), la reabre una vez con
 * las credenciales del usuario ya logueado y repite.
 */
export async function adminFetch(
  input: string, init: RequestInit | undefined,
  creds: { username: string; password: string } | null | undefined,
): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: 'same-origin' });
  if (res.status !== 401 || !creds) return res;
  if (!(await openAdminSession(creds.username, creds.password))) return res;
  return fetch(input, { ...init, credentials: 'same-origin' });
}
