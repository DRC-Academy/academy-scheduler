// Posibles ausencias del profesor de los últimos 30 días, para la pestaña
// "Recuperaciones" del admin (components/admin/PossibleAbsencesSection). GET.
//
// Sin teléfono, email ni payload: el admin solo necesita saber qué clase, de
// quién y si se avisó a Zapier. La tabla tiene RLS, así que se lee con el
// cliente admin (service role).

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { listAbsencesForAdmin, isMissingAbsencesTable } from '@/lib/teacherAbsenceStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  // ?mes=YYYY-MM: las clases de ese mes (pestaña Penalizaciones). Sin él, 30 días.
  const mes = new URL(request.url).searchParams.get('mes') ?? undefined;
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el entorno.' }, { status: 500, headers: NO_STORE });
  try {
    return Response.json({ absences: await listAbsencesForAdmin(admin, 30, mes) }, { headers: NO_STORE });
  } catch (err) {
    if (isMissingAbsencesTable(err)) {
      return Response.json({ absences: [], noConfigurado: true }, { headers: NO_STORE });
    }
    console.error('[posibles-ausencias]', err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500, headers: NO_STORE });
  }
}
