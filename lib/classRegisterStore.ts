// ── Registro para disputas: lecturas en el SERVIDOR ───────────────────────────
//
// Junta los datos y llama a las reglas puras (lib/classRegister). SOLO LECTURA:
// aquí no hay un solo insert, update ni delete.
//
// Los datos base salen de los MISMOS cargadores que usa el "Registro de clases"
// del admin (lib/db: profesores con su calendario, asignaciones, ingresos,
// constancias, transcripts sin el texto, alumnos, bajas e historial de
// horarios), así que las dos pestañas parten de lo mismo. Lo que esos cargadores
// no traen —la IP del ingreso, las posibles ausencias y las recuperaciones— se
// lee aparte con el cliente admin, solo del rango pedido.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dbGetTeachers, dbGetAssignments, dbGetClassJoinLogs, dbGetClassRecords, dbGetClassTranscripts,
  dbGetStudents, dbGetSlotChanges,
} from '@/lib/db';
import { dbGetStudentDropouts, periodIndex } from '@/lib/studentPeriod';
import { readPaymentHolds } from '@/lib/paymentHoldStore';
import { buildAttendanceRows, markMovedClasses } from '@/lib/attendance';
import { gridOccupancyOfTeacher, applyGridSlots, addDaysIso } from '@/lib/teacherClasses';
import { profesoresConHistorial, asignacionesConHistorial } from '@/lib/slotHistory';
import { getSpainParts } from '@/lib/spainTime';
import { nkName } from '@/lib/sessions';
import {
  buildRegisterRows, filterRegisterRows, rangeHasApproxSchedule,
  type RegisterFilter, type RegisterRow, type RegisterJoinLog, type RegisterAbsence, type RegisterRecovery,
} from '@/lib/classRegister';

/** Rango máximo de una consulta (la proyección del calendario corta en 370 días). */
export const MAX_RANGE_DAYS = 366;

export interface RegisterStudentInfo {
  name: string;
  email: string | null;
  /** Profesores con los que aparece en el rango. */
  teachers: string[];
}

export interface RegisterResult {
  filtro: RegisterFilter;
  rows: RegisterRow[];
  /** Opciones de los filtros (sobre el rango, sin filtrar por alumno/profe/estado). */
  profes: Array<{ id: string; name: string }>;
  alumnos: string[];
  /** Ficha del alumno si se filtró por uno solo. */
  alumno: RegisterStudentInfo | null;
  /** El rango empieza antes del historial de horarios: el calendario es aproximado. */
  horarioAproximado: boolean;
}

export class RegisterRangeError extends Error {}

/** Valida y normaliza el filtro. Lanza RegisterRangeError con el texto para la pantalla. */
export function normalizeFilter(raw: Partial<Record<keyof RegisterFilter, string | null>>, todayIso: string): RegisterFilter {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const desde = raw.desde && iso.test(raw.desde) ? raw.desde : `${todayIso.slice(0, 7)}-01`;
  let hasta = raw.hasta && iso.test(raw.hasta) ? raw.hasta : todayIso;
  if (hasta > todayIso) hasta = todayIso;
  if (desde > hasta) throw new RegisterRangeError('La fecha de inicio es posterior a la de fin.');
  if (addDaysIso(desde, MAX_RANGE_DAYS) < hasta) throw new RegisterRangeError(`El rango no puede pasar de ${MAX_RANGE_DAYS} días.`);
  return {
    desde, hasta,
    alumno: raw.alumno?.trim() || null,
    profe: raw.profe?.trim() || null,
    estado: (raw.estado?.trim() || null) as RegisterFilter['estado'],
  };
}

type Row = Record<string, unknown>;

