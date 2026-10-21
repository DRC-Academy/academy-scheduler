// Anular una multa del sistema único (admin: pestaña Penalizaciones y el
// "Revertir" de Finanzas). POST { eventId, by, reason }. Motivo obligatorio.
//
// SOLO devuelve el dinero (10 € la falta, 5 € la cancelación tardía): la
// recuperación del alumno sigue viva y el comodín sigue gastado. Lógica en
// lib/teacherPenaltyStore (annulPenalty).

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { annulPenalty, PenaltyAdminError } from '@/lib/teacherPenaltyStore';
import { readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson<{ eventId?: string; by?: string; reason?: string }>(request)) ?? {};
  const reason = body.reason?.trim() ?? '';
  if (!body.eventId) return Response.json({ error: 'datos_invalidos', mensaje: 'Falta la multa.' }, { status: 400, headers: NO_STORE });
  if (reason.length < 3) {
    return Response.json({ error: 'datos_invalidos', mensaje: 'Escribe el motivo de la anulación.' }, { status: 422, headers: NO_STORE });
  }
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'no_configurado', mensaje: 'Falta SUPABASE_SERVICE_ROLE_KEY en el entorno.' }, { status: 503, headers: NO_STORE });
  try {
    const out = await annulPenalty({ eventId: body.eventId, by: body.by?.trim() || 'admin', reason: reason.slice(0, 500) }, admin);
    return Response.json(out, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof PenaltyAdminError) {
      return Response.json({ error: 'error', mensaje: err.message }, { status: err.status, headers: NO_STORE });
    }
    console.error('[penalizaciones/anular]', err);
    return Response.json({ error: 'error', mensaje: err instanceof Error ? err.message : String(err) }, { status: 500, headers: NO_STORE });
  }
}
