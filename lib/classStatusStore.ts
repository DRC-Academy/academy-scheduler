// ── Estado de cada clase dada: la BASE y los avisos ───────────────────────────
//
// Las reglas viven en lib/classStatus (puras, con tests). Aquí:
//   · se leen los datos con el cliente admin (calendarios, constancias,
//     ingresos, transcripts, posibles ausencias y revisiones);
//   · runClassStatusCheck: el reloj horario (app/api/cron/estado-clases) avisa
//     al profesor a las 24 h del final de una clase sin estado (campanita +
//     email) y al admin a las 48 h (campanita + email);
//   · listUnmarkedForTeacher: lo que pinta "Mis clases" (todas las terminadas
//     sin estado, sin esperar a las 24 h);
//   · declareTeacherAbsence: "Estuve ausente". Es una FALTA del profesor, por
//     el mismo camino que la reclasificación del admin (reclassifyAsTeacherFalta):
//     −10 €, recuperación para el alumno y sin doble cobro si la detección ya la
//     había cobrado.
//
// ANTI-DUPLICADO: el id de la notificación es fijo por clase (estado_<…> y
// estado_<…>_admin) y se inserta con upsert + ignoreDuplicates. Solo se manda
// email por las notificaciones que se crearon DE VERDAD en esta vuelta, así que
// dos vueltas no pueden avisar dos veces de la misma clase. Si el email falla,
// la campanita queda y no se reintenta el correo.
//
// La lectura de calendarios replica la de lib/teacherAbsenceStore (las mismas
// funciones de lib/db para armar los alumnos de cada profesor), con un filtro
// opcional por profesor para la pantalla.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllPages, gridClassesOf, teacherStudentsFrom, teacherAssignmentsFrom } from '@/lib/db';
import { gridOccupancyOfTeacher, addDaysIso, fmtDateDMY } from '@/lib/teacherClasses';
import { periodIndex } from '@/lib/studentPeriod';
import { getSpainParts } from '@/lib/spainTime';
import { nkName } from '@/lib/sessions';
import type { TeacherScheduleInput } from '@/lib/teacherAbsences';
import type { ClassTranscriptRef } from '@/lib/transcriptDeadline';
import {
  findUnmarkedClasses, statusDates, CLASS_STATUS_LABEL, DECLARED_ABSENCE_COMMENT,
  STATUS_TEACHER_AFTER_HOURS, STATUS_ADMIN_AFTER_HOURS, STATUS_LOOKBACK_DAYS,
  type UnmarkedClass, type StatusRecord, type StatusJoinLog, type StatusAbsence, type StatusReview,
} from '@/lib/classStatus';
import { sendClassStatusReminder, sendClassStatusAdminAlert, type TeacherLike } from '@/lib/emailNotifications';
import { reclassifyAsTeacherFalta } from '@/lib/classRecoveryStore';
import type { Assignment, ClassRecordType, Grid, Student } from '@/types';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Días que mira la pantalla del profesor (todas las terminadas desde el corte, con tope). */
const TEACHER_VIEW_DAYS = 30;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strU = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function isMissingTable(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table/i.test(e.message ?? ''));
}

async function leer(
  label: string,
  run: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string; code?: string } | null }>,
  opcional = false,
): Promise<Row[]> {
  const { rows, error } = await fetchAllPages<Row>(label, run);
  if (error) {
    // Las posibles ausencias y las revisiones solo AÑADEN estados: sin su tabla,
    // se sigue sin ellas (avisaría de más, nunca de menos).
    if (opcional && isMissingTable(error)) return [];
    throw new Error(`No se pudo leer ${label}: ${error.message}`);
  }
  return rows;
}

function toAssignment(r: Row): Assignment {
  return {
    id: str(r.id), teacherId: str(r.teacher_id), teacherName: str(r.teacher_name), teacherEmail: str(r.teacher_email),
    studentId: str(r.student_id), studentName: str(r.student_name), studentEmail: str(r.student_email),
    studentLevel: str(r.student_level), slots: [], objetivo: '', plan: str(r.plan),
    weeklyHours: 0, availability: '', notes: '',
    startDate: strU(r.start_date), createdAt: str(r.created_at), status: strU(r.status),
  };
}

function toStudent(r: Row): Student {
  return {
    id: str(r.id), name: str(r.name), email: str(r.email), phone: strU(r.phone),
    level: str(r.level), plan: str(r.plan), createdAt: strU(r.created_at),
  } as Student;
}

