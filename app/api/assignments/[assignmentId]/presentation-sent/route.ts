// Marca el email de presentación de una asignación como enviado.
// Lo llama el panel del profesor al abrir el borrador en el gestor de correo.
//
// Efectos:
//   · assignments.presentation_email_sent = true, presentation_email_sent_at = now()
//   · Si pasaron más de 24 h desde la asignación → registra un scoring_event
//     'email_presentacion_tardio' (-5 puntos) para el profesor.
//   · Idempotente: si ya estaba marcado, no vuelve a penalizar.

import { supabase } from '@/lib/supabase';
import { dbAddScoringEvent } from '@/lib/db';
import { hoursSinceAssigned, PRESENTATION_DEADLINE_HOURS, PRESENTATION_LATE_PENALTY } from '@/lib/presentationEmailUtils';

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<Response> {
  const { assignmentId } = await params;
  if (!assignmentId) {
    return Response.json({ error: 'Falta el id de la asignación.' }, { status: 400 });
  }

  // 1) Traer la asignación (con el estado actual del email para ser idempotente).
  const { data: asgn, error: readErr } = await supabase
    .from('assignments')
    .select('id, teacher_id, teacher_name, student_name, created_at, presentation_email_sent, presentation_email_sent_at')
    .eq('id', assignmentId)
    .maybeSingle();

  if (readErr) {
    console.error('[presentation-sent] Error al leer la asignación:', readErr);
    return Response.json({ error: 'Error del servidor.' }, { status: 500 });
  }
  if (!asgn) {
    return Response.json({ error: 'Asignación no encontrada.' }, { status: 404 });
  }

  const hoursElapsed = hoursSinceAssigned(asgn.created_at);
  const sentOnTime = hoursElapsed <= PRESENTATION_DEADLINE_HOURS;

  // Ya marcado: no repetir el update ni la penalización.
  if (asgn.presentation_email_sent) {
    const prevHours = hoursSinceAssigned(asgn.created_at, new Date(asgn.presentation_email_sent_at ?? Date.now()).getTime());
    return Response.json({
      success: true,
      alreadySent: true,
      hoursElapsed: prevHours,
      sentOnTime: prevHours <= PRESENTATION_DEADLINE_HOURS,
    });
  }

  // 2) Marcar como enviado.
  const now = new Date().toISOString();
  const { error: updErr } = await supabase
    .from('assignments')
    .update({ presentation_email_sent: true, presentation_email_sent_at: now })
    .eq('id', assignmentId)
    .eq('presentation_email_sent', false);   // evita doble marcado concurrente

  if (updErr) {
    console.error('[presentation-sent] Error al marcar como enviado:', updErr);
    return Response.json({ error: 'No se pudo actualizar la asignación.' }, { status: 500 });
  }

  // 3) Penalización si se envió fuera de tiempo (> 24 h).
  if (!sentOnTime) {
    const retrasoH = Math.round(hoursElapsed);
    try {
      await dbAddScoringEvent({
        teacherId:   asgn.teacher_id,
        teacherName: asgn.teacher_name,
        eventType:   'email_presentacion_tardio',
        points:      PRESENTATION_LATE_PENALTY,
        euros:       0,
        note:        `Email de presentación enviado con ${retrasoH}h de retraso (alumno: ${asgn.student_name})`,
        createdBy:   'sistema',
        studentRef:  asgn.student_name,
      });
    } catch (e) {
      // El email igual quedó marcado como enviado; registramos y seguimos.
      console.error('[presentation-sent] Error al registrar el scoring tardío:', e);
    }
  }

  return Response.json({ success: true, hoursElapsed, sentOnTime });
}
