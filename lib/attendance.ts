// ── Asistencias / accesos a clase ─────────────────────────────────────────────
// Fuente ÚNICA que arma las filas de asistencia cruzando los horarios recurrentes
// de los assignments con los class_join_logs (el botón "Ingresar a clase"). Por
// cada clase esperada del rango decide su estado. La usan el panel del admin
// (todos los profes) y la sección "Asistencias" del profesor (solo las suyas).

import type { Assignment, ClassJoinLog } from '@/types';
import { minutesLateSpain } from '@/lib/spainTime';
import { contiguousRunLength, groupByContiguousHour, hourNum, hourText, nkName, sessionRangeLabel } from '@/lib/sessions';
import type { GridOccupancy } from '@/lib/teacherClasses';

export type AttendanceStatus =
  | 'on_time' | 'late' | 'very_late'   // ingresó (según puntualidad del log)
  | 'missed'                            // clase pasada sin ingreso
  | 'pending'                           // hoy, la hora aún no llegó
  | 'upcoming';                         // fecha futura (solo si includeFuture)

export interface LogRow {
  id: string;
  date: string;
  /** Hora de INICIO. Una sesión de 2h es UNA fila, no dos. */
  hour: string;
  /** Duración en horas: 2 cuando el alumno tiene dos celdas contiguas ese día. */
  durationHours: number;
  /** "12:00 - 14:00" para una sesión de 2h; "12:00" para una de 1h. */
  hoursLabel: string;
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

/**
 * Estilo de un estado, tolerante a valores que no conocemos.
 *
 * Acceder a PUNCT_STYLE[estado] directamente devuelve undefined ante un valor
 * inesperado, y leer `.bg` de ahí tira la pantalla ENTERA: así fue como tres
 * filas con la puntualidad en español dejaron sin cargar todo el "Registro de
 * clases". Una fila que no sepamos pintar se pinta en gris; nunca se lleva por
 * delante a las otras mil.
 */
export function punctStyleOf(status: string | null | undefined): { label: string; color: string; bg: string } {
  return PUNCT_STYLE[status as AttendanceStatus]
    ?? { label: '— Sin dato', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
}

const DAY_NAMES_BY_JSDAY = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Minutos de retraso (negativo = se adelantó) entre la hora programada y el clic.
// La hora programada es hora de ESPAÑA, no del navegador que mira: ver
// lib/spainTime.ts.
export function minutesLate(scheduledDate: string, scheduledTime: string, clickedAt: string): number {
  return minutesLateSpain(scheduledDate, scheduledTime, clickedAt);
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
  /**
   * Ocupación del CALENDARIO por profesor (`gridOccupancyOfTeacher`). Decide qué
   * horas seguidas son UNA clase de 2h con un solo acceso esperado. Sin ella se
   * agrupa por el horario de la ficha, que puede estar desactualizado.
   */
  gridOccupancyByTeacher?: Record<string, GridOccupancy>;
}): LogRow[] {
  const { assignments, joinLogs, teacherId, fromDate, toDate, todayIso, nowMinutes, includeFuture = false, gridOccupancyByTeacher } = opts;
  const rows: LogRow[] = [];
  const consumedLogs = new Set<string>();
  const relevant = assignments.filter(a => !teacherId || a.teacherId === teacherId);

  // Índice por hora NUMÉRICA para que '12:00' y '12' sean la misma hora.
  const logKey = (teacher: string, student: string, date: string, hour: string | number) =>
    `${teacher}|${student}|${date}|${hourNum(hour)}`;
  const logByKey = new Map<string, ClassJoinLog>();
  for (const log of joinLogs) {
    logByKey.set(logKey(log.teacherId, log.studentName, log.scheduledDate, log.scheduledTime), log);
  }

  const start = new Date(fromDate + 'T00:00:00');
  const end   = new Date(toDate + 'T00:00:00');
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return rows;

  const maxDays = 370;
  for (const a of relevant) {
    const hasLink = !!a.meetLink;

    // Horario del alumno agrupado en SESIONES: dos horas contiguas el mismo día
    // (12:00 + 13:00) son una sola clase de 2h, así que generan UNA fila con un
    // solo acceso esperado. Quien decide si son contiguas es el CALENDARIO
    // (`gridOccupancy`); la ficha puede haberse quedado con un horario viejo.
    const occ = gridOccupancyByTeacher?.[a.teacherId];
    const sessionsByDay = new Map<string, number[][]>();
    for (const slot of a.slots ?? []) {
      const arr = sessionsByDay.get(slot.day);
      const h = hourNum(slot.hour);
      if (!Number.isFinite(h)) continue;
      if (arr) arr.push([h]); else sessionsByDay.set(slot.day, [[h]]);
    }
    for (const [day, singles] of sessionsByDay) {
      const hours = singles.map(x => x[0]);
      const gridHours = occ?.hours.get(`${nkName(a.studentName)}|${day}`);
      // Solo se encadenan dos horas si el calendario las tiene seguidas.
      const chain = (x: number, y: number) => {
        if (!gridOccupancyByTeacher) return true;                 // llamador sin calendario
        // Con calendario disponible: si no tiene a este alumno ese día, la ficha
        // está vieja y no se espera un solo acceso para dos horas.
        if (!gridHours || gridHours.length === 0) return false;
        const run = contiguousRunLength(gridHours, x);
        return run > 1 && contiguousRunLength(gridHours, y) === run;
      };
      sessionsByDay.set(day, groupByContiguousHour(hours, h => h, chain));
    }

    const cursor = new Date(start);
    let dayCount = 0;
    while (cursor <= end && dayCount <= maxDays) {
      const dayName = DAY_NAMES_BY_JSDAY[cursor.getDay()];
      for (const run of sessionsByDay.get(dayName) ?? []) {
        const dateIso = isoDate(cursor);
        const startHour = run[0];
        const durationHours = run.length;
        const hour = hourText(startHour);
        const hoursLabel = sessionRangeLabel(startHour, durationHours);
        const id = `${a.id}_${dateIso}_${hour}`;

        // UN acceso dentro del rango de la sesión la valida ENTERA. Antes se
        // exigía un log por hora exacta, así que la segunda hora de una clase de
        // 2h salía siempre "🔴 No ingresó" aunque el profesor hubiera entrado.
        let log: ClassJoinLog | undefined;
        for (const h of run) {
          const k = logKey(a.teacherId, a.studentName, dateIso, h);
          const found = logByKey.get(k);
          // Todas las horas de la sesión quedan consumidas: si no, el ingreso de
          // la segunda hora reaparecería abajo como una fila suelta duplicada.
          consumedLogs.add(k);
          if (found && !log) log = found;
        }

        if (log) {
          rows.push({
            id, date: dateIso, hour, durationHours, hoursLabel,
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
            const startMinutes = startHour * 60;
            status = startMinutes < nowMinutes ? 'missed' : 'pending';
          } else if (includeFuture) {
            status = 'upcoming';
          }
          if (status) {
            rows.push({
              id, date: dateIso, hour, durationHours, hoursLabel,
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

  // Logs que no matchean un slot actual (p. ej. el horario cambió después, o una
  // clase dada fuera del horario fijo). Se agrupan con la MISMA regla: dos
  // accesos contiguos del mismo alumno el mismo día son una sesión de 2h, no dos
  // clases sueltas — así esta vista dice lo mismo que finanzas.
  const leftovers = new Map<string, ClassJoinLog[]>();
  for (const log of joinLogs) {
    if (teacherId && log.teacherId !== teacherId) continue;
    if (log.scheduledDate < fromDate || log.scheduledDate > toDate) continue;
    const key = logKey(log.teacherId, log.studentName, log.scheduledDate, log.scheduledTime);
    if (consumedLogs.has(key)) continue;
    consumedLogs.add(key);   // dos clics a la misma hora no son dos clases
    const k = `${log.teacherId}|${log.studentName}|${log.scheduledDate}`;
    const arr = leftovers.get(k);
    if (arr) arr.push(log); else leftovers.set(k, [log]);
  }
  for (const logs of leftovers.values()) {
    for (const run of groupByContiguousHour(logs, l => l.scheduledTime, () => true)) {
      const first = run[0];
      const linked = assignments.find(a => a.teacherId === first.teacherId && a.studentName === first.studentName);
      rows.push({
        id: first.id,
        date: first.scheduledDate, hour: hourText(hourNum(first.scheduledTime)),
        durationHours: run.length,
        hoursLabel: sessionRangeLabel(first.scheduledTime, run.length),
        teacherId: first.teacherId, teacherName: first.teacherName, studentName: first.studentName,
        joinedAt: first.clickedAt, status: first.punctuality, hasLink: !!linked?.meetLink,
        subscriptionStatus: first.subscriptionStatus, enteredWithoutActive: first.enteredWithoutActive,
        subscriptionDaysRemaining: first.subscriptionDaysRemaining,
      });
    }
  }

  return rows;
}
