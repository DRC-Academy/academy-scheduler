// GET ?teacherId=… → { sinEstado: UnmarkedClass[] }
//
// Clases ya terminadas del profesor que siguen sin estado (lib/classStatus),
// para que "Mis clases" las señale con "Marcar estado". Es la MISMA función que
// usa el reloj de avisos, así que la pantalla y el email no pueden discrepar.
//
// Hasta que haya login real, el teacherId llega del navegador, como en el resto
// de rutas del profesor; ver la sesión de seguridad pendiente.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { listUnmarkedForTeacher } from '@/lib/classStatusStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const teacherId = (new URL(request.url).searchParams.get('teacherId') ?? '').trim();
  if (!teacherId) return Response.json({ error: 'Falta teacherId.' }, { status: 400, headers: NO_STORE });
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el entorno.' }, { status: 500, headers: NO_STORE });
  try {
    return Response.json({ sinEstado: await listUnmarkedForTeacher(admin, teacherId) }, { headers: NO_STORE });
  } catch (err) {
    console.error('[classes/estado GET]', err);
    return Response.json({ error: 'No se pudo calcular el estado de tus clases.' }, { status: 500, headers: NO_STORE });
  }
}
