// POST { teacherId, studentName, date, hour } → { penaltyEuros }
//
// "Estuve ausente": el profesor declara que no se conectó a una clase suya ya
// terminada, sin estado y sin "Ingresar a clase". Es una FALTA del profesor por
// el mismo camino que la reclasificación del admin: −10 €, recuperación para el
// alumno y sin doble cobro si la detección de ausencias ya la había cobrado
// (lib/classStatusStore.declareTeacherAbsence). Idempotente.
//
// Hasta que haya login real, el teacherId llega del navegador, como en el resto
// de rutas del profesor; ver la sesión de seguridad pendiente.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { declareTeacherAbsence, ClassStatusError } from '@/lib/classStatusStore';
import { RecoveryError } from '@/lib/classRecoveryStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request): Promise<Response> {
  const b = await request.json().catch(() => null) as Record<string, unknown> | null;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const teacherId = text(b?.teacherId), studentName = text(b?.studentName), date = text(b?.date), hour = text(b?.hour);
  if (!teacherId || !studentName || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:00$/.test(hour)) {
    return Response.json({ error: 'Faltan datos de la clase.' }, { status: 400, headers: NO_STORE });
  }
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el entorno.' }, { status: 500, headers: NO_STORE });
  try {
    return Response.json(await declareTeacherAbsence(admin, { teacherId, studentName, date, hour }), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof ClassStatusError) return Response.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    if (err instanceof RecoveryError) return Response.json({ error: err.message }, { status: err.status, headers: NO_STORE });
    console.error('[classes/estuve-ausente POST]', err);
    return Response.json({ error: 'No se pudo registrar la ausencia. Inténtalo de nuevo.' }, { status: 500, headers: NO_STORE });
  }
}