/** Lectura opcional: sin la tabla o la columna (SQL sin correr) devuelve []. */
async function opcional(label: string, q: PromiseLike<{ data: Row[] | null; error: { message: string; code?: string } | null }>): Promise<Row[]> {
  const { data, error } = await q;
  if (error) {
    console.warn(`[registro] ${label}: ${error.message}`);
    return [];
  }
  return data ?? [];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function loadRegister(admin: SupabaseClient, filtro: RegisterFilter, nowMs = Date.now()): Promise<RegisterResult> {
  const now = getSpainParts(new Date(nowMs));
  const { desde, hasta } = filtro;

  const [teachersBase, assignmentsBase, joinLogs, records, analyses, students, dropouts, cambios, ipsRaw, absRaw, recRaw] = await Promise.all([
    dbGetTeachers(), dbGetAssignments(), dbGetClassJoinLogs(), dbGetClassRecords(), dbGetClassTranscripts(),
    dbGetStudents(), dbGetStudentDropouts(),
    // Cambios de horario DESDE el inicio del rango: los que reconstruyen el
    // horario que tenía cada alumno en esas fechas.
    dbGetSlotChanges(`${addDaysIso(desde, -1)}T00:00:00Z`),
    opcional('ip', admin.from('class_join_logs').select('id, ip').gte('scheduled_date', desde).lte('scheduled_date', hasta).limit(20000)),
    opcional('ausencias', admin.from('teacher_absence_alerts').select('id, status, annulled_at').gte('class_date', desde).lte('class_date', hasta).limit(20000)),
    opcional('recuperaciones', admin.from('class_recoveries').select('teacher_id, student_name, chosen_date, chosen_hour, status')
      .gte('chosen_date', desde).lte('chosen_date', hasta).limit(20000)),
  ]);

  const teachers = profesoresConHistorial(teachersBase, cambios);
  const occupancy = Object.fromEntries(teachers.map(t => [t.id, gridOccupancyOfTeacher(t)]));
  const assignments = asignacionesConHistorial(applyGridSlots(assignmentsBase, occupancy), cambios);
  // Pago pendiente: esas clases no existen, tampoco en el registro (lib/paymentHolds).
  const holds = await readPaymentHolds(admin);
  const periods = Object.fromEntries(teachers.map(t => [t.id, periodIndex(assignmentsBase, dropouts, t.id, holds)]));

  const attendance = markMovedClasses(buildAttendanceRows({
    assignments, joinLogs,
    fromDate: desde, toDate: hasta,
    todayIso: now.dateStr, nowMinutes: now.hour * 60 + now.minute,
    includeFuture: false,
    gridOccupancyByTeacher: occupancy,
    periodsByTeacher: periods,
  }), records);

  const ipById = new Map(ipsRaw.map(r => [str(r.id), str(r.ip) || null]));
  const registerJoins: RegisterJoinLog[] = joinLogs
    .filter(l => l.scheduledDate >= desde && l.scheduledDate <= hasta)
    .map(l => ({
      id: l.id, teacherId: l.teacherId, studentName: l.studentName,
      scheduledDate: l.scheduledDate, scheduledTime: l.scheduledTime, clickedAt: l.clickedAt,
      ip: ipById.get(l.id) ?? null,
    }));
  const absences: RegisterAbsence[] = absRaw.map(a => ({ id: str(a.id), status: str(a.status), annulledAt: str(a.annulled_at) || null }));
  const recoveries: RegisterRecovery[] = recRaw.map(r => ({
    teacherId: str(r.teacher_id), studentName: str(r.student_name),
    chosenDate: str(r.chosen_date) || null, chosenHour: str(r.chosen_hour) || null, status: str(r.status),
  }));

  // El nombre ACTUAL del profesor: los ingresos guardan el que tenía al pulsar
  // ("Sebastian" / "Sebastian (test)"), y el mismo profe no puede salir con dos.
  const nombreActual = new Map(teachersBase.map(t => [t.id, t.name]));
  const all = buildRegisterRows({ attendance, joinLogs: registerJoins, records, analyses, absences, recoveries, nowMs })
    .map(r => ({ ...r, teacherName: nombreActual.get(r.teacherId) ?? r.teacherName }));
  const enRango = filterRegisterRows(all, { desde, hasta });
  const rows = filterRegisterRows(enRango, filtro);

  const profes = [...new Map(enRango.map(r => [r.teacherId, r.teacherName])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const alumnos = [...new Set(enRango.map(r => r.studentName))].sort((a, b) => a.localeCompare(b));

  let alumno: RegisterStudentInfo | null = null;
  if (filtro.alumno) {
    const key = nkName(filtro.alumno);
    const s = students.find(x => nkName(x.name) === key);
    const a = assignmentsBase.find(x => nkName(x.studentName) === key && x.studentEmail);
    alumno = {
      name: s?.name ?? rows[0]?.studentName ?? filtro.alumno,
      email: s?.email?.trim() || a?.studentEmail?.trim() || null,
      teachers: [...new Set(rows.map(r => r.teacherName))].sort((x, y) => x.localeCompare(y)),
    };
  }

  return { filtro, rows, profes, alumnos, alumno, horarioAproximado: rangeHasApproxSchedule(desde) };
}