interface StatusData {
  teachers: TeacherScheduleInput[];
  teacherInfo: Map<string, TeacherLike>;
  records: StatusRecord[];
  joinLogs: StatusJoinLog[];
  analyses: ClassTranscriptRef[];
  absences: StatusAbsence[];
  reviews: StatusReview[];
}

async function loadStatusData(admin: SupabaseClient, dates: string[], teacherId?: string): Promise<StatusData> {
  // Filtro opcional por profesor (la pantalla); el reloj lee a todos.
  const byTeacher = <Q,>(q: Q, col = 'teacher_id'): Q =>
    (teacherId ? (q as unknown as { eq: (c: string, v: string) => Q }).eq(col, teacherId) : q);
  // Un transcript enlazado por ingreso puede llevar una fecha algo distinta.
  const desde = addDaysIso(dates[0], -3);

  const [teachersRaw, calendars, asgRaw, studentsRaw, dropoutsRaw, logsRaw, recordsRaw, analysesRaw, absencesRaw, reviewsRaw] = await Promise.all([
    leer('teachers', (f, t) => byTeacher(admin.from('teachers').select('*'), 'id').order('id').range(f, t)),
    leer('teacher_calendars', (f, t) => byTeacher(admin.from('teacher_calendars').select('teacher_id, grid')).order('teacher_id').range(f, t)),
    leer('assignments', (f, t) => byTeacher(admin.from('assignments')
      .select('id, teacher_id, teacher_name, teacher_email, student_id, student_name, student_email, student_level, plan, start_date, created_at, status'))
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(f, t)),
    leer('students', (f, t) => admin.from('students').select('id, name, email, phone, level, plan, created_at').order('id').range(f, t)),
    leer('student_dropouts', (f, t) => byTeacher(admin.from('student_dropouts').select('id, teacher_id, student_name, dropped_at')).order('id').range(f, t)),
    leer('class_join_logs', (f, t) => byTeacher(admin.from('class_join_logs')
      .select('id, teacher_id, student_name, scheduled_date, scheduled_time')).in('scheduled_date', dates).order('id').range(f, t)),
    leer('class_records', (f, t) => byTeacher(admin.from('class_records')
      .select('id, teacher_id, student_name, class_date, class_time, class_type, rescheduled_to, comment')).in('class_date', dates).order('id').range(f, t)),
    leer('class_analyses', (f, t) => byTeacher(admin.from('class_analyses')
      .select('id, teacher_id, student_name, class_date, analyzed_at, has_transcript, validation_status, join_log_id')).gte('class_date', desde).order('id').range(f, t)),
    leer('teacher_absence_alerts', (f, t) => byTeacher(admin.from('teacher_absence_alerts')
      .select('id, status, annulled_at')).in('class_date', dates).order('id').range(f, t), true),
    leer('class_review_requests', (f, t) => byTeacher(admin.from('class_review_requests')
      .select('id, teacher_id, student_name, class_date, class_time, status, requested_type, resolved_type')).in('class_date', dates).order('id').range(f, t), true),
  ]);

  const grids = new Map<string, Grid>(calendars.map(c => [str(c.teacher_id), (c.grid ?? {}) as Grid]));
  const students = studentsRaw.map(toStudent);
  const dropouts = dropoutsRaw.map(d => ({ teacherId: str(d.teacher_id), studentName: str(d.student_name), droppedAt: strU(d.dropped_at) }));

  // Ya vienen de la más reciente a la más vieja, que es lo que espera teacherStudentsFrom.
  const asgPorProfe = new Map<string, Assignment[]>();
  for (const a of asgRaw.map(toAssignment)) {
    const arr = asgPorProfe.get(a.teacherId);
    if (arr) arr.push(a); else asgPorProfe.set(a.teacherId, [a]);
  }

  const teachers: TeacherScheduleInput[] = [];
  const teacherInfo = new Map<string, TeacherLike>();
  for (const t of teachersRaw) {
    if (t.archived_at) continue;
    const id = str(t.id);
    const grid = grids.get(id);
    if (!grid || Object.keys(grid).length === 0) continue;
    const prof = { id, name: str(t.name), email: str(t.email) };
    teacherInfo.set(id, { id, name: prof.name, email: prof.email, notificationEmail: str(t.notification_email) });
    const assignments = teacherAssignmentsFrom(prof, teacherStudentsFrom(grid, asgPorProfe.get(id) ?? [], students));
    teachers.push({
      teacherId: id, teacherName: prof.name, assignments, grid,
      occupancy: gridOccupancyOfTeacher(gridClassesOf(grid)),
      periods: periodIndex(assignments, dropouts, id),
    });
  }

  return {
    teachers, teacherInfo,
    records: recordsRaw.map(r => ({
      id: str(r.id), teacherId: str(r.teacher_id), studentName: str(r.student_name), classDate: str(r.class_date),
      classTime: strU(r.class_time), classType: strU(r.class_type) as ClassRecordType | undefined,
      rescheduledTo: strU(r.rescheduled_to), comment: strU(r.comment),
    })),
    joinLogs: logsRaw.map(l => ({
      id: str(l.id), teacherId: str(l.teacher_id), studentName: str(l.student_name),
      scheduledDate: str(l.scheduled_date), scheduledTime: str(l.scheduled_time),
    })),
    analyses: analysesRaw as ClassTranscriptRef[],
    absences: absencesRaw.map(a => ({ id: str(a.id), status: str(a.status), annulledAt: strU(a.annulled_at) ?? null })),
    reviews: reviewsRaw.map(r => ({
      teacherId: str(r.teacher_id), studentName: str(r.student_name), classDate: str(r.class_date),
      classTime: strU(r.class_time) ?? null, status: str(r.status),
      requestedType: str(r.requested_type), resolvedType: strU(r.resolved_type) ?? null,
    })),
  };
}

