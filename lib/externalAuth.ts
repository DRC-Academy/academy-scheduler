// Autenticación de los endpoints externos (/api/external/*).
//
// Secreto fijo en un header, comparado contra DASHBOARD_EXTERNAL_SECRET. Es a
// propósito lo más simple que sirve: un único consumidor de confianza
// (drc-financial-dashboard) llamando servidor a servidor.
//
// SERVIDOR A SERVIDOR, no desde el navegador. No se emiten cabeceras CORS
// justamente para que no se pueda: si el dashboard llamara desde el cliente, el
// secreto viajaría en el bundle y sería público. La llamada tiene que salir de
// una route handler / server component del otro proyecto.

import { timingSafeEqual } from 'node:crypto';

export const DASHBOARD_SECRET_HEADER = 'x-dashboard-secret';

/** Comparación en tiempo constante: un `===` filtra el secreto carácter a carácter. */
function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual exige misma longitud; comparar las longitudes antes no
  // filtra nada útil (la longitud del secreto no es el secreto).
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Devuelve `null` si la petición está autorizada, o la Response de error.
 *
 * Sin la variable configurada responde 503 y NO deja pasar: un endpoint que se
 * abre solo porque falta una env var es la forma habitual de publicar datos sin
 * enterarse.
 */
export function requireDashboardSecret(request: Request): Response | null {
  const expected = process.env.DASHBOARD_EXTERNAL_SECRET;
  if (!expected) {
    console.error('[external] Falta DASHBOARD_EXTERNAL_SECRET: el endpoint queda cerrado.');
    return Response.json(
      { error: 'endpoint_no_configurado' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const got = request.headers.get(DASHBOARD_SECRET_HEADER);
  if (!got || !secretsMatch(got, expected)) {
    return Response.json(
      { error: 'no_autorizado', hint: `Falta o no coincide la cabecera ${DASHBOARD_SECRET_HEADER}.` },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return null;
}
