// LMS → Gestión: qué puede cambiar el alumno de su horario y desde cuándo.
// GET ?alumno_id=<students.id>   Cabecera x-lms-secret. Contrato: docs/autoservicio-contrato.md
// Solo lee.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { estadoAutoservicioWith } from '@/lib/cambioHorario/autoservicio';
import { autorizarLms, respuestaCodigo, respuestaError, respuestaOk } from '@/lib/cambioHorario/respuestas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denegada = autorizarLms(request);
  if (denegada) return denegada;
  const alumnoId = new URL(request.url).searchParams.get('alumno_id')?.trim();
  if (!alumnoId) return respuestaCodigo('DATOS_INVALIDOS');
  const admin = getSupabaseAdmin();
  if (!admin) return respuestaCodigo('NO_CONFIGURADO');
  try {
    return respuestaOk(await estadoAutoservicioWith(admin, alumnoId));
  } catch (err) {
    return respuestaError(err, 'lms/autoservicio/estado');
  }
}
