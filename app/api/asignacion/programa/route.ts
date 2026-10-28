// Activación de un PROGRAMA DE PAGO ÚNICO al confirmar la asignación (modal del
// setter, app/setter/page.tsx). La llama el navegador DESPUÉS de guardar el
// alumno y la asignación.
//
// POST { studentId, productId, orderId?, start, until? }
//   → { finalUntil, result, warning, orderRegistered, warnings }
//
// SEGURIDAD: con sesión de admin vale cualquier fecha de fin (también editada a
// mano) y no hace falta pedido. Sin ella (setter: no tiene sesión de servidor)
// solo se acepta la fecha del plan respaldada por un pedido pagado de ese mismo
// email y programa. Ver lib/planOrderStore.activateFromAssignment.

import { requireAdminSession } from '@/lib/adminSession';
import { requireAdminClient } from '@/lib/cronAuth';
import { activateFromAssignment, PlanSyncError } from '@/lib/planOrderStore';
import { madridToday } from '@/lib/subscriptionAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: 'JSON inválido' }, { status: 400, headers: NO_STORE }); }

  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : '';
  const productId = Number(body.productId);
  const orderId = body.orderId != null && Number(body.orderId) > 0 ? Number(body.orderId) : null;
  const start = typeof body.start === 'string' ? body.start : '';
  const until = typeof body.until === 'string' && body.until ? body.until : null;
  if (!studentId || !Number.isInteger(productId) || !ISO.test(start) || (until && !ISO.test(until))) {
    return Response.json({ error: 'Datos incompletos' }, { status: 400, headers: NO_STORE });
  }

  const { admin, error } = requireAdminClient('asignacion-programa');
  if (error) return error;
  const isAdmin = !requireAdminSession(request).error;

  try {
    const r = await activateFromAssignment(admin, { studentId, productId, orderId, start, until, isAdmin, today: madridToday() });
    return Response.json({
      finalUntil: r.decision.finalUntil, result: r.decision.result, warning: r.decision.warning,
      orderRegistered: r.orderRegistered, warnings: r.warnings,
    }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof PlanSyncError) return Response.json({ error: err.message }, { status: 409, headers: NO_STORE });
    console.error('[asignacion/programa]', err);
    return Response.json({ error: 'No se pudo activar el programa.' }, { status: 500, headers: NO_STORE });
  }
}
