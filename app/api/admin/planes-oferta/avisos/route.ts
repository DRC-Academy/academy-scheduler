// Avisos de la OFERTA NUEVA para el admin: productos sin regla, pedidos o
// suscripciones sin alumno, planes de 2 personas con la segunda sin vincular y
// pedidos activados que después se reembolsaron. Ver lib/planOrders.
//
// GET  → avisos abiertos.
// POST { key } → marca uno como revisado (no cambia nada más).

import { requireAdminSession } from '@/lib/adminSession';
import { requireAdminClient } from '@/lib/cronAuth';
import { listPlanAlerts, resolvePlanAlert, PlanSyncError } from '@/lib/planOrderStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const session = requireAdminSession(request);
  if (session.error) return session.error;
  const { admin, error } = requireAdminClient('planes-oferta/avisos');
  if (error) return error;
  try {
    return Response.json(await listPlanAlerts(admin), { headers: NO_STORE });
  } catch (err) {
    console.error('[planes-oferta/avisos]', err);
    return Response.json({ error: 'No se pudieron leer los avisos.' }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: Request): Promise<Response> {
  const session = requireAdminSession(request);
  if (session.error) return session.error;
  const { admin, error } = requireAdminClient('planes-oferta/avisos');
  if (error) return error;
  let key = '';
  try { key = String(((await request.json()) as { key?: unknown }).key ?? ''); } catch { /* sin cuerpo */ }
  try {
    await resolvePlanAlert(admin, key, session.userId);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    const msg = err instanceof PlanSyncError ? err.message : 'No se pudo marcar el aviso.';
    return Response.json({ error: msg }, { status: 400, headers: NO_STORE });
  }
}
