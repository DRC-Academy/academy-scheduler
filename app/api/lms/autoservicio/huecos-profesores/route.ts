// LMS → Gestión: HORARIOS para cambiar de profesor (Fase 2, contrato v3).
// GET ?alumno_id=<students.id>[&dia=<Lunes…>][&franja=manana|mediodia|tarde|noche]
//     [&elegidos=<JSON [{ "dia", "hora", "duracion" }]>]
// Cabecera x-lms-secret. Contrato: docs/autoservicio-contrato.md. Solo lee.
// La respuesta NO lleva ningún dato del profesor (ni id ni nombre).

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { huecosEntreProfesores, type Horario } from '@/lib/cambioProfesor/huecos';
import { autorizarLms, respuestaCodigo, respuestaError, respuestaOk } from '@/lib/cambioHorario/respuestas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `elegidos` de la query: lista JSON de { dia, hora, duracion }. undefined si está mal formada. */
function leerElegidos(raw: string | null): Horario[] | undefined {
  if (!raw?.trim()) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return undefined;
    return v.map(x => {
      const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      return { dia: typeof o.dia === 'string' ? o.dia.trim() : '', hora: typeof o.hora === 'string' ? o.hora.trim() : '', duracion: Number(o.duracion) };
    });
  } catch {
    return undefined;
  }
}

export async function GET(request: Request): Promise<Response> {
  const denegada = autorizarLms(request);
  if (denegada) return denegada;
  const q = new URL(request.url).searchParams;
  const alumnoId = q.get('alumno_id')?.trim();
  const elegidos = leerElegidos(q.get('elegidos'));
  if (!alumnoId || !elegidos) return respuestaCodigo('DATOS_INVALIDOS');
  const admin = getSupabaseAdmin();
  if (!admin) return respuestaCodigo('NO_CONFIGURADO');
  try {
    return respuestaOk(await huecosEntreProfesores({
      client: admin, alumno: alumnoId, dia: q.get('dia'), franja: q.get('franja'), elegidos,
    }));
  } catch (err) {
    return respuestaError(err, 'lms/autoservicio/huecos-profesores');
  }
}
