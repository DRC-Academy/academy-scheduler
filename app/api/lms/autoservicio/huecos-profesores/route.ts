// LMS → Gestión: huecos con OTROS profesores para cambiar de profesor (Fase 2).
// GET ?alumno_id=<students.id>[&dia=<Lunes…>][&franja=manana|tarde|noche][&profesor_id=<id>]
// Cabecera x-lms-secret. Contrato: docs/autoservicio-contrato.md. Solo lee.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { huecosEntreProfesores } from '@/lib/cambioProfesor/huecos';
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
    return respuestaOk(await huecosEntreProfesores({
      client: admin, alumno: alumnoId,
      dia: q.get('dia'), franja: q.get('franja'), profesorFijado: q.get('profesor_id'),
    }));
  } catch (err) {
    return respuestaError(err, 'lms/autoservicio/huecos-profesores');
  }
}
