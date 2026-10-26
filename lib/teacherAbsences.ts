// ── Posibles ausencias del profesor: las REGLAS, sin red ni base ──────────────
//
// A los 30 minutos del inicio de una clase (hora de España), si el profesor no
// pulsó "Ingresar a clase", Gestión avisa a Zapier (que manda el WhatsApp al
// alumno y el aviso a Slack) y lo deja anotado en el admin como "posible
// ausencia". Este módulo decide, sin tocar nada:
//   · qué clases TOCABAN en la ventana (calendario + recuperaciones confirmadas,
//     sesión de 2 h como UNA clase, dentro del período del alumno);
//   · cuáles quedan fuera (canceladas, reprogramadas, faltas del alumno ya
//     registradas, o con ingreso);
//   · el id fijo de cada clase (un solo aviso por clase);
//   · qué se manda a Zapier.
// Lo que necesita a WooCommerce (pausa, inactivo, teléfono de facturación) y la
// base lo hace lib/teacherAbsenceStore. Lo prueba lib/teacherAbsences.test.ts.
//
// LA MISMA REGLA QUE VE EL PROFESOR. Las clases se arman exactamente como en
// "Mis clases" (components/MisClasesPanel): classesForDate + recoveriesForDate +
// groupContiguousClasses, con el período del alumno y las constancias que las
// apagan. Si cada lado tuviera su propia definición de "clase", el aviso le
// llegaría a un alumno por una clase que el profesor ni siquiera veía.

import {
  classesForDate, recoveriesForDate, groupContiguousClasses, rescheduledTargetFor,
  cancellationFor, addDaysIso, fmtDateDMY,
  type GridOccupancy, type TeacherSession,
} from '@/lib/teacherClasses';
import type { StudentPeriod } from '@/lib/studentPeriod';
import { getSpainParts, spainWallClockToEpoch } from '@/lib/spainTime';
import { hourNum, hourText, nkName } from '@/lib/sessions';
import type { Assignment, ClassRecord, Grid } from '@/types';

// ── Constantes ────────────────────────────────────────────────────────────────

/** Minutos desde el inicio de la clase sin ingreso para considerarla posible ausencia. */
export const ABSENCE_AFTER_MINUTES = 30;
/**
 * Hasta cuántos minutos después del inicio se sigue mirando una clase. Con el
 * chequeo cada 5 minutos, el aviso sale entre el minuto 30 y el 35; el margen
 * hasta el 90 cubre un reloj que se salte vueltas.
 */
export const ABSENCE_WINDOW_END_MINUTES = 90;
/** Intentos de envío a Zapier por clase (solo se reintenta si Zapier falló). */
export const MAX_ZAPIER_ATTEMPTS = 3;

// ── Recuperación automática por ausencia ─────────────────────────────────────

/**
 * Profesores a los que, al detectar una posible ausencia, se les crea sola la
 * recuperación (el alumno elige la fecha desde el LMS). `['*']` = todos (desde
 * el 19/10/2026; antes fue una beta con ['t1']). Con una lista de ids, el resto
 * sigue como antes: aviso a Zapier sin recuperación y con `enlace_recuperacion`
 * vacío.
 */
export const ABSENCE_RECOVERY_BETA_TEACHERS: readonly string[] = ['*'];

export function isAbsenceRecoveryTeacher(teacherId: string | null | undefined): boolean {
  if (ABSENCE_RECOVERY_BETA_TEACHERS.includes('*')) return true;
  return !!teacherId && ABSENCE_RECOVERY_BETA_TEACHERS.includes(teacherId);
}

/** Opciones que se ofrecen al alumno: una por día, como mucho estas. */
export const MAX_ABSENCE_OPTIONS = 4;

/**
 * Cuándo se manda el email al alumno con el enlace de la recuperación.
 * 'siempre' mientras el WhatsApp de Zapier no esté activo; después,
 * 'sin_telefono' (solo a quien no le puede llegar el WhatsApp).
 */
export const ABSENCE_RECOVERY_STUDENT_EMAIL: 'siempre' | 'sin_telefono' = 'siempre';

