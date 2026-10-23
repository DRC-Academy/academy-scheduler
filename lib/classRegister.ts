// ── Registro para disputas: las REGLAS, sin red ni base ───────────────────────
//
// Un listado de todas las clases con su estado, para defender una disputa de
// Stripe ("no recibí las clases"). No hay una fila por clase en ninguna tabla:
// la lista se ARMA.
//
//   1. Las clases que tocaban: lib/attendance.buildAttendanceRows, la MISMA
//      proyección del calendario que el "Registro de clases" del admin y las
//      Asistencias del profe (horario reconstruido con calendar_changes, sesiones
//      de 2 h como una fila, período del alumno, y los ingresos que no casan con
//      ninguna clase agendada como filas sueltas). markMovedClasses marca las
//      movidas. Aquí no se proyecta nada a mano.
//   2. A cada fila se le pegan sus rastros con la regla de siempre (profesor +
//      alumno + fecha + hora dentro del tramo de la sesión): el clic
//      (class_join_logs), la constancia (class_records), el transcript
//      (class_analyses, por join_log_id y si no por fecha: findTranscriptFor),
//      la posible ausencia detectada y la recuperación.
//   3. El estado, en este orden (gana el primero que aplica):
//        reprogramada            la clase se movió a otra fecha y no se entró
//        constancia              cancelada por el profe / el profe no se conectó /
//                                cancelada por el alumno (avisó) / menos de 24 h /
//                                el alumno no se conectó
//        clic o transcript       realizada, o recuperada si repone otra clase
//        posible ausencia        detectada y sin confirmar
//        sin registro            nada de lo anterior
//
// SOLO LECTURA por construcción: estas funciones reciben datos y devuelven filas.
// Lo que va al PDF lo decide `pdfRows`: nunca "sin registro" ni "posible
// ausencia", porque una disputa no puede llevar clases que quizá no existieron ni
// ausencias sin confirmar.

import { cancellationRecordFor } from '@/lib/teacherClasses';
import { absenceIdOf } from '@/lib/teacherAbsences';
import { DECLARED_ABSENCE_COMMENT } from '@/lib/classStatus';
import { findTranscriptFor, transcriptStateOf, type ClassTranscriptRef, type TranscriptExclusions } from '@/lib/transcriptDeadline';
import { getSpainParts, spainWallClockToEpoch } from '@/lib/spainTime';
import { hourNum, nkName } from '@/lib/sessions';
import type { LogRow } from '@/lib/attendance';
import type { ClassRecord } from '@/types';

// ── Estados ───────────────────────────────────────────────────────────────────

export type RegisterStatus =
  | 'realizada'
  | 'recuperada'
  | 'reprogramada'
  | 'cancelada_alumno_aviso'
  | 'cancelada_alumno_tarde'
  | 'alumno_no_conecto'
  | 'cancelada_profesor'
  | 'profesor_no_conecto'
  | 'posible_ausencia'
  | 'sin_registro';

export const REGISTER_STATUS_LABEL: Record<RegisterStatus, string> = {
  realizada:              'Realizada',
  recuperada:             'Recuperada',
  reprogramada:           'Reprogramada',
  cancelada_alumno_aviso: 'Cancelada por el alumno (avisó)',
  cancelada_alumno_tarde: 'Cancelada por el alumno con menos de 24 h (se da por realizada)',
  alumno_no_conecto:      'El alumno no se conectó (se da por realizada)',
  cancelada_profesor:     'Cancelada por el profe',
  profesor_no_conecto:    'El profe no se conectó',
  posible_ausencia:       'Posible ausencia del profe (sin confirmar)',
  sin_registro:           'Sin registro',
};

/** Orden de los filtros y de la leyenda. */
export const REGISTER_STATUSES = Object.keys(REGISTER_STATUS_LABEL) as RegisterStatus[];

/** Estados que nunca van al PDF: no prueban nada y podrían no ser ciertos. */
export const NOT_IN_PDF: ReadonlySet<RegisterStatus> = new Set(['sin_registro', 'posible_ausencia']);

/**
 * Antes de esta fecha no hay historial de horarios (calendar_changes): el
 * calendario de esas fechas se proyecta con el horario de HOY y es aproximado.
 */
export const SCHEDULE_HISTORY_START = '2026-09-28';

/**
 * Comentario con que la reclasificación del admin crea su constancia
 * 'cancelada_por_profesor' (lib/classRecoveryStore.reclassifyAsTeacherFalta).
 */
export const ADMIN_RECLASSIFIED_PREFIX = 'Solicitud de revisión aprobada por';

/**
 * Estado que dice una constancia de cancelación. `cancelada_por_profesor` es de
 * dos cosas distintas con el mismo tipo: la cancelación del profesor ("No puedo
 * dar esta clase", y la del botón viejo) y su FALTA confirmada (reclasificada por
 * el admin, o declarada por el propio profesor con "Estuve ausente"). Se
 * distinguen por el comentario que deja cada flujo.
 */
