// PUT: guarda el enlace de la clase (assignments.meet_link) de una asignación.
//
// Es la ÚNICA vía para escribirlo. Antes se hacía desde el navegador con la anon
// key y sin mirar el error: si fallaba, el profesor creía que estaba guardado.
// Aquí se normaliza (https:// si falta), se valida que sea de una videollamada
// (lib/meetLink, misma lista que el LMS) y se registra meet_link_set_at.
//
// Body: { link: string }. Respuestas: 200 { meetLink, meetLinkSetAt } ·
// 400 { error } con el texto para el profesor · 404 · 500.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { validateMeetLink } from '@/lib/meetLink';

export const dynamic = 'force-dynamic';

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<Response> {
  const { assignmentId } = await params;
  if (!assignmentId) return Response.json({ error: 'Falta el id de la asignación.' }, { status: 400 });

  const body = await request.json().catch(() => null) as { link?: unknown } | null;
  const check = validateMeetLink(typeof body?.link === 'string' ? body.link : '');
  if (!check.ok) return Response.json({ error: check.error }, { status: 400 });

  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ error: 'No se pudo guardar el enlace (falta configuración del servidor).' }, { status: 500 });

  const meetLinkSetAt = new Date().toISOString();
  const { data, error } = await admin.from('assignments')
    .update({ meet_link: check.url, meet_link_set_at: meetLinkSetAt })
    .eq('id', assignmentId)
    .select('id');
  if (error) {
    console.error(`[meet-link] ${assignmentId}:`, error);
    return Response.json({ error: 'No se pudo guardar el enlace. Inténtalo de nuevo.' }, { status: 500 });
  }
  if (!data?.length) return Response.json({ error: 'No se encontró la asignación.' }, { status: 404 });

  return Response.json({ meetLink: check.url, meetLinkSetAt });
}