export function shouldEmailAbsenceRecovery(phone: string | null | undefined): boolean {
  return ABSENCE_RECOVERY_STUDENT_EMAIL === 'siempre' || !(phone ?? '').trim();
}

/**
 * Las opciones de una recuperación por ausencia: UNA por día (los días vienen
 * ya en orden y filtrados: desde mañana, 7 días, sin domingos), la hora libre
 * más cercana a la de la clase perdida (a igual distancia, la más temprana), y
 * como mucho `max` días. Los días sin horas libres se saltan.
 */
export function pickAbsenceOptions(
  freeByDay: Array<{ date: string; hours: string[] }>, originalHour: string, hours: number, max = MAX_ABSENCE_OPTIONS,
): Array<{ date: string; hour: string; hours: number }> {
  const target = hourNum(originalHour);
  const out: Array<{ date: string; hour: string; hours: number }> = [];
  for (const day of freeByDay) {
    if (out.length >= max) break;
    const best = [...day.hours]
      .filter(h => Number.isFinite(hourNum(h)))
      .sort((a, b) => Math.abs(hourNum(a) - target) - Math.abs(hourNum(b) - target) || hourNum(a) - hourNum(b))[0];
    if (best) out.push({ date: day.date, hour: hourText(hourNum(best)), hours });
  }
  return out;
}

/**
 * El profesor pulsó "Ingresar" tarde: ¿antes de la MITAD de la clase?
 *   · true  → la clase se dio: se anula la recuperación;
 *   · false → la recuperación sigue viva y la fila queda para que la revise un
 *             admin (la clase original puede acabar pagándose: ver
 *             lib/teacherAbsenceStore).
 * Un ingreso sin hora legible cuenta como antes de la mitad: hubo ingreso y,
 * ante la duda, no se deja abierta una segunda clase que pagar.
 *
 * OJO: la ausencia se detecta al minuto 30, así que en una clase de 1 h
 * cualquier ingreso posterior ya cae en la segunda mitad.
 */
export function joinedBeforeHalf(a: { classDate: string; classHour: string; durationHours: number }, clickedAt: string | null | undefined): boolean {
  const t = Date.parse(clickedAt ?? '');
  const start = spainWallClockToEpoch(a.classDate, hourNum(a.classHour));
  if (!Number.isFinite(t) || !Number.isFinite(start)) return true;
  const half = start + (Math.max(1, a.durationHours || 1) * 60 * MIN) / 2;
  return t < half;
}

const MIN = 60_000;

// ── Tipos ─────────────────────────────────────────────────────────────────────

/** Lo mínimo de un ingreso ("Ingresar a clase") que necesita la regla. */
export interface JoinLogLite {
  teacherId: string;
  studentName: string;
  scheduledDate: string;
  scheduledTime: string;
  clickedAt: string;
}

/** Lo mínimo de una constancia de clase (cancelación, reprogramación, falta). */
export type ClassRecordLite = Pick<ClassRecord, 'id' | 'teacherId' | 'studentName' | 'classDate' | 'classTime' | 'classType' | 'rescheduledTo'>;

/** Un profesor con todo lo que hace falta para saber qué clases tenía. */
export interface TeacherScheduleInput {
  teacherId: string;
  teacherName: string;
  /** Sus alumnos tal como los ve él (lib/db.teacherAssignmentsFrom: slots del grid). */
  assignments: Assignment[];
  grid: Grid;
  occupancy: GridOccupancy;
  /** Período de cada alumno (lib/studentPeriod.periodIndex). */
  periods: Map<string, StudentPeriod>;
}

/** Una clase que tocaba, empezó hace 30–90 minutos y no tiene ingreso. */
export interface DueAbsence {
  /** Id fijo de la clase: profesor + fecha + hora de inicio + alumno. */
  id: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  assignment: Assignment;
  /** 'YYYY-MM-DD' (hora de España). */
  date: string;
  /** 'HH:00'. */
  hour: string;
  durationHours: number;
  isRecovery: boolean;
  startMs: number;
}

/** Una posible ausencia ya anotada, lo justo para saber si el profesor llegó tarde. */
export interface OpenAbsenceLite {
  id: string;
  teacherId: string;
  studentName: string;
  classDate: string;
  classHour: string;
  durationHours: number;
}

