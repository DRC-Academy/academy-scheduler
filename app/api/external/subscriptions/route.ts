// GET /api/external/subscriptions
//
// Recuento AGREGADO de suscripciones para drc-financial-dashboard (servidor a
// servidor). Devuelve números, nunca datos de alumnos: ni nombres, ni emails, ni
// qué producto tiene cada uno.
//
// Dos bloques que no son lo mismo:
//   · `woocommerce` — foto cruda por estado, contando SUSCRIPCIONES.
//   · `alumnos`     — activos reales contando PERSONAS, con la regla única de
//                     lib/subscriptionAccess (Woo OR manual OR Oritalk).
//
// Todo el trabajo vive en lib/externalSubscriptions; acá solo se autoriza y se
// envuelve. Mismo patrón que /api/external/payouts.
//
// SOLO LECTURA. A diferencia de /api/check-subscription —que persiste el producto
// detectado y activa planes de empresa— este endpoint no escribe nada en la base.

import { requireDashboardSecret } from '@/lib/externalAuth';
import { loadSubscriptionsSnapshot } from '@/lib/externalSubscriptions';

export const maxDuration = 60;
// Es un recuento del presente: no se cachea la respuesta. El ahorro de llamadas a
// WooCommerce lo da el cache en memoria de 60 s de loadSubscriptionsSnapshot.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = requireDashboardSecret(request);
  if (denied) return denied;

  try {
    // ?fresh=1 → salta el cache de 60 s. Para comprobar a mano un cambio recién
    // hecho (una activación manual, una baja en Woo) sin esperar al vencimiento.
    const fresh = new URL(request.url).searchParams.get('fresh') === '1';
    const snap = await loadSubscriptionsSnapshot(fresh);

    return Response.json(
      { generated_at: new Date().toISOString(), ...snap },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[external/subscriptions] fallo al contar:', e);
    return Response.json(
      { error: 'error_interno' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
