// ── Estado de cada clase dada: las REGLAS, sin red ni base ────────────────────
//
// Después de cada clase el profesor deja constancia de qué pasó. Siempre uno de
// estos siete estados:
//
//   realizada                      transcript subido (en revisión o validado)
//   recuperada                     ídem, en una clase de recuperación
//   cancelada_alumno_antelacion    el alumno avisó con más de 24 h ('falta_con_aviso'
//                                  o clase reprogramada)
//   cancelada_alumno_tarde         'cancelacion_hora' — se da por realizada
//   alumno_no_conecto              'falta_sin_aviso' — se da por realizada
//   cancelada_profesor             "No puedo dar esta clase" ('cancelada_con_preaviso',
//                                  o 'cancelada_por_profesor' con ese comentario)
//   profesor_ausente               falta del profesor: posible ausencia detectada,
//                                  reclasificación del admin o "Estuve ausente"
//
// NO HAY COLUMNA DE ESTADO. Cada estado sale de lo que ya existe (class_records,
// el transcript, la posible ausencia, la solicitud de revisión), así que no puede
// contradecir a Finanzas: es la misma constancia que Finanzas lee. Una solicitud
// de revisión pendiente también cuenta como marcada: el profesor ya dijo qué
// pasó y lo que falta es la validación del admin.
//
// Si no hay nada, la clase está SIN ESTADO. A las 24 h del final se avisa al
// profesor y a las 48 h al admin (lib/classStatusStore, reloj horario).
//
// Las clases se arman exactamente como en "Mis clases" y en el chequeo de
// ausencias (sessionsOfTeacherOn): la misma definición de "clase" en las tres
// puntas.

import {
  rescheduledTargetFor, cancellationRecordFor, addDaysIso,
} from '@/lib/teacherClasses';
import { sessionsOfTeacherOn, absenceIdOf, type TeacherScheduleInput } from '@/lib/teacherAbsences';
import { findTranscriptFor, transcriptStateOf, type ClassTranscriptRef } from '@/lib/transcriptDeadline';
import { getSpainParts, spainWallClockToEpoch } from '@/lib/spainTime';
import { hourNum, hourText, nkName } from '@/lib/sessions';
import type { ClassRecord } from '@/types';

// ── Constantes ────────────────────────────────────────────────────────────────

/**
 * Primer día cuyas clases necesitan estado (hora de España). Nada hacia atrás:
 * las clases anteriores no se avisan nunca. Es el día del despliegue.
 */
export const CLASS_STATUS_START_DATE = '2026-10-23';

/** Horas desde el FINAL de la clase sin estado para avisar al profesor. */
export const STATUS_TEACHER_AFTER_HOURS = 24;
/** Horas desde el final para avisar al admin. */
export const STATUS_ADMIN_AFTER_HOURS = 48;
/**
 * Días hacia atrás que mira el reloj en cada vuelta. Cubre el aviso al admin
 * (48 h) con margen de sobra para un reloj que se salte vueltas; los ids fijos
 * impiden repetir avisos.
 */
export const STATUS_LOOKBACK_DAYS = 4;

/**
 * Comentario con el que "No puedo dar esta clase" crea su constancia
 * (lib/classRecoveryStore). Distingue la cancelación del profesor de una falta
 * suya, que usan el mismo tipo 'cancelada_por_profesor'.
 */
export const TEACHER_CANCEL_COMMENT_PREFIX = 'No puedo dar esta clase';

/** Comentario de la constancia cuando el propio profesor declara su falta. */
export const DECLARED_ABSENCE_COMMENT = 'Declarada por el profesor: estuve ausente';

// ── Estados ───────────────────────────────────────────────────────────────────

export type ClassStatus =
  | 'realizada'
  | 'recuperada'
  | 'cancelada_alumno_antelacion'
  | 'cancelada_alumno_tarde'
  | 'alumno_no_conecto'
  | 'cancelada_profesor'
  | 'profesor_ausente';

export const CLASS_STATUS_LABEL: Record<ClassStatus, string> = {
  realizada:                   'Realizada',
  recuperada:                  'Recuperada',
  cancelada_alumno_antelacion: 'Cancelada por el alumno con más de 24 h',
  cancelada_alumno_tarde:      'Cancelada por el alumno con menos de 24 h',
  alumno_no_conecto:           'El alumno no se conectó',
  cancelada_profesor:          'Cancelada por el profe',
  profesor_ausente:            'El profe no se conectó',
};