function unmarked(d: StatusData, dates: string[], nowMs: number, minHoursAfterEnd: number): UnmarkedClass[] {
  return findUnmarkedClasses({
    teachers: d.teachers, records: d.records, joinLogs: d.joinLogs, analyses: d.analyses,
    absences: d.absences, reviews: d.reviews, dates, nowMs, minHoursAfterEnd,
  });
}

// ── El reloj ──────────────────────────────────────────────────────────────────

export interface ClassStatusCheckReport {
  ahoraEspana: string;
  fechas: string[];
  /** Clases sin estado con 24 h o más (candidatas al aviso del profesor). */
  sinEstado24h: number;
  /** Las que además pasan de 48 h (candidatas al aviso del admin). */
  sinEstado48h: number;
  avisosProfesor: Array<{ id: string; profesor: string; alumno: string; fecha: string; hora: string }>;
  avisosAdmin: Array<{ id: string; profesor: string; alumno: string; fecha: string; hora: string }>;
  emailsProfesor: number;
  emailAdmin: boolean;
  errores: string[];
}

const lineOf = (c: UnmarkedClass) => ({ id: c.id, profesor: c.teacherName, alumno: c.studentName, fecha: c.date, hora: c.hour });
const emailLine = (c: UnmarkedClass) => ({ studentName: c.studentName, date: c.date, hour: c.hour, durationHours: c.durationHours, teacherName: c.teacherName });

/** Inserta las campanitas que falten y devuelve los ids creados DE VERDAD en esta vuelta. */
async function insertBells(admin: SupabaseClient, rows: Row[]): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const { data, error } = await admin.from('notifications')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`No se pudieron crear las notificaciones: ${error.message}`);
  return new Set((data ?? []).map(r => str(r.id)));
}

