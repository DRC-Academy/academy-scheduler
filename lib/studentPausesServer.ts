// ── Pausas: escritura (SOLO SERVIDOR) ───────────────────────────────────────
//
// Abre y cierra filas de `student_pauses` según lo que diga WooCommerce. La
// llaman /api/check-subscription (cada verificación de un alumno) y el cron
// /api/cron/sync-pausas (todos, una vez al día). Es idempotente: llamarla diez
// veces con el mismo estado no cambia nada después de la primera.
//
// Nunca lanza: una pausa sin registrar solo deja sin fecha el badge y las
// asistencias; no puede tumbar la verificación de acceso de un alumno.

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { hasPauseItem } from '@/lib/subscriptions/pause';
import { fetchRecentOrdersByEmail } from '@/lib/wooPausedEmails';
import { pauseFromRow, type StudentPause } from '@/lib/studentPauses';

/** 'YYYY-MM-DD' en hora de Madrid de una fecha de Woo ('2026-10-06T10:00:00'). */
function madridDateOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.startsWith('0000')) return null;
  const d = new Date(raw.trim().replace(' ', 'T'));
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * Día en que empezó la pausa ACTUAL según los pedidos: el más antiguo de la
 * racha de pedidos de Pausa más reciente (el cambio a la Pausa y sus
 * renovaciones mensuales). Si el pedido más nuevo no es de Pausa (p. ej. el
 * admin cambió la línea a mano en la suscripción), null: se usa el día de hoy.
 */
export async function pauseStartFromOrders(email: string): Promise<string | null> {
  try {
    const orders = await fetchRecentOrdersByEmail(email);
    let start: string | null = null;
    for (const o of orders) {
      if (!hasPauseItem(o.line_items)) break;
      start = madridDateOf(o.date_paid) ?? madridDateOf(o.date_created) ?? start;
    }
    return start;
  } catch (err) {
    console.warn(`[pausas] No se pudieron leer los pedidos de ${email}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export interface PauseStudentRef {
  studentId: string;
  studentName: string;
  email: string;
}

/**
 * Deja la tabla de acuerdo con el estado de ahora:
 *   · en pausa y sin fila abierta  → abre una (desde el primer pedido de Pausa);
 *   · no en pausa y con fila abierta → la cierra hoy.
 * Devuelve la pausa abierta tras el cambio (null si no está en pausa o si falló).
 */
export async function recordPauseState(
  db: SupabaseClient, s: PauseStudentRef, paused: boolean, today: string,
): Promise<StudentPause | null> {
  try {
    const { data: openRows, error } = await db.from('student_pauses')
      .select('*').eq('student_id', s.studentId).is('ended_on', null).limit(1);
    if (error) {
      // 42P01 = la tabla no existe (SQL sin correr): se sigue sin fechas.
      if (error.code !== '42P01') console.warn(`[pausas] ${s.studentName}: no se pudo leer la pausa:`, error.message);
      return null;
    }
    const open = openRows?.[0] as Record<string, unknown> | undefined;

    if (paused) {
      if (open) return pauseFromRow(open);
      const fromOrders = await pauseStartFromOrders(s.email);
      const started = fromOrders && fromOrders <= today ? fromOrders : today;
      const row = {
        student_id: s.studentId, student_name: s.studentName, student_email: s.email.trim().toLowerCase(),
        started_on: started,
      };
      const { data, error: insErr } = await db.from('student_pauses').insert(row).select('*').maybeSingle();
      if (insErr) {
        // 23505: otra verificación la abrió a la vez. Vale la suya.
        if (insErr.code === '23505') {
          const { data: again } = await db.from('student_pauses')
            .select('*').eq('student_id', s.studentId).is('ended_on', null).limit(1);
          return again?.[0] ? pauseFromRow(again[0] as Record<string, unknown>) : null;
        }
        console.warn(`[pausas] ${s.studentName}: no se pudo abrir la pausa:`, insErr.message);
        return null;
      }
      console.log(`[pausas] ${s.studentName}: en pausa desde ${started}.`);
      return data ? pauseFromRow(data as Record<string, unknown>) : null;
    }

    if (open) {
      const started = String(open.started_on ?? '').slice(0, 10);
      const ended = today >= started ? today : started;
      const { error: upErr } = await db.from('student_pauses')
        .update({ ended_on: ended, updated_at: new Date().toISOString() })
        .eq('id', open.id as string).is('ended_on', null);
      if (upErr) console.warn(`[pausas] ${s.studentName}: no se pudo cerrar la pausa:`, upErr.message);
      else console.log(`[pausas] ${s.studentName}: reactivado el ${ended}.`);
    }
    return null;
  } catch (err) {
    console.warn(`[pausas] ${s.studentName}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