export function statusFromCancelRecord(r: Pick<ClassRecord, 'classType' | 'comment'>): RegisterStatus | null {
  switch (r.classType) {
    case 'cancelada_con_preaviso': return 'cancelada_profesor';
    case 'cancelada_por_profesor': {
      const c = (r.comment ?? '').trim();
      return c.startsWith(ADMIN_RECLASSIFIED_PREFIX) || c === DECLARED_ABSENCE_COMMENT ? 'profesor_no_conecto' : 'cancelada_profesor';
    }
    case 'cancelacion_hora':       return 'cancelada_alumno_tarde';
    case 'falta_sin_aviso':        return 'alumno_no_conecto';
    case 'falta_con_aviso':        return 'cancelada_alumno_aviso';
    default:                       return null;
  }
}

// ── Datos ─────────────────────────────────────────────────────────────────────

export interface RegisterJoinLog {
  id: string;
  teacherId: string;
  studentName: string;
  scheduledDate: string;
  scheduledTime: string;
  clickedAt: string;
  ip?: string | null;
}

export interface RegisterAbsence { id: string; status: string; annulledAt?: string | null }

export interface RegisterRecovery {
  teacherId: string;
  studentName: string;
  chosenDate: string | null;
  chosenHour: string | null;
  status: string;
}

export interface RegisterRow {
  id: string;
  /** 'YYYY-MM-DD' (hora de España). */
  date: string;
  /** 'HH:00', hora programada de inicio. */
  hour: string;
  /** "17:00" o "17:00 - 19:00". */
  hoursLabel: string;
  durationHours: number;
  studentName: string;
  teacherId: string;
  teacherName: string;
  status: RegisterStatus;
  /** Clic del profesor en "Ingresar a clase" (el primero de la sesión), ISO. */
  joinedAt: string | null;
  /** IP de ese clic (desde el 22/10/2026). */
  ip: string | null;
  /** Transcript subido y no rechazado. */
  hasTranscript: boolean;
  /** 'reprogramada': fecha a la que se movió. */
  rescheduledTo: string | null;
}

// ── Construcción ──────────────────────────────────────────────────────────────

/**
 * Filas del registro a partir de las de asistencia. `nowMs` deja fuera las
 * clases que todavía no han terminado sin ingreso (no se sabe aún qué pasó).
 */
