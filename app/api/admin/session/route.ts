// Sesión mínima de ADMIN (lib/adminSession).
//   POST   { username, password } → 200 { ok } + cookie httpOnly · 401 si no es un admin
//   DELETE                        → borra la cookie
//
// Solo emite sesión para el rol admin; un profesor recibe 401 y su login de la
// app no cambia en nada.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { checkAdminCredentials, createAdminToken, sessionCookie, clearSessionCookie } from '@/lib/adminSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === 'string' ? body.username : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el entorno.' }, { status: 500, headers: NO_STORE });

  const userId = await checkAdminCredentials(admin, username, password);
  if (!userId) return Response.json({ error: 'Usuario o contraseña de admin incorrectos.' }, { status: 401, headers: NO_STORE });
  const token = createAdminToken(userId);
  if (!token) return Response.json({ error: 'Falta la clave de firma de sesiones en el servidor.' }, { status: 500, headers: NO_STORE });

  return Response.json({ ok: true }, { headers: { ...NO_STORE, 'Set-Cookie': sessionCookie(request, token) } });
}

export async function DELETE(request: Request): Promise<Response> {
  return Response.json({ ok: true }, { headers: { ...NO_STORE, 'Set-Cookie': clearSessionCookie(request) } });
}
