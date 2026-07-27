import { supabase } from './supabase';
import { triggerEmail } from './emailClient';
import { baseStateOf, baseStudentOf, withBaseState, assignableCellKeys, puntualCellDates } from './cells';
import { minutesLateSpain } from './spainTime';
import { Teacher, Student, Assignment, AppUser, Grid, TeacherStatus, ScoringEvent, ClassCount, AppNotification, ClassJoinLog, AssignedSlot, EmailPreferences } from '@/types';

// ── AUTH ─────────────────────────────────────────────────────────────────────

export async function dbAuthenticate(username: string, password: string): Promise<AppUser | null> {
  const { data, error } = await supabase
    .from('app_users')
    .select('*')
    .eq('username', username.toLowerCase().trim())
    .eq('password', password)
    .single();

  if (error || !data) return null;

  return {
    id:          data.id,
    username:    data.username,
    password:    data.password,
    role:        data.role,
    teacherId:   data.teacher_id ?? undefined,
    displayName: data.display_name,
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function calcStatusFromGrid(grid: Grid): { status: TeacherStatus; freeSpots: number; ocupadoSpots: number; weeklyLoad: number } {
  // Se cuenta el estado RECURRENTE (baseStateOf): una recuperación puntual tapa la
  // celda una sola semana, así que ese horario sigue siendo un cupo libre.
  const cells = Object.values(grid).map(baseStateOf);
  const freeSpots    = cells.filter(s => s === 'libre').length;
  const ocupadoSpots = cells.filter(s => s === 'ocupado').length;
  const totalActive  = freeSpots + ocupadoSpots;

  let status: TeacherStatus = 'no_availability';
  if (totalActive > 0) {
    const pct = totalActive > 0 ? ocupadoSpots / totalActive : 0;
    if (pct >= 1)        status = 'busy';
    else if (pct >= 0.7) status = 'almost_full';
    else                 status = 'available';
  }

  return { status, freeSpots, ocupadoSpots, weeklyLoad: ocupadoSpots };
}

// ── WEEK DATES ────────────────────────────────────────────────────────────────

export function dbGetWeekDates(offset: number = 0): Date[] {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun, 1=Mon, ...
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday + offset * 7);
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

// ── TEACHERS ─────────────────────────────────────────────────────────────────

export async function dbGetTeachers(): Promise<Teacher[]> {
  const [teachersRes, calendarsRes] = await Promise.all([
    supabase.from('teachers').select('*').order('name'),
    supabase.from('teacher_calendars').select('teacher_id, grid'),
  ]);

  if (teachersRes.error || !teachersRes.data) return [];

  const gridMap: Record<string, Grid> = {};
  if (calendarsRes.data) {
    for (const row of calendarsRes.data) {
      gridMap[row.teacher_id] = row.grid as Grid;
    }
  }

  return teachersRes.data.map(row => {
    const grid = gridMap[row.id] ?? {};
    const { status, freeSpots, ocupadoSpots, weeklyLoad } = calcStatusFromGrid(grid);

    const upcomingClasses = Object.entries(grid)
      .map(([key, cell]) => ({ key, student: baseStudentOf(cell) }))
      .filter((e): e is { key: string; student: string } => !!e.student)
      .map(({ key, student }) => {
        const [day, time] = key.split('_');
        return { id: key, studentName: student, day, time, duration: 1, type: 'Clase' };
      });

    // Exact list of free cell keys (`${day}_${hour}`) — the single source of truth
    // for slot availability. Cuentan las celdas cuyo estado RECURRENTE es 'libre':
    // 'libre' a secas y las que solo tienen una marca puntual encima (recuperación
    // o reprogramada de UNA semana) sobre un fondo libre.
    const libreCells = assignableCellKeys(grid);
    // key → fecha 'YYYY-MM-DD' de la marca puntual, para avisar en el buscador que
    // ese horario está libre salvo esa semana.
    const puntualCells = puntualCellDates(grid);

    // One TimeSlot per individual free hour (NOT a min-max range), so any
    // consumer iterating from→to lands on real free cells only — occupied
    // cells between free hours are never spanned over.
    const timeSlots = libreCells
      .map(key => {
        const [day, hour] = key.split('_');
        const h = parseInt(hour);
        return {
          day,
          from: h.toString().padStart(2, '0') + ':00',
          to:   (h + 1).toString().padStart(2, '0') + ':00',
          spots: 1,
          usedSpots: 0,
        };
      })
      .sort((a, b) => a.day.localeCompare(b.day) || a.from.localeCompare(b.from));

    return {
      id:                  row.id,
      name:                row.name,
      email:               row.email,
      notificationEmail:   row.notification_email ?? undefined,
    emailPreferences:    parseEmailPrefs(row.email_preferences),
      gender:              row.gender ?? undefined,
      avatar:              row.avatar,
      status,
      weeklyLoad,
      maxWeeklyLoad:       20,
      freeSpots,
      totalSpots:          freeSpots + ocupadoSpots,
      specialties:         row.specialties ?? ['Inglés'],
      // Rango del calendario. Sin migrar (columna ausente) → 9-22, el de siempre.
      calendarStartHour:   row.calendar_start_hour ?? 9,
      calendarEndHour:     row.calendar_end_hour ?? 22,
      timeSlots,
      libreCells,
      puntualCells,
      blockedSlots:        [],
      vacations:           [],
      upcomingClasses,
      internalRating:      row.internal_rating ?? 0,
      createdAt:           row.created_at ?? undefined,
      currentLevel:        row.current_level ?? 1,
      totalScore:          row.total_score ?? 0,
      totalEuros:          row.total_euros ?? 0,
      retentionRate:       row.retention_rate ?? undefined,
      isBlocked:           row.is_blocked ?? false,
      isTeacherOfMonth:    row.is_teacher_of_month ?? false,
      isTeacherOfQuarter:  row.is_teacher_of_quarter ?? false,
      teacherOfMonthDate:  row.teacher_of_month_date ?? undefined,
      lastMonthlyReset:    row.last_monthly_reset ?? undefined,
      lastQuarterlyReset:  row.last_quarterly_reset ?? undefined,
    };
  });
}

export async function dbAddTeacher(teacher: Teacher, username: string): Promise<void> {
  await supabase.from('teachers').insert({
    id:         teacher.id,
    name:       teacher.name,
    email:      teacher.email,
    avatar:     teacher.avatar,
    username:   username,
    password:   'profe123',
    specialties: ['Inglés'],
  });

  await supabase.from('app_users').insert({
    id:           `u_${teacher.id}`,
    username:     username,
    password:     'profe123',
    role:         'teacher',
    teacher_id:   teacher.id,
    display_name: teacher.name,
  });
}

export interface DeleteTeacherResult {
  ok: boolean;
  /** Cantidad de asignaciones activas que impiden borrar (guard), si ok === false. */
  activeAssignments?: number;
  /** Nombres de los alumnos aún asignados a ese profesor. */
  studentNames?: string[];
}

// Elimina DEFINITIVAMENTE a un profesor que ya no trabaja con la academia.
//
// GUARD: si el profesor todavía tiene alumnos asignados (assignments), NO se borra
// — devuelve ok:false con el recuento y los nombres, para que el admin primero
// reasigne o dé de baja a esos alumnos. Así nunca dejamos a un alumno activo sin
// profesor por accidente.
//
// Al borrar se elimina su IDENTIDAD y ACCESO: la fila de `teachers`, su usuario de
// login (`app_users`) y su calendario (`teacher_calendars`). El HISTORIAL de clases
// y finanzas (class_records, class_join_logs, finance_payments, scoring_events) se
// PRESERVA a propósito: son la base contable de meses ya cerrados y no deben
// desaparecer porque el profesor se vaya (misma filosofía que dbDeleteStudent).
export async function dbDeleteTeacher(teacherId: string): Promise<DeleteTeacherResult> {
  const { data: assigns } = await supabase
    .from('assignments')
    .select('student_name')
    .eq('teacher_id', teacherId);

  if (assigns && assigns.length > 0) {
    const studentNames = [...new Set(assigns.map(a => a.student_name).filter(Boolean) as string[])];
    return { ok: false, activeAssignments: assigns.length, studentNames };
  }

  // Sin alumnos asignados → borrado seguro de identidad + acceso + calendario.
  await supabase.from('app_users').delete().eq('teacher_id', teacherId);
  await supabase.from('teacher_calendars').delete().eq('teacher_id', teacherId);

  const { error } = await supabase.from('teachers').delete().eq('id', teacherId);
  if (error) {
    console.error('[dbDeleteTeacher] Error al eliminar el profesor:', error);
    throw new Error(error.message);
  }

  console.log(`[dbDeleteTeacher] Profesor ${teacherId} eliminado (identidad + login + calendario). Historial preservado.`);
  return { ok: true };
}

// ── CALENDARS ─────────────────────────────────────────────────────────────────

export async function dbGetTeacherGrid(teacherId: string): Promise<Grid> {
  const { data, error } = await supabase
    .from('teacher_calendars')
    .select('grid')
    .eq('teacher_id', teacherId)
    .single();

  if (error || !data) return {};
  return data.grid as Grid;
}

export async function dbSaveTeacherGrid(teacherId: string, grid: Grid): Promise<void> {
  await supabase
    .from('teacher_calendars')
    .upsert({
      teacher_id: teacherId,
      grid:       grid,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'teacher_id' });
}

/**
 * Rango de horas que el profesor quiere ver en su calendario (06–23).
 * Si las columnas todavía no existen (falta correr supabase-calendar-hours.sql)
 * no se rompe nada: el calendario sigue funcionando, solo no recuerda el rango
 * entre sesiones.
 */
export async function dbSaveTeacherCalendarHours(
  teacherId: string, startHour: number, endHour: number,
): Promise<void> {
  const { error } = await supabase.from('teachers').update({
    calendar_start_hour: startHour,
    calendar_end_hour:   endHour,
  }).eq('id', teacherId);

  if (error) {
    if (error.code === 'PGRST204' || error.code === '42703') {
      console.warn('[db] Falta correr supabase-calendar-hours.sql: el rango del calendario no se guarda.');
      return;
    }
    console.error('[db] Error al guardar el rango del calendario:', error);
    throw new Error(error.message);
  }
}

// ── STUDENTS ─────────────────────────────────────────────────────────────────

export async function dbGetStudents(): Promise<Student[]> {
  const { data, error } = await supabase
    .from('students')
    .select('*')
    .order('name');

  if (error || !data) return [];

  return data.map(row => ({
    id:                row.id,
    name:              row.name,
    email:             row.email,
    phone:             row.phone ?? undefined,
    gender:            row.gender ?? undefined,
    level:             row.level,
    plan:              row.plan,
    notes:             row.notes ?? undefined,
    manualActiveUntil: row.manual_active_until ?? undefined,
    productType:       row.product_type ?? undefined,
    productName:       row.product_name ?? undefined,
    createdAt:         row.created_at,
  }));
}

// Activa (o desactiva con null) manualmente la suscripción de un alumno hasta una
// fecha límite ('YYYY-MM-DD'). Mientras esa fecha sea futura, el sistema lo trata
// como suscripción activa sin consultar WooCommerce.
export async function dbSetStudentManualActive(studentId: string, until: string | null): Promise<void> {
  await supabase.from('students').update({ manual_active_until: until }).eq('id', studentId);
}

// Guarda el tipo + nombre de producto WooCommerce del alumno (y plan). Resiliente:
// si las columnas product_type/product_name aún no existen, persiste al menos plan.
export async function dbSetStudentProduct(
  studentId: string, productType: 'subscription' | 'one_time' | null, productName: string | null,
): Promise<void> {
  const { error } = await supabase.from('students')
    .update({ product_type: productType, product_name: productName, plan: productName ?? undefined })
    .eq('id', studentId);
  if (error && productName) {
    await supabase.from('students').update({ plan: productName }).eq('id', studentId);
  }
}

// Activa el acceso de un alumno de PAGO ÚNICO hasta una fecha, y notifica a sus
// profesores. Devuelve la cantidad de profesores notificados.
export async function dbActivateOneTimeAccess(
  studentId: string, studentName: string, until: string, productName: string | null,
): Promise<void> {
  await supabase.from('students').update({ manual_active_until: until }).eq('id', studentId);

  // Profesores del alumno (por id o por nombre).
  const [byId, byName] = await Promise.all([
    supabase.from('assignments').select('teacher_id').eq('student_id', studentId),
    supabase.from('assignments').select('teacher_id').eq('student_name', studentName),
  ]);
  const teacherIds = new Set<string>();
  for (const r of [...(byId.data ?? []), ...(byName.data ?? [])]) if (r.teacher_id) teacherIds.add(r.teacher_id);
  if (teacherIds.size === 0) return;

  const untilLabel = (() => {
    const d = new Date(until + 'T00:00:00');
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  const now = new Date().toISOString();
  const rows = [...teacherIds].map((tid, i) => ({
    id:          `notif_access_${Date.now()}_${i}`,
    target_user: tid,
    target_role: null,
    title:       '📅 Acceso activado',
    body:        `${studentName} tiene acceso activado hasta ${untilLabel}.${productName ? ` Producto: ${productName}` : ''}`,
    type:        'one_time_access',
    read_by:     [],
    created_at:  now,
    created_by:  'sistema',
  }));
  await supabase.from('notifications').insert(rows);
}

export async function dbUpsertStudent(student: Student): Promise<void> {
  const email = (student.email ?? '').trim();
  const row = {
    id:    student.id,
    name:  student.name,
    // Email vacío → null: '' como clave de conflicto fusiona alumnos DISTINTOS
    // que casualmente no tienen email (y rompe la FK de la assignment cuando el
    // id nuevo no llega a insertarse). Postgres permite múltiples NULL.
    email: email || null,
    phone: student.phone ?? null,
    level: student.level,
    plan:  student.plan ?? 'Plan Individual',
    notes: student.notes ?? null,
  };
  // Con email deduplicamos por email; sin email, por id.
  const { error } = email
    ? await supabase.from('students').upsert(row, { onConflict: 'email' })
    : await supabase.from('students').upsert(row, { onConflict: 'id' });
  if (error) {
    console.error('[dbUpsertStudent] upsert en students falló:', error);
    throw new Error(`No se pudo guardar el alumno: ${error.message}`);
  }
}

// ── ASSIGNMENTS ───────────────────────────────────────────────────────────────

export async function dbGetAssignments(): Promise<Assignment[]> {
  const { data, error } = await supabase
    .from('assignments')
    .select('*')
    .order('created_at', { ascending: false });

  if (error || !data) return [];

  return data.map(row => ({
    id:                    row.id,
    teacherId:             row.teacher_id,
    teacherName:           row.teacher_name,
    teacherEmail:          row.teacher_email,
    studentId:             row.student_id,
    studentName:           row.student_name,
    studentEmail:          row.student_email,
    studentLevel:          row.student_level,
    slots:                 row.slots,
    objetivo:              row.objetivo ?? '',
    plan:                  row.plan ?? '',
    weeklyHours:           row.weekly_hours,
    availability:          row.availability ?? '',
    notes:                 row.notes ?? '',
    startDate:             row.start_date ?? undefined,
    createdAt:             row.created_at,
    manualClassAdjustment: row.manual_class_adjustment ?? 0,
    meetLink:              row.meet_link ?? undefined,
    presentationEmailSent:   row.presentation_email_sent ?? false,
    presentationEmailSentAt: row.presentation_email_sent_at ?? undefined,
  }));
}

// Normaliza para comparaciones tolerantes (trim + lower).
const normKey = (x: unknown): string => String(x ?? '').trim().toLowerCase();

// Trae students + assignments de forma consistente. Usa la función RPC
// `get_students_with_assignments` (LEFT JOIN robusto en PostgreSQL por
// student_id O email) para obtener el mapeo correcto assignment→student, y
// mantiene TODOS los campos de la assignment (el RPC no trae created_at ni
// manual_class_adjustment). Auto-corrige y persiste los student_id huérfanos.
export async function dbGetAllStudentsWithAssignments(): Promise<{ students: Student[]; assignments: Assignment[] }> {
  // Mapeo autoritativo assignment_id → student.id desde el RPC (join en SQL).
  const rpcMap = new Map<string, string>();
  try {
    const { data, error } = await supabase.rpc('get_students_with_assignments');
    if (!error && Array.isArray(data)) {
      for (const r of data as any[]) {
        if (r?.assignment_id && r?.id) rpcMap.set(String(r.assignment_id), String(r.id));
      }
    }
  } catch { /* RPC no disponible → fallback al self-heal por JS */ }

  const [students, rawAssignments] = await Promise.all([dbGetStudents(), dbGetAssignments()]);

  const byId    = new Map(students.map(s => [s.id, s]));
  const byEmail = new Map(students.filter(s => s.email).map(s => [normKey(s.email), s]));
  const byName  = new Map(students.map(s => [normKey(s.name), s]));

  const fixes: Array<{ assignmentId: string; studentId: string }> = [];

  const assignments = rawAssignments.map(a => {
    // student.id correcto: RPC (join por id O email) → self-heal por email/nombre.
    let sid = a.studentId;
    const rpcSid = rpcMap.get(a.id);
    if (rpcSid && byId.has(rpcSid)) {
      sid = rpcSid;
    } else if (!byId.has(a.studentId)) {
      const match = (a.studentEmail && byEmail.get(normKey(a.studentEmail))) || byName.get(normKey(a.studentName));
      if (match) sid = match.id;
    }
    if (sid !== a.studentId && byId.has(sid)) {
      fixes.push({ assignmentId: a.id, studentId: sid });
      return { ...a, studentId: sid };
    }
    return a;
  });

  // Persistir las correcciones (best-effort).
  if (fixes.length > 0) {
    console.log(`[dbGetAllStudentsWithAssignments] Corrigiendo ${fixes.length} student_id huérfano(s)`);
    await Promise.all(fixes.map(f =>
      supabase.from('assignments').update({ student_id: f.studentId }).eq('id', f.assignmentId)
    ));
  }

  return { students, assignments };
}

// Sincroniza manualmente los vínculos: corrige los student_id de assignments que
// no apuntan a un alumno real, matcheando por email. Devuelve cuántos corrigió.
export async function dbSyncStudentAssignments(): Promise<number> {
  const [students, assignments] = await Promise.all([dbGetStudents(), dbGetAssignments()]);
  const byId    = new Map(students.map(s => [s.id, s]));
  const byEmail = new Map(students.filter(s => s.email).map(s => [normKey(s.email), s]));
  const byName  = new Map(students.map(s => [normKey(s.name), s]));

  const fixes: Array<{ id: string; studentId: string }> = [];
  for (const a of assignments) {
    if (byId.has(a.studentId)) continue; // ya válido
    const match = (a.studentEmail && byEmail.get(normKey(a.studentEmail))) || byName.get(normKey(a.studentName));
    if (match && match.id !== a.studentId) fixes.push({ id: a.id, studentId: match.id });
  }
  if (fixes.length > 0) {
    await Promise.all(fixes.map(f => supabase.from('assignments').update({ student_id: f.studentId }).eq('id', f.id)));
  }
  return fixes.length;
}

// Busca TODAS las assignments cuyo student_email coincide con el email dado
// (trim + lower), SIN importar el student_id. Sirve para el flujo manual de
// "Vincular alumno": encontrar asignaciones ya creadas en Supabase para un
// alumno que aparece como "sin asignar" por un student_id roto.
export async function dbFindAssignmentsByEmail(email: string): Promise<Assignment[]> {
  const target = normKey(email);
  if (!target) return [];
  const all = await dbGetAssignments();
  return all.filter(a => normKey(a.studentEmail) === target);
}

// Repara el vínculo de UNA assignment concreta: la reapunta al alumno real
// (id + email + nombre correctos de la tabla students).
export async function dbRepairStudentLink(
  studentId: string, studentEmail: string, studentName: string, assignmentId: string,
): Promise<void> {
  await supabase.from('assignments').update({
    student_id:    studentId,
    student_email: studentEmail,
    student_name:  studentName,
  }).eq('id', assignmentId);
}

// Repara TODOS los vínculos rotos de una vez: para cada assignment cuyo
// student_email matchea un alumno pero el student_id difiere, corrige el
// student_id (+ nombre). Devuelve la cantidad de assignments reparadas.
export async function dbRepairAllBrokenLinks(): Promise<number> {
  const [students, assignments] = await Promise.all([dbGetStudents(), dbGetAssignments()]);
  const byEmail = new Map(students.filter(s => s.email).map(s => [normKey(s.email), s]));

  const fixes: Array<{ id: string; studentId: string; studentName: string }> = [];
  for (const a of assignments) {
    const match = byEmail.get(normKey(a.studentEmail));
    if (match && match.id !== a.studentId) {
      fixes.push({ id: a.id, studentId: match.id, studentName: match.name });
    }
  }
  if (fixes.length > 0) {
    await Promise.all(fixes.map(f =>
      supabase.from('assignments').update({ student_id: f.studentId, student_name: f.studentName }).eq('id', f.id)
    ));
  }
  return fixes.length;
}

// ── SINCRONIZACIÓN CALENDARIO (grid) ↔ ASSIGNMENTS/STUDENTS ────────────────────
// El grid del profesor (teacher_calendars.grid) guarda nombres de alumnos en las
// celdas 'ocupado'. Esos datos pueden quedar DESCONECTADOS de assignments/students
// (el alumno aparece en el calendario pero no en las tablas). Estas funciones
// diagnostican y reparan esa desconexión.

interface OcupadoCell { student: string; day: string; hour: string; }

// Extrae las celdas 'ocupado' con nombre de alumno de un grid.
function extractOcupadoCells(grid: Grid | null | undefined): OcupadoCell[] {
  const out: OcupadoCell[] = [];
  for (const [key, cell] of Object.entries(grid ?? {})) {
    // Alumno RECURRENTE: incluye las celdas tapadas por una recuperación puntual,
    // que si no quedarían fuera de la auditoría de vínculos.
    const student = cell ? baseStudentOf(cell)?.trim() : undefined;
    if (student) {
      const [day, hour] = key.split('_');
      out.push({ student, day, hour });
    }
  }
  return out;
}

// Agrupa las celdas ocupado por nombre de alumno (normalizado), conservando el
// nombre tal como aparece y todos sus slots.
function groupCellsByStudent(cells: OcupadoCell[]): Map<string, { name: string; slots: AssignedSlot[] }> {
  const byName = new Map<string, { name: string; slots: AssignedSlot[] }>();
  for (const c of cells) {
    const k = normKey(c.student);
    if (!byName.has(k)) byName.set(k, { name: c.student, slots: [] });
    byName.get(k)!.slots.push({ day: c.day, hour: c.hour });
  }
  return byName;
}

export interface CalendarDiagnosisRow {
  studentNameInGrid: string;
  day: string;
  hour: string;
  slots: AssignedSlot[];
  existsInAssignments: boolean;
  existsInStudents: boolean;
  assignmentId: string | null;
  studentId: string | null;
}

export interface CalendarDiagnosisAllRow extends CalendarDiagnosisRow {
  teacherId: string;
  teacherName: string;
  teacherEmail: string;
}

// Diagnóstico para UN profesor: compara los nombres del grid contra assignments
// (de ese teacher) y students.
export async function dbDiagnoseCalendarVsAssignments(teacherId: string): Promise<CalendarDiagnosisRow[]> {
  const [grid, teacherAsgs, students] = await Promise.all([
    dbGetTeacherGrid(teacherId),
    dbGetAssignmentsByTeacher(teacherId),
    dbGetStudents(),
  ]);
  const studentsByName = new Map(students.map(s => [normKey(s.name), s]));
  const rows: CalendarDiagnosisRow[] = [];
  for (const { name, slots } of groupCellsByStudent(extractOcupadoCells(grid)).values()) {
    const nk = normKey(name);
    const asg = teacherAsgs.find(a => normKey(a.studentName) === nk);
    const stu = studentsByName.get(nk);
    rows.push({
      studentNameInGrid: name,
      day: slots[0].day, hour: slots[0].hour, slots,
      existsInAssignments: !!asg,
      existsInStudents: !!stu,
      assignmentId: asg?.id ?? null,
      studentId: stu?.id ?? asg?.studentId ?? null,
    });
  }
  return rows;
}

// Diagnóstico para TODOS los profesores (1 sola query por tabla, eficiente).
export async function dbDiagnoseAllCalendars(): Promise<CalendarDiagnosisAllRow[]> {
  const [teachers, allAssignments, students, calRes] = await Promise.all([
    dbGetTeachers(),
    dbGetAssignments(),
    dbGetStudents(),
    supabase.from('teacher_calendars').select('teacher_id, grid'),
  ]);
  const studentsByName = new Map(students.map(s => [normKey(s.name), s]));
  const asgByTeacher = new Map<string, Assignment[]>();
  for (const a of allAssignments) {
    if (!asgByTeacher.has(a.teacherId)) asgByTeacher.set(a.teacherId, []);
    asgByTeacher.get(a.teacherId)!.push(a);
  }
  const teacherById = new Map(teachers.map(t => [t.id, t]));

  const rows: CalendarDiagnosisAllRow[] = [];
  for (const cal of (calRes.data ?? []) as any[]) {
    const t = teacherById.get(cal.teacher_id);
    if (!t) continue;
    const tAsgs = asgByTeacher.get(t.id) ?? [];
    for (const { name, slots } of groupCellsByStudent(extractOcupadoCells(cal.grid as Grid)).values()) {
      const nk = normKey(name);
      const asg = tAsgs.find(a => normKey(a.studentName) === nk);
      const stu = studentsByName.get(nk);
      rows.push({
        teacherId: t.id, teacherName: t.name, teacherEmail: t.email,
        studentNameInGrid: name,
        day: slots[0].day, hour: slots[0].hour, slots,
        existsInAssignments: !!asg,
        existsInStudents: !!stu,
        assignmentId: asg?.id ?? null,
        studentId: stu?.id ?? asg?.studentId ?? null,
      });
    }
  }
  return rows;
}

// Ocupación de TODOS los grids: nombres de alumnos por profesor (para detectar en
// el Setter los alumnos que están en un calendario pero no tienen assignment).
export interface GridOccupancy {
  teacherId: string;
  teacherName: string;
  teacherEmail: string;
  studentName: string;
  slots: AssignedSlot[];
}
export async function dbGetAllGridOccupancy(): Promise<GridOccupancy[]> {
  const [teachers, calRes] = await Promise.all([
    dbGetTeachers(),
    supabase.from('teacher_calendars').select('teacher_id, grid'),
  ]);
  const teacherById = new Map(teachers.map(t => [t.id, t]));
  const out: GridOccupancy[] = [];
  for (const cal of (calRes.data ?? []) as any[]) {
    const t = teacherById.get(cal.teacher_id);
    if (!t) continue;
    for (const { name, slots } of groupCellsByStudent(extractOcupadoCells(cal.grid as Grid)).values()) {
      out.push({ teacherId: t.id, teacherName: t.name, teacherEmail: t.email, studentName: name, slots });
    }
  }
  return out;
}

// Crea el vínculo COMPLETO (student + assignment) a partir de datos de un
// formulario. Idempotente: reutiliza el student si ya existe (por email o
// nombre) y la assignment si ya existe (corrige su student_id).
export async function dbCreateFullLink(params: {
  teacherId: string; teacherName: string; teacherEmail: string;
  name: string; email: string; level: string; plan: string;
  weeklyHours: number; startDate?: string; slots: AssignedSlot[];
}): Promise<void> {
  const emailTrim = params.email.trim();
  const nameTrim = params.name.trim();

  // 1) student por email → nombre → crear.
  let studentId: string | null = null;
  if (emailTrim) {
    const { data } = await supabase.from('students').select('id').ilike('email', emailTrim).limit(1).maybeSingle();
    if (data) studentId = data.id;
  }
  if (!studentId) {
    const { data } = await supabase.from('students').select('id').ilike('name', nameTrim).limit(1).maybeSingle();
    if (data) studentId = data.id;
  }
  if (!studentId) {
    studentId = crypto.randomUUID();
    const { error } = await supabase.from('students').insert({
      id: studentId, name: nameTrim, email: emailTrim,
      level: params.level, plan: params.plan,
    });
    if (error) {
      console.error('[dbCreateFullLink] INSERT en students falló:', error);
      throw new Error(`No se pudo crear el alumno: ${error.message}`);
    }
  } else {
    await supabase.from('students').update({
      email: emailTrim || undefined, level: params.level, plan: params.plan,
    }).eq('id', studentId);
  }

  // 2) assignment de ese teacher para ese alumno (por student_id o nombre).
  let asgId: string | null = null;
  {
    const { data } = await supabase.from('assignments').select('id')
      .eq('teacher_id', params.teacherId).eq('student_id', studentId).limit(1).maybeSingle();
    if (data) asgId = data.id;
  }
  if (!asgId) {
    const { data } = await supabase.from('assignments').select('id')
      .eq('teacher_id', params.teacherId).ilike('student_name', nameTrim).limit(1).maybeSingle();
    if (data) asgId = data.id;
  }

  const payload = {
    student_id: studentId, student_name: nameTrim, student_email: emailTrim,
    student_level: params.level, slots: params.slots, plan: params.plan,
    weekly_hours: params.weeklyHours, start_date: params.startDate || new Date().toISOString().slice(0, 10),
    availability: params.slots.map(s => `${s.day} ${s.hour}`).join(', '),
  };
  const { error: linkErr } = asgId
    ? await supabase.from('assignments').update(payload).eq('id', asgId)
    : await supabase.from('assignments').insert({
        id: crypto.randomUUID(),
        teacher_id: params.teacherId, teacher_name: params.teacherName, teacher_email: params.teacherEmail,
        objetivo: '', notes: '', manual_class_adjustment: 0, ...payload,
      });
  if (linkErr) {
    console.error('[dbCreateFullLink] guardado de assignment falló:', linkErr);
    throw new Error(`No se pudo guardar la asignación: ${linkErr.message}`);
  }
}

// Garantiza que exista el student (por email o nombre) y una assignment para el
// teacher+student dados. Idempotente — pensada para llamarse al marcar una celda
// 'ocupado', manteniendo grid/students/assignments en sincronía desde el origen.
export async function dbEnsureStudentAndAssignment(params: {
  teacherId: string; teacherName: string; teacherEmail: string;
  studentName: string; studentEmail?: string; studentLevel?: string;
  plan?: string; slots: AssignedSlot[]; startDate?: string;
}): Promise<void> {
  const nameTrim = params.studentName.trim();
  if (!nameTrim) return;
  const emailTrim = (params.studentEmail ?? '').trim();

  let student: { id: string; name: string; email: string; level: string; plan: string } | null = null;
  if (emailTrim) {
    const { data } = await supabase.from('students').select('id, name, email, level, plan').ilike('email', emailTrim).limit(1).maybeSingle();
    if (data) student = data as any;
  }
  if (!student) {
    const { data } = await supabase.from('students').select('id, name, email, level, plan').ilike('name', nameTrim).limit(1).maybeSingle();
    if (data) student = data as any;
  }
  if (!student) {
    const id = crypto.randomUUID();
    const rec = { id, name: nameTrim, email: emailTrim, level: params.studentLevel ?? 'B1', plan: params.plan ?? '' };
    const { error: stuErr } = await supabase.from('students').insert(rec);
    if (stuErr) {
      console.error('[dbEnsureStudentAndAssignment] INSERT en students falló:', stuErr);
      throw new Error(`No se pudo crear el alumno: ${stuErr.message}`);
    }
    student = rec;
  }

  // ¿ya hay assignment para este teacher+student?
  let asgId: string | null = null;
  {
    const { data } = await supabase.from('assignments').select('id')
      .eq('teacher_id', params.teacherId).eq('student_id', student.id).limit(1).maybeSingle();
    if (data) asgId = data.id;
  }
  if (!asgId) {
    const { data } = await supabase.from('assignments').select('id')
      .eq('teacher_id', params.teacherId).ilike('student_name', nameTrim).limit(1).maybeSingle();
    if (data) { // existe pero con student_id posiblemente roto → corregir
      await supabase.from('assignments').update({ student_id: student.id }).eq('id', data.id);
      return;
    }
  } else {
    return; // ya existe y está bien vinculada
  }

  const { error: asgErr } = await supabase.from('assignments').insert({
    id: crypto.randomUUID(),
    teacher_id: params.teacherId, teacher_name: params.teacherName, teacher_email: params.teacherEmail,
    student_id: student.id, student_name: student.name, student_email: student.email, student_level: student.level,
    slots: params.slots, objetivo: '', plan: params.plan ?? student.plan ?? '', weekly_hours: params.slots.length,
    availability: params.slots.map(s => `${s.day} ${s.hour}`).join(', '), notes: '',
    start_date: params.startDate ?? new Date().toISOString().slice(0, 10), manual_class_adjustment: 0,
  });
  if (asgErr) {
    console.error('[dbEnsureStudentAndAssignment] INSERT en assignments falló:', asgErr);
    throw new Error(`No se pudo guardar la asignación: ${asgErr.message}`);
  }
}

// Sincronización masiva: para cada profesor, crea automáticamente la assignment
// faltante cuando el alumno del grid YA existe en students. Los que no existen en
// students quedan como "pendiente manual" (requieren email/datos mínimos).
export async function dbSyncAllCalendarsToAssignments(): Promise<{ autoFixed: number; pendingManual: string[] }> {
  const [teachers, allAssignments, students, calRes] = await Promise.all([
    dbGetTeachers(),
    dbGetAssignments(),
    dbGetStudents(),
    supabase.from('teacher_calendars').select('teacher_id, grid'),
  ]);
  const studentsByName = new Map(students.map(s => [normKey(s.name), s]));
  const asgByTeacher = new Map<string, Assignment[]>();
  for (const a of allAssignments) {
    if (!asgByTeacher.has(a.teacherId)) asgByTeacher.set(a.teacherId, []);
    asgByTeacher.get(a.teacherId)!.push(a);
  }
  const teacherById = new Map(teachers.map(t => [t.id, t]));

  const inserts: any[] = [];
  const pendingManual: string[] = [];
  for (const cal of (calRes.data ?? []) as any[]) {
    const t = teacherById.get(cal.teacher_id);
    if (!t) continue;
    const tAsgs = asgByTeacher.get(t.id) ?? [];
    for (const { name, slots } of groupCellsByStudent(extractOcupadoCells(cal.grid as Grid)).values()) {
      const nk = normKey(name);
      if (tAsgs.some(a => normKey(a.studentName) === nk)) continue; // ya vinculado
      const stu = studentsByName.get(nk);
      if (stu) {
        inserts.push({
          id: crypto.randomUUID(),
          teacher_id: t.id, teacher_name: t.name, teacher_email: t.email,
          student_id: stu.id, student_name: stu.name, student_email: stu.email, student_level: stu.level,
          slots, objetivo: '', plan: stu.plan ?? '', weekly_hours: slots.length,
          availability: slots.map(s => `${s.day} ${s.hour}`).join(', '), notes: '',
          start_date: null, manual_class_adjustment: 0,
        });
      } else {
        pendingManual.push(`${name} (${t.name})`);
      }
    }
  }
  if (inserts.length > 0) {
    await supabase.from('assignments').insert(inserts);
  }
  return { autoFixed: inserts.length, pendingManual };
}

// ── AUDIT: vínculos alumnos ↔ assignments ─────────────────────────────────────

export interface AuditResult {
  // A) Alumnos sin ninguna assignment.
  studentsWithoutAssignment: Array<{ id: string; name: string; email: string }>;
  // B) Assignments cuyo student_id no existe en students.
  orphanAssignments: Array<{ assignmentId: string; studentId: string; studentName: string; studentEmail: string; studentLevel: string; teacherName: string }>;
  // C) student_name en assignments ≠ name en students (mismo student_id).
  nameMismatches: Array<{ assignmentId: string; studentId: string; nameStudents: string; nameAssignments: string; email: string; teacherName: string }>;
  // D) Alumnos duplicados por email.
  duplicateEmails: Array<{ email: string; total: number; names: string; students: Array<{ id: string; name: string; hasAssignment: boolean }> }>;
  // E) Alumnos con más de una assignment.
  multipleAssignments: Array<{ studentId: string; studentName: string; total: number; teachers: string }>;
}

export async function dbAuditStudentAssignments(): Promise<AuditResult> {
  const [students, assignments] = await Promise.all([dbGetStudents(), dbGetAssignments()]);
  const byId = new Map(students.map(s => [s.id, s]));

  const matches = (s: Student, a: Assignment) =>
    a.studentId === s.id ||
    (!!a.studentEmail && !!s.email && normKey(a.studentEmail) === normKey(s.email)) ||
    normKey(a.studentName) === normKey(s.name);

  // A
  const studentsWithoutAssignment = students
    .filter(s => !assignments.some(a => matches(s, a)))
    .map(s => ({ id: s.id, name: s.name, email: s.email }));

  // B (LEFT JOIN solo por student_id)
  const orphanAssignments = assignments
    .filter(a => !byId.has(a.studentId))
    .map(a => ({ assignmentId: a.id, studentId: a.studentId, studentName: a.studentName, studentEmail: a.studentEmail, studentLevel: a.studentLevel, teacherName: a.teacherName }));

  // C
  const nameMismatches = assignments
    .filter(a => { const s = byId.get(a.studentId); return !!s && normKey(s.name) !== normKey(a.studentName); })
    .map(a => { const s = byId.get(a.studentId)!; return { assignmentId: a.id, studentId: a.studentId, nameStudents: s.name, nameAssignments: a.studentName, email: s.email, teacherName: a.teacherName }; });

  // D — duplicados por email
  const emailGroups = new Map<string, Student[]>();
  for (const s of students) {
    const e = normKey(s.email);
    if (!e) continue;
    const arr = emailGroups.get(e);
    if (arr) arr.push(s); else emailGroups.set(e, [s]);
  }
  const duplicateEmails = [...emailGroups.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([email, arr]) => ({
      email,
      total: arr.length,
      names: arr.map(s => s.name).join(' / '),
      students: arr.map(s => ({ id: s.id, name: s.name, hasAssignment: assignments.some(a => matches(s, a)) })),
    }));

  // E — múltiples assignments por alumno
  const asgnGroups = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const key = a.studentId || normKey(a.studentName);
    const arr = asgnGroups.get(key);
    if (arr) arr.push(a); else asgnGroups.set(key, [a]);
  }
  const multipleAssignments = [...asgnGroups.values()]
    .filter(arr => arr.length > 1)
    .map(arr => ({
      studentId: arr[0].studentId,
      studentName: arr[0].studentName,
      total: arr.length,
      teachers: arr.map(a => a.teacherName).join(' / '),
    }));

  return { studentsWithoutAssignment, orphanAssignments, nameMismatches, duplicateEmails, multipleAssignments };
}

// Vincula una assignment a un alumno real (corrige id + sincroniza datos).
export async function dbRelinkAssignment(assignmentId: string, student: { id: string; name: string; email: string; level: string }): Promise<void> {
  await supabase.from('assignments').update({
    student_id:    student.id,
    student_name:  student.name,
    student_email: student.email,
    student_level: student.level,
  }).eq('id', assignmentId);
}

// Sincroniza el student_name de una assignment con el nombre real del alumno.
export async function dbSyncAssignmentName(assignmentId: string, name: string): Promise<void> {
  await supabase.from('assignments').update({ student_name: name }).eq('id', assignmentId);
}

// Fusiona dos alumnos duplicados: reapunta las assignments del duplicado al que
// se conserva y elimina el registro duplicado.
export async function dbMergeDuplicateStudents(keepId: string, removeId: string): Promise<void> {
  if (keepId === removeId) return;
  const { data: keep } = await supabase.from('students').select('*').eq('id', keepId).maybeSingle();
  if (keep) {
    await supabase.from('assignments')
      .update({ student_id: keepId, student_name: keep.name, student_email: keep.email })
      .eq('student_id', removeId);
  } else {
    await supabase.from('assignments').update({ student_id: keepId }).eq('student_id', removeId);
  }
  await supabase.from('students').delete().eq('id', removeId);
}

// Trae TODAS las assignments de un profesor con una query directa por teacher_id
// (sin depender del estado del contexto, que puede estar vacío momentáneamente).
export async function dbGetAssignmentsByTeacher(teacherId: string): Promise<Assignment[]> {
  const { data, error } = await supabase
    .from('assignments')
    .select('*')
    .eq('teacher_id', teacherId)
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return (data as any[]).map(row => ({
    id:                    row.id,
    teacherId:             row.teacher_id,
    teacherName:           row.teacher_name,
    teacherEmail:          row.teacher_email,
    studentId:             row.student_id,
    studentName:           row.student_name,
    studentEmail:          row.student_email,
    studentLevel:          row.student_level,
    slots:                 row.slots,
    objetivo:              row.objetivo ?? '',
    plan:                  row.plan ?? '',
    weeklyHours:           row.weekly_hours,
    availability:          row.availability ?? '',
    notes:                 row.notes ?? '',
    startDate:             row.start_date ?? undefined,
    createdAt:             row.created_at,
    manualClassAdjustment: row.manual_class_adjustment ?? 0,
    meetLink:              row.meet_link ?? undefined,
    presentationEmailSent:   row.presentation_email_sent ?? false,
    presentationEmailSentAt: row.presentation_email_sent_at ?? undefined,
  }));
}

export async function dbAddAssignment(a: Assignment): Promise<void> {
  const { error } = await supabase.from('assignments').insert({
    id:                     a.id,
    teacher_id:             a.teacherId,
    teacher_name:           a.teacherName,
    teacher_email:          a.teacherEmail,
    student_id:             a.studentId,
    student_name:           a.studentName,
    student_email:          a.studentEmail,
    student_level:          a.studentLevel,
    slots:                  a.slots,
    objetivo:               a.objetivo,
    plan:                   a.plan,
    weekly_hours:           a.weeklyHours,
    availability:           a.availability,
    notes:                  a.notes,
    // Default a hoy si viene vacío: el reloj del bono de retención (6 meses) se
    // mide desde start_date. Sin fecha, la asignación quedaba fuera de la
    // detección del bono. Ver lib/retention.ts.
    start_date:             a.startDate ?? new Date().toISOString().slice(0, 10),
    manual_class_adjustment: a.manualClassAdjustment ?? 0,
  });
  // CRÍTICO: no tragar el error. Si el INSERT falla (RLS / FK / columna
  // requerida), hay que lanzarlo — de lo contrario la asignación "parece"
  // creada (estado local + notificación + celda del grid) pero no existe en la
  // base, y desaparece al recargar. Lanzar mantiene grid ↔ assignments en sync.
  if (error) {
    console.error('[dbAddAssignment] INSERT en assignments falló:', error);
    throw new Error(`No se pudo guardar la asignación: ${error.message}`);
  }
}

export async function dbUpdateAssignmentAdjustment(assignmentId: string, newAdjustment: number): Promise<void> {
  await supabase.from('assignments').update({ manual_class_adjustment: newAdjustment }).eq('id', assignmentId);
}

export async function dbUpdateTeacherRating(teacherId: string, rating: number): Promise<void> {
  await supabase.from('teachers').update({ internal_rating: rating }).eq('id', teacherId);
}

// Profesor afectado por la baja de un alumno, con los datos necesarios para
// enviarle el aviso por email.
export interface AffectedTeacher {
  teacherId: string;
  name: string;
  email: string;
  notificationEmail?: string;
}

export async function dbDeleteStudent(studentId: string, studentName: string, createdBy?: string): Promise<AffectedTeacher[]> {
  const firstName = studentName.split(' ')[0];

  const [byId, byName] = await Promise.all([
    supabase.from('assignments').select('teacher_id, start_date, created_at').eq('student_id', studentId),
    supabase.from('assignments').select('teacher_id, start_date, created_at').eq('student_name', studentName),
  ]);

  // Fecha de inicio conocida por profesor (la más antigua entre sus assignments
  // con este alumno) — se guarda en el registro de baja para poder auditar.
  const teacherIds = new Set<string>();
  const startByTeacher = new Map<string, string>();
  for (const row of [...(byId.data ?? []), ...(byName.data ?? [])]) {
    teacherIds.add(row.teacher_id);
    const start = row.start_date ?? row.created_at ?? undefined;
    if (start) {
      const cur = startByTeacher.get(row.teacher_id);
      if (!cur || start < cur) startByTeacher.set(row.teacher_id, start);
    }
  }

  // Datos de contacto de los profesores afectados (para el aviso por email).
  let affectedTeachers: AffectedTeacher[] = [];
  if (teacherIds.size > 0) {
    const { data: teacherRows } = await supabase
      .from('teachers')
      .select('id, name, email, notification_email')
      .in('id', [...teacherIds]);
    affectedTeachers = (teacherRows ?? []).map(r => ({
      teacherId:         r.id,
      name:              r.name,
      email:             r.email,
      notificationEmail: r.notification_email ?? undefined,
    }));
  }

  console.log(
    `[dbDeleteStudent] "${studentName}" (id: ${studentId}) — ` +
    `assignments: ${byId.data?.length ?? 0} por id + ${byName.data?.length ?? 0} por nombre → ` +
    `profesores afectados: [${[...teacherIds].join(', ')}]`
  );

  // Registrar la baja (churn) ANTES de borrar el alumno. Sin esto la baja no
  // dejaría rastro y la retención no podría contarla. `reason`: 'webhook' si lo
  // dispara el sistema (suscripción cancelada), 'manual' si lo hace un admin.
  if (teacherIds.size > 0) {
    const now = new Date().toISOString();
    const reason = createdBy === 'sistema' ? 'webhook' : 'manual';
    const dropoutRows = [...teacherIds].map((tid, i) => ({
      id:           `drop_${Date.now()}_${i}`,
      teacher_id:   tid,
      student_id:   studentId,
      student_name: studentName,
      start_date:   startByTeacher.get(tid) ?? null,
      dropped_at:   now,
      reason,
      created_by:   createdBy ?? null,
    }));
    const { error: dropErr } = await supabase.from('student_dropouts').insert(dropoutRows);
    if (dropErr) console.error('[dbDeleteStudent] Error al registrar la baja (churn):', dropErr);
  }

  // Notificar a cada profesor afectado antes de limpiar (manual o vía webhook).
  if (createdBy && teacherIds.size > 0) {
    const now = new Date().toISOString();
    const notifRows = [...teacherIds].map((tid, i) => ({
      id:          `notif_studrm_${Date.now()}_${i}`,
      target_user: tid,
      target_role: null,
      title:       '❌ Alumno eliminado del sistema',
      body:        `${studentName} fue eliminado porque no cuenta con suscripción activa.`,
      type:        'student_removed',
      read_by:     [],
      created_at:  now,
      created_by:  createdBy,
    }));
    await supabase.from('notifications').insert(notifRows);
  }

  for (const teacherId of teacherIds) {
    const grid = await dbGetTeacherGrid(teacherId);
    const updated: Grid = { ...grid };
    let cleaned = 0;

    for (const key of Object.keys(updated)) {
      const cell = updated[key];
      if (cell.state !== 'ocupado') continue;

      const cellStudent = cell.student ?? '';
      const matches =
        cellStudent === studentName ||
        cellStudent === firstName ||
        studentName.startsWith(cellStudent) ||
        cellStudent.startsWith(firstName);

      if (matches) {
        updated[key] = { state: 'libre', student: undefined };
        cleaned++;
      }
    }

    console.log(`[dbDeleteStudent] Profesor ${teacherId}: ${cleaned} celda(s) limpiada(s)`);

    if (cleaned > 0) {
      const { error } = await supabase
        .from('teacher_calendars')
        .upsert(
          { teacher_id: teacherId, grid: updated, updated_at: new Date().toISOString() },
          { onConflict: 'teacher_id' }
        );
      if (error) {
        console.error(`[dbDeleteStudent] Error al guardar grid del profesor ${teacherId}:`, error);
      } else {
        console.log(`[dbDeleteStudent] Grid del profesor ${teacherId} guardado OK`);
      }
    }
  }

  // Solo se eliminan assignments + students (y se liberan las celdas del grid).
  //
  // IMPORTANTE — historial intacto: NO se borran class_records (capturas) ni
  // class_join_logs (ingresos), porque son la base del cálculo de finanzas del
  // mes en curso y de meses anteriores. Aunque el alumno ya no exista en
  // `students`, sus clases ya dadas deben seguir contando para el pago al
  // profesor (ver lib/finance.ts → "orphan history"). Tampoco se tocan
  // scoring_events (ej. bonos ya cobrados) ni notifications.
  await supabase.from('assignments').delete().eq('student_id', studentId);
  await supabase.from('assignments').delete().eq('student_name', studentName);
  await supabase.from('students').delete().eq('id', studentId);

  console.log(`[dbDeleteStudent] Alumno "${studentName}" eliminado correctamente (historial de clases/finanzas preservado)`);

  // Refrescar retención/score/bloqueo de los profesores afectados: ahora que la
  // baja quedó registrada, su tasa de retención cambia.
  await Promise.all([...teacherIds].map(tid => dbRecalculateTeacherScore(tid)));

  return affectedTeachers;
}

export async function dbUpdateStudent(student: Student): Promise<void> {
  await supabase.from('students').update({
    name:  student.name,
    email: student.email,
    level: student.level,
    plan:  student.plan ?? 'Plan Individual',
    phone: student.phone ?? null,
    notes: student.notes ?? null,
  }).eq('id', student.id);
}

// ── SCORING CONSTANTS ─────────────────────────────────────────────────────────

export const EVENT_POINTS: Record<string, number> = {
  falta_injustificada: -15,
  falta_justificada:    -5,
  atraso:               -8,
  queja:               -20,
  cancelacion_tardia:  -10,
  upsell:               25,
  bonus_retencion:      30,
  bonus_puntualidad:    20,
  review_trustpilot:    15,
  bonus_feedback:       10,
  cambio_por_alumno:   -10,
  cambio_por_profesor: -20,
  profe_del_mes:        50,
  profe_del_trimestre: 100,
  email_presentacion_tardio: -5,
};

export const EVENT_EUROS: Record<string, number> = {
  upsell:          20,
  bonus_retencion: 30,
};

// ── RETENTION RATE ────────────────────────────────────────────────────────────

// Ventana (en días) sobre la que se cuentan las bajas para la retención. Una
// baja fuera de esta ventana ya no penaliza (la retención mira el pasado reciente).
export const RETENTION_WINDOW_DAYS = 90;

// Fórmula única de retención (churn-aware). `retained` = alumnos activos hoy;
// `dropouts` = bajas dentro de la ventana. Sin datos (0 y 0) devuelve 100 para
// no penalizar a un profesor nuevo o sin actividad reciente.
//   retención = retained / (retained + dropouts) × 100
export function retentionRateFromCounts(retained: number, dropouts: number): number {
  const denom = retained + dropouts;
  if (denom === 0) return 100;
  return (retained / denom) * 100;
}

// Cuenta las bajas de un profesor dentro de la ventana de retención.
export async function dbGetDropoutCount(teacherId: string): Promise<number> {
  const since = new Date(Date.now() - RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('student_dropouts')
    .select('id', { count: 'exact', head: true })
    .eq('teacher_id', teacherId)
    .gte('dropped_at', since);
  return count ?? 0;
}

export async function calcRetentionRate(teacherId: string): Promise<number> {
  const [{ data }, dropouts] = await Promise.all([
    supabase.from('assignments').select('id').eq('teacher_id', teacherId),
    dbGetDropoutCount(teacherId),
  ]);
  const activeStudents = (data ?? []).length;
  return retentionRateFromCounts(activeStudents, dropouts);
}

// ── SCORE RECALCULATION ───────────────────────────────────────────────────────

export async function dbRecalculateTeacherScore(teacherId: string): Promise<void> {
  const [evRes, asRes, calRes, dropouts] = await Promise.all([
    supabase.from('scoring_events').select('points, euros').eq('teacher_id', teacherId),
    supabase.from('assignments').select('id').eq('teacher_id', teacherId),
    supabase.from('teacher_calendars').select('grid').eq('teacher_id', teacherId).single(),
    dbGetDropoutCount(teacherId),
  ]);

  const manualPoints = (evRes.data ?? []).reduce((s: number, e: any) => s + (e.points ?? 0), 0);
  const manualEuros  = (evRes.data ?? []).reduce((s: number, e: any) => s + (e.euros ?? 0), 0);

  const as = asRes.data ?? [];
  const activeStudents = as.length;
  const grid = ((calRes.data?.grid ?? {}) as Grid);
  const ocupado = Object.values(grid).filter(c => c.state === 'ocupado').length;
  const monthlyHours = ocupado * 4;

  // Retención churn-aware: activos vs. bajas de la ventana (ver retentionRateFromCounts).
  const ret = retentionRateFromCounts(activeStudents, dropouts);

  let auto = activeStudents * 10 + monthlyHours * 2;
  if (ret >= 85)                              auto += 50;
  else if (ret >= 80)                         auto += 25;
  else if (ret < 65 && activeStudents > 0)    auto -= 30;

  const totalScore   = Math.max(0, manualPoints + auto);
  const totalEuros   = Math.max(0, manualEuros);
  const currentLevel = totalScore >= 300 ? 3 : totalScore >= 150 ? 2 : 1;
  const isBlocked    = activeStudents > 0 && ret < 65;

  await supabase.from('teachers')
    .update({
      total_score:    totalScore,
      total_euros:    totalEuros,
      current_level:  currentLevel,
      is_blocked:     isBlocked,
      retention_rate: Math.round(ret),
    })
    .eq('id', teacherId);
}

export async function dbAddScoringEvent(event: Omit<ScoringEvent, 'id' | 'createdAt'>): Promise<ScoringEvent> {
  const id        = `se_${Date.now()}`;
  const createdAt = new Date().toISOString();

  await supabase.from('scoring_events').insert({
    id,
    teacher_id:   event.teacherId,
    teacher_name: event.teacherName,
    event_type:   event.eventType,
    points:       event.points,
    euros:        event.euros,
    note:         event.note,
    created_by:   event.createdBy,
    student_ref:  event.studentRef ?? null,
    quantity:     event.quantity ?? null,
    created_at:   createdAt,
  });

  await dbRecalculateTeacherScore(event.teacherId);
  return { ...event, id, createdAt };
}

// ── PENALIZACIONES POR FALTA (Bloque 4) ─────────────────────────────────────────

async function notifyAdmin(title: string, body: string, type: string): Promise<void> {
  await supabase.from('notifications').insert({
    id:          `notif_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    target_user: null, target_role: 'admin',
    title, body, type,
    read_by:     [], created_at: new Date().toISOString(), created_by: 'sistema',
  });
}

// Efectos secundarios al registrar una falta/cancelación (además del class_record):
//  · 'falta_sin_aviso'  → penalización de -5 € (scoring_event) + alerta admin a las 4.
//  · 'cancelacion_hora'/'falta_con_aviso' → sin penalización económica; se cuentan
//    y se avisa al admin al superar 3 y al superar 5 (contador interno, no al profe).
// Best-effort: nunca debe romper el registro de la clase.
export async function dbApplyFaltaSideEffects(p: {
  teacherId: string; teacherName: string; studentName: string; classDate: string;
  classType: import('@/types').ClassRecordType;
}): Promise<void> {
  const monthPrefix = (p.classDate || new Date().toISOString()).slice(0, 7);

  try {
    if (p.classType === 'falta_sin_aviso') {
      // Penalización económica de -5 € en el balance del profesor.
      await dbAddScoringEvent({
        teacherId: p.teacherId, teacherName: p.teacherName,
        eventType: 'falta_sin_aviso_penalizacion', points: 0, euros: -5,
        note: `Falta sin aviso registrada — alumno ${p.studentName}, fecha ${p.classDate}`,
        createdBy: 'sistema', studentRef: p.studentName,
      });

      // Contador interno (SOLO admin): faltas sin aviso NO revertidas del mes.
      const { data } = await supabase.from('scoring_events')
        .select('created_at, student_ref, reverted')
        .eq('teacher_id', p.teacherId).eq('event_type', 'falta_sin_aviso_penalizacion');
      const month = (data ?? []).filter(e => (e.created_at ?? '').slice(0, 7) === monthPrefix && !e.reverted);
      if (month.length === 4) {
        const alumnos = [...new Set(month.map(e => e.student_ref).filter(Boolean))].join(', ');
        await notifyAdmin(
          `${p.teacherName} alcanzó 4 faltas sin aviso`,
          `Revisar situación. Alumnos afectados: ${alumnos || '—'}.`,
          'limite_faltas_admin',
        );
      }
    } else if (p.classType === 'cancelacion_hora' || p.classType === 'falta_con_aviso') {
      // Faltas CON aviso: sin penalización económica, pero se cuentan para el admin.
      const { data } = await supabase.from('class_records')
        .select('student_name, class_date, class_type')
        .eq('teacher_id', p.teacherId).in('class_type', ['cancelacion_hora', 'falta_con_aviso']);
      const month = (data ?? []).filter(r => (r.class_date ?? '').slice(0, 7) === monthPrefix);
      // Avisar al superar 3 (=4) y al superar 5 (=6). No en cada falta.
      if (month.length === 4 || month.length === 6) {
        const alumnos = [...new Set(month.map(r => r.student_name).filter(Boolean))].join(', ');
        await notifyAdmin(
          `Alerta: ${p.teacherName} acumula ${month.length} faltas con aviso`,
          `${p.teacherName} ha registrado ${month.length} faltas con aviso este mes. Alumnos afectados: ${alumnos || '—'}.`,
          'faltas_con_aviso_alerta',
        );
      }
    }
  } catch (e) {
    console.error('[dbApplyFaltaSideEffects] Error (no bloquea el registro):', e);
  }
}

// Revierte una penalización de falta sin aviso (Bloque 4.5): marca la original como
// revertida y crea un evento compensatorio +5 € (constancia). El neto en finanzas
// es 0 (ambos se excluyen del cálculo; ver lib/finance.ts).
export async function dbRevertPenalty(p: {
  penaltyId: string; teacherId: string; teacherName: string;
  originalDate: string; studentName?: string; reason: string; adminName: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('scoring_events')
    .update({ reverted: true, reverted_by: p.adminName, reverted_at: now })
    .eq('id', p.penaltyId);
  if (error) throw new Error(error.message);

  await dbAddScoringEvent({
    teacherId: p.teacherId, teacherName: p.teacherName,
    eventType: 'penalizacion_revertida', points: 0, euros: 5,
    note: `Reversión de penalización del ${p.originalDate}${p.studentName ? ` (${p.studentName})` : ''} — Motivo: ${p.reason}`,
    createdBy: p.adminName, studentRef: p.studentName,
  });
}

export async function dbGetScoringEvents(teacherId?: string): Promise<ScoringEvent[]> {
  let q = supabase.from('scoring_events').select('*').order('created_at', { ascending: false });
  if (teacherId) q = (q as any).eq('teacher_id', teacherId);
  const { data, error } = await q;
  // Se LANZA ante error en vez de devolver []: una lista vacía es un estado
  // legítimo (no hay eventos) y el llamador no podía distinguirla de un fallo de
  // red, así que un refresh caído vaciaba el scoring en pantalla.
  if (error || !data) throw new Error(`dbGetScoringEvents: ${error?.message ?? 'sin datos'}`);
  return (data as any[]).map(r => ({
    id:          r.id,
    teacherId:   r.teacher_id,
    teacherName: r.teacher_name,
    eventType:   r.event_type,
    points:      r.points,
    euros:       r.euros,
    note:        r.note,
    createdAt:   r.created_at,
    createdBy:   r.created_by,
    studentRef:  r.student_ref ?? undefined,
    quantity:    r.quantity ?? undefined,
    reverted:    r.reverted ?? false,
    revertedBy:  r.reverted_by ?? undefined,
    revertedAt:  r.reverted_at ?? undefined,
  }));
}

export async function dbRecalculateAllScores(): Promise<void> {
  const { data } = await supabase.from('teachers').select('id');
  if (!data) return;
  await Promise.all((data as any[]).map(t => dbRecalculateTeacherScore(t.id)));
}

// ── TEACHER OF MONTH / QUARTER ────────────────────────────────────────────────

export async function dbAssignTeacherOfMonth(teacherId: string, euros: number): Promise<void> {
  const now = new Date();
  const monthLabel = now.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

  // Get teacher name
  const { data: tData } = await supabase.from('teachers').select('name').eq('id', teacherId).single();
  const teacherName = tData?.name ?? '';

  // Clear previous teacher of month
  await supabase.from('teachers')
    .update({ is_teacher_of_month: false, teacher_of_month_date: null })
    .neq('id', 'none_placeholder');

  // Set new teacher of month
  await supabase.from('teachers')
    .update({ is_teacher_of_month: true, teacher_of_month_date: now.toISOString() })
    .eq('id', teacherId);

  // Add scoring event
  await supabase.from('scoring_events').insert({
    id:           `tom_${teacherId}_${Date.now()}`,
    teacher_id:   teacherId,
    teacher_name: teacherName,
    event_type:   'profe_del_mes',
    points:       EVENT_POINTS.profe_del_mes,
    euros,
    note:         `🏆 Profe del Mes — ${monthLabel} — Bonus: €${euros}`,
    created_by:   'Admin',
    created_at:   now.toISOString(),
  });

  await dbRecalculateTeacherScore(teacherId);
}

export async function dbAssignTeacherOfQuarter(teacherId: string, euros: number): Promise<void> {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3) + 1;
  const quarterLabel = `Q${quarter} ${now.getFullYear()}`;

  const { data: tData } = await supabase.from('teachers').select('name').eq('id', teacherId).single();
  const teacherName = tData?.name ?? '';

  await supabase.from('teachers')
    .update({ is_teacher_of_quarter: false })
    .neq('id', 'none_placeholder');

  await supabase.from('teachers')
    .update({ is_teacher_of_quarter: true })
    .eq('id', teacherId);

  await supabase.from('scoring_events').insert({
    id:           `toq_${teacherId}_${Date.now()}`,
    teacher_id:   teacherId,
    teacher_name: teacherName,
    event_type:   'profe_del_trimestre',
    points:       EVENT_POINTS.profe_del_trimestre,
    euros,
    note:         `🏆 Profe del Trimestre — ${quarterLabel} — Bonus: €${euros}`,
    created_by:   'Admin',
    created_at:   now.toISOString(),
  });

  await dbRecalculateTeacherScore(teacherId);
}

// ── RESETS ────────────────────────────────────────────────────────────────────

export async function dbCheckAndResetMonthly(): Promise<{ needed: boolean; performed: boolean }> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { data: teachers } = await supabase
    .from('teachers')
    .select('id, last_monthly_reset');

  if (!teachers || teachers.length === 0) return { needed: false, performed: false };

  const needReset = teachers.filter((t: any) =>
    !t.last_monthly_reset || t.last_monthly_reset < monthStart
  );

  if (needReset.length === 0) return { needed: false, performed: false };

  const ids = needReset.map((t: any) => t.id);
  await supabase.from('teachers').update({ last_monthly_reset: now.toISOString() }).in('id', ids);
  await Promise.all(ids.map((id: string) => dbRecalculateTeacherScore(id)));

  return { needed: true, performed: true };
}

export async function dbForceMonthlyReset(): Promise<void> {
  const now = new Date();
  const { data: teachers } = await supabase.from('teachers').select('id');
  if (!teachers) return;

  const ids = teachers.map((t: any) => t.id);
  await supabase.from('teachers').update({ last_monthly_reset: now.toISOString() }).in('id', ids);
  await Promise.all(ids.map((id: string) => dbRecalculateTeacherScore(id)));
}

export async function dbCheckAndResetQuarterly(): Promise<{ needed: boolean; performed: boolean }> {
  const now = new Date();
  const month = now.getMonth();
  const lastQuarterStart = new Date(now.getFullYear(), Math.floor(month / 3) * 3, 1).toISOString();

  const { data: teachers } = await supabase
    .from('teachers')
    .select('id, last_quarterly_reset, total_score, name');

  if (!teachers || teachers.length === 0) return { needed: false, performed: false };

  const needReset = teachers.filter((t: any) =>
    !t.last_quarterly_reset || t.last_quarterly_reset < lastQuarterStart
  );

  if (needReset.length === 0) return { needed: false, performed: false };

  // Log reset events before clearing scores
  const insertEvents = needReset
    .filter((t: any) => (t.total_score ?? 0) > 0)
    .map((t: any) => ({
      id:           `qreset_${t.id}_${Date.now()}`,
      teacher_id:   t.id,
      teacher_name: t.name,
      event_type:   'quarterly_reset',
      points:       -(t.total_score ?? 0),
      euros:        0,
      note:         `Reset trimestral — Score anterior: ${t.total_score ?? 0} pts`,
      created_by:   'Sistema',
      created_at:   now.toISOString(),
    }));

  if (insertEvents.length > 0) {
    await supabase.from('scoring_events').insert(insertEvents);
  }

  const ids = needReset.map((t: any) => t.id);
  await supabase.from('teachers')
    .update({ last_quarterly_reset: now.toISOString(), total_score: 0, current_level: 1 })
    .in('id', ids);

  return { needed: true, performed: true };
}

export async function dbForceQuarterlyReset(): Promise<void> {
  await dbCheckAndResetQuarterly();
  const now = new Date();
  const { data: teachers } = await supabase.from('teachers').select('id');
  if (!teachers) return;
  const ids = teachers.map((t: any) => t.id);
  await supabase.from('teachers').update({ last_quarterly_reset: now.toISOString(), total_score: 0, current_level: 1 }).in('id', ids);
}

// ── CLASS COUNT CALCULATOR (estimación por fecha — DEPRECADO) ──────────────────
// El seguimiento clase a clase ya NO se estima por fecha: se cuenta por clases
// registradas (ver calcRegisteredClassNumber más abajo). Esta función se conserva
// solo como referencia/estimación y no debería usarse para hitos ni para la UI.

const DAY_TO_JSDAY: Record<string, number> = {
  'Lunes': 1, 'Martes': 2, 'Miércoles': 3, 'Jueves': 4, 'Viernes': 5, 'Sábado': 6,
};

export function calcCurrentClassNumber(assignment: {
  startDate?: string;
  slots: Array<{ day: string; hour: string }>;
  manualClassAdjustment?: number;
}): number {
  const adjustment = assignment.manualClassAdjustment ?? 0;

  if (!assignment.startDate) return Math.max(0, adjustment);

  const [sy, sm, sd] = assignment.startDate.split('-').map(Number);
  const startLocal = new Date(sy, sm - 1, sd, 0, 0, 0, 0);
  const now = new Date();

  if (now < startLocal) return Math.max(0, adjustment);

  const MS_DAY = 24 * 60 * 60 * 1000;
  const diffMs   = now.getTime() - startLocal.getTime();
  const diffDays = Math.floor(diffMs / MS_DAY);

  const fullWeeks   = Math.floor(diffDays / 7);
  const partialDays = diffDays % 7;
  const startJsDay  = startLocal.getDay();

  // Full weeks × slots per week
  const slots = assignment.slots ?? [];
  let count = fullWeeks * slots.length;

  // Add slots from the current partial week that have already occurred
  for (const slot of slots) {
    const slotJsDay = DAY_TO_JSDAY[slot.day] ?? -1;
    if (slotJsDay === -1) continue;

    let dist = slotJsDay - startJsDay;
    if (dist < 0) dist += 7;

    if (dist < partialDays) {
      count++;
    } else if (dist === partialDays && now.getHours() >= parseInt(slot.hour)) {
      count++;
    }
  }

  return Math.max(0, count + adjustment);
}

// ── CONTEO POR CLASES REGISTRADAS ─────────────────────────────────────────────
// El seguimiento clase a clase se basa en las clases efectivamente cargadas por el
// profesor (class_records), NO en una estimación por fecha. Solo suman las clases
// dadas — 'normal' y 'recuperacion' (las que llevan transcript). Faltas,
// cancelaciones y reprogramadas no cuentan. Esta es la fuente de verdad del número
// de clase (incluida la detección de hitos 15/30/50).

// class_type NULL se trata como 'normal' (así lo mapea mapClassRecord).
export function classCountsForProgress(classType?: string | null): boolean {
  return classType == null || classType === 'normal' || classType === 'recuperacion';
}

// Clases dadas para un alumno+profesor, a partir de registros ya cargados en memoria.
export function countGivenClasses(
  records: Array<{ teacherId: string; studentName: string; classType?: import('@/types').ClassRecordType }>,
  teacherId: string,
  studentName: string,
): number {
  const nk = (s: string) => (s ?? '').trim().toLowerCase();
  const target = nk(studentName);
  let n = 0;
  for (const r of records) {
    if (r.teacherId === teacherId && nk(r.studentName) === target && classCountsForProgress(r.classType)) n++;
  }
  return n;
}

// Número de clase actual = clases dadas registradas + ajuste manual del admin.
// Reemplaza a calcCurrentClassNumber (estimación por fecha) para el seguimiento y
// los hitos. Toma los registros ya cargados (contexto), sin ir a la base.
export function calcRegisteredClassNumber(
  assignment: { teacherId: string; studentName: string; manualClassAdjustment?: number },
  records: Array<{ teacherId: string; studentName: string; classType?: import('@/types').ClassRecordType }>,
): number {
  return Math.max(0, countGivenClasses(records, assignment.teacherId, assignment.studentName) + (assignment.manualClassAdjustment ?? 0));
}

// Versión server-side: cuenta las clases dadas directamente en la base (para
// disparadores que no tienen los registros en memoria, p. ej. la detección de
// hitos al registrar una clase).
export async function dbCountGivenClasses(teacherId: string, studentName: string): Promise<number> {
  const { count } = await supabase
    .from('class_records')
    .select('id', { count: 'exact', head: true })
    .eq('teacher_id', teacherId)
    .eq('student_name', studentName)
    // class_type NULL (filas antiguas) o normal/recuperacion.
    .or('class_type.is.null,class_type.eq.normal,class_type.eq.recuperacion');
  return count ?? 0;
}

// ── CLASS COUNT ───────────────────────────────────────────────────────────────

export async function dbGetClassCounts(teacherId: string): Promise<ClassCount[]> {
  const { data, error } = await supabase
    .from('class_count')
    .select('*')
    .eq('teacher_id', teacherId)
    .order('class_number', { ascending: false });

  if (error || !data) return [];

  return data.map((row: any) => ({
    id:           row.id,
    teacherId:    row.teacher_id,
    studentName:  row.student_name,
    studentEmail: row.student_email ?? undefined,
    classNumber:  row.class_number,
    lastUpdated:  row.last_updated,
  }));
}

export async function dbIncrementClassCount(
  teacherId: string,
  studentName: string,
  studentEmail?: string,
): Promise<ClassCount> {
  const id  = `cc_${teacherId}_${studentName.replace(/\s+/g, '_').toLowerCase()}`;
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from('class_count')
    .select('*')
    .eq('id', id)
    .single();

  if (existing) {
    const newNumber = (existing.class_number as number) + 1;
    await supabase.from('class_count').update({ class_number: newNumber, last_updated: now }).eq('id', id);
    return {
      id,
      teacherId,
      studentName,
      studentEmail: studentEmail ?? existing.student_email ?? undefined,
      classNumber:  newNumber,
      lastUpdated:  now,
    };
  }

  await supabase.from('class_count').insert({
    id,
    teacher_id:    teacherId,
    student_name:  studentName,
    student_email: studentEmail ?? null,
    class_number:  1,
    last_updated:  now,
  });

  return { id, teacherId, studentName, studentEmail, classNumber: 1, lastUpdated: now };
}

export async function dbGetTeacherStudents(teacherId: string): Promise<Assignment[]> {
  const { data, error } = await supabase
    .from('assignments')
    .select('*')
    .eq('teacher_id', teacherId);

  if (error || !data) return [];

  const seen = new Set<string>();
  return (data as any[])
    .filter(row => { if (seen.has(row.student_name)) return false; seen.add(row.student_name); return true; })
    .map(row => ({
      id:                    row.id,
      teacherId:             row.teacher_id,
      teacherName:           row.teacher_name,
      teacherEmail:          row.teacher_email,
      studentId:             row.student_id,
      studentName:           row.student_name,
      studentEmail:          row.student_email,
      studentLevel:          row.student_level,
      slots:                 row.slots,
      objetivo:              row.objetivo ?? '',
      plan:                  row.plan ?? '',
      weeklyHours:           row.weekly_hours,
      availability:          row.availability ?? '',
      notes:                 row.notes ?? '',
      startDate:             row.start_date ?? undefined,
      createdAt:             row.created_at,
      manualClassAdjustment: row.manual_class_adjustment ?? 0,
      meetLink:              row.meet_link ?? undefined,
      presentationEmailSent:   row.presentation_email_sent ?? false,
      presentationEmailSentAt: row.presentation_email_sent_at ?? undefined,
    }));
}

export async function dbUpdateAssignmentStartDate(assignmentId: string, startDate: string): Promise<void> {
  await supabase.from('assignments').update({ start_date: startDate }).eq('id', assignmentId);
}

export async function dbCheckStudentExists(email: string): Promise<import('@/types').Student | null> {
  const trimmed = email.trim().toLowerCase();
  const { data } = await supabase.from('students').select('*').ilike('email', trimmed).limit(1).single();
  if (!data) return null;
  return {
    id: data.id, name: data.name, email: data.email,
    level: data.level, plan: data.plan ?? 'Plan Individual',
    phone: data.phone ?? undefined, notes: data.notes ?? undefined,
    createdAt: data.created_at,
  };
}

// Busca un alumno por email (match tolerante ilike). Devuelve el Student COMPLETO
// (incl. nivel, plan y datos de producto WooCommerce) para el autocompletado de
// los formularios de asignación. Null si no existe.
export async function dbGetStudentByEmail(email: string): Promise<Student | null> {
  const trimmed = email.trim();
  if (!trimmed) return null;
  const { data } = await supabase.from('students').select('*').ilike('email', trimmed).limit(1).maybeSingle();
  if (!data) return null;
  return {
    id:                data.id,
    name:              data.name,
    email:             data.email,
    phone:             data.phone ?? undefined,
    level:             data.level,
    plan:              data.plan,
    notes:             data.notes ?? undefined,
    manualActiveUntil: data.manual_active_until ?? undefined,
    productType:       data.product_type ?? undefined,
    productName:       data.product_name ?? undefined,
    createdAt:         data.created_at,
  };
}

export async function dbUpdateAssignmentSlots(
  assignmentId: string,
  slots: Array<{ day: string; hour: string }>,
  weeklyHours: number,
): Promise<void> {
  await supabase.from('assignments').update({
    slots,
    weekly_hours: weeklyHours,
    availability: slots.map(s => `${s.day} ${s.hour}`).join(', '),
  }).eq('id', assignmentId);
}

export async function dbGetAllClassCounts(): Promise<ClassCount[]> {
  const { data, error } = await supabase
    .from('class_count')
    .select('*')
    .order('class_number', { ascending: false });

  if (error || !data) return [];

  return data.map((row: any) => ({
    id:           row.id,
    teacherId:    row.teacher_id,
    studentName:  row.student_name,
    studentEmail: row.student_email ?? undefined,
    classNumber:  row.class_number,
    lastUpdated:  row.last_updated,
  }));
}

// ── TEACHER UPDATE ────────────────────────────────────────────────────────────

export async function dbUpdateTeacherSpecialties(teacherId: string, specialties: string[]): Promise<void> {
  await supabase.from('teachers').update({ specialties }).eq('id', teacherId);
}

export async function dbUpdateTeacherInfo(teacherId: string, data: { name: string; email: string; specialties: string[] }): Promise<void> {
  await supabase.from('teachers').update({
    name:       data.name,
    email:      data.email,
    specialties: data.specialties,
  }).eq('id', teacherId);
}

// Correo de notificaciones del profesor (opcional). Vacío → null (se usa email).
export async function dbUpdateTeacherNotificationEmail(teacherId: string, email: string): Promise<void> {
  await supabase.from('teachers')
    .update({ notification_email: email.trim() || null })
    .eq('id', teacherId);
}

// email_preferences puede venir como jsonb (objeto) o como string JSON.
function parseEmailPrefs(v: unknown): EmailPreferences | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as EmailPreferences; } catch { return undefined; }
  }
  return v as EmailPreferences;
}

// Preferencias de avisos por email del profesor.
export async function dbUpdateTeacherEmailPreferences(
  teacherId: string, prefs: EmailPreferences,
): Promise<void> {
  const { error } = await supabase.from('teachers')
    .update({ email_preferences: prefs })
    .eq('id', teacherId);
  if (error) throw new Error(`No se pudieron guardar las preferencias: ${error.message}`);
}

// ── MEET LINKS ────────────────────────────────────────────────────────────────

export async function dbUpdateMeetLink(assignmentId: string, link: string): Promise<void> {
  await supabase.from('assignments').update({ meet_link: link.trim() || null }).eq('id', assignmentId);
}

// ── CLASS JOIN LOGS ───────────────────────────────────────────────────────────

function calcPunctuality(scheduledDate: string, scheduledTime: string, clickedAt: Date): ClassJoinLog['punctuality'] {
  // scheduledTime es "HH:00" en hora de ESPAÑA. Antes se construía la hora
  // programada con `new Date(y, m, d, h)`, que usa la zona del navegador: un
  // profesor en Argentina la medía contra las 15:00 argentinas en vez de las
  // españolas, así que entrar 5 h tarde quedaba registrado como 'on_time'.
  const diffMin = minutesLateSpain(scheduledDate, scheduledTime, clickedAt);
  if (isNaN(diffMin)) return 'on_time';   // fecha inválida: no penalizamos
  if (diffMin <= 5)  return 'on_time';
  if (diffMin <= 15) return 'late';
  return 'very_late';
}

export async function dbLogClassJoin(
  teacherId: string,
  teacherName: string,
  studentName: string,
  scheduledDate: string,
  scheduledTime: string,
  subscriptionStatus?: string,
  enteredWithoutActive?: boolean,
  subscriptionDaysRemaining?: number | null,
): Promise<ClassJoinLog> {
  const clickedAt   = new Date();
  const punctuality = calcPunctuality(scheduledDate, scheduledTime, clickedAt);
  const id          = `cjl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  await supabase.from('class_join_logs').insert({
    id,
    teacher_id:                  teacherId,
    teacher_name:                teacherName,
    student_name:                studentName,
    scheduled_date:              scheduledDate,
    scheduled_time:              scheduledTime,
    clicked_at:                  clickedAt.toISOString(),
    punctuality,
    subscription_status:         subscriptionStatus ?? null,
    entered_without_active:      enteredWithoutActive ?? false,
    subscription_days_remaining: subscriptionDaysRemaining ?? null,
  });

  return {
    id, teacherId, teacherName, studentName,
    scheduledDate, scheduledTime,
    clickedAt: clickedAt.toISOString(),
    punctuality,
    subscriptionStatus,
    enteredWithoutActive: enteredWithoutActive ?? false,
    subscriptionDaysRemaining: subscriptionDaysRemaining ?? undefined,
  };
}

export async function dbGetClassJoinLogs(): Promise<ClassJoinLog[]> {
  const { data, error } = await supabase
    .from('class_join_logs')
    .select('*')
    .order('clicked_at', { ascending: false });

  if (error || !data) return [];

  return (data as any[]).map(row => ({
    id:            row.id,
    teacherId:     row.teacher_id,
    teacherName:   row.teacher_name,
    studentName:   row.student_name,
    scheduledDate: row.scheduled_date,
    scheduledTime: row.scheduled_time,
    clickedAt:     row.clicked_at,
    punctuality:   row.punctuality,
    subscriptionStatus:   row.subscription_status ?? undefined,
    enteredWithoutActive: row.entered_without_active ?? false,
    subscriptionDaysRemaining: row.subscription_days_remaining ?? undefined,
  }));
}

// ── UNASSIGNED STUDENTS ───────────────────────────────────────────────────────

// Students that exist in `students` but have no row in `assignments`.
export async function dbGetUnassignedStudents(): Promise<Student[]> {
  const [studentsRes, assignmentsRes] = await Promise.all([
    supabase.from('students').select('*').order('created_at', { ascending: true }),
    supabase.from('assignments').select('student_id, student_name'),
  ]);

  // Lanza ante error (ver dbGetScoringEvents): "ningún alumno sin asignar" es un
  // estado normal y no debe confundirse con un fallo de red.
  if (studentsRes.error || !studentsRes.data) {
    throw new Error(`dbGetUnassignedStudents: ${studentsRes.error?.message ?? 'sin datos'}`);
  }

  const assignedIds   = new Set<string>();
  const assignedNames = new Set<string>();
  for (const row of (assignmentsRes.data ?? [])) {
    if (row.student_id)   assignedIds.add(row.student_id);
    if (row.student_name) assignedNames.add(row.student_name);
  }

  return (studentsRes.data as any[])
    .filter(row => !assignedIds.has(row.id) && !assignedNames.has(row.name))
    .map(row => ({
      id:        row.id,
      name:      row.name,
      email:     row.email,
      phone:     row.phone ?? undefined,
      level:     row.level,
      plan:      row.plan,
      notes:     row.notes ?? undefined,
      createdAt: row.created_at,
    }));
}

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────

function mapNotif(row: any): AppNotification {
  return {
    id:         row.id,
    targetUser: row.target_user ?? undefined,
    targetRole: row.target_role ?? undefined,
    title:      row.title,
    body:       row.body,
    type:       row.type,
    readBy:     row.read_by ?? [],
    createdAt:  row.created_at,
    createdBy:  row.created_by,
  };
}

export async function dbSendNotification(notification: {
  targetUser?: string;
  targetRole?: string;
  title: string;
  body: string;
  type: string;
  createdBy: string;
}): Promise<AppNotification> {
  const id        = `notif_${Date.now()}`;
  const createdAt = new Date().toISOString();
  await supabase.from('notifications').insert({
    id,
    target_user: notification.targetUser ?? null,
    target_role: notification.targetRole ?? null,
    title:       notification.title,
    body:        notification.body,
    type:        notification.type,
    read_by:     [],
    created_at:  createdAt,
    created_by:  notification.createdBy,
  });
  return {
    id,
    targetUser: notification.targetUser,
    targetRole: notification.targetRole,
    title:      notification.title,
    body:       notification.body,
    type:       notification.type,
    readBy:     [],
    createdAt,
    createdBy:  notification.createdBy,
  };
}

// Notifica a un profesor que se le asignó un nuevo alumno: aviso in-app + email.
// El email va por /api/emails porque RESEND_API_KEY es server-only y esta función
// corre en el navegador. Es best-effort: si falla, la notificación in-app queda.
export async function dbNotifyNewAssignment(
  teacherId: string,
  studentName: string,
  studentEmail: string,
  details?: { plan?: string | null; level?: string | null; slots?: Array<{ day: string; hour: string }> | null; startDate?: string | null },
): Promise<void> {
  await supabase.from('notifications').insert({
    id:          `notif_newasgn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    target_user: teacherId,
    target_role: null,
    title:       '📚 Nuevo alumno asignado',
    body:        `Se te asignó ${studentName}. Recordá presentarte por correo electrónico (${studentEmail || 'sin email'}) antes de la primera clase.`,
    type:        'new_assignment',
    read_by:     [],
    created_at:  new Date().toISOString(),
    created_by:  'sistema',
  });

  await triggerEmail({
    type: 'new_student',
    teacherId,
    studentName,
    studentEmail,
    plan: details?.plan,
    level: details?.level,
    slots: details?.slots,
    startDate: details?.startDate,
  });
}

export async function dbGetNotificationsForUser(userId: string, role: string): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .or(`target_user.eq.${userId},target_role.eq.${role}`)
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data.map(mapNotif);
}

export async function dbMarkNotificationRead(notificationId: string, userId: string): Promise<void> {
  const { data } = await supabase.from('notifications').select('read_by').eq('id', notificationId).single();
  if (!data) return;
  const readBy: string[] = data.read_by ?? [];
  if (readBy.includes(userId)) return;
  await supabase.from('notifications').update({ read_by: [...readBy, userId] }).eq('id', notificationId);
}

export async function dbGetAllNotifications(): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data.map(mapNotif);
}

export async function dbMarkAllNotificationsRead(userId: string, role: string): Promise<void> {
  const { data } = await supabase
    .from('notifications')
    .select('id, read_by')
    .or(`target_user.eq.${userId},target_role.eq.${role}`);
  if (!data || data.length === 0) return;
  const unread = data.filter((n: any) => !(n.read_by ?? []).includes(userId));
  if (unread.length === 0) return;
  await Promise.all(unread.map((n: any) =>
    supabase.from('notifications')
      .update({ read_by: [...(n.read_by ?? []), userId] })
      .eq('id', n.id)
  ));
}

export async function dbUpsertTeacherAlerts(
  teacherId: string,
  assignments: Array<{
    studentName: string;
    startDate?: string;
    slots: Array<{ day: string; hour: string }>;
    manualClassAdjustment?: number;
  }>,
): Promise<void> {
  const today = new Date();
  const toInsert: any[] = [];

  // Conteo por clases registradas (normal/recuperacion) del profesor, en una sola
  // query, para detectar la cercanía a la clase 15 con el número real.
  const nk = (s: string) => (s ?? '').trim().toLowerCase();
  const givenByStudent = new Map<string, number>();
  {
    const { data: recs } = await supabase
      .from('class_records')
      .select('student_name, class_type')
      .eq('teacher_id', teacherId);
    for (const r of (recs ?? []) as Array<{ student_name: string; class_type: string | null }>) {
      if (!classCountsForProgress(r.class_type)) continue;
      const k = nk(r.student_name);
      givenByStudent.set(k, (givenByStudent.get(k) ?? 0) + 1);
    }
  }

  for (const a of assignments) {
    const slugName = a.studentName.replace(/\s+/g, '_').toLowerCase();
    const classNum = Math.max(0, (givenByStudent.get(nk(a.studentName)) ?? 0) + (a.manualClassAdjustment ?? 0));

    // Near clase 15 (3 or fewer classes away, not yet reached)
    if (classNum < 15 && 15 - classNum <= 3) {
      const left = 15 - classNum;
      toInsert.push({
        id:          `alert_c15_${teacherId}_${slugName}`,
        target_user: teacherId,
        title:       `🎬 ${a.studentName} está cerca de la clase 15`,
        body:        `Faltan ${left} clase${left === 1 ? '' : 's'} para llegar a la clase 15. Recordá grabar la clase y compartir el enlace de Fathom.`,
        type:        'clase15',
        read_by:     [],
        created_at:  new Date().toISOString(),
        created_by:  'Sistema',
      });
    }

    // Near 6-month bonus (0-15 days remaining) or already reached
    if (a.startDate) {
      const start     = new Date(a.startDate + 'T00:00:00');
      const daysActive = Math.floor((today.getTime() - start.getTime()) / 86400000);
      const daysLeft   = 180 - daysActive;

      if (daysLeft <= 15) {
        toInsert.push({
          id:          `alert_6m_${teacherId}_${slugName}`,
          target_user: teacherId,
          title:       daysLeft <= 0
            ? `🎁 Bono disponible — ${a.studentName}`
            : `🎁 ${a.studentName} cumple 6 meses pronto`,
          body:        daysLeft <= 0
            ? `${a.studentName} lleva más de 6 meses. Solicitá el bono de retención a pagos@drcacademy.com.`
            : `Faltan ${daysLeft} día${daysLeft === 1 ? '' : 's'} para que ${a.studentName} cumpla 6 meses. Prepará la solicitud del bono.`,
          type:        'bono6m',
          read_by:     [],
          created_at:  new Date().toISOString(),
          created_by:  'Sistema',
        });
      }
    }
  }

  if (toInsert.length === 0) return;
  // ignoreDuplicates preserves existing read_by state
  await supabase.from('notifications').upsert(toInsert, { onConflict: 'id', ignoreDuplicates: true });
}

// ── FINANCE: CLASS RECORDS (capturas) ─────────────────────────────────────────

function mapClassRecord(row: any): import('@/types').ClassRecord {
  return {
    id:            row.id,
    teacherId:     row.teacher_id,
    teacherName:   row.teacher_name,
    studentName:   row.student_name,
    classDate:     row.class_date,
    classTime:     row.class_time ?? undefined,
    screenshotUrl: row.screenshot_url,
    comment:       row.comment ?? undefined,
    classType:     row.class_type ?? 'normal',
    subscriptionStatus: row.subscription_status ?? undefined,
    originalDate:   row.original_date ?? undefined,
    rescheduledTo:  row.rescheduled_to ?? undefined,
    recoveryForDate: row.recovery_for_date ?? undefined,
    createdAt:     row.created_at,
  };
}

// Cuenta cuántos registros de un class_type específico existen para un
// alumno+profesor en class_records (acumulativo, sin filtro de mes).
export async function dbCountClassTypeForStudent(
  teacherId: string, studentName: string, classType: import('@/types').ClassRecordType,
): Promise<number> {
  const { count } = await supabase
    .from('class_records')
    .select('id', { count: 'exact', head: true })
    .eq('teacher_id', teacherId)
    .eq('student_name', studentName)
    .eq('class_type', classType);
  return count ?? 0;
}

export async function dbGetClassRecords(): Promise<import('@/types').ClassRecord[]> {
  const { data, error } = await supabase
    .from('class_records')
    .select('*')
    .order('class_date', { ascending: false });
  if (error || !data) return [];
  return (data as any[]).map(mapClassRecord);
}

/**
 * Transcripciones para el cálculo de finanzas (SEGUNDO FACTOR de verificación).
 * Se traen solo las columnas necesarias: el texto completo del transcript puede
 * ser enorme y acá únicamente interesa si existe y no está vacío.
 */
export async function dbGetClassTranscripts(): Promise<import('@/lib/finance').ClassTranscriptRef[]> {
  const { data, error } = await supabase
    .from('class_analyses')
    .select('teacher_id, student_name, class_date, analyzed_at, transcript, join_log_id, validation_status')
    .order('analyzed_at', { ascending: false });
  if (error || !data) {
    if (error) console.error('[db] Error al leer class_analyses para finanzas:', error);
    // Si la columna validation_status aún no existe, reintentar sin ella.
    if (error?.code === '42703' || error?.code === 'PGRST204') {
      const retry = await supabase
        .from('class_analyses')
        .select('teacher_id, student_name, class_date, analyzed_at, transcript, join_log_id')
        .order('analyzed_at', { ascending: false });
      if (!retry.error && retry.data) return retry.data as unknown as import('@/lib/finance').ClassTranscriptRef[];
    }
    return [];
  }
  return data as unknown as import('@/lib/finance').ClassTranscriptRef[];
}

// ── VALIDACIÓN DE TRANSCRIPCIONES (Bloque 1) ────────────────────────────────────

export interface FlaggedTranscript {
  id: string;
  teacherId: string | null;
  studentName: string;
  classDate: string | null;
  analyzedAt: string | null;
  transcript: string;
  score: number | null;
  flags: string[];
  aiCheck: { authentic?: boolean; confidence?: number; reasoning?: string } | null;
  validationStatus: string;   // 'review' | 'approved' | 'rejected' | 'ok'
  reviewedBy: string | null;
  reviewedAt: string | null;
}

// Transcripciones marcadas (en revisión o ya resueltas) para el panel del admin.
export async function dbGetFlaggedTranscripts(): Promise<FlaggedTranscript[]> {
  const { data, error } = await supabase
    .from('class_analyses')
    .select('id, teacher_id, student_name, class_date, analyzed_at, transcript, transcript_validation_score, transcript_validation_flags, ai_authenticity_check, validation_status, validation_reviewed_by, validation_reviewed_at')
    .in('validation_status', ['review', 'approved', 'rejected'])
    .order('analyzed_at', { ascending: false });
  if (error || !data) {
    if (error && error.code !== '42703' && error.code !== 'PGRST204') {
      console.error('[db] Error al leer transcripciones marcadas:', error);
    }
    return [];   // columnas aún no migradas → lista vacía (degradación limpia)
  }
  return (data as Array<Record<string, unknown>>).map(r => ({
    id:               r.id as string,
    teacherId:        (r.teacher_id as string) ?? null,
    studentName:      (r.student_name as string) ?? '',
    classDate:        (r.class_date as string) ?? null,
    analyzedAt:       (r.analyzed_at as string) ?? null,
    transcript:       (r.transcript as string) ?? '',
    score:            (r.transcript_validation_score as number) ?? null,
    flags:            (r.transcript_validation_flags as string[]) ?? [],
    aiCheck:          (r.ai_authenticity_check as FlaggedTranscript['aiCheck']) ?? null,
    validationStatus: (r.validation_status as string) ?? 'review',
    reviewedBy:       (r.validation_reviewed_by as string) ?? null,
    reviewedAt:       (r.validation_reviewed_at as string) ?? null,
  }));
}

// Aprobar o rechazar una transcripción marcada. Al rechazar, avisa al profesor
// (mensaje neutro) para que registre la clase de nuevo con el transcript correcto.
export async function dbReviewTranscript(
  row: { id: string; teacherId: string | null; studentName: string; classDate: string | null },
  decision: 'approved' | 'rejected',
  reviewerName: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('class_analyses').update({
    validation_status:      decision,
    validation_reviewed_by: reviewerName,
    validation_reviewed_at: now,
  }).eq('id', row.id);
  if (error) throw new Error(error.message);

  if (decision === 'rejected' && row.teacherId) {
    await supabase.from('notifications').insert({
      id:          `notif_txrej_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      target_user: row.teacherId,
      target_role: null,
      title:       'Revisión de una clase registrada',
      body:        `La clase de ${row.studentName}${row.classDate ? ` del ${row.classDate}` : ''} no pudo validarse y no se contará para el pago. Si la diste, vuelve a registrarla copiando la transcripción completa de Fathom.`,
      type:        'transcript_rejected',
      read_by:     [],
      created_at:  now,
      created_by:  'sistema',
    });
  }
}

// ── PREDICCIÓN DE BAJAS (churn) ─────────────────────────────────────────────────

export interface ChurnRiskStudent {
  id: string;
  studentName: string;
  teacherId: string | null;
  capturedAt: string | null;
  combinedRisk: number | null;
  cancellations: number | null;
  lateCount: number | null;
  speakingTrend: string | null;
  aiReasoning: string | null;
  explicitQuit: boolean | null;
}

export interface ChurnOverview {
  churnedCount: number;        // ejemplos de baja recopilados (meta ~100)
  activeScannedCount: number;  // fotos de alumnos activos
  atRisk: ChurnRiskStudent[];  // alumnos activos con riesgo alto (última foto)
}

// Resumen para el panel del admin. Degradación limpia si la tabla no existe aún.
export async function dbGetChurnOverview(riskThreshold = 55): Promise<ChurnOverview> {
  const empty: ChurnOverview = { churnedCount: 0, activeScannedCount: 0, atRisk: [] };
  try {
    const [churnedRes, activeRes, recentRes] = await Promise.all([
      supabase.from('churn_snapshots').select('id', { count: 'exact', head: true }).eq('label', 'churned'),
      supabase.from('churn_snapshots').select('id', { count: 'exact', head: true }).eq('label', 'active'),
      supabase.from('churn_snapshots')
        .select('id, student_name, teacher_id, captured_at, combined_risk, cancellations, late_count, speaking_trend, ai_reasoning, ai_explicit_quit')
        .eq('label', 'active').order('captured_at', { ascending: false }).limit(300),
    ]);

    // Última foto por alumno.
    const latest = new Map<string, ChurnRiskStudent>();
    for (const r of (recentRes.data ?? []) as Array<Record<string, unknown>>) {
      const key = String(r.student_name ?? '').trim().toLowerCase();
      if (!key || latest.has(key)) continue;
      latest.set(key, {
        id:            r.id as string,
        studentName:   r.student_name as string,
        teacherId:     (r.teacher_id as string) ?? null,
        capturedAt:    (r.captured_at as string) ?? null,
        combinedRisk:  (r.combined_risk as number) ?? null,
        cancellations: (r.cancellations as number) ?? null,
        lateCount:     (r.late_count as number) ?? null,
        speakingTrend: (r.speaking_trend as string) ?? null,
        aiReasoning:   (r.ai_reasoning as string) ?? null,
        explicitQuit:  (r.ai_explicit_quit as boolean) ?? null,
      });
    }
    const atRisk = [...latest.values()]
      .filter(s => (s.combinedRisk ?? 0) >= riskThreshold)
      .sort((a, b) => (b.combinedRisk ?? 0) - (a.combinedRisk ?? 0));

    return {
      churnedCount: churnedRes.count ?? 0,
      activeScannedCount: activeRes.count ?? 0,
      atRisk,
    };
  } catch (e) {
    console.error('[db] dbGetChurnOverview:', e);
    return empty;
  }
}

// Sube la captura al bucket público "class-screenshots" y devuelve su URL pública.
export async function dbUploadClassScreenshot(file: File, teacherId: string): Promise<string> {
  const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${teacherId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from('class-screenshots').upload(path, file, {
    cacheControl: '3600', upsert: false, contentType: file.type || undefined,
  });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from('class-screenshots').getPublicUrl(path);
  return data.publicUrl;
}

export async function dbAddClassRecord(
  teacherId: string, teacherName: string, studentName: string,
  classDate: string, classTime: string | undefined, screenshotUrl: string,
  classType: import('@/types').ClassRecordType = 'normal', comment?: string, subscriptionStatus?: string,
): Promise<import('@/types').ClassRecord> {
  const id        = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = new Date().toISOString();
  const base = {
    id,
    teacher_id:     teacherId,
    teacher_name:   teacherName,
    student_name:   studentName,
    class_date:     classDate,
    class_time:     classTime ?? null,
    screenshot_url: screenshotUrl,
    class_type:     classType,
    comment:        comment ?? null,
    created_at:     createdAt,
  };
  // Resiliente: si la columna subscription_status aún no existe en la BD,
  // reintenta sin ella para no bloquear el registro de la clase.
  const { error } = await supabase.from('class_records').insert({ ...base, subscription_status: subscriptionStatus ?? null });
  if (error) await supabase.from('class_records').insert(base);
  return { id, teacherId, teacherName, studentName, classDate, classTime, screenshotUrl, classType, comment, subscriptionStatus, createdAt };
}

// Registra la constancia de una clase REPROGRAMADA (o cancelación sobre la hora que
// se reprograma). class_date = fecha original; rescheduled_to = nueva fecha. Las de
// tipo 'reprogramada' NO cuentan para el pago (ver lib/finance.ts); las de tipo
// 'cancelacion_hora' sí son cobrables (hasta 2 por alumno). Resiliente si la BD no
// tiene aún las columnas original_date/rescheduled_to.
export async function dbAddRescheduleRecord(p: {
  teacherId: string; teacherName: string; studentName: string;
  originalDate: string; originalTime?: string;
  newDate: string; newTime?: string;
  classType: 'reprogramada' | 'cancelacion_hora';
  comment: string;
}): Promise<import('@/types').ClassRecord> {
  const id        = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = new Date().toISOString();
  const base = {
    id, teacher_id: p.teacherId, teacher_name: p.teacherName, student_name: p.studentName,
    class_date: p.originalDate, class_time: p.originalTime ?? null,
    screenshot_url: '', class_type: p.classType, comment: p.comment, created_at: createdAt,
  };
  const { error } = await supabase.from('class_records').insert({ ...base, original_date: p.originalDate, rescheduled_to: p.newDate });
  if (error) await supabase.from('class_records').insert(base);
  return {
    id, teacherId: p.teacherId, teacherName: p.teacherName, studentName: p.studentName,
    classDate: p.originalDate, classTime: p.originalTime, screenshotUrl: '', classType: p.classType,
    comment: p.comment, originalDate: p.originalDate, rescheduledTo: p.newDate, createdAt,
  };
}

// Registra una clase de RECUPERACIÓN vinculada al alumno y a la fecha original que
// se recupera. class_date = fecha de HOY (cuando se recupera). Cuenta para el pago
// con la tarifa normal del alumno (igual que una clase normal). Resiliente si la BD
// no tiene aún la columna recovery_for_date.
export async function dbAddRecoveryClass(p: {
  teacherId: string; teacherName: string; studentName: string;
  recoveryDate: string; originalDate: string; note?: string; classTime?: string;
}): Promise<import('@/types').ClassRecord> {
  const id        = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = new Date().toISOString();
  const comment   = `Recuperación de clase del ${p.originalDate}${p.note ? ` — ${p.note}` : ''}`;
  const base = {
    id, teacher_id: p.teacherId, teacher_name: p.teacherName, student_name: p.studentName,
    class_date: p.recoveryDate, class_time: p.classTime ?? null,
    screenshot_url: '', class_type: 'recuperacion', comment, created_at: createdAt,
  };
  const { error } = await supabase.from('class_records').insert({ ...base, recovery_for_date: p.originalDate });
  if (error) await supabase.from('class_records').insert(base);
  return {
    id, teacherId: p.teacherId, teacherName: p.teacherName, studentName: p.studentName,
    classDate: p.recoveryDate, classTime: p.classTime, screenshotUrl: '', classType: 'recuperacion',
    comment, recoveryForDate: p.originalDate, createdAt,
  };
}

// ── CAMBIO DE PROFESOR / DUPLICADOS ────────────────────────────────────────────

const _nk = (x: unknown): string => String(x ?? '').trim().toLowerCase();

// ¿La celda 'ocupado' pertenece a este alumno? (match tolerante por nombre/first name).
function _cellIsStudent(cellStudent: string | undefined, studentName: string): boolean {
  const cs = _nk(cellStudent);
  if (!cs) return false;
  const full  = _nk(studentName);
  const first = _nk(studentName.split(' ')[0]);
  return cs === full || cs === first || full.startsWith(cs) || cs.startsWith(first);
}

export interface ChangeTeacherParams {
  assignmentId: string;
  studentName: string;
  studentEmail: string;
  weeklyHours: number;
  from: { id: string; name: string; email: string };
  to:   { id: string; name: string; email: string };
  oldSlots: AssignedSlot[];
  newSlots: AssignedSlot[];
  reason: 'alumno' | 'profesor' | 'reorg';
  // Datos del alumno arrastrados desde la assignment, para el aviso por email al
  // nuevo profesor (Resend) — mismo contenido que una asignación nueva.
  plan?: string | null;
  level?: string | null;
  startDate?: string | null;
}

// Transfiere un alumno de un profesor a otro (punto 1). Libera las celdas del
// profesor anterior, ocupa las del nuevo, reapunta la assignment (mantiene
// student_id/start_date), registra el evento de scoring según el motivo y notifica
// a ambos profesores. Recalcula el score de ambos.
export async function dbChangeStudentTeacher(p: ChangeTeacherParams): Promise<void> {
  // 1) Liberar celdas del profesor ANTERIOR (por slots exactos o por nombre).
  const oldGrid = await dbGetTeacherGrid(p.from.id);
  const updatedOld: Grid = { ...oldGrid };
  const oldKeys = new Set(p.oldSlots.map(s => `${s.day}_${s.hour}`));
  let cleared = 0;
  for (const key of Object.keys(updatedOld)) {
    const cell = updatedOld[key];
    // Se mira el alumno RECURRENTE: una celda con una recuperación encima sigue
    // siendo el horario fijo del alumno que se transfiere, y hay que liberarla.
    const recurring = baseStudentOf(cell);
    if (!recurring) continue;
    if (oldKeys.has(key) || _cellIsStudent(recurring, p.studentName)) {
      updatedOld[key] = withBaseState(cell, 'libre');
      cleared++;
    }
  }
  if (cleared > 0) await dbSaveTeacherGrid(p.from.id, updatedOld);

  // 2) Ocupar celdas del profesor NUEVO con el nombre del alumno.
  const newGrid = await dbGetTeacherGrid(p.to.id);
  const updatedNew: Grid = { ...newGrid };
  for (const s of p.newSlots) {
    const key = `${s.day}_${s.hour}`;
    updatedNew[key] = withBaseState(updatedNew[key], 'ocupado', p.studentName);
  }
  await dbSaveTeacherGrid(p.to.id, updatedNew);

  // 3) Reapuntar la assignment al nuevo profesor + nuevos horarios.
  //    Se reinicia el email de presentación: created_at = ahora (el contador de
  //    24 h se ancla en created_at, ver getPresentationEmailStatus) y se borra el
  //    estado de enviado, para que el NUEVO profesor tenga sus 24 h completas para
  //    presentarse sin penalización de scoring.
  await supabase.from('assignments').update({
    teacher_id:   p.to.id,
    teacher_name: p.to.name,
    teacher_email: p.to.email,
    slots:        p.newSlots,
    weekly_hours: p.weeklyHours,
    availability: p.newSlots.map(s => `${s.day} ${s.hour}`).join(', '),
    presentation_email_sent:    false,
    presentation_email_sent_at: null,
    created_at:                 new Date().toISOString(),
  }).eq('id', p.assignmentId);

  // 4) Evento de scoring para el profesor anterior según el motivo del cambio.
  if (p.reason !== 'reorg') {
    const eventType = p.reason === 'alumno' ? 'cambio_por_alumno' : 'cambio_por_profesor';
    await dbAddScoringEvent({
      teacherId:   p.from.id,
      teacherName: p.from.name,
      eventType:   eventType as ScoringEvent['eventType'],
      points:      EVENT_POINTS[eventType],
      euros:       0,
      note:        `Cambio de profesor — ${p.studentName} transferido a ${p.to.name}`,
      createdBy:   'sistema',
      studentRef:  p.studentName,
    });
  }

  // 5) Notificar al profesor NUEVO (misma notificación + email Resend que una
  //    asignación nueva), con los datos del alumno y los horarios recién asignados.
  await dbNotifyNewAssignment(p.to.id, p.studentName, p.studentEmail, {
    plan: p.plan, level: p.level, slots: p.newSlots, startDate: p.startDate,
  });

  // 6) Notificar al profesor ANTERIOR.
  await supabase.from('notifications').insert({
    id:          `notif_transfer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    target_user: p.from.id,
    target_role: null,
    title:       'ℹ️ Alumno transferido',
    body:        `${p.studentName} fue transferido a otro profesor.`,
    type:        'student_transferred',
    read_by:     [],
    created_at:  new Date().toISOString(),
    created_by:  'sistema',
  });

  // Recalcular el score/retención de ambos (el anterior perdió, el nuevo ganó).
  await Promise.all([dbRecalculateTeacherScore(p.from.id), dbRecalculateTeacherScore(p.to.id)]);
}

// Elimina una assignment y libera las celdas del alumno en el grid del profesor.
// Usado por la resolución de duplicados (punto 4: "Mantener solo con X").
export async function dbRemoveAssignment(
  assignmentId: string, teacherId: string, studentName: string, slots: AssignedSlot[],
): Promise<void> {
  await supabase.from('assignments').delete().eq('id', assignmentId);
  const grid = await dbGetTeacherGrid(teacherId);
  const updated: Grid = { ...grid };
  const keys = new Set(slots.map(s => `${s.day}_${s.hour}`));
  let changed = false;
  for (const key of Object.keys(updated)) {
    const cell = updated[key];
    if (cell.state !== 'ocupado') continue;
    if (keys.has(key) || _cellIsStudent(cell.student, studentName)) {
      updated[key] = { state: 'libre', student: undefined };
      changed = true;
    }
  }
  if (changed) await dbSaveTeacherGrid(teacherId, updated);
  await dbRecalculateTeacherScore(teacherId);
}

export interface DuplicateAssignmentGroup {
  key: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  assignments: Array<{ assignmentId: string; teacherId: string; teacherName: string; slots: AssignedSlot[]; startDate?: string }>;
}

// Detecta alumnos asignados a MÁS DE UN profesor (punto 4). Función pura: opera
// sobre las assignments ya cargadas en memoria (sin llamadas a la base).
export function findDuplicateTeacherAssignments(assignments: Assignment[]): DuplicateAssignmentGroup[] {
  const groups = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const key = a.studentId || _nk(a.studentEmail) || _nk(a.studentName);
    if (!key) continue;
    const arr = groups.get(key);
    if (arr) arr.push(a); else groups.set(key, [a]);
  }
  const out: DuplicateAssignmentGroup[] = [];
  for (const [key, arr] of groups) {
    const teacherIds = new Set(arr.map(a => a.teacherId));
    if (teacherIds.size > 1) {
      out.push({
        key,
        studentId:    arr[0].studentId,
        studentName:  arr[0].studentName,
        studentEmail: arr[0].studentEmail,
        assignments:  arr.map(a => ({ assignmentId: a.id, teacherId: a.teacherId, teacherName: a.teacherName, slots: a.slots, startDate: a.startDate })),
      });
    }
  }
  return out;
}

// ── FINANCE: APROBACIONES MANUALES ────────────────────────────────────────────

function mapManualApproval(row: any): import('@/types').FinanceManualApproval {
  return {
    id:          row.id,
    teacherId:   row.teacher_id,
    studentName: row.student_name,
    classDate:   row.class_date,
    approvedBy:  row.approved_by,
    approvedAt:  row.approved_at,
    reason:      row.reason ?? undefined,
  };
}

export async function dbGetManualApprovals(): Promise<import('@/types').FinanceManualApproval[]> {
  const { data, error } = await supabase.from('finance_manual_approvals').select('*');
  if (error || !data) return [];
  return (data as any[]).map(mapManualApproval);
}

// Aprueba manualmente una clase puntual (a_revisar o excede_limite → pagable).
export async function dbAddManualApproval(
  teacherId: string, studentName: string, classDate: string, approvedBy: string, reason: string,
): Promise<import('@/types').FinanceManualApproval> {
  const id        = `fma_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const approvedAt = new Date().toISOString();
  await supabase.from('finance_manual_approvals').insert({
    id,
    teacher_id:   teacherId,
    student_name: studentName,
    class_date:   classDate,
    approved_by:  approvedBy,
    approved_at:  approvedAt,
    reason,
  });
  return { id, teacherId, studentName, classDate, approvedBy, approvedAt, reason };
}

// Adjunta una captura a una clase puntual (fecha+alumno). Si ya existe un
// class_records para esa fecha lo actualiza; si no, crea uno nuevo (caso típico
// cuando el origen fue solo un class_join_logs).
export async function dbAttachScreenshotToClass(
  teacherId: string, teacherName: string, studentName: string,
  date: string, classTime: string | undefined, screenshotUrl: string, comment?: string,
): Promise<import('@/types').ClassRecord> {
  const { data: existing } = await supabase
    .from('class_records')
    .select('*')
    .eq('teacher_id', teacherId)
    .eq('student_name', studentName)
    .eq('class_date', date)
    .limit(1)
    .maybeSingle();

  if (existing) {
    const newComment = comment ?? existing.comment ?? null;
    await supabase.from('class_records')
      .update({ screenshot_url: screenshotUrl, comment: newComment })
      .eq('id', existing.id);
    return mapClassRecord({ ...existing, screenshot_url: screenshotUrl, comment: newComment });
  }

  const id        = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = new Date().toISOString();
  await supabase.from('class_records').insert({
    id,
    teacher_id:     teacherId,
    teacher_name:   teacherName,
    student_name:   studentName,
    class_date:     date,
    class_time:     classTime ?? null,
    screenshot_url: screenshotUrl,
    comment:        comment ?? null,
    created_at:     createdAt,
  });
  return { id, teacherId, teacherName, studentName, classDate: date, classTime, screenshotUrl, comment, createdAt };
}

// ── FINANCE: RATES ────────────────────────────────────────────────────────────

export async function dbGetFinanceRates(): Promise<import('@/types').FinanceRate[]> {
  const { data, error } = await supabase.from('finance_rates').select('*');
  if (error || !data) return [];
  return (data as any[]).map(row => ({
    id:       row.id,
    planType: row.plan_type,
    tier:     row.tier,
    rate:     Number(row.rate),
  }));
}

// ── FINANCE: PAYMENTS ─────────────────────────────────────────────────────────

function mapFinancePayment(row: any): import('@/types').FinancePayment {
  return {
    id:                  row.id,
    teacherId:           row.teacher_id,
    teacherName:         row.teacher_name,
    monthYear:           row.month_year,
    totalClassesPayable: row.total_classes_payable ?? 0,
    totalAmount:         Number(row.total_amount ?? 0),
    bonusAmount:         Number(row.bonus_amount ?? 0),
    status:              row.status ?? 'pending',
    paidAt:              row.paid_at ?? undefined,
    approvedOverrides:   row.approved_overrides ?? [],
  };
}

export async function dbGetFinancePayments(): Promise<import('@/types').FinancePayment[]> {
  const { data, error } = await supabase.from('finance_payments').select('*');
  if (error || !data) return [];
  return (data as any[]).map(mapFinancePayment);
}

const financePaymentId = (teacherId: string, monthYear: string) => `fp_${teacherId}_${monthYear}`;

// Upsert de aprobaciones manuales (mantiene status/paid_at existentes).
export async function dbSetFinanceOverrides(
  teacherId: string, teacherName: string, monthYear: string, overrides: string[],
): Promise<import('@/types').FinancePayment> {
  const id = financePaymentId(teacherId, monthYear);
  await supabase.from('finance_payments').upsert({
    id,
    teacher_id:        teacherId,
    teacher_name:      teacherName,
    month_year:        monthYear,
    approved_overrides: overrides,
  }, { onConflict: 'id' });
  const { data } = await supabase.from('finance_payments').select('*').eq('id', id).single();
  return mapFinancePayment(data);
}

// Marca el mes como pagado, congelando los totales calculados.
export async function dbMarkPaymentPaid(
  teacherId: string, teacherName: string, monthYear: string,
  totals: { totalClassesPayable: number; totalAmount: number; bonusAmount: number },
): Promise<import('@/types').FinancePayment> {
  const id     = financePaymentId(teacherId, monthYear);
  const paidAt = new Date().toISOString();
  await supabase.from('finance_payments').upsert({
    id,
    teacher_id:            teacherId,
    teacher_name:          teacherName,
    month_year:            monthYear,
    total_classes_payable: totals.totalClassesPayable,
    total_amount:          totals.totalAmount,
    bonus_amount:          totals.bonusAmount,
    status:                'paid',
    paid_at:               paidAt,
  }, { onConflict: 'id' });
  const { data } = await supabase.from('finance_payments').select('*').eq('id', id).single();
  return mapFinancePayment(data);
}
