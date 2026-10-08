// LMS → Gestión: huecos a los que el alumno puede mover una sesión.
// GET ?alumno_id=<students.id>&modo=puntual|fijo&sesion=<dia>_<HH:MM>[&fecha=YYYY-MM-DD]
// Cabecera x-lms-secret. Contrato: docs/autoservicio-contrato.md. Solo lee.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { huecosAutoservicioWith } from '@/lib/cambioHorario/autoservicio';
import { autorizarLms, respuestaCodigo, respuestaError, respuestaOk } from '@/lib/cambioHorario/respuestas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denegada = autorizarLms(request);
  if (denegada) return denegada;
  const q = new URL(request.url).searchParams;
  const alumnoId = q.get('alumno_id')?.trim();
  if (!alumnoId) return respuestaCodigo('DATOS_INVALIDOS');
  const admin = getSupabaseAdmin();
  if (!admin) return respuestaCodigo('NO_CONFIGURADO');
  try {
    return respuestaOk(await huecosAutoservicioWith(admin, alumnoId, {
      modo: q.get('modo'), sesion: q.get('sesion'), fecha: q.get('fecha'),
    }));
  } catch (err) {
    return respuestaError(err, 'lms/autoservicio/huecos');
  }
}