/** Estado que dice una constancia de class_records, si dice alguno. */
export function statusFromRecord(r: Pick<ClassRecord, 'classType' | 'comment'>): ClassStatus | null {
  switch (r.classType) {
    case 'reprogramada':
    case 'falta_con_aviso':        return 'cancelada_alumno_antelacion';
    case 'cancelacion_hora':       return 'cancelada_alumno_tarde';
    case 'falta_sin_aviso':        return 'alumno_no_conecto';
    case 'cancelada_con_preaviso': return 'cancelada_profesor';
    case 'cancelada_por_profesor':
      return (r.comment ?? '').startsWith(TEACHER_CANCEL_COMMENT_PREFIX) ? 'cancelada_profesor' : 'profesor_ausente';
    default:                       return null;
  }
}

/** Estado que dice una solicitud de revisión no rechazada (lo resuelto manda). */
export function statusFromReview(type: string | null | undefined): ClassStatus | null {
  switch (type) {
    case 'normal':                 return 'realizada';
    case 'falta_sin_aviso':        return 'alumno_no_conecto';
    case 'falta_con_aviso':        return 'cancelada_alumno_antelacion';
    case 'cancelacion_hora':       return 'cancelada_alumno_tarde';
    case 'cancelada_por_profesor': return 'profesor_ausente';
    default:                       return null;
  }
}

/**
 * Estado de UNA clase a partir de lo que se sabe de ella. En este orden: el
 * transcript (la clase se dio), la reprogramación, la constancia, la falta del
 * profesor detectada y, por último, lo declarado en una revisión pendiente.
 */
export function classStatusOf(i: {
  isRecovery: boolean;
  /** Estado del transcript de la clase (lib/transcriptDeadline.transcriptStateOf). */
  transcriptState: 'none' | 'review' | 'rejected' | 'ok';
  rescheduled: boolean;
  record: Pick<ClassRecord, 'classType' | 'comment'> | null;
  absenceDetected: boolean;
  reviewType: string | null;
}): ClassStatus | null {
  if (i.transcriptState === 'ok' || i.transcriptState === 'review') return i.isRecovery ? 'recuperada' : 'realizada';
  if (i.rescheduled) return 'cancelada_alumno_antelacion';
  const fromRecord = i.record ? statusFromRecord(i.record) : null;
  if (fromRecord) return fromRecord;
  if (i.absenceDetected) return 'profesor_ausente';
  return statusFromReview(i.reviewType);
}

// ── Datos mínimos ─────────────────────────────────────────────────────────────

export interface StatusJoinLog {
  id: string;
  teacherId: string;
  studentName: string;
  scheduledDate: string;
  scheduledTime: string;
}

export type StatusRecord = Pick<ClassRecord, 'id' | 'teacherId' | 'studentName' | 'classDate' | 'classTime' | 'classType' | 'rescheduledTo' | 'comment'>;

export interface StatusAbsence {
  id: string;
  status: string;
  annulledAt?: string | null;
}

export interface StatusReview {
  teacherId: string;
  studentName: string;
  classDate: string;
  classTime?: string | null;
  status: string;
  requestedType: string;
  resolvedType?: string | null;
}

/** Una clase terminada que sigue sin estado. */
export interface UnmarkedClass {
  /** Id fijo: profesor + fecha + hora de inicio + alumno. */
  id: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  /** 'YYYY-MM-DD' (hora de España). */
  date: string;
  /** 'HH:00', hora de inicio. */
  hour: string;
  durationHours: number;
  isRecovery: boolean;
  /** Instante del FINAL de la clase. */
  endMs: number;
  /** Horas enteras desde el final. */
  hoursSinceEnd: number;
  /** ¿Pulsó "Ingresar a clase"? Sin ingreso puede declarar "Estuve ausente". */
  hasJoin: boolean;
}

// ── Ids y fechas ──────────────────────────────────────────────────────────────

/** Id fijo de la clase para los avisos de estado (mismo esquema que la ausencia). */
export function statusIdOf(teacherId: string, studentName: string, date: string, startHour: number | string): string {
  return absenceIdOf(teacherId, studentName, date, startHour).replace(/^aus_/, 'estado_');
}

