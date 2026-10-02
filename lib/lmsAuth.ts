// Autenticación de los endpoints que llama el LMS (/api/lms/*).
//
// Secreto compartido en la cabecera `x-lms-secret`, comparado contra
// LMS_GESTION_SECRET. Mismo esquema que /api/external (lib/externalAuth.ts):
// SERVIDOR A SERVIDOR, sin CORS, para que el secreto nunca viaje al navegador.
// Es un secreto distinto del que usa Gestión para llamar al LMS
// (LMS_EXTERNAL_SECRET): cada dirección tiene el suyo.

import { secretsMatch } from '@/lib/externalAuth';

export const LMS_SECRET_HEADER = 'x-lms-secret';

/** null si la petición está autorizada; si no, la Response de error del contrato. */
export function requireLmsSecret(request: Request): Response | null {
  const expected = process.env.LMS_GESTION_SECRET;
  if (!expected) {
    console.error('[lms] Falta LMS_GESTION_SECRET: los endpoints del LMS quedan cerrados.');
    return Response.json(
      { error: 'no_configurado', mensaje: 'Gestión no tiene configurado el secreto del LMS.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const got = request.headers.get(LMS_SECRET_HEADER);
  if (!got || !secretsMatch(got, expected)) {
    return Response.json(
      { error: 'no_autorizado', mensaje: `Falta o no coincide la cabecera ${LMS_SECRET_HEADER}.` },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return null;
}
