// Cobrar una falta que quedó para revisar (admin, Recuperaciones → Posibles
// ausencias). POST { by }.
//
// Solo para las marcadas "revisar": el profesor no se conectó, pero antes había
// intentado cancelar con la app vieja y el sistema lo bloqueó, así que el
// chequeo no la cobró solo. El admin decide: esta ruta la cobra (−10 €, mes de
// la clase) o "Anular" la cierra sin multa. Lógica en lib/teacherAbsenceStore
// (chargeReviewedAbsence).

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { chargeReviewedAbsence, AbsenceAdminError } from '@/lib/teacherAbsenceStore';
import { readJson } from '@/lib/recoveryHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await readJson<{ by?: string }>(request)) ?? {};
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'no_configurado', mensaje: 'Falta SUPABASE_SERVICE_ROLE_KEY en el entorno.' }, { status: 503, headers: NO_STORE });
  try {
    return Response.json(await chargeReviewedAbsence(admin, id, { by: body.by?.trim() || 'admin' }), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AbsenceAdminError) {
      return Response.json({ error: 'error', mensaje: err.message }, { status: err.status, headers: NO_STORE });
    }
    console.error('[posibles-ausencias/cobrar]', err);
    return Response.json({ error: 'error', mensaje: err instanceof Error ? err.message : String(err) }, { status: 500, headers: NO_STORE });
  }
}
