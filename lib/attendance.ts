// ── Asistencias / accesos a clase ─────────────────────────────────────────────
// Fuente ÚNICA que arma las filas de asistencia cruzando los horarios recurrentes
// de los assignments con los class_join_logs (el botón "Ingresar a clase"). Por
// cada clase esperada del rango decide su estado. La usan el panel del admin
// (todos los profes) y la sección "Asistencias" del profesor (solo las suyas).

import type { Assignment, ClassJoinLog } from '@/types';

export type AttendanceStatus =
  | 'on_time' | 'late' | 'very_late'   // ingresó (según puntualidad del log)
  | 'missed'                            // clase pasada sin ingreso
  | 'pending'                           // hoy, la hora aún no llegó
  | 'upcoming';                         // fecha futura (solo si includeFuture)

export interface LogRow {
  id: string;
  date: string;
  hour: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  joinedAt?: string;
  status: AttendanceStatus;
  hasLink: boolean;
  subscriptionStatus?: string;
  enteredWithoutActive?: boolean;
  subscriptionDaysRemaining?: number;
}

export const PUNCT_STYLE: Record<AttendanceStatus, { label: string; color: string; bg: string }> = {
  on_time:   { label: '✅ A tiempo',  color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' },
  late:      { label: '🟡 Tarde',     color: '#b45309', bg: 'rgba(245,158,11,0.12)' },
  very_late: { label: '🟠 Muy tarde', color: '#ea580c', bg: 'rgba(249,115,22,0.12)' },
  missed:    { label: '🔴 No ingresó', color: '#dc2626', bg: 'rgba(239,68,68,0.1)' },
  pending:   { label: '⏳ Pendiente',  color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' },
  upcoming:  { label: '🗓️ Próxima',   color: '#2563eb', bg: 'rgba(37,99,235,0.1)' },
};

const DAY_NAMES_BY_JSDAY = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Minutos de retraso (negativo = se adelantó) entre la hora programada y el clic.
export function minutesLate(scheduledDate: string, scheduledTime: string, clickedAt: string): number {
  const [y, m, d] = scheduledDate.split('-').map(Number);
  const hour = parseInt(scheduledTime);
  const scheduled = new Date(y, (m ?? 1) - 1, d ?? 1, isNaN(hour) ? 0 : hour, 0, 0, 0);
  return (new Date(clickedAt).getTime() - scheduled.getTime()) / 60000;
}

// Badge de suscripción de una fila (solo tiene sentido si hubo ingreso).
export function attendanceSubBadge(r: { joinedAt?: string; subscriptionStatus?: string; enteredWithoutActive?: boolean; subscriptionDaysRemaining?: number }):
  { label: string; color: string; bg: string } | null {
  if (!r.joinedAt) return null; // no se registró ingreso (no ingresó)
  if (r.enteredWithoutActive) {
    const days = (r.subscriptionDaysRemaining != null && r.subscriptionDaysRemaining > 0)
      ? ` · ${r.subscriptionDaysRemaining}d`
      : '';
    return { label: `⚠️ Inactiva (ingresó igual)${days}`, color: '#ea580c', bg: 'rgba(249,115,22,0.12)' };
  }
  if (r.subscriptionStatus === 'active') return { label: '✅ Activa', color: '#1E9E3A', bg: 'rgba(30,158,58,0.1)' };
  return { label: '❓ No verificado', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
}

/**
 * Arma las filas de asistencia del rango [fromDate, toDate].
 *
 * Por cada instancia recurrente de clase (slot que cae en un día del rango):
 *   · si hay join log → estado = puntualidad del log (ingresó).
 *   · sin log y fecha pasada → 'missed' (no ingresó).
 *   · sin log y hoy: hora ya pasó → 'missed'; aún no → 'pending'.
 *   · sin log y fecha futura → 'upcoming' (solo si includeFuture), si no se omite.
 * Además incluye los logs que ya no matchean un slot actual (horario cambiado).
 *
 * `now` (todayIso/nowMinutes) debe venir en hora de España para que "pasó/no pasó"
 * sea consistente sin importar la zona del que mira. NO ordena: ordena el caller.
 */
export function buildAttendanceRows(opts: {
  assignments: Assignment[];
  joinLogs: ClassJoinLog[];
  teacherId?: string;        // filtra a un profesor (admin: filtro; profe: su id)
  fromDate: string;          // ISO
  toDate: string;            // ISO
  todayIso: string;          // ISO (hora España)
  nowMinutes: number;        // minutos desde 00:00 (hora España)
  includeFuture?: boolean;   // incluir clases futuras como 'upcoming'
}): LogRow[] {
  const { assignments, joinLogs, teacherId, fromDate, toDate, todayIso, nowMinutes, includeFuture = false } = opts;
  const rows: LogRow[] = [];
  const consumedLogs = new Set<string>();
  const relevant = assignments.filter(a => !teacherId || a.teacherId === teacherId);

  const logByKey = new Map<string, ClassJoinLog>();
  for (const log of joinLogs) {
    logByKey.set(`${log.teacherId}|${log.studentName}|${log.scheduledDate}|${log.scheduledTime}`, log);
  }

  const start = new Date(fromDate + 'T00:00:00');
  const end   = new Date(toDate + 'T00:00:00');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return rows;

  const maxDays = 370;
  for (const a of relevant) {
    const hasLink = !!a.meetLink;
    const cursor = new Date(start);
    let dayCount = 0;
    while (cursor <= end && dayCount <= maxDays) {
      const dayName = DAY_NAMES_BY_JSDAY[cursor.getDay()];
      for (const slot of a.slots) {
        if (slot.day !== dayName) continue;
        const dateIso = isoDate(cursor);
        const key = `${a.teacherId}|${a.studentName}|${dateIso}|${slot.hour}`;
        const log = logByKey.get(key);
        if (log) {
          consumedLogs.add(key);
          rows.push({
            id: `${a.id}_${dateIso}_${slot.hour}`,
            date: dateIso, hour: slot.hour,
            teacherId: a.teacherId, teacherName: a.teacherName, studentName: a.studentName,
            joinedAt: log.clickedAt, status: log.punctuality, hasLink,
            subscriptionStatus: log.subscriptionStatus, enteredWithoutActive: log.enteredWithoutActive,
            subscriptionDaysRemaining: log.subscriptionDaysRemaining,
          });
        } else {
          let status: AttendanceStatus | null = null;
          if (dateIso < todayIso) {
            status = 'missed';
          } else if (dateIso === todayIso) {
            const startMinutes = (parseInt(slot.hour) || 0) * 60;
            status = startMinutes < nowMinutes ? 'missed' : 'pending';
          } else if (includeFuture) {
            status = 'upcoming';
          }
          if (status) {
            rows.push({
              id: `${a.id}_${dateIso}_${slot.hour}`,
              date: dateIso, hour: slot.hour,
              teacherId: a.teacherId, teacherName: a.teacherName, studentName: a.studentName,
              status, hasLink,
            });
          }
        }
      }
      cursor.setDate(cursor.getDate() + 1);
      dayCount++;
    }
  }

  // Logs que no matchean un slot actual (p. ej. el horario cambió después).
  for (const log of joinLogs) {
    if (teacherId && log.teacherId !== teacherId) continue;
    if (log.scheduledDate < fromDate || log.scheduledDate > toDate) continue;
    const key = `${log.teacherId}|${log.studentName}|${log.scheduledDate}|${log.scheduledTime}`;
    if (consumedLogs.has(key)) continue;
    const linked = assignments.find(a => a.teacherId === log.teacherId && a.studentName === log.studentName);
    rows.push({
      id: log.id,
      date: log.scheduledDate, hour: log.scheduledTime,
      teacherId: log.teacherId, teacherName: log.teacherName, studentName: log.studentName,
      joinedAt: log.clickedAt, status: log.punctuality, hasLink: !!linked?.meetLink,
      subscriptionStatus: log.subscriptionStatus, enteredWithoutActive: log.enteredWithoutActive,
      subscriptionDaysRemaining: log.subscriptionDaysRemaining,
    });
  }

  return rows;
}
