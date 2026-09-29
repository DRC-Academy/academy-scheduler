// Estado del formulario inicial y de la prueba de nivel de un alumno, con el
// historial de los "Regenerar todo" anteriores (lib/onboardingStatus). Lo usan
// la ficha del alumno y la confirmación antes de regenerar.
//
// Como el resto del panel, la autenticación es del lado del cliente y se usa la
// clave anónima (RLS deshabilitado).

import { supabase } from '@/lib/supabase';
import { loadOnboardingStatus } from '@/lib/onboardingStatus';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const studentId = url.searchParams.get('studentId')?.trim() || null;
  const studentName = url.searchParams.get('studentName')?.trim() || '';
  if (!studentId && !studentName) {
    return Response.json({ error: 'Falta el alumno (studentId o studentName).' }, { status: 400 });
  }
  try {
    return Response.json(await loadOnboardingStatus(supabase, { id: studentId, name: studentName }));
  } catch (e) {
    console.error('[onboarding-status] No se pudo leer el estado:', e);
    return Response.json({ error: 'No se pudo leer el estado del formulario y la prueba.' }, { status: 500 });
  }
}
