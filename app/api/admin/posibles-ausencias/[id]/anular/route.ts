// Anular una posible ausencia (admin, Recuperaciones → Posibles ausencias).
// POST { by, reason }. El motivo es obligatorio y queda en la fila.
//
// Pasa la ausencia a 'anulada' y anula su recuperación automática, si la tiene
// (libera la fecha si el alumno ya la había elegido). Así no se paga dos veces
// la misma clase. Si la falta llevaba multa (−10 €), se revierte. Lógica en
// lib/teacherAbsenceStore (annulAbsence).

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { annulAbsence, AbsenceAdminError } from '@/lib/teacherAbsenceStore';
import { readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await readJson<{ by?: string; reason?: string }>(request)) ?? {};
  const reason = body.reason?.trim() ?? '';
  if (reason.length < 3) {
    return Response.json({ error: 'datos_invalidos', mensaje: 'Escribe el motivo de la anulación.' }, { status: 422, headers: NO_STORE });
  }
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'no_configurado', mensaje: 'Falta SUPABASE_SERVICE_ROLE_KEY en el entorno.' }, { status: 503, headers: NO_STORE });
  try {
    const out = await annulAbsence(admin, id, { by: body.by?.trim() || 'admin', reason: reason.slice(0, 500) });
    return Response.json(out, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AbsenceAdminError) {
      return Response.json({ error: 'error', mensaje: err.message }, { status: err.status, headers: NO_STORE });
    }
    console.error('[posibles-ausencias/anular]', err);
    return Response.json({ error: 'error', mensaje: err instanceof Error ? err.message : String(err) }, { status: 500, headers: NO_STORE });
  }
}
