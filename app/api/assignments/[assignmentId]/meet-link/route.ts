// PUT: guarda el enlace de la clase (assignments.meet_link) de una asignación.
//
// Es la ÚNICA vía para escribirlo. Antes se hacía desde el navegador con la anon
// key y sin mirar el error: si fallaba, el profesor creía que estaba guardado.
// Aquí se normaliza (https:// si falta), se valida que sea de una videollamada
// (lib/meetLink, misma lista que el LMS; si se pega la invitación entera se
// extrae el enlace) y se registra meet_link_set_at.
//
// PENALIZACIÓN 'enlace_tardio' (-5 puntos), desde la Fase 3 (sep/2026): solo la
// PRIMERA vez que se define el enlace de la asignación, si pasaron más de 24 h
// desde created_at y la asignación es del corte en adelante
// (lib/meetLinkStatus.shouldPenalizeLateLink). Cambiar un enlace ya definido
// nunca penaliza. "Primera vez" lo decide la base: un UPDATE condicionado a
// meet_link_set_at nulo, así que dos guardados simultáneos no pueden contar los
// dos como primero. El evento lleva un id fijo por asignación y profesor
// (se_enlace_tardio_<asignación>_<profe>): la clave primaria impide duplicarlo.
// Si la penalización falla, el enlace queda guardado igual (solo se registra).
//
// Body: { link: string }. Respuestas: 200 { meetLinkSetAt, meetLink, lateLinkPenalty } ·
// 400 { error } con el texto para el profesor · 404 · 500.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { validateMeetLink } from '@/lib/meetLink';
import { hoursSinceAssignment, shouldPenalizeLateLink } from '@/lib/meetLinkStatus';
import { dbAddScoringEvent, EVENT_POINTS } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface FirstDefinition {
  id: string;
  teacher_id: string;
  teacher_name: string;
  student_name: string;
  created_at: string;
}

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
  const patch = { meet_link: check.url, meet_link_set_at: meetLinkSetAt };

  // 1) ¿Primera definición? Solo afecta a la fila si todavía no tenía fecha.
  const { data: first, error: firstErr } = await admin.from('assignments')
    .update(patch)
    .eq('id', assignmentId)
    .is('meet_link_set_at', null)
    .select('id, teacher_id, teacher_name, student_name, created_at');
  if (firstErr) return saveError(assignmentId, firstErr);

  let lateLinkPenalty = false;
  if (first?.length) {
    lateLinkPenalty = await maybePenalize(admin, first[0] as FirstDefinition);
  } else {
    // 2) Ya tenía enlace: es un cambio, sin penalización.
    const { data, error } = await admin.from('assignments').update(patch).eq('id', assignmentId).select('id');
    if (error) return saveError(assignmentId, error);
    if (!data?.length) return Response.json({ error: 'No se encontró la asignación.' }, { status: 404 });
  }

  return Response.json({ meetLink: check.url, meetLinkSetAt, lateLinkPenalty });
}

function saveError(assignmentId: string, error: unknown): Response {
  console.error(`[meet-link] ${assignmentId}:`, error);
  return Response.json({ error: 'No se pudo guardar el enlace. Inténtalo de nuevo.' }, { status: 500 });
}

/** Aplica 'enlace_tardio' si corresponde. Nunca lanza. true = se aplicó ahora. */
async function maybePenalize(admin: SupabaseClient, a: FirstDefinition): Promise<boolean> {
  if (!shouldPenalizeLateLink({ createdAt: a.created_at, previousSetAt: null })) return false;

  const eventId = `se_enlace_tardio_${a.id}_${a.teacher_id}`;
  try {
    const { data: previo } = await admin.from('scoring_events').select('id').eq('id', eventId).limit(1);
    if (previo?.length) return false;

    const horas = Math.floor(hoursSinceAssignment(a.created_at));
    await dbAddScoringEvent({
      teacherId:   a.teacher_id,
      teacherName: a.teacher_name,
      eventType:   'enlace_tardio',
      points:      EVENT_POINTS.enlace_tardio,
      euros:       0,
      note:        `Enlace de clase definido con ${horas}h de retraso (alumno: ${a.student_name})`,
      createdBy:   'sistema',
      studentRef:  a.student_name,
    }, { id: eventId });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') return false;   // otro guardado ya la aplicó
    console.error(`[meet-link] ${a.id}: no se pudo aplicar la penalización por enlace tardío:`, err);
    return false;
  }
}