// ── Tiempo ────────────────────────────────────────────────────────────────────

/** Instante de inicio de una sesión (hora de pared española → epoch). */
export function sessionStartMs(s: { date: string; startHourNum: number }): number {
  return spainWallClockToEpoch(s.date, s.startHourNum);
}

/** ¿La clase empezó hace entre 30 y 90 minutos? */
export function inAbsenceWindow(startMs: number, nowMs: number): boolean {
  if (!Number.isFinite(startMs)) return false;
  const elapsed = nowMs - startMs;
  return elapsed >= ABSENCE_AFTER_MINUTES * MIN && elapsed <= ABSENCE_WINDOW_END_MINUTES * MIN;
}

/**
 * Fechas (hora de España) en las que pudo empezar una clase de la ventana. Casi
 * siempre una sola; dos pasada la medianoche (una clase de las 23:00 se mira a
 * las 00:10 del día siguiente).
 */
export function windowDates(nowMs: number): string[] {
  const a = getSpainParts(new Date(nowMs - ABSENCE_WINDOW_END_MINUTES * MIN)).dateStr;
  const b = getSpainParts(new Date(nowMs - ABSENCE_AFTER_MINUTES * MIN)).dateStr;
  return a === b ? [a] : [a, b];
}

/** Hoy y ayer en España: lo que se lee de la base en cada vuelta. */
export function readDates(nowMs: number): string[] {
  const hoy = getSpainParts(new Date(nowMs)).dateStr;
  return [addDaysIso(hoy, -1), hoy];
}

// ── Id fijo ───────────────────────────────────────────────────────────────────