/** Fechas a mirar: desde hace `lookbackDays` (nunca antes del corte) hasta hoy, en España. */
export function statusDates(nowMs: number, lookbackDays: number): string[] {
  const hoy = getSpainParts(new Date(nowMs)).dateStr;
  const out: string[] = [];
  for (let d = addDaysIso(hoy, -lookbackDays); d <= hoy; d = addDaysIso(d, 1)) {
    if (d >= CLASS_STATUS_START_DATE) out.push(d);
  }
  return out;
}

// ── Clases sin estado ─────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

/**
 * Clases de esas fechas que terminaron hace al menos `minHoursAfterEnd` horas y
 * siguen sin estado. Con 0, todas las terminadas (lo que ve el profesor).
 */
export function findUnmarkedClasses(input: {
  teachers: TeacherScheduleInput[];
  records: StatusRecord[];
  joinLogs: StatusJoinLog[];
  analyses: ClassTranscriptRef[];
  absences: StatusAbsence[];
  reviews: StatusReview[];
  dates: string[];
  nowMs: number;
  minHoursAfterEnd: number;
}): UnmarkedClass[] {
  const records = input.records as ClassRecord[];
  const absences = new Map(input.absences.map(a => [a.id, a]));
  const out: UnmarkedClass[] = [];

  for (const t of input.teachers) {
    for (const date of input.dates) {
      if (date < CLASS_STATUS_START_DATE) continue;
      for (const s of sessionsOfTeacherOn(t, date)) {
        const startMs = spainWallClockToEpoch(s.date, s.startHourNum);
        if (!Number.isFinite(startMs)) continue;
        const endMs = startMs + Math.max(1, s.durationHours) * HOUR_MS;
        if (input.nowMs < endMs + input.minHoursAfterEnd * HOUR_MS) continue;

        const names = [...new Set([s.studentName, s.assignment?.studentName].filter(Boolean) as string[])];
        const nameKeys = new Set(names.map(nkName));
        const inSpan = (time: string | null | undefined) => {
          const h = hourNum(time ?? '');
          return !Number.isFinite(h) || (h >= s.startHourNum && h < s.endHourNum);
        };
        const span = { start: s.startHourNum, end: s.endHourNum };

        const joins = input.joinLogs.filter(l =>
          l.teacherId === t.teacherId && l.scheduledDate === date && nameKeys.has(nkName(l.studentName)) && inSpan(l.scheduledTime));
        const joinLogIds = joins.map(l => l.id);
        const transcript = names
          .map(n => findTranscriptFor(input.analyses, { teacherId: t.teacherId, studentName: n, dateIso: date, joinLogIds }))
          .find(Boolean);
        const rescheduled = names.some(n => !!rescheduledTargetFor(records, t.teacherId, n, date, span));
        const record = names.map(n => cancellationRecordFor(records, t.teacherId, n, date, span)).find(Boolean) ?? null;
        const absence = absences.get(absenceIdOf(t.teacherId, s.studentName, date, s.startHourNum));
        const review = input.reviews.find(r =>
          r.teacherId === t.teacherId && r.classDate === date && nameKeys.has(nkName(r.studentName))
          && inSpan(r.classTime) && r.status !== 'rechazada');

        const status = classStatusOf({
          isRecovery: !!s.isRecovery,
          transcriptState: transcriptStateOf(transcript),
          rescheduled,
          record,
          absenceDetected: !!absence && absence.status === 'posible_ausencia' && !absence.annulledAt,
          reviewType: review ? (review.resolvedType ?? review.requestedType) : null,
        });
        if (status) continue;

        out.push({
          id: statusIdOf(t.teacherId, s.studentName, date, s.startHourNum),
          teacherId: t.teacherId, teacherName: t.teacherName,
          studentName: s.studentName, date, hour: hourText(s.startHourNum),
          durationHours: s.durationHours, isRecovery: !!s.isRecovery,
          endMs, hoursSinceEnd: Math.floor((input.nowMs - endMs) / HOUR_MS),
          hasJoin: joins.length > 0,
        });
      }
    }
  }
  return out.sort((a, b) => a.endMs - b.endMs);
}