export function buildRegisterRows(input: {
  attendance: LogRow[];
  joinLogs: RegisterJoinLog[];
  records: ClassRecord[];
  analyses: ClassTranscriptRef[];
  absences: RegisterAbsence[];
  recoveries: RegisterRecovery[];
  nowMs: number;
}): RegisterRow[] {
  const records = input.records.filter(r => !r.revertedAt);
  const absences = new Map(input.absences.map(a => [a.id, a]));
  const used: TranscriptExclusions = new Set();
  const out: RegisterRow[] = [];

  // Una clase, una fila: un alumno con DOS asignaciones con el mismo profesor
  // (pasa: Facundo Test con t1) sale dos veces en la proyección. Se queda la que
  // tiene ingreso, si alguna lo tiene.
  const unicas = new Map<string, LogRow>();
  for (const r of input.attendance) {
    if (r.status === 'pending' || r.status === 'upcoming') continue;
    const k = `${r.teacherId}|${nkName(r.studentName)}|${r.date}|${hourNum(r.hour)}`;
    const prev = unicas.get(k);
    if (!prev || (!prev.joinedAt && r.joinedAt)) unicas.set(k, r);
  }
  // Del más antiguo al más nuevo: el respaldo por fecha del transcript consume
  // los sueltos en orden, como en el resto de vistas.
  const ordered = [...unicas.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || hourNum(a.hour) - hourNum(b.hour));

  for (const r of ordered) {
    const start = hourNum(r.hour);
    const span = Number.isFinite(start) ? { start, end: start + Math.max(1, r.durationHours) } : undefined;
    const inSpan = (time: string | null | undefined) => {
      const h = hourNum(time ?? '');
      return !span || !Number.isFinite(h) || (h >= span.start && h < span.end);
    };
    const same = (teacherId: string, studentName: string) => teacherId === r.teacherId && nkName(studentName) === nkName(r.studentName);

    const joins = input.joinLogs
      .filter(l => same(l.teacherId, l.studentName) && l.scheduledDate === r.date && inSpan(l.scheduledTime))
      .sort((a, b) => a.clickedAt.localeCompare(b.clickedAt));
    const join = joins[0] ?? null;
    const joinedAt = join?.clickedAt ?? r.joinedAt ?? null;

    // Una clase que no ha terminado y sin ingreso todavía no tiene historia.
    const endMs = span ? spainWallClockToEpoch(r.date, span.end) : NaN;
    if (!joinedAt && Number.isFinite(endMs) && endMs > input.nowMs) continue;

    const transcript = findTranscriptFor(input.analyses, {
      teacherId: r.teacherId, studentName: r.studentName, dateIso: r.date,
      joinLogIds: joins.map(j => j.id), exclude: used,
    });
    const tState = transcriptStateOf(transcript);
    const hasTranscript = tState === 'ok' || tState === 'review';

    const record = cancellationRecordFor(records, r.teacherId, r.studentName, r.date, span);
    const isRecovery = !!r.rescheduledFrom
      || records.some(c => same(c.teacherId, c.studentName) && c.classDate === r.date && c.classType === 'recuperacion' && inSpan(c.classTime))
      || input.recoveries.some(c => same(c.teacherId, c.studentName) && c.chosenDate === r.date
        && (c.status === 'confirmada' || c.status === 'recuperada') && inSpan(c.chosenHour));
    const absence = Number.isFinite(start) ? absences.get(absenceIdOf(r.teacherId, r.studentName, r.date, start)) : undefined;

    let status: RegisterStatus;
    if (r.status === 'rescheduled' && !joinedAt) status = 'reprogramada';
    else if (record && statusFromCancelRecord(record)) status = statusFromCancelRecord(record)!;
    else if (joinedAt || hasTranscript) status = isRecovery ? 'recuperada' : 'realizada';
    else if (absence && absence.status === 'posible_ausencia' && !absence.annulledAt) status = 'posible_ausencia';
    else status = 'sin_registro';

    out.push({
      id: r.id, date: r.date, hour: r.hour, hoursLabel: r.hoursLabel, durationHours: r.durationHours,
      studentName: r.studentName, teacherId: r.teacherId, teacherName: r.teacherName,
      status, joinedAt, ip: join?.ip ?? null, hasTranscript,
      rescheduledTo: status === 'reprogramada' ? r.rescheduledTo ?? null : null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || hourNum(a.hour) - hourNum(b.hour)
    || a.teacherName.localeCompare(b.teacherName) || a.studentName.localeCompare(b.studentName));
}

// ── Filtros, PDF y resumen ────────────────────────────────────────────────────

export interface RegisterFilter {
  desde: string;
  hasta: string;
  /** Nombre del alumno (sin distinguir mayúsculas). */
  alumno?: string | null;
  profe?: string | null;
  estado?: RegisterStatus | null;
}

export function filterRegisterRows(rows: RegisterRow[], f: RegisterFilter): RegisterRow[] {
  const alumno = f.alumno ? nkName(f.alumno) : null;
  return rows.filter(r =>
    r.date >= f.desde && r.date <= f.hasta
    && (!alumno || nkName(r.studentName) === alumno)
    && (!f.profe || r.teacherId === f.profe)
    && (!f.estado || r.status === f.estado));
}

/** Lo que va al PDF: lo filtrado, sin lo que no prueba nada. */
export function pdfRows(rows: RegisterRow[]): RegisterRow[] {
  return rows.filter(r => !NOT_IN_PDF.has(r.status));
}

export interface StudentSummary {
  total: number;
  realizadas: number;
  /** Cancelación con menos de 24 h + el alumno no se conectó. */
  dadasPorRealizadas: number;
  canceladasAlumno: number;
  canceladasProfe: number;
  profeNoConecto: number;
  recuperadas: number;
  reprogramadas: number;
}

/** Resumen del alumno, sobre las filas del PDF. */
export function studentSummary(rows: RegisterRow[]): StudentSummary {
  const n = (...s: RegisterStatus[]) => rows.filter(r => s.includes(r.status)).length;
  return {
    total: rows.length,
    realizadas: n('realizada'),
    dadasPorRealizadas: n('cancelada_alumno_tarde', 'alumno_no_conecto'),
    canceladasAlumno: n('cancelada_alumno_aviso'),
    canceladasProfe: n('cancelada_profesor'),
    profeNoConecto: n('profesor_no_conecto'),
    recuperadas: n('recuperada'),
    reprogramadas: n('reprogramada'),
  };
}

/** Hora de España 'HH:MM' de un instante ISO ('' si no es válido). */
export function spainTimeOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = getSpainParts(d);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * Hora del ingreso para la tabla: 'HH:MM' (España) si el clic fue el día de la
 * clase; con la fecha delante ('dd/mm HH:MM') si fue otro día, para que una
 * clase de las 23:00 a la que se entró a la 01:30 no parezca del mismo día.
 */
export function joinedLabel(joinedAt: string | null | undefined, classDate: string): string {
  if (!joinedAt) return '';
  const d = new Date(joinedAt);
  if (isNaN(d.getTime())) return '';
  const p = getSpainParts(d);
  const hhmm = spainTimeOf(joinedAt);
  return p.dateStr === classDate ? hhmm : `${p.dateStr.slice(8, 10)}/${p.dateStr.slice(5, 7)} ${hhmm}`;
}

/** 'dd/mm/aaaa' de 'YYYY-MM-DD'. */
export function dmy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/** Nombre del archivo: registro-[alumno]-[desde]-[hasta].pdf (sin tildes ni espacios). */
export function pdfFileName(alumno: string | null | undefined, desde: string, hasta: string): string {
  const slug = (alumno ?? 'todos').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'todos';
  return `registro-${slug}-${desde}-${hasta}.pdf`;
}

/** ¿El rango toca fechas con el horario aproximado (sin historial)? */
export function rangeHasApproxSchedule(desde: string): boolean {
  return desde < SCHEDULE_HISTORY_START;
}
