// Anular una recuperación (admin): libera reservas y quita la recuperación
// futura del calendario. POST { by, reason }. La pestaña del admin llega en el
// bloque B; mientras tanto sirve para las pruebas con curl.

import { annulRecovery, getRecovery } from '@/lib/classRecoveryStore';
import { isRecoveryBetaTeacher } from '@/lib/classRecoveries';
import { recoveryErrorResponse, readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await readJson<{ by?: string; reason?: string }>(request)) ?? {};
  try {
    const rec = await getRecovery(id);
    if (!rec) return Response.json({ error: 'no_encontrada', mensaje: 'No encontramos esa recuperación.' }, { status: 404 });
    if (!isRecoveryBetaTeacher(rec.teacherId)) return Response.json({ error: 'no_beta', mensaje: 'No disponible.' }, { status: 403 });
    const out = await annulRecovery(id, { by: body.by?.trim() || 'admin', reason: body.reason?.trim() || 'Anulada a mano' });
    return Response.json({ estado: out?.status ?? null });
  } catch (err) {
    return recoveryErrorResponse(err, 'recuperaciones/anular');
  }
}
