// Puesta al día de la OFERTA NUEVA (oct/2026): pedidos y suscripciones de Woo
// desde el lanzamiento (06/10/2026) contra el catálogo de lib/productCatalog.
//
// GET  → SIMULACIÓN: calcula la tabla, no escribe NADA.
// POST → aplica (exige la tabla woo_plan_events: sin ella no hay idempotencia).
//
// Mismo par simular/aplicar que /api/admin/sync-company-plans, y mismas reglas
// que el webhook y el barrido diario (lib/planOrders): acá NO va autoOnly,
// porque esta es justamente la vía para lo anterior a AUTO_SINCE.
//
// SEGURIDAD: sesión de admin (lib/adminSession). Escribe accesos a clase.

import { requireAdminSession } from '@/lib/adminSession';
import { requireAdminClient } from '@/lib/cronAuth';
import { syncPlanOrders, OFFER_START, PlanSyncError } from '@/lib/planOrderStore';
import { madridToday } from '@/lib/subscriptionAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const NO_STORE = { 'Cache-Control': 'no-store' };

async function run(request: Request, apply: boolean): Promise<Response> {
  const session = requireAdminSession(request);
  if (session.error) return session.error;
  const { admin, error } = requireAdminClient('planes-oferta');
  if (error) return error;
  try {
    const r = await syncPlanOrders(admin, { apply, since: OFFER_START, today: madridToday() });
    return Response.json(r, { headers: NO_STORE });
  } catch (err) {
    const msg = err instanceof PlanSyncError ? err.message : 'No se pudo completar la sincronización.';
    console.error('[admin/planes-oferta]', err);
    return Response.json({ error: msg }, { status: err instanceof PlanSyncError ? 409 : 500, headers: NO_STORE });
  }
}

export async function GET(request: Request): Promise<Response> { return run(request, false); }
export async function POST(request: Request): Promise<Response> { return run(request, true); }