export async function runClassStatusCheck(admin: SupabaseClient, opts: { nowMs?: number; dry?: boolean } = {}): Promise<ClassStatusCheckReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const parts = getSpainParts(new Date(nowMs));
  const dates = statusDates(nowMs, STATUS_LOOKBACK_DAYS);
  const report: ClassStatusCheckReport = {
    ahoraEspana: `${parts.dateStr} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    fechas: dates, sinEstado24h: 0, sinEstado48h: 0,
    avisosProfesor: [], avisosAdmin: [], emailsProfesor: 0, emailAdmin: false, errores: [],
  };
  if (dates.length === 0) return report;

  const data = await loadStatusData(admin, dates);
  const due = unmarked(data, dates, nowMs, STATUS_TEACHER_AFTER_HOURS);
  const dueAdmin = due.filter(c => c.hoursSinceEnd >= STATUS_ADMIN_AFTER_HOURS);
  report.sinEstado24h = due.length;
  report.sinEstado48h = dueAdmin.length;

  if (opts.dry) {
    report.avisosProfesor = due.map(lineOf);
    report.avisosAdmin = dueAdmin.map(lineOf);
    return report;
  }

  const createdAt = new Date(nowMs).toISOString();

  // 1) Profesor: campanita por clase + un email con las nuevas.
  const teacherBells = due.map(c => ({
    id: c.id, target_user: c.teacherId, target_role: null,
    title: `📋 Marca el estado de tu clase con ${c.studentName}`,
    body: `La clase con ${c.studentName} del ${fmtDateDMY(c.date)} a las ${c.hour} terminó hace más de ${STATUS_TEACHER_AFTER_HOURS} horas y sigue sin estado. `
      + 'Sube el transcript si la diste o indica qué pasó desde «Mis clases» → ⋯ → «Marcar estado».',
    type: 'clase_sin_estado', read_by: [], created_at: createdAt, created_by: 'sistema',
  }));
  let nuevasProfesor = new Set<string>();
  try {
    nuevasProfesor = await insertBells(admin, teacherBells);
  } catch (err) {
    report.errores.push(err instanceof Error ? err.message : String(err));
  }
  const porProfesor = new Map<string, UnmarkedClass[]>();
  for (const c of due) {
    if (!nuevasProfesor.has(c.id)) continue;
    report.avisosProfesor.push(lineOf(c));
    const arr = porProfesor.get(c.teacherId);
    if (arr) arr.push(c); else porProfesor.set(c.teacherId, [c]);
  }
  for (const [teacherId, clases] of porProfesor) {
    const teacher = data.teacherInfo.get(teacherId);
    if (!teacher) continue;
    if (await sendClassStatusReminder(teacher, clases.map(emailLine))) report.emailsProfesor++;
    else report.errores.push(`Email al profesor ${teacher.name} no enviado.`);
  }

  // 2) Admin: campanita por clase + un email con todas las nuevas.
  const adminBells = dueAdmin.map(c => ({
    id: `${c.id}_admin`, target_user: null, target_role: 'admin',
    title: `📋 ${c.teacherName}: clase sin estado (48 h)`,
    body: `${c.teacherName} no ha marcado el estado de la clase con ${c.studentName} del ${fmtDateDMY(c.date)} a las ${c.hour}. Se le avisó a las ${STATUS_TEACHER_AFTER_HOURS} h.`,
    type: 'clase_sin_estado_admin', read_by: [], created_at: createdAt, created_by: 'sistema',
  }));
  let nuevasAdmin = new Set<string>();
  try {
    nuevasAdmin = await insertBells(admin, adminBells);
  } catch (err) {
    report.errores.push(err instanceof Error ? err.message : String(err));
  }
  const paraAdmin = dueAdmin.filter(c => nuevasAdmin.has(`${c.id}_admin`));
  report.avisosAdmin = paraAdmin.map(lineOf);
  if (paraAdmin.length > 0) {
    report.emailAdmin = await sendClassStatusAdminAlert(paraAdmin.map(emailLine));
    if (!report.emailAdmin) report.errores.push('Email al admin no enviado.');
  }
  return report;
}

// ── La pantalla del profesor ──────────────────────────────────────────────────

/** Clases ya terminadas del profesor que siguen sin estado (desde el corte). */
export async function listUnmarkedForTeacher(admin: SupabaseClient, teacherId: string, nowMs = Date.now()): Promise<UnmarkedClass[]> {
  const dates = statusDates(nowMs, TEACHER_VIEW_DAYS);
  if (dates.length === 0) return [];
  const data = await loadStatusData(admin, dates, teacherId);
  return unmarked(data, dates, nowMs, 0);
}

// ── "Estuve ausente" ──────────────────────────────────────────────────────────

export class ClassStatusError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * El profesor declara que no se conectó. Solo sobre una clase SUYA, ya
 * terminada, sin estado y sin "Ingresar a clase" (con ingreso no hay ausencia
 * que declarar: para eso están las demás opciones).
 */
export async function declareTeacherAbsence(admin: SupabaseClient, input: {
  teacherId: string; studentName: string; date: string; hour: string;
}): Promise<{ penaltyEuros: number }> {
  const clases = await listUnmarkedForTeacher(admin, input.teacherId);
  const clase = clases.find(c =>
    c.date === input.date && c.hour === input.hour && nkName(c.studentName) === nkName(input.studentName));
  if (!clase) throw new ClassStatusError(409, 'Esta clase ya tiene estado o todavía no ha terminado.');
  if (clase.hasJoin) throw new ClassStatusError(409, 'Pulsaste «Ingresar a clase» en esta clase: no se puede declarar como ausencia.');

  const r = await reclassifyAsTeacherFalta({
    teacherId: clase.teacherId, studentName: clase.studentName, classDate: clase.date, classTime: clase.hour,
    by: clase.teacherName || 'profesor',
    recordComment: DECLARED_ABSENCE_COMMENT,
    recoveryReason: `Falta declarada por el profesor (${CLASS_STATUS_LABEL.profesor_ausente.toLowerCase()})`,
  });
  return { penaltyEuros: r.penaltyEuros };
}
