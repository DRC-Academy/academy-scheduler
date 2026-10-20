// Penalizaciones a profesores — lo que se ESCRIBE. SOLO SERVIDOR.
//
// Las reglas están en lib/teacherPenalties.ts (puro). Aquí, con el cliente
// ADMIN (service role), se cobra y se revierte la FALTA (−10 €) y la multa de la
// cancelación tardía. TIENE que ser el cliente admin: el trigger de
// supabase-penalizaciones-unicas.sql descarta cualquier multa en euros que
// llegue con la llave pública (la app vieja abierta en un navegador).
//
// Ids fijos en todo: un reintento, dos vueltas del chequeo que se pisan o el
// chequeo y la reclasificación del admin sobre la misma clase chocan con la
// clave primaria (23505) y no cobran dos veces.

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { addScoringEventWith } from '@/lib/scoringStore';
import { nkName } from '@/lib/sessions';
import {
  FALTA_EVENT_TYPE, FALTA_PENALTY_EUROS, faltaEventId, faltaBellBody, faltaEventNote,
} from '@/lib/teacherPenalties';
import type { ScoringEvent } from '@/types';

type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

export const BLOCKED_ATTEMPTS_TABLE = 'blocked_cancel_attempts';

export class PenaltyConfigError extends Error {}

export function adminClient(): SupabaseClient {
  const admin = getSupabaseAdmin();
  if (!admin) throw new PenaltyConfigError('Falta SUPABASE_SERVICE_ROLE_KEY: no se pueden registrar multas.');
  return admin;
}

const is23505 = (err: unknown) => (err as { code?: string } | null)?.code === '23505';

/**
 * Guarda un evento de multa con id fijo. `created: false` si ya existía (no es
 * un error: es la garantía de "nunca dos cobros"). Cualquier otro fallo lanza.
 */
export async function insertPenaltyEvent(
  event: Omit<ScoringEvent, 'id' | 'createdAt'>, id: string, admin: SupabaseClient = adminClient(),
): Promise<{ created: boolean }> {
  try {
    await addScoringEventWith(admin, event, { id });
    return { created: true };
  } catch (err) {
    if (is23505(err)) return { created: false };
    throw err;
  }
}

/** Campanita con id fijo (un reintento no la duplica). Best-effort. */
export async function bell(admin: SupabaseClient, n: {
  id: string; teacherId?: string | null; title: string; body: string; type: string;
}): Promise<void> {
  try {
    await admin.from('notifications').upsert({
      id: n.id, target_user: n.teacherId ?? null, target_role: n.teacherId ? null : 'admin',
      title: n.title, body: n.body, type: n.type,
      read_by: [], created_at: new Date().toISOString(), created_by: 'sistema',
    }, { onConflict: 'id', ignoreDuplicates: true });
  } catch (err) {
    console.error('[penalizaciones] Campanita fallida:', err);
  }
}

// ── Falta ─────────────────────────────────────────────────────────────────────

export interface FaltaInput {
  /** Id de la posible ausencia de esa clase (absenceIdOf): de él sale el id del evento. */
  absenceId: string;
  teacherId: string; teacherName: string;
  studentName: string; classDate: string; hour: string;
  origen: 'deteccion' | 'reclasificacion';
  createdBy: string;
}

/**
 * Cobra la falta de UNA clase (−10 €, mes de la clase) y avisa al profesor.
 * Quien llama ya decidió que corresponde (faltaApplies). Idempotente.
 */
export async function chargeFalta(input: FaltaInput, admin: SupabaseClient = adminClient()): Promise<{ eventId: string; created: boolean }> {
  const eventId = faltaEventId(input.absenceId);
  const { created } = await insertPenaltyEvent({
    teacherId: input.teacherId, teacherName: input.teacherName,
    eventType: FALTA_EVENT_TYPE, points: 0, euros: -FALTA_PENALTY_EUROS,
    note: faltaEventNote({ studentName: input.studentName, classDate: input.classDate, hour: input.hour, origen: input.origen }),
    createdBy: input.createdBy, studentRef: input.studentName,
    appliesMonth: input.classDate.slice(0, 7),
  }, eventId, admin);
  if (created) {
    await bell(admin, {
      id: `notif_falta_${input.absenceId}`, teacherId: input.teacherId,
      title: 'Falta registrada',
      body: faltaBellBody({ hour: input.hour, studentName: input.studentName, classDate: input.classDate }),
      type: 'falta_profesor',
    });
  }
  return { eventId, created };
}

/**
 * Revierte la falta de una clase: marca el evento como revertido y deja el
 * compensatorio (+10 €, constancia). Finanzas excluye los dos, así que el neto
 * es 0 en el mismo mes. `reverted: false` si no había multa viva que revertir.
 */
export async function revertFalta(input: {
  absenceId: string; by: string; reason: string;
}, admin: SupabaseClient = adminClient()): Promise<{ reverted: boolean }> {
  const eventId = faltaEventId(input.absenceId);
  const { data: ev, error } = await admin.from('scoring_events').select('*').eq('id', eventId).maybeSingle();
  if (error) throw new Error(`No se pudo leer la multa ${eventId}: ${error.message}`);
  if (!ev || ev.reverted) return { reverted: false };

  const now = new Date().toISOString();
  const { data: upd, error: updErr } = await admin.from('scoring_events')
    .update({ reverted: true, reverted_by: input.by, reverted_at: now })
    .eq('id', eventId).or('reverted.is.null,reverted.eq.false').select('id');
  if (updErr) throw new Error(`No se pudo revertir la multa ${eventId}: ${updErr.message}`);
  if (!upd?.length) return { reverted: false };   // otro la revirtió a la vez

  const ref = (ev as Row).student_ref ?? undefined;
  await insertPenaltyEvent({
    teacherId: (ev as Row).teacher_id, teacherName: (ev as Row).teacher_name,
    eventType: 'penalizacion_revertida', points: 0, euros: Math.abs(Number((ev as Row).euros) || FALTA_PENALTY_EUROS),
    note: `Reversión de la falta${ref ? ` (${ref})` : ''}. Motivo: ${input.reason}`,
    createdBy: input.by, studentRef: ref,
    appliesMonth: (ev as Row).applies_month ?? undefined,
  }, `${eventId}_rev`, admin);
  return { reverted: true };
}

// ── Intentos bloqueados de la app vieja ───────────────────────────────────────

/**
 * ¿Hubo para esa clase un intento de "Cancelar clase" con la app vieja que el
 * trigger descartó? Entonces el profesor SÍ quiso avisar: no se cobra la falta
 * y queda para que la revise un admin.
 *
 * Si la lectura falla, true: ante la duda no se cobra y lo mira un admin (un
 * cobro de más le llega al profesor; uno de menos se corrige desde el admin).
 */
export async function hadBlockedCancelAttempt(admin: SupabaseClient, a: {
  teacherId: string; studentName: string; classDate: string;
}): Promise<boolean> {
  const { data, error } = await admin.from(BLOCKED_ATTEMPTS_TABLE).select('student_name')
    .eq('teacher_id', a.teacherId).eq('class_date', a.classDate);
  if (error) {
    console.error('[penalizaciones] No se pudo leer blocked_cancel_attempts:', error.message);
    return true;
  }
  return (data ?? []).some((r: Row) => nkName(r.student_name) === nkName(a.studentName));
}
