// Genera un link único de Test de Nivel para un candidato/alumno.
// Lo llaman el admin o el profesor (ya logueados; auth client-side, igual que el
// resto del sistema). Espejo de app/api/forms/generate-token.

import { createTestSession, type TestSessionInput } from '@/lib/levelTest/createSession';
import { publicBase } from '@/lib/appUrl';

export async function POST(request: Request): Promise<Response> {
  let body: TestSessionInput;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'JSON inválido' }, { status: 400 }); }

  const { token, error } = await createTestSession(body);
  if (error || !token) {
    return Response.json({ error: error || 'No se pudo generar el link.' }, { status: 500 });
  }

  const url = `${publicBase(request)}/test/${token}`;
  return Response.json({ token, url });
}
