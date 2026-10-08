// Consultas de class_recoveries con el cliente de Supabase INYECTADO.
//
// Las usan lib/classRecoveryStore.ts (servidor, su cliente de siempre) y el
// núcleo de transferencia (navegador o servidor). NO importa lib/supabase.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { proposalsExpired, slotHours, type RecoveryStatus, type Slot } from '@/lib/classRecoveries';

type Db = SupabaseClient;

export interface LiveReservation { date: string; hour: string; studentName: string; groupId: string }

/** Reservas vivas del profesor: propuestas en 'esperando_alumno' que no vencieron, una por hora. */
export async function liveReservationsWith(db: Db, teacherId: string, nowMs = Date.now()): Promise<LiveReservation[]> {
  return (await liveReservationsOfTeachersWith(db, [teacherId], nowMs)).get(teacherId) ?? [];
}

/** liveReservationsWith para VARIOS profesores en UNA consulta, por profesor. */
export async function liveReservationsOfTeachersWith(
  db: Db, teacherIds: string[], nowMs = Date.now(),
): Promise<Map<string, LiveReservation[]>> {
  const out = new Map<string, LiveReservation[]>(teacherIds.map(id => [id, []]));
  if (teacherIds.length === 0) return out;
  const { data, error } = await db.from('class_recoveries')
    .select('teacher_id, group_id, student_name, teacher_proposals, status').in('teacher_id', teacherIds).eq('status', 'esperando_alumno');
  if (error) return out;
  for (const r of data ?? []) {
    const props = (r.teacher_proposals ?? []) as Slot[];
    if (proposalsExpired(props, nowMs)) continue;
    const lista = out.get(r.teacher_id);
    if (!lista) continue;
    for (const s of props) for (const h of slotHours(s)) lista.push({ ...h, studentName: r.student_name, groupId: r.group_id });
  }
  return out;
}

/**
 * Recuperación ABIERTA = todavía puede acabar en una clase: el profesor propuso
 * (esperando_alumno), el alumno propuso (alumno_propuso) o hay fecha elegida que
 * aún no se dio (confirmada; el chequeo nocturno la pasa a 'recuperada').
 * 'recuperada', 'sin_acuerdo' y 'anulada' ya no generan clase.
 */
export const OPEN_RECOVERY_STATUSES: readonly RecoveryStatus[] = ['esperando_alumno', 'alumno_propuso', 'confirmada'];

export interface OpenRecovery { id: string; groupId: string; status: RecoveryStatus; teacherId: string; originalDate: string; originalHour: string }

/**
 * Recuperaciones abiertas del alumno, buscadas por su asignación o por su id de
 * alumno. Sin la tabla (SQL sin correr) devuelve [] y lo avisa. LANZA ante otro
 * error: decir "no tiene" por un fallo de lectura dejaría pasar una operación que
 * debía frenarse.
 */
export async function openRecoveriesOfStudentWith(
  db: Db, who: { assignmentId: string; studentId?: string | null },
): Promise<OpenRecovery[]> {
  const filtro = who.studentId
    ? `assignment_id.eq.${who.assignmentId},student_id.eq.${who.studentId}`
    : `assignment_id.eq.${who.assignmentId}`;
  const { data, error } = await db.from('class_recoveries')
    .select('id, group_id, status, teacher_id, original_date, original_hour')
    .or(filtro)
    .in('status', OPEN_RECOVERY_STATUSES as RecoveryStatus[]);
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') {
      console.warn('[recuperaciones] Falta la tabla class_recoveries: no se comprueban recuperaciones abiertas.');
      return [];
    }
    throw new Error(`No se pudieron leer las recuperaciones del alumno: ${error.message}`);
  }
  return ((data ?? []) as Array<{ id: string; group_id: string; status: RecoveryStatus; teacher_id: string; original_date: string; original_hour: string }>)
    .map(r => ({ id: r.id, groupId: r.group_id, status: r.status, teacherId: r.teacher_id, originalDate: String(r.original_date).slice(0, 10), originalHour: r.original_hour }));
}
