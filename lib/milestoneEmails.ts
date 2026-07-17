// Disparo del email de hito (clase 15/30/50) desde el cliente, con anti-duplicados.
//
// El registro de qué hitos ya se avisaron vive en assignments.milestone_emails_sent
// (text[]). Marcamos ANTES de enviar y de forma condicional: si dos pestañas
// calculan el hito a la vez, sólo una consigue añadir el valor y sólo esa envía.
// Un email perdido es mejor que el profe recibiendo el mismo aviso dos veces.

import { supabase } from '@/lib/supabase';
import { triggerEmail } from '@/lib/emailClient';

export type MilestoneNumber = 15 | 30 | 50;

/** Los hitos que avisan por email. La clase 1 tiene banner in-app, pero no email. */
export const EMAIL_MILESTONES: readonly MilestoneNumber[] = [15, 30, 50];

export function isEmailMilestone(n: number): n is MilestoneNumber {
  return (EMAIL_MILESTONES as readonly number[]).includes(n);
}

/**
 * Envía el email de hito si corresponde y aún no se envió.
 * Devuelve true sólo si se envió ahora.
 */
export async function maybeSendMilestoneEmail(args: {
  assignmentId: string;
  teacherId: string;
  studentName: string;
  classNumber: number;
}): Promise<boolean> {
  if (!isEmailMilestone(args.classNumber)) return false;
  return claimAndSend(args.assignmentId, String(args.classNumber), () =>
    triggerEmail({
      type: 'milestone',
      teacherId: args.teacherId,
      studentName: args.studentName,
      milestone: args.classNumber,
    }),
  );
}

/**
 * Aviso de bono de retención disponible (6 meses). Se anota en el mismo
 * registro que los hitos con la etiqueta 'bonus6m': es un aviso único por
 * alumno y no necesita una columna propia.
 */
export async function maybeSendBonusEmail(args: {
  assignmentId: string;
  teacherId: string;
  studentName: string;
}): Promise<boolean> {
  return claimAndSend(args.assignmentId, 'bonus6m', () =>
    triggerEmail({ type: 'bonus', teacherId: args.teacherId, studentName: args.studentName }),
  );
}

/** Reclama la etiqueta en assignments.milestone_emails_sent y envía si la gana. */
async function claimAndSend(
  assignmentId: string, tag: string, sendFn: () => Promise<boolean>,
): Promise<boolean> {
  try {
    // Estado actual del registro.
    const { data, error } = await supabase
      .from('assignments')
      .select('milestone_emails_sent')
      .eq('id', assignmentId)
      .maybeSingle();

    if (error) {
      console.error('[milestoneEmails] No se pudo leer milestone_emails_sent:', error);
      return false;
    }
    const sent: string[] = data?.milestone_emails_sent ?? [];
    if (sent.includes(tag)) return false;   // ya se avisó

    // Reclamamos el hito. El filtro por el array previo hace de compare-and-swap:
    // si otra pestaña ya lo marcó, este update no afecta a ninguna fila.
    const { data: claimed, error: updErr } = await supabase
      .from('assignments')
      .update({ milestone_emails_sent: [...sent, tag] })
      .eq('id', assignmentId)
      .not('milestone_emails_sent', 'cs', `{${tag}}`)
      .select('id');

    if (updErr) {
      console.error('[milestoneEmails] No se pudo marcar el aviso:', updErr);
      return false;
    }
    if (!claimed || claimed.length === 0) return false;   // otra corrida se lo llevó

    const ok = await sendFn();

    // Si el envío falla, liberamos la marca para poder reintentar más adelante.
    if (!ok) {
      await supabase.from('assignments')
        .update({ milestone_emails_sent: sent })
        .eq('id', assignmentId);
    }
    return ok;
  } catch (err) {
    console.error('[milestoneEmails] Fallo inesperado:', err);
    return false;
  }
}