function slug(s: string): string {
  return nkName(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Id de la posible ausencia: el mismo en todas las vueltas del chequeo, que es
 * lo que impide avisar dos veces por la misma clase (es la clave primaria).
 */
export function absenceIdOf(teacherId: string, studentName: string, date: string, startHour: number | string): string {
  const h = hourNum(startHour);
  const hh = Number.isFinite(h) ? String(h).padStart(2, '0') : String(startHour);
  return `aus_${teacherId}_${date}_${hh}_${slug(studentName)}`;
}

// ── Qué clases tocaban ────────────────────────────────────────────────────────

/** Sesiones del profesor en una fecha, igual que en "Mis clases". */
export function sessionsOfTeacherOn(t: TeacherScheduleInput, dateIso: string): TeacherSession[] {
  return groupContiguousClasses([
    ...classesForDate(t.assignments, dateIso, t.periods),
    ...recoveriesForDate(t.grid, dateIso, t.assignments, t.periods),
  ], t.teacherId, t.occupancy);
}

/** Los nombres con los que puede figurar el alumno de una sesión (celda y ficha). */
function namesOf(s: { studentName: string; assignment?: { studentName: string } }): Set<string> {
  const out = new Set([nkName(s.studentName)]);
  if (s.assignment?.studentName) out.add(nkName(s.assignment.studentName));
  return out;
}

/**
 * Ingreso del profesor para esa clase: mismo profesor, mismo alumno, misma
 * fecha y la hora dentro del tramo de la sesión (en una de 2 h el acceso puede
 * figurar en cualquiera de sus dos horas). Un ingreso sin hora legible cuenta
 * por la fecha: ante la duda, no se avisa.
 */
export function joinFor(
  s: { teacherId: string; studentName: string; assignment?: { studentName: string }; date: string; start: number; end: number },
  logs: JoinLogLite[],
): JoinLogLite | undefined {
  const names = namesOf(s);
  return logs.find(l => {
    if (l.teacherId !== s.teacherId || l.scheduledDate !== s.date) return false;
    if (!names.has(nkName(l.studentName))) return false;
    const h = hourNum(l.scheduledTime);
    return !Number.isFinite(h) || (h >= s.start && h < s.end);
  });
}

/**
 * ¿La clase se canceló, se reprogramó o el profesor ya registró la falta del
 * alumno? Mismas consultas que "Mis clases" (lib/teacherClasses), acotadas al
 * tramo de la sesión, con los dos nombres posibles del alumno.
 */
export function isSwitchedOff(
  s: { teacherId: string; studentName: string; assignment?: { studentName: string }; date: string; start: number; end: number },
  records: ClassRecordLite[],
): boolean {
  const span = { start: s.start, end: s.end };
  const recs = records as ClassRecord[];
  for (const name of new Set([s.studentName, s.assignment?.studentName ?? s.studentName])) {
    if (rescheduledTargetFor(recs, s.teacherId, name, s.date, span)) return true;
    if (cancellationFor(recs, s.teacherId, name, s.date, span)) return true;
  }
  return false;
}

/**
 * Las clases que tocaban, empezaron hace 30–90 minutos, siguen en pie y no
 * tienen ingreso. Las que ya tienen fila (`known`) se saltan: de eso se ocupa el
 * repaso de "llegó tarde" y el reintento de Zapier.
 *
 * La pausa y la suscripción inactiva NO se miran acá (hace falta WooCommerce):
 * lo decide lib/teacherAbsenceStore, y solo para estas pocas candidatas.
 */
export function findDueAbsences(input: {
  teachers: TeacherScheduleInput[];
  records: ClassRecordLite[];
  joinLogs: JoinLogLite[];
  nowMs: number;
  known: Set<string>;
}): { due: DueAbsence[]; inWindow: number } {
  const dates = windowDates(input.nowMs);
  const due: DueAbsence[] = [];
  let inWindow = 0;
  // Solo los ingresos hechos HASTA ahora. En una vuelta real no hay otros; en un
  // ensayo con una hora pasada (?ensayo=1&ahora=…) los clics de después taparían
  // la ausencia que sí se habría avisado (y luego marcado "llegó tarde").
  const joinLogs = input.joinLogs.filter(l => {
    const t = Date.parse(l.clickedAt);
    return !Number.isFinite(t) || t <= input.nowMs;
  });
  for (const t of input.teachers) {
    for (const date of dates) {
      for (const s of sessionsOfTeacherOn(t, date)) {
        const startMs = sessionStartMs(s);
        if (!inAbsenceWindow(startMs, input.nowMs)) continue;
        inWindow++;
        const ref = {
          teacherId: t.teacherId, studentName: s.studentName, assignment: s.assignment,
          date: s.date, start: s.startHourNum, end: s.endHourNum,
        };
        if (isSwitchedOff(ref, input.records)) continue;
        if (joinFor(ref, joinLogs)) continue;
        const id = absenceIdOf(t.teacherId, s.studentName, s.date, s.startHourNum);
        if (input.known.has(id)) continue;
        due.push({
          id, teacherId: t.teacherId, teacherName: t.teacherName,
          studentName: s.studentName, assignment: s.assignment,
          date: s.date, hour: hourText(s.startHourNum), durationHours: s.durationHours,
          isRecovery: !!s.isRecovery, startMs,
        });
      }
    }
  }
  return { due: due.sort((a, b) => a.startMs - b.startMs), inWindow };
}

/** Posibles ausencias abiertas cuyo profesor ya pulsó "Ingresar": llegó tarde. */
export function findLateJoins(open: OpenAbsenceLite[], logs: JoinLogLite[]): Array<{ id: string; clickedAt: string }> {
  const out: Array<{ id: string; clickedAt: string }> = [];
  for (const a of open) {
    const start = hourNum(a.classHour);
    const log = joinFor({
      teacherId: a.teacherId, studentName: a.studentName, date: a.classDate,
      start, end: start + Math.max(1, a.durationHours || 1),
    }, logs);
    if (log) out.push({ id: a.id, clickedAt: log.clickedAt });
  }
  return out;
}

// ── Teléfono y nombre ─────────────────────────────────────────────────────────

/**
 * Teléfono en formato internacional (+34600111222). Los alumnos están en
 * España: un número de 9 cifras que empieza por 6, 7, 8 o 9 lleva +34. Lo que
 * ya trae prefijo (+ o 00) se respeta. Si no se puede saber, se devuelve tal
 * cual (solo cifras) y `phoneLooksInternational` lo detecta.
 */
export function normalizePhone(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  let s = t.replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (s.startsWith('+')) return `+${digits}`;
  if (digits.length === 9 && /^[6789]/.test(digits)) return `+34${digits}`;
  if (digits.length === 11 && digits.startsWith('34')) return `+${digits}`;
  return digits;
}

export function phoneLooksInternational(p: string): boolean {
  return /^\+\d{8,15}$/.test(p);
}

/** Nombre de pila ("Ana" de "Ana García López"). */
export function firstNameOf(name: string): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

// ── Lo que recibe Zapier ──────────────────────────────────────────────────────

/**
 * Snake_case y nombres FIJOS: Zapier mapea los campos por nombre exacto, y
 * renombrar uno rompe el Zap sin ningún error visible. Para cambiar algo, se
 * AÑADE un campo; no se renombra.
 */
export interface AbsenceWebhookPayload {
  clase_id: string;
  /** '15/10/2026' */
  fecha: string;
  /** '18:00' (hora de España) */
  hora: string;
  profe_nombre: string;
  /**
   * Donde el profesor recibe los avisos de Gestión: teachers.notification_email
   * y, si está vacío, teachers.email. Zapier le manda el email de la ausencia
   * (Gestión ya no lo manda). '' si no hay ninguno.
   */
  profe_email: string;
  alumno_nombre: string;
  alumno_nombre_pila: string;
  alumno_email: string;
  /** '+34600111222', o '' si no lo tenemos. */
  alumno_telefono: string;
  /** Mensaje listo para Slack. */
  texto_slack: string;
  /**
   * <LMS_URL>/mis-clases?recuperacion=<id>: donde el alumno elige cuándo
   * recuperar la clase. '' si no se creó recuperación (profesor fuera de
   * ABSENCE_RECOVERY_BETA_TEACHERS, o falló al crearla).
   */
  enlace_recuperacion: string;
}

export function slackTextOf(a: { teacherName: string; hour: string; studentName: string; phone: string }): string {
  const tel = !a.phone
    ? 'no tenemos su teléfono'
    : phoneLooksInternational(a.phone) ? a.phone : `${a.phone} (revisar el formato)`;
  return `⚠️ Posible falta: ${a.teacherName} no se ha conectado a la clase de las ${a.hour} con ${a.studentName}. Teléfono del alumno: ${tel}`;
}

export function buildAbsencePayload(a: {
  id: string; date: string; hour: string; teacherName: string; teacherEmail?: string;
  studentName: string; studentEmail: string; phone: string;
  recoveryLink?: string;
}): AbsenceWebhookPayload {
  return {
    clase_id: a.id,
    fecha: fmtDateDMY(a.date),
    hora: a.hour,
    profe_nombre: a.teacherName,
    profe_email: a.teacherEmail ?? '',
    alumno_nombre: a.studentName,
    alumno_nombre_pila: firstNameOf(a.studentName),
    alumno_email: a.studentEmail,
    alumno_telefono: a.phone,
    texto_slack: slackTextOf({ teacherName: a.teacherName, hour: a.hour, studentName: a.studentName, phone: a.phone }),
    enlace_recuperacion: a.recoveryLink ?? '',
  };
}

/**
 * Ejemplo con datos inventados para configurar el Zap (?prueba=1). Va marcado
 * como prueba en los nombres para que nadie llame a nadie desde Slack.
 */
export function sampleAbsencePayload(nowMs = Date.now()): AbsenceWebhookPayload {
  const p = getSpainParts(new Date(nowMs));
  return buildAbsencePayload({
    id: `aus_prueba_${p.dateStr}_${String(p.hour).padStart(2, '0')}`,
    date: p.dateStr, hour: hourText(p.hour),
    teacherName: 'Profesora Ejemplo [PRUEBA]',
    teacherEmail: 'profesora.ejemplo@drcacademy.test',
    studentName: 'Alumna Ejemplo [PRUEBA]',
    studentEmail: 'prueba@drcacademy.test',
    phone: '+34600111222',
    recoveryLink: 'https://drc-lms.vercel.app/mis-clases?recuperacion=rec_prueba',
  });
}
