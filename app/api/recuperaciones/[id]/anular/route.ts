// Anular una recuperación (admin, pestaña "Recuperaciones"): libera reservas y
// quita la recuperación futura del calendario. POST { by, reason }. El motivo
// es obligatorio y queda guardado con quién y cuándo (supabase-class-recoveries-b.sql).
// Sin comprobación de beta: el admin tiene que poder anular cualquier fila,
// también si un profesor sale de la lista.

import { annulRecovery, getRecovery } from '@/lib/classRecoveryStore';
import { recoveryErrorResponse, readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await readJson<{ by?: string; reason?: string }>(request)) ?? {};
  const reason = body.reason?.trim() ?? '';
  if (reason.length < 3) {
    return Response.json({ error: 'datos_invalidos', mensaje: 'Escribe el motivo de la anulación.' }, { status: 422 });
  }
  try {
    const rec = await getRecovery(id);
    if (!rec) return Response.json({ error: 'no_encontrada', mensaje: 'No encontramos esa recuperación.' }, { status: 404 });
    const out = await annulRecovery(id, { by: body.by?.trim() || 'admin', reason: reason.slice(0, 500) });
    return Response.json({ estado: out?.status ?? null });
  } catch (err) {
    return recoveryErrorResponse(err, 'recuperaciones/anular');
  }
}
