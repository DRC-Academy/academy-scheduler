import { supabase } from './supabase';
import { triggerEmail } from './emailClient';
import { baseStateOf, baseStudentOf, withBaseState, assignableCellKeys, puntualCellDates } from './cells';
import { minutesLateSpain } from './spainTime';
import { fetchOpenAlertState } from './interventionsClient';
import { findContiguityMismatches, type ContiguityMismatch } from './teacherClasses';
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

export async function dbSaveTeacherGrid(teacherId: string, grid: Grid): Promise<StudentLeftGrid[]> {
  // El grid ANTERIOR se lee antes de pisarlo: hace falta para saber qué alumno
  // se quedó sin celdas en ESTE guardado (ver reconcileAssignmentStatus).
  const previous = await dbGetTeacherGrid(teacherId);

  const { error } = await supabase
    .from('teacher_calendars')
    .upsert({
      teacher_id: teacherId,
      grid:       grid,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'teacher_id' });

  // El error se registra pero NO se lanza: el autoguardado del calendario llama
  // a esta función en cada clic y romper ahí dejaría al profesor sin poder tocar
  // su grid. Para las operaciones donde un fallo silencioso deja el sistema
  // inconsistente (transferencias) está saveTeacherGridOrThrow.
  if (error) console.error(`[db] No se pudo guardar el grid de ${teacherId}:`, error);

  return reconcileAssignmentStatus(teacherId, previous, grid);
}

/**
 * Igual que dbSaveTeacherGrid pero LANZA si la escritura falla.
 *
 * Existe porque el upsert de arriba se traga el error: en una transferencia eso
 * significa que el calendario de un profesor puede no haberse guardado y el
 * resto de la operación sigue como si nada, dejando el estado partido (que es
 * exactamente lo que pasó con Izaro Gaztañaga en julio de 2026).
 */
async function saveTeacherGridOrThrow(teacherId: string, grid: Grid): Promise<void> {
  const previous = await dbGetTeacherGrid(teacherId);

  const { error } = await supabase
    .from('teacher_calendars')
    .upsert({
      teacher_id: teacherId,
      grid:       grid,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'teacher_id' });

  if (error) throw new Error(`No se pudo guardar el calendario de ${teacherId}: ${error.message}`);

  await reconcileAssignmentStatus(teacherId, previous, grid);
}

/**
 * Marca inactivos los assignments cuyo alumno acaba de perder su ÚLTIMA celda, y
 * reactiva los de quien vuelve a tener alguna. Nunca borra: el histórico de
 * clases contadas se conserva.
 *
 * Se compara ANTES vs DESPUÉS a propósito, en vez de desactivar todo lo que no
 * esté en el grid. Un barrido general marcaría inactivos de golpe a los
 * assignments que ya estaban huérfanos de antes (hoy son 22, y 14 son alumnos
 * reales cuyo profesor nunca pintó las celdas). Esto solo reacciona al cambio
 * real: "se liberó la última celda de X".
 *
 * Best-effort: si la columna `status` no está migrada, se avisa y el guardado
 * del calendario sigue su curso.
 */
const DAY_ORDER_SLOTS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Clave estable de un horario, para comparar dos listas de slots sin ruido de orden. */
function slotsKey(slots: AssignedSlot[]): string {
  return [...slots]
    .map(s => `${DAY_ORDER_SLOTS.indexOf(s.day)}|${String(parseInt(s.hour, 10)).padStart(2, '0')}`)
    .sort()
    .join(',');
}

/** Slots ordenados (día, hora) tal como se guardan en la ficha. */
function sortSlots(slots: AssignedSlot[]): AssignedSlot[] {
  return [...slots].sort((a, b) =>
    DAY_ORDER_SLOTS.indexOf(a.day) - DAY_ORDER_SLOTS.indexOf(b.day) ||
    parseInt(a.hour, 10) - parseInt(b.hour, 10));
}

/**
 * EL CALENDARIO MANDA: copia a la ficha del alumno el horario que dice el grid.
 *
 * El calendario es la prueba real de qué clases existen — si el profesor y el
 * alumno acuerdan otro horario, se refleja ahí — así que `assignments.slots` es
 * un espejo suyo, no una segunda opinión. De `slots` salen la agenda del
 * profesor, las asistencias y, sobre todo, la DURACIÓN de la clase: dos horas
 * seguidas en el grid son una sesión de 2h que se paga doble. Mientras las dos
 * fuentes pudieron discrepar, hubo alumnos cobrando 2 horas con una sola celda
 * ocupada en el calendario.
 *
 * Solo toca a los alumnos que están EN el grid: al que se quedó sin celdas lo
 * gestiona el cambio de `status` (su horario se conserva como histórico). Y solo
 * escribe cuando el horario cambió de verdad, porque esto corre en cada
 * autoguardado del calendario.
 */
async function syncSlotsFromGrid(teacherId: string, grid: Grid, onlyStudent?: string): Promise<number> {
  const enGrid = groupCellsByStudent(extractOcupadoCells(grid));
  if (enGrid.size === 0) return 0;

  const assignments = await dbGetAssignmentsByTeacher(teacherId);
  const objetivo = onlyStudent ? normKey(onlyStudent) : null;
  let actualizados = 0;

  for (const a of assignments) {
    if (objetivo && normKey(a.studentName) !== objetivo) continue;
    const desdeGrid = enGrid.get(normKey(a.studentName));
    if (!desdeGrid) continue;                                   // no está en el grid → lo ve el status
    if (slotsKey(desdeGrid.slots) === slotsKey(a.slots ?? [])) continue;   // ya coinciden

    const slots = sortSlots(desdeGrid.slots);
    const { error } = await supabase.from('assignments').update({
      slots,
      weekly_hours: slots.length,
      availability: slots.map(s => `${s.day} ${s.hour}`).join(', '),
    }).eq('id', a.id);

    if (error) {
      console.error(`[db] No se pudo sincronizar el horario de ${a.studentName} desde el calendario:`, error);
      continue;
    }
    actualizados++;
    console.log(
      `[db] ${a.studentName}: horario actualizado desde el calendario ` +
      `(${(a.slots ?? []).length}h → ${slots.length}h).`,
    );
  }
  return actualizados;
}

/**
 * Pone la ficha al día con el calendario, a mano. Lo usa la auditoría para los
 * desajustes que ya existían antes de que el guardado del grid los reconciliara
 * solo: esos no se corrigen hasta que alguien vuelve a tocar ese calendario.
 *
 * Sin `studentName` sincroniza a todos los alumnos de ese profesor.
 */
export async function dbSyncSlotsFromCalendar(teacherId: string, studentName?: string): Promise<number> {
  const grid = await dbGetTeacherGrid(teacherId);
  return syncSlotsFromGrid(teacherId, grid, studentName);
}

/** Alumno que acaba de quedarse SIN ninguna celda en el calendario del profesor. */
export interface StudentLeftGrid {
  assignmentId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
}

async function reconcileAssignmentStatus(
  teacherId: string, before: Grid, after: Grid,
): Promise<StudentLeftGrid[]> {
  const namesOf = (g: Grid) => new Set(extractOcupadoCells(g).map(c => normKey(c.student)));
  const antes   = namesOf(before);
  const despues = namesOf(after);

  const liberados = [...antes].filter(n => !despues.has(n));     // perdió su última celda
  const recuperados = [...despues].filter(n => !antes.has(n));   // volvió al grid

  // El horario de los que SIGUEN en el grid también se reconcilia: ver
  // syncSlotsFromGrid. Antes solo se miraba el alta/baja completa, así que un
  // alumno que pasaba de dos horas seguidas a una conservaba las dos en su ficha
  // para siempre — y la agenda y finanzas seguían tratándolo como clase de 2h.
  await syncSlotsFromGrid(teacherId, after);

  if (liberados.length === 0 && recuperados.length === 0) return [];

  const assignments = await dbGetAssignmentsByTeacher(teacherId);
  const idsOf = (names: string[]) => {
    const set = new Set(names);
    return assignments.filter(a => set.has(normKey(a.studentName))).map(a => a.id);
  };

  const cambios: Array<{ ids: string[]; status: string }> = [
    { ids: idsOf(liberados),   status: 'inactive' },
    { ids: idsOf(recuperados), status: 'active'   },
  ].filter(c => c.ids.length > 0);

  for (const { ids, status } of cambios) {
    const { error } = await supabase.from('assignments').update({ status }).in('id', ids);
    if (error) {
      if (error.code === '42703' || error.code === 'PGRST204') {
        console.warn(
          '[db] La columna assignments.status no existe todavía. ' +
          'Corré supabase-assignment-status.sql para que el calendario pueda retirar alumnos sin borrarlos.',
        );
        break;   // sin columna no hay status que reconciliar; el resto sigue igual
      }
      console.error('[db] No se pudo actualizar el status de los assignments:', error);
      break;
    }
    console.log(`[db] ${ids.length} assignment(s) de ${teacherId} marcados '${status}'.`);
  }

  // Quiénes se quedaron sin horario. El llamador decide qué hacer con ellos: si
  // su suscripción está CANCELADA se eliminan del sistema, y si no, siguen
  // asignados al profesor como "actualmente sin tomar clases". Esa decisión NO se
  // toma acá: necesita consultar WooCommerce y, cuando implica borrar, que una
  // persona lo confirme.
  const salidos = new Set(liberados);
  return assignments
    .filter(a => salidos.has(normKey(a.studentName)))
    .map(a => ({
      assignmentId: a.id,
      studentId:    a.studentId,
      studentName:  a.studentName,
      studentEmail: a.studentEmail,
    }));
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
    status:                  row.status ?? undefined,
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

// ── FUENTE ÚNICA DE VERDAD: alumnos de un profesor ───────────────────────────
//
// REGLA: un alumno pertenece a un profesor SI Y SOLO SI tiene al menos una celda
// 'ocupado' RECURRENTE en el grid de teacher_calendars de ese profesor.
// `assignments` guarda METADATOS (start_date, weeklyHours, meetLink, contador),
// nunca define la pertenencia por sí sola.
//
// Dos detalles que hay que respetar y no son obvios:
//
//   1. El grid identifica al alumno por NOMBRE, no por id: `Cell.student` es un
//      string. No hay student_id en las celdas, así que el cruce con students y
//      assignments es por nombre normalizado, igual que el resto de lib/db.ts.
//
//   2. Se lee con `baseStudentOf` (lib/cells.ts), no con `cell.student`: una
//      recuperación puntual ('bloqueado'/'reprogramada') tapa la celda esa
//      semana y deja al alumno fijo en `baseStudent`. Mirando `cell.state` crudo,
//      un alumno con una recuperación esta semana desaparecería de su profesor.

export interface TeacherStudent {
  /** Nombre tal como está escrito en el grid: la fuente de verdad. */
  studentName: string;
  /** Horario recurrente REAL, derivado de las celdas (no de assignment.slots). */
  slots: AssignedSlot[];
  /** Ficha en `students`, si el nombre matchea. Null si el alumno no existe ahí. */
  student: Student | null;
  /** Metadatos. Null si el alumno está en el grid pero no tiene assignment. */
  assignment: Assignment | null;
  /**
   * `false` = sigue asignado al profesor pero NO tiene horario en el calendario:
   * "actualmente sin tomar clases". Antes estos alumnos desaparecían de la lista
   * sin más, así que el profesor perdía de vista a alguien que seguía siendo suyo.
   */
  activo: boolean;
}

/**
 * Alumnos de un profesor: los que tienen celdas en el grid (`activo: true`) y los
 * que conservan su assignment pero se quedaron sin horario (`activo: false`).
 */
export async function getStudentsForTeacher(teacherId: string): Promise<TeacherStudent[]> {
  const [grid, assignments, students] = await Promise.all([
    dbGetTeacherGrid(teacherId),
    dbGetAssignmentsByTeacher(teacherId),
    dbGetStudents(),
  ]);

  const studentsByName = new Map(students.map(s => [normKey(s.name), s]));
  const asgByName = new Map<string, Assignment>();
  for (const a of assignments) {
    // Con assignments duplicados para el mismo alumno gana el más reciente
    // (dbGetAssignmentsByTeacher ya ordena por created_at desc).
    const k = normKey(a.studentName);
    if (!asgByName.has(k)) asgByName.set(k, a);
  }

  const out: TeacherStudent[] = [];
  const enGrid = new Set<string>();
  for (const { name, slots } of groupCellsByStudent(extractOcupadoCells(grid)).values()) {
    const k = normKey(name);
    enGrid.add(k);
    out.push({
      studentName: name,
      slots,
      student:     studentsByName.get(k) ?? null,
      assignment:  asgByName.get(k) ?? null,
      activo:      true,
    });
  }

  // Asignados SIN horario: siguen siendo alumnos del profesor, pero ahora mismo
  // no toman clases. Se muestran al final, sin slots, para que no desaparezcan de
  // su vista mientras se resuelve si vuelven o se dan de baja.
  for (const a of asgByName.values()) {
    const k = normKey(a.studentName);
    if (enGrid.has(k)) continue;
    out.push({
      studentName: a.studentName,
      slots:       [],
      student:     studentsByName.get(k) ?? null,
      assignment:  a,
      activo:      false,
    });
  }

  return out.sort((a, b) =>
    Number(b.activo) - Number(a.activo) ||
    a.studentName.localeCompare(b.studentName, 'es'));
}

/**
 * Lo mismo que `getStudentsForTeacher`, pero en forma de `Assignment[]`, que es
 * lo que consumen los listados. ESTA es la función que deben usar Asistencias,
 * Próximas clases y Mis alumnos: ninguna de las tres puede filtrar `assignments`
 * por teacherId por su cuenta.
 *
 * `slots` sale SIEMPRE del grid, no de assignment.slots. Las dos fuentes estaban
 * desincronizadas en 26 alumnos y la de assignments hacía que se mostraran horas
 * que no existen en el calendario del profesor.
 */
export async function getTeacherAssignments(teacher: Teacher): Promise<Assignment[]> {
  const rows = await getStudentsForTeacher(teacher.id);
  return rows.map(ts => ts.assignment
    ? { ...ts.assignment, slots: ts.slots }
    : assignmentFromGrid(teacher, ts));
}

/**
 * Alumno presente en el grid pero SIN fila en `assignments`. Se representa igual:
 * tiene celdas, así que pertenece al profesor y este tiene que verlo. Le faltarán
 * meet link, fecha de inicio y contador hasta que se le cree el vínculo.
 */
function assignmentFromGrid(teacher: Teacher, ts: TeacherStudent): Assignment {
  return {
    id:            `grid_${teacher.id}_${normKey(ts.studentName).replace(/\s+/g, '_')}`,
    teacherId:     teacher.id,
    teacherName:   teacher.name,
    teacherEmail:  teacher.email,
    studentId:     ts.student?.id ?? '',
    studentName:   ts.studentName,
    studentEmail:  ts.student?.email ?? '',
    studentLevel:  ts.student?.level ?? '',
    slots:         ts.slots,
    objetivo:      '',
    plan:          ts.student?.plan ?? '',
    weeklyHours:   ts.slots.length,
    availability:  ts.slots.map(s => `${s.day} ${s.hour}`).join(', '),
    notes:         '',
    createdAt:     ts.student?.createdAt ?? new Date().toISOString(),
    status:        'active',
  };
}

/**
 * Assignments del profesor que NO tienen ninguna celda en su grid. No se borran
 * ni se ocultan solos: esto alimenta el diagnóstico y la limpieza manual.
 * Equivale a `scripts/diagnose-orphan-assignments.mjs` para un solo profesor.
 */
export async function getOrphanAssignmentsForTeacher(teacherId: string): Promise<Assignment[]> {
  const [grid, assignments] = await Promise.all([
    dbGetTeacherGrid(teacherId),
    dbGetAssignmentsByTeacher(teacherId),
  ]);
  const inGrid = new Set(
    extractOcupadoCells(grid).map(c => normKey(c.student)),
  );
  return assignments.filter(a => !inGrid.has(normKey(a.studentName)));
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
  // F) Assignment que apunta a un profesor pero el alumno ocupa el calendario de
  //    OTRO. Es la firma de una transferencia que quedó a medias (caso Izaro).
  misplacedStudents: MisplacedStudent[];
  // G) Clases de 2h que solo ve UNA de las dos fuentes: el calendario dice horas
  //    contiguas y los slots no, o al revés. Se informa y no se toca: inventar la
  //    contigüidad que falta haría cobrar 2 por una clase de 1 hora.
  contiguityMismatches: ContiguityMismatch[];
}

/** Alumno cuya assignment y cuyo calendario dicen profesores distintos. */
export interface MisplacedStudent {
  assignmentId: string;
  studentName: string;
  /** Profesor al que apunta la assignment (el que se ve en "Alumnos"). */
  assignedTeacherId: string;
  assignedTeacherName: string;
  /** Profesor en cuyo calendario está de verdad. Si hay varios, el primero. */
  gridTeacherId: string;
  gridTeacherName: string;
  /** Los otros calendarios donde también aparece (raro, pero se informa). */
  otherGridTeachers: string[];
  /** Horarios que ocupa en el calendario de gridTeacher. Es la verdad a aplicar. */
  gridSlots: AssignedSlot[];
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

  const [misplacedStudents, contiguityMismatches] = await Promise.all([
    dbFindMisplacedStudents(assignments),
    dbFindContiguityMismatches(assignments),
  ]);

  return {
    studentsWithoutAssignment, orphanAssignments, nameMismatches,
    duplicateEmails, multipleAssignments, misplacedStudents, contiguityMismatches,
  };
}

/**
 * G — Alumnos cuya contigüidad NO coincide entre el calendario del profesor y los
 * slots de su assignment. Es lo que decide si una clase vale 1 o 2, así que una
 * discrepancia entre las dos fuentes hay que verla, no resolverla adivinando.
 */
export async function dbFindContiguityMismatches(known?: Assignment[]): Promise<ContiguityMismatch[]> {
  const [assignments, teachers, calendars] = await Promise.all([
    known ? Promise.resolve(known) : dbGetAssignments(),
    dbGetTeachers(),
    supabase.from('teacher_calendars').select('teacher_id, grid'),
  ]);
  if (calendars.error) {
    console.error('[db] No se pudieron leer los calendarios para la auditoría de 2h:', calendars.error);
    return [];
  }

  const out: ContiguityMismatch[] = [];
  for (const row of (calendars.data ?? []) as Array<{ teacher_id: string; grid: Grid }>) {
    const name = teachers.find(t => t.id === row.teacher_id)?.name ?? row.teacher_id;
    out.push(...findContiguityMismatches(row.grid ?? {}, assignments, { id: row.teacher_id, name }));
  }
  return out.sort((a, b) => a.teacherName.localeCompare(b.teacherName) || a.studentName.localeCompare(b.studentName));
}

/**
 * F — Alumnos cuya assignment apunta a un profesor pero que ocupan el calendario
 * de OTRO. Es la firma exacta de una transferencia interrumpida: el calendario
 * ya se movió y la ficha no, o al revés.
 *
 * La pertenencia la decide el GRID (misma regla que getStudentsForTeacher), así
 * que el calendario es la verdad y la assignment es lo que hay que corregir.
 * Un alumno SIN celdas en ningún calendario no cuenta acá: ese es el caso
 * "huérfano", que ya cubre scripts/diagnose-orphan-assignments.
 */
export async function dbFindMisplacedStudents(known?: Assignment[]): Promise<MisplacedStudent[]> {
  const [assignments, teachers, calendars] = await Promise.all([
    known ? Promise.resolve(known) : dbGetAssignments(),
    dbGetTeachers(),
    supabase.from('teacher_calendars').select('teacher_id, grid'),
  ]);
  if (calendars.error) {
    console.error('[db] No se pudieron leer los calendarios para la auditoría:', calendars.error);
    return [];
  }

  const teacherName = (id: string) => teachers.find(t => t.id === id)?.name ?? id;

  // alumno normalizado → profesor → horarios que ocupa en su grid
  const owners = new Map<string, Map<string, AssignedSlot[]>>();
  for (const row of (calendars.data ?? []) as Array<{ teacher_id: string; grid: Grid }>) {
    for (const [key, cell] of Object.entries(row.grid ?? {})) {
      const student = baseStudentOf(cell);
      if (!student) continue;
      const usc = key.lastIndexOf('_');
      if (usc < 0) continue;
      const slot: AssignedSlot = { day: key.slice(0, usc), hour: key.slice(usc + 1) };
      const k = normKey(student);
      if (!owners.has(k)) owners.set(k, new Map());
      const byTeacher = owners.get(k)!;
      if (!byTeacher.has(row.teacher_id)) byTeacher.set(row.teacher_id, []);
      byTeacher.get(row.teacher_id)!.push(slot);
    }
  }

  const out: MisplacedStudent[] = [];
  for (const a of assignments) {
    if ((a.status ?? 'active') !== 'active') continue;
    const byTeacher = owners.get(normKey(a.studentName));
    if (!byTeacher || byTeacher.size === 0) continue;   // sin celdas: es "huérfano", no "descolocado"
    if (byTeacher.has(a.teacherId)) continue;           // coincide: todo bien

    // Gana el calendario con más celdas suyas (el horario real del alumno).
    const ranked = [...byTeacher.entries()].sort((x, y) => y[1].length - x[1].length);
    const [gridTeacherId, gridSlots] = ranked[0];
    out.push({
      assignmentId: a.id,
      studentName: a.studentName,
      assignedTeacherId: a.teacherId,
      assignedTeacherName: a.teacherName || teacherName(a.teacherId),
      gridTeacherId,
      gridTeacherName: teacherName(gridTeacherId),
      otherGridTeachers: ranked.slice(1).map(([id]) => teacherName(id)),
      gridSlots: gridSlots.sort((x, y) => parseInt(x.hour) - parseInt(y.hour)),
    });
  }
  return out;
}

/**
 * Repara un alumno descolocado: reapunta su assignment al profesor en cuyo
 * calendario está de verdad, con los horarios que ocupa allí.
 *
 * NO toca ningún calendario a propósito. En el caso Izaro, el calendario del
 * profesor viejo ya no la tenía y sus horarios de esa hora eran de otra alumna:
 * "liberar las celdas del profesor anterior" habría borrado a esa otra alumna.
 * Si además quedaran celdas del alumno en el calendario viejo, la auditoría lo
 * vuelve a detectar en la siguiente pasada.
 */
export async function dbRepairMisplacedStudent(m: MisplacedStudent): Promise<void> {
  const teachers = await dbGetTeachers();
  const dest = teachers.find(t => t.id === m.gridTeacherId);
  if (!dest) throw new Error(`No existe el profesor ${m.gridTeacherId}`);

  const { error } = await supabase.from('assignments').update({
    teacher_id:    dest.id,
    teacher_name:  dest.name,
    teacher_email: dest.email,
    slots:         m.gridSlots,
    weekly_hours:  m.gridSlots.length,
    availability:  m.gridSlots.map(s => `${s.day} ${s.hour}`).join(', '),
  }).eq('id', m.assignmentId);

  if (error) throw new Error(`No se pudo reparar a ${m.studentName}: ${error.message}`);
  console.log(`[audit] ${m.studentName}: assignment reapuntada a ${dest.name} con ${m.gridSlots.length} horario(s)`);
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
    status:                  row.status ?? undefined,
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

/**
 * Pide al servidor la foto de churn de un alumno que se está dando de baja.
 * Nunca lanza: si falla, se pierde el ejemplo del dataset pero la baja sigue.
 *
 * Tope de 20 s para que el admin no se quede esperando. Si se agota, el endpoint
 * sigue corriendo en el servidor y normalmente acaba guardando la foto igual: se
 * pierde el aviso en consola, no el dato.
 */
async function captureChurnOnDropout(args: {
  studentId: string | null; studentName: string; teacherId: string | null;
  /** Solo para el aviso al admin si la baja llega con una alerta abierta. */
  teacherName?: string | null;
}): Promise<void> {
  try {
    const res = await fetch('/api/churn/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...args, trigger: 'manual_dropout', label: 'churned' }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (data?.captured) {
      console.log(`[dbDeleteStudent] Foto de churn guardada para "${args.studentName}" (riesgo ${data.combinedRisk}/100).`);
    } else {
      console.warn(`[dbDeleteStudent] No se pudo capturar la foto de churn de "${args.studentName}":`, data?.error ?? data?.reason ?? 'sin detalle');
    }
  } catch (e) {
    console.error('[dbDeleteStudent] Falló la captura de churn (la baja continúa):', e);
  }
}

/**
 * Copia de seguridad COMPLETA de un alumno, ANTES de eliminarlo de la
 * plataforma. Solo interviene en el borrado del ADMIN: la desvinculación del
 * profesor no borra nada, así que no genera backup.
 *
 * LANZA si el guardado falla. Es deliberado: sin backup no se borra. Perder la
 * ficha de un alumno que vuelve en tres meses no tiene arreglo, y el admin
 * prefiere un error a un borrado silencioso e irreversible.
 *
 * Requiere haber corrido supabase-student-backup.sql.
 */
export async function dbBackupStudentBeforeDelete(
  studentId: string, studentName: string, deletedBy?: string, alsoStudentIds: string[] = [],
): Promise<void> {
  const ids = [...new Set([studentId, ...alsoStudentIds].filter(Boolean))];

  // Se busca por id Y por nombre a propósito: hay fichas duplicadas y filas
  // huérfanas cuyo student_id no apunta a ninguna de las ids conocidas. En un
  // backup vale más de sobra que de menos.
  const [studentsRes, profilesRes, analysesRes, asgById, asgByName] = await Promise.all([
    supabase.from('students').select('*').in('id', ids),
    supabase.from('student_profiles').select('*').in('student_id', ids),
    supabase.from('class_analyses').select('*').in('student_id', ids),
    supabase.from('assignments').select('*').in('student_id', ids),
    supabase.from('assignments').select('*').eq('student_name', studentName),
  ]);

  // Los análisis huérfanos (student_id ya en null por una baja anterior) solo se
  // localizan por nombre. Se añaden sin duplicar.
  const analysesByName = await supabase.from('class_analyses').select('*').eq('student_name', studentName);
  const analyses = [...(analysesRes.data ?? [])];
  const vistos = new Set(analyses.map(r => r.id));
  for (const row of (analysesByName.data ?? [])) if (!vistos.has(row.id)) { analyses.push(row); vistos.add(row.id); }

  // Ficha por id o por nombre (student_profiles.id === student_id en el alta
  // normal, pero las fichas antiguas no siempre rellenaron student_id).
  const profiles = [...(profilesRes.data ?? [])];
  if (profiles.length === 0) {
    const porId = await supabase.from('student_profiles').select('*').in('id', ids);
    profiles.push(...(porId.data ?? []));
  }

  const assignments = [...(asgById.data ?? [])];
  const asgVistas = new Set(assignments.map(r => r.id));
  for (const row of (asgByName.data ?? [])) if (!asgVistas.has(row.id)) { assignments.push(row); asgVistas.add(row.id); }

  const principal = (studentsRes.data ?? []).find(r => r.id === studentId) ?? (studentsRes.data ?? [])[0] ?? null;

  // IDEMPOTENTE: un intento anterior pudo guardar el backup y fallar al borrar
  // (el DELETE de students lanza). Al reintentar NO se duplica la copia: se
  // reescribe la que ya había con los datos frescos. Solo se reutiliza una copia
  // sin restaurar; si el alumno fue restaurado y vuelve a borrarse, eso es una
  // baja NUEVA y merece su propia fila.
  const { data: previo } = await supabase
    .from('deleted_students_backup')
    .select('id')
    .eq('original_student_id', studentId)
    .not('restored', 'is', true)   // false O null (filas viejas sin el flag)
    .limit(1)
    .maybeSingle();

  const fila = {
    original_student_id: studentId,
    student_name:        studentName,
    student_email:       principal?.email ?? assignments[0]?.student_email ?? null,
    plan:                principal?.plan ?? assignments[0]?.plan ?? null,
    level:               principal?.level ?? assignments[0]?.student_level ?? null,
    // El registro COMPLETO, no un resumen: si hay que restaurarlo, el jsonb tiene
    // que bastar por sí solo. Si había fichas duplicadas se guardan todas.
    student_data:        (studentsRes.data ?? []).length > 1 ? studentsRes.data : (principal ?? null),
    profile_data:        profiles.length > 1 ? profiles : (profiles[0] ?? null),
    class_analyses_data: analyses,
    assignments_data:    assignments,
    deleted_by:          deletedBy ?? null,
    deleted_at:          new Date().toISOString(),
  };

  const { error } = previo
    ? await supabase.from('deleted_students_backup').update(fila).eq('id', previo.id)
    : await supabase.from('deleted_students_backup').insert({
        id: `delbak_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ...fila,
      });

  if (error) {
    if (error.code === '42P01') {
      throw new Error(
        'Falta la tabla deleted_students_backup: corré supabase-student-backup.sql antes de eliminar alumnos. ' +
        'No se ha borrado nada.',
      );
    }
    console.error('[dbBackupStudentBeforeDelete] No se pudo guardar el backup:', error);
    throw new Error(`No se pudo guardar la copia de seguridad de "${studentName}": ${error.message}. No se ha borrado nada.`);
  }

  console.log(
    `[dbBackupStudentBeforeDelete] Backup de "${studentName}" ${previo ? 'ACTUALIZADO (reintento, no se duplica)' : 'creado'}: ` +
    `${(studentsRes.data ?? []).length} ficha(s), ${profiles.length} perfil(es), ` +
    `${analyses.length} análisis de clase, ${assignments.length} asignación(es).`,
  );
}

/** Informe que devuelve la RPC `delete_student_cascade`. */
interface CascadeReport {
  ok: boolean;
  dry_run: boolean;
  student_name: string;
  ids: string[];
  assignment_ids: string[];
  repaired: Array<{ assignment: string; student_name: string; teacher: string; reapuntada_a: string }>;
  /** Referencias nulificadas, por `tabla.columna`. */
  cleared: Record<string, number>;
  deleted: Record<string, number>;
  /** Filas que SOBREVIVEN al borrado (finanzas), por tabla. */
  preserved: Record<string, number>;
}

/**
 * Borra la cadena entera de dependencias del alumno en UNA transacción de
 * Postgres (supabase-delete-student-cascade.sql).
 *
 * Antes esto eran doce llamadas sueltas desde el navegador, sin transacción: si
 * una fallaba a mitad, el alumno se quedaba sin assignments y con el grid del
 * profesor vaciado pero VIVO en `students` (el caso Diego Ruiz). Y fallaban
 * siempre por lo mismo: solo se soltaban las FK contra `students(id)`, nunca las
 * que cuelgan de `assignments(id)` — form_tokens.assignment_id primero,
 * level_test_sessions.assignment_id justo detrás.
 *
 * Con `dryRun` no escribe nada: devuelve el mismo informe con lo que haría, y
 * lanza igual si hay vínculos corruptos. Es el pre-flight.
 */
async function runDeleteCascade(ids: string[], studentName: string, dryRun: boolean): Promise<CascadeReport> {
  const { data, error } = await supabase.rpc('delete_student_cascade', {
    p_ids: ids, p_student_name: studentName, p_dry_run: dryRun,
  });

  if (error) {
    // PGRST202 / 42883: la función no existe todavía (migración sin correr).
    if (error.code === 'PGRST202' || error.code === '42883') {
      throw new Error(
        'Falta la función delete_student_cascade en Supabase: corré supabase-delete-student-cascade.sql ' +
        'antes de eliminar alumnos. No se ha borrado nada.',
      );
    }
    // Postgres ya revirtió la transacción entera: la base quedó como estaba.
    throw new Error(
      `No se pudo eliminar a "${studentName}": ${error.message}` +
      (dryRun ? '' : '\nNo se ha borrado nada: la transacción se revirtió entera.'),
    );
  }

  return data as CascadeReport;
}

/**
 * ELIMINACIÓN TOTAL de un alumno (acción del ADMIN, o del webhook de Woo).
 *
 * NO es lo que hace el profesor desde su calendario: allí el alumno solo se
 * desvincula del horario y sigue siendo suyo («Actualmente sin tomar clases»,
 * ver reconcileAssignmentStatus + getStudentsForTeacher). El profesor NO puede
 * llegar hasta acá.
 *
 * Orden. La regla es que NADA irreversible ocurra antes de que la transacción
 * confirme: hasta el 03/08/2026 el grid se vaciaba y la baja se registraba antes
 * del borrado, así que un fallo dejaba al alumno sin horario pero vivo.
 *   1. PRE-FLIGHT (RPC en ensayo): lista lo que se va a borrar y aborta si hay
 *      vínculos corruptos, sin haber tocado nada.
 *   2. BACKUP completo (idempotente). Si falla, no se borra nada.
 *   3. Lectura de lo que hace falta después (profesores, alerta abierta) y foto
 *      de churn: todo esto necesita al alumno VIVO.
 *   4. RPC `delete_student_cascade`: la cadena entera en una transacción —
 *      form_tokens/level_test_sessions (assignment_id) → class_analyses/
 *      form_tokens/level_test_sessions (student_id) → student_profiles →
 *      assignments → re-verificación → students. Todo o nada.
 *   5. Solo si la RPC confirmó: baja (student_dropouts), avisos y grid.
 *
 * FINANZAS INTACTAS: class_records, class_join_logs, scoring_events y
 * class_analyses se conservan enteros. Los análisis son el segundo factor de
 * verificación del pago (lib/finance.ts): borrarlos pasaría de 'pagable' a
 * 'a_revisar' las clases ya dadas del mes en curso. Finanzas empareja por
 * teacher_id + student_name, nunca por student_id, así que nulificarlo es
 * inocuo. El alumno desaparece igual de todas las vistas porque esas filas solo
 * se leen a través de su ficha, que ya no existe.
 *
 * `alsoStudentIds`: ids ADICIONALES del mismo alumno cuando está duplicado en
 * `students` (dos altas de la misma persona). Sin esto quedaba la fila huérfana
 * de la segunda alta, que es justo lo que provoca los duplicados de profesor.
 */
export async function dbDeleteStudent(
  studentId: string, studentName: string, createdBy?: string, alsoStudentIds: string[] = [],
): Promise<AffectedTeacher[]> {
  const firstName = studentName.split(' ')[0];

  // TODAS las fichas del alumno: la principal y las de las altas duplicadas.
  // Se calcula acá arriba porque manda en el pre-flight, en el borrado de
  // assignments y en la comprobación final: los tres tienen que mirar el MISMO
  // conjunto de ids o se quedan filas apuntando a una ficha que ya no está.
  const idsABorrar = [...new Set([studentId, ...alsoStudentIds].filter(Boolean))];

  // ANTES que nada, ni siquiera el backup: el ensayo recorre la cadena entera y
  // lanza con la base intacta si hay vínculos corruptos que no se pueden reparar
  // solos. También deja en consola TODO lo que se va a borrar.
  const plan = await runDeleteCascade(idsABorrar, studentName, true);
  console.log(
    `[dbDeleteStudent] Ensayo de "${studentName}": ` +
    `${plan.assignment_ids.length} assignment(s) a borrar, ` +
    `referencias a soltar ${JSON.stringify(plan.cleared)}, ` +
    `a borrar ${JSON.stringify(plan.deleted)}, ` +
    `se conservan ${JSON.stringify(plan.preserved)}.`,
  );

  // Después el backup, antes de tocar nada. Lanza si falla: sin copia no se borra.
  await dbBackupStudentBeforeDelete(studentId, studentName, createdBy, alsoStudentIds);

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

  // ¿Se va con una alerta de riesgo sin atender? Es CONTEXTO para el admin (no
  // penaliza a nadie) y va en la fila de la baja. Se LEE acá porque necesita al
  // alumno vivo, pero la baja se ESCRIBE después de que la transacción confirme.
  const alerta = teacherIds.size > 0
    ? await fetchOpenAlertState({ studentId, studentName }).catch(() => null)
    : null;

  // Foto de señales de churn ANTES de borrar: es el ejemplo POSITIVO etiquetado
  // que alimenta la predicción de bajas. En DRC las bajas son siempre manuales
  // (el admin ve "cancelado" en WooSubscriptions y borra al alumno), así que sin
  // esto el dataset se quedaba vacío: el webhook de Woo nunca se dispara.
  //
  // Va por endpoint porque la captura es de servidor (lee varias tablas y llama a
  // la IA) y esta función corre en el navegador. Best-effort: la baja NUNCA se
  // bloquea ni se retrasa de forma perceptible por esto.
  await captureChurnOnDropout({
    studentId,
    studentName,
    teacherId: [...teacherIds][0] ?? null,
    teacherName: affectedTeachers[0]?.name ?? null,
  });

  // ── EL BORRADO, en una sola transacción ────────────────────────────────────
  //
  // La cadena entera va acá dentro: form_tokens/level_test_sessions
  // (assignment_id) → class_analyses/form_tokens/level_test_sessions
  // (student_id) → student_profiles → assignments → re-verificación → students.
  // Si algo falla, Postgres revierte hasta el primer update y esta llamada lanza:
  // el alumno se queda exactamente como estaba, nunca a medias.
  //
  // FINANZAS INTACTAS: class_records y class_join_logs ni se tocan (no tienen
  // student_id, cruzan por student_name) y class_analyses se nulifica en vez de
  // borrarse — es el segundo factor de verificación del pago en lib/finance.ts.
  // Tampoco se tocan scoring_events ni notifications.
  const informe = await runDeleteCascade(idsABorrar, studentName, false);

  console.log(
    `[dbDeleteStudent] "${studentName}" eliminado en transacción: ` +
    `borrado ${JSON.stringify(informe.deleted)}, ` +
    `referencias soltadas ${JSON.stringify(informe.cleared)}, ` +
    `conservado para finanzas ${JSON.stringify(informe.preserved)}.`,
  );
  for (const rep of informe.repaired) {
    console.log(`[dbDeleteStudent] Vínculo reparado: "${rep.student_name}" · ${rep.teacher} → ficha ${rep.reapuntada_a}`);
  }

  // ── A PARTIR DE ACÁ, el alumno ya no existe ────────────────────────────────
  // Todo lo que sigue es rastro y limpieza visual. Va DESPUÉS a propósito: antes
  // se registraba la baja y se vaciaba el grid primero, así que cada intento
  // fallido dejaba al profesor sin horario y sumaba una baja duplicada (Virginia
  // Alfonso Villal acumuló 18 filas en student_dropouts, una por reintento).

  // Registrar la baja (churn): sin esto la retención no podría contarla.
  // `reason`: 'webhook' si lo dispara el sistema, 'manual' si lo hace un admin.
  // IDEMPOTENTE: si ya había una baja de este alumno con este profesor no se
  // vuelve a insertar, porque duplicarla le hunde la retención al profesor.
  if (teacherIds.size > 0) {
    const now = new Date().toISOString();
    const reason = createdBy === 'sistema' ? 'webhook' : 'manual';

    const { data: yaRegistradas } = await supabase
      .from('student_dropouts').select('teacher_id').in('student_id', idsABorrar);
    const yaTiene = new Set((yaRegistradas ?? []).map(r => r.teacher_id));

    const dropoutRows = [...teacherIds].filter(tid => !yaTiene.has(tid)).map((tid, i) => ({
      id:           `drop_${Date.now()}_${i}`,
      teacher_id:   tid,
      student_id:   studentId,
      student_name: studentName,
      start_date:   startByTeacher.get(tid) ?? null,
      dropped_at:   now,
      reason,
      created_by:   createdBy ?? null,
      had_open_alert:    alerta?.hasOpenAlert ?? false,
      unattended_alerts: alerta?.unattended ?? 0,
    }));

    if (dropoutRows.length > 0) {
      let { error: dropErr } = await supabase.from('student_dropouts').insert(dropoutRows);
      // Migración sin correr: la baja se registra igual, sin el marcador.
      if (dropErr && (dropErr.code === '42703' || dropErr.code === 'PGRST204')) {
        console.warn('[dbDeleteStudent] student_dropouts sin las columnas de alertas. Corré supabase-interventions.sql.');
        ({ error: dropErr } = await supabase.from('student_dropouts').insert(
          dropoutRows.map(({ had_open_alert, unattended_alerts, ...base }) => {
            void had_open_alert; void unattended_alerts;
            return base;
          }),
        ));
      }
      if (dropErr) console.error('[dbDeleteStudent] Error al registrar la baja (churn):', dropErr);
    }
    if (yaTiene.size > 0) {
      console.log(`[dbDeleteStudent] ${yaTiene.size} baja(s) de "${studentName}" ya estaban registradas: no se duplican.`);
    }
  }

  // Notificar a cada profesor afectado (manual o vía webhook).
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

  // Liberar las celdas del grid de cada profesor.
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

  if (idsABorrar.length > 1) {
    console.log(`[dbDeleteStudent] "${studentName}" tenía ${idsABorrar.length} fichas duplicadas: ${idsABorrar.join(', ')}`);
  }

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
  // Se carga SOLO a mano desde la auditoría de intervenciones (panel de admin).
  // El sistema nunca lo aplica automáticamente: una intervención sutil puede no
  // verse en el transcript, así que la decisión es humana.
  alerta_no_atendida:  -10,
};

// Importe en euros de cada tipo de evento. Los NEGATIVOS son penalizaciones y se
// restan del pago del mes (lib/finance.ts los suma aparte para mostrarlos en rojo).
export const EVENT_EUROS: Record<string, number> = {
  upsell:          20,
  bonus_retencion: 30,
  // Una falta injustificada resta 15 puntos de scoring Y 5 € del pago, igual que
  // la falta sin aviso registrada desde el calendario. Antes solo restaba puntos,
  // así que el admin la cargaba esperando ver el descuento en finanzas y no pasaba
  // nada.
  falta_injustificada: -5,
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

/**
 * Guarda un evento de scoring.
 *
 * LANZA si el INSERT falla. Antes se ignoraba el error y se devolvía el objeto
 * como si estuviera guardado: el contexto lo metía en el estado local y en
 * pantalla parecía aplicado hasta recargar. Con las columnas `student_ref` y
 * `quantity` sin migrar, PostgREST rechazaba TODOS los inserts (PGRST204) y no
 * se guardó ni un solo evento durante semanas sin que nadie lo notara.
 */
export async function dbAddScoringEvent(event: Omit<ScoringEvent, 'id' | 'createdAt'>): Promise<ScoringEvent> {
  const id        = `se_${Date.now()}`;
  const createdAt = new Date().toISOString();

  const row = {
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
  };

  let { error } = await supabase.from('scoring_events').insert(row);

  // Si faltan las columnas opcionales (migración sin correr), se reintenta sin
  // ellas para no perder el evento: mejor guardarlo sin el alumno que no
  // guardarlo. Se avisa por consola para que se corra supabase-scoring-columns.sql.
  if (error && (error.code === 'PGRST204' || error.code === '42703')) {
    console.warn('[dbAddScoringEvent] Faltan columnas en scoring_events (student_ref/quantity). Corré supabase-scoring-columns.sql. Se guarda sin ellas.');
    const { student_ref, quantity, ...base } = row;
    void student_ref; void quantity;
    ({ error } = await supabase.from('scoring_events').insert(base));
  }

  if (error) {
    console.error('[dbAddScoringEvent] No se pudo guardar el evento:', error);
    throw new Error(`No se pudo guardar el evento de scoring: ${error.message}`);
  }

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
  /** Importe de la penalización original (positivo). Por defecto 5 €. */
  amount?: number;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('scoring_events')
    .update({ reverted: true, reverted_by: p.adminName, reverted_at: now })
    .eq('id', p.penaltyId);
  if (error) throw new Error(error.message);

  // El compensatorio devuelve lo que se descontó, no un 5 fijo: ya hay
  // penalizaciones de tipos distintos y mañana puede haberlas de otro importe.
  const amount = Math.abs(p.amount ?? 5);
  await dbAddScoringEvent({
    teacherId: p.teacherId, teacherName: p.teacherName,
    eventType: 'penalizacion_revertida', points: 0, euros: amount,
    note: `Reversión de penalización del ${p.originalDate}${p.studentName ? ` (${p.studentName})` : ''}. Motivo: ${p.reason}`,
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

/**
 * Puntualidad tal como sale de la base, traducida a los tres valores que entiende
 * la aplicación.
 *
 * En `class_join_logs` hay filas antiguas con el valor en español ('a_tiempo'),
 * que ningún código actual escribe. Nadie las traducía, así que llegaban intactas
 * a las pantallas: el panel de admin busca el estilo por ese valor y, al no
 * encontrarlo, la pestaña "Registro de clases" entera dejaba de cargar por tres
 * filas de hace un mes.
 *
 * Un valor desconocido se toma como 'on_time' por el mismo criterio que
 * calcPunctuality cuando la fecha no es válida: ante la duda, no se penaliza.
 */
function normalizePunctuality(v: unknown): ClassJoinLog['punctuality'] {
  switch (String(v ?? '').trim().toLowerCase()) {
    case 'late':
    case 'tarde':      return 'late';
    case 'very_late':
    case 'muy_tarde':  return 'very_late';
    default:           return 'on_time';
  }
}

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
    punctuality:   normalizePunctuality(row.punctuality),
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
  // Se piden las columnas opcionales una a una y se van descartando si la base no
  // las tiene. El reintento anterior sólo quitaba `validation_status` y seguía
  // pidiendo `join_log_id`: cuando faltaban las DOS (migraciones sin correr) el
  // reintento fallaba igual, esta función devolvía [] y finanzas se quedaba sin el
  // segundo factor de verificación, con TODAS las clases marcadas "a revisar"
  // aunque tuvieran transcript.
  const BASE = 'teacher_id, student_name, class_date, analyzed_at, transcript';
  const OPCIONALES = ['join_log_id', 'validation_status'];

  for (let quitar = 0; quitar <= OPCIONALES.length; quitar++) {
    const cols = [BASE, ...OPCIONALES.slice(0, OPCIONALES.length - quitar)].join(', ');
    const { data, error } = await supabase
      .from('class_analyses')
      .select(cols)
      .order('analyzed_at', { ascending: false });

    if (!error && data) {
      if (quitar > 0) {
        console.warn(`[db] class_analyses sin las columnas [${OPCIONALES.slice(OPCIONALES.length - quitar).join(', ')}]. Faltan migraciones: supabase-join-log-link.sql / supabase-transcript-validation.sql.`);
      }
      return data as unknown as import('@/lib/finance').ClassTranscriptRef[];
    }
    if (error && error.code !== '42703' && error.code !== 'PGRST204') {
      console.error('[db] Error al leer class_analyses para finanzas:', error);
      return [];
    }
  }
  return [];
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

export interface FlaggedTranscriptsResult {
  rows: FlaggedTranscript[];
  /** true → falta la migración de validación: la pestaña no puede mostrar nada. */
  missingColumns: boolean;
}

// Transcripciones marcadas (en revisión o ya resueltas) para el panel del admin.
//
// Si las columnas de validación no están migradas se devuelve `missingColumns`
// en vez de una lista vacía a secas: antes la pestaña se veía vacía como si todo
// estuviera en orden, cuando en realidad la consulta fallaba con un 42703.
/** Cola de validación esperando al admin. Ver `dbCountPendingValidations`. */
export interface PendingValidationSummary {
  total: number;
  /** Fecha de la clase más antigua que sigue esperando ('YYYY-MM-DD'). */
  oldestDate: string | null;
  /** Días que lleva esperando esa clase. 0 si no hay cola. */
  oldestDays: number;
}

/**
 * Cuántas transcripciones esperan a que el admin las mire, y desde cuándo.
 *
 * Consulta LIGERA a propósito (no trae la columna `transcript`, que son decenas
 * de miles de caracteres por fila): la usa el badge de la pestaña, que se carga
 * en cada visita al panel. Mientras la cola no se veía desde fuera, llegó a
 * acumular 19 clases —la más vieja de 4 días— que no le contaban a nadie.
 */
export async function dbCountPendingValidations(): Promise<PendingValidationSummary> {
  const { data, error } = await supabase
    .from('class_analyses')
    .select('class_date, analyzed_at')
    .eq('validation_status', 'review');

  if (error || !data) {
    // Sin la columna (migración sin correr) no hay cola que mostrar: se calla.
    if (error && error.code !== '42703' && error.code !== 'PGRST204') {
      console.error('[db] No se pudo contar la cola de validación:', error);
    }
    return { total: 0, oldestDate: null, oldestDays: 0 };
  }

  const fechas = (data as Array<{ class_date: string | null; analyzed_at: string | null }>)
    .map(r => r.class_date || (r.analyzed_at ?? '').slice(0, 10))
    .filter(Boolean)
    .sort();
  const oldestDate = fechas[0] ?? null;
  const oldestDays = oldestDate
    ? Math.max(0, Math.round((Date.now() - new Date(oldestDate + 'T00:00:00').getTime()) / 86_400_000))
    : 0;
  return { total: data.length, oldestDate, oldestDays };
}

export async function dbGetFlaggedTranscripts(): Promise<FlaggedTranscriptsResult> {
  const { data, error } = await supabase
    .from('class_analyses')
    .select('id, teacher_id, student_name, class_date, analyzed_at, transcript, transcript_validation_score, transcript_validation_flags, ai_authenticity_check, validation_status, validation_reviewed_by, validation_reviewed_at')
    // 'auto_approved' entra para que el admin pueda AUDITARLAS, aunque no
    // requieran ninguna acción suya. 'ok' se queda fuera a propósito: son las
    // limpias de score < 80, que nunca pasaron por validación.
    .in('validation_status', ['review', 'approved', 'rejected', 'auto_approved'])
    .order('analyzed_at', { ascending: false });
  if (error || !data) {
    const missingColumns = error?.code === '42703' || error?.code === 'PGRST204';
    if (error && !missingColumns) {
      console.error('[db] Error al leer transcripciones marcadas:', error);
    } else if (missingColumns) {
      console.warn('[db] Faltan las columnas de validación en class_analyses. Corré supabase-transcript-validation.sql.');
    }
    return { rows: [], missingColumns };
  }
  const rows = (data as Array<Record<string, unknown>>).map(r => ({
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
  return { rows, missingColumns: false };
}

/**
 * Reabre una clase auto-aprobada: el admin vio algo que no le cuadra y la manda
 * a revisión manual. Es la única vía para sacar algo de 'auto_approved'.
 * OJO: al pasar a 'review' la clase DEJA de contar para el pago hasta que se
 * apruebe o rechace (lib/finance.ts), que es justamente lo que se busca.
 */
export async function dbReopenTranscript(analysisId: string, reviewerName: string): Promise<void> {
  const { error } = await supabase.from('class_analyses').update({
    validation_status:      'review',
    validation_reviewed_by: reviewerName,
    validation_reviewed_at: new Date().toISOString(),
  }).eq('id', analysisId);
  if (error) throw new Error(error.message);
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
  /** Días sin actividad (o desde el alta si nunca tuvo ninguna). */
  daysSinceLastClass: number | null;
  speakingTrend: string | null;
  aiReasoning: string | null;
  explicitQuit: boolean | null;
}

export interface ChurnOverview {
  churnedCount: number;        // ejemplos de baja recopilados (meta ~100)
  activeScannedCount: number;  // fotos de alumnos activos
  /** Alumnos ORDENADOS por riesgo (los `topN` primeros), no filtrados por umbral. */
  atRisk: ChurnRiskStudent[];
  /** Cuántos superan el umbral de aviso (los que de verdad son alerta). */
  aboveThreshold: number;
  /** Alumnos escaneados distintos (una foto por alumno, la última). */
  studentsScanned: number;
}

/**
 * Resumen para el panel del admin. Degradación limpia si la tabla no existe aún.
 *
 * Devuelve el TOP por riesgo en vez de filtrar por umbral: con la muestra actual
 * el riesgo máximo real es ~33 y un filtro en 55 dejaba la tabla siempre vacía,
 * así que el escaneo parecía no hacer nada. Viendo el top se puede calibrar el
 * umbral mirando datos en vez de a ojo.
 */
export async function dbGetChurnOverview(riskThreshold = 65, topN = 15): Promise<ChurnOverview> {
  const empty: ChurnOverview = {
    churnedCount: 0, activeScannedCount: 0, atRisk: [], aboveThreshold: 0, studentsScanned: 0,
  };
  try {
    const [churnedRes, activeRes, recentRes] = await Promise.all([
      supabase.from('churn_snapshots').select('id', { count: 'exact', head: true }).eq('label', 'churned'),
      supabase.from('churn_snapshots').select('id', { count: 'exact', head: true }).eq('label', 'active'),
      supabase.from('churn_snapshots')
        .select('id, student_name, teacher_id, captured_at, combined_risk, cancellations, late_count, days_since_last_class, speaking_trend, ai_reasoning, ai_explicit_quit')
        // Se queda con la ÚLTIMA foto de cada alumno, así que hay que traer varias
        // rondas de escaneo: con 177 alumnos, 300 filas se quedaban cortas a la
        // segunda pasada y los últimos alumnos desaparecían del resumen.
        .eq('label', 'active').order('captured_at', { ascending: false }).limit(2000),
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
        daysSinceLastClass: (r.days_since_last_class as number) ?? null,
        speakingTrend: (r.speaking_trend as string) ?? null,
        aiReasoning:   (r.ai_reasoning as string) ?? null,
        explicitQuit:  (r.ai_explicit_quit as boolean) ?? null,
      });
    }
    const ordenados = [...latest.values()]
      .sort((a, b) => (b.combinedRisk ?? 0) - (a.combinedRisk ?? 0));

    return {
      churnedCount: churnedRes.count ?? 0,
      activeScannedCount: activeRes.count ?? 0,
      atRisk: ordenados.slice(0, topN),
      aboveThreshold: ordenados.filter(s => (s.combinedRisk ?? 0) >= riskThreshold).length,
      studentsScanned: ordenados.length,
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

/**
 * Fallo de una transferencia, con el detalle de QUÉ alcanzó a hacerse.
 *
 * Sin esto el usuario solo veía "algo falló" y no había forma de saber si el
 * alumno quedó con el profesor viejo, con el nuevo, o a medio camino.
 */
export class TransferError extends Error {
  /** Pasos que SÍ se completaron, en orden. */
  readonly completed: string[];
  /** Paso que falló. */
  readonly failedStep: string;

  constructor(failedStep: string, completed: string[], cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Falló en "${failedStep}": ${detail}`);
    this.name = 'TransferError';
    this.failedStep = failedStep;
    this.completed = completed;
  }

  /** Mensaje listo para mostrarle al usuario, con el estado real del sistema. */
  get userMessage(): string {
    const hecho = this.completed.length
      ? `Lo que SÍ se hizo: ${this.completed.join('; ')}.`
      : 'No se llegó a modificar nada.';
    return `El cambio de profesor no se completó (falló en: ${this.failedStep}). ${hecho} `
         + 'Revisá "Auditoría de vínculos" en el panel de admin para completarlo.';
  }
}

/**
 * Transfiere un alumno de un profesor a otro (punto 1).
 *
 * ORDEN DE ESCRITURA — importa, y no es el orden "natural":
 *   1. Validar TODO antes de escribir nada.
 *   2. Ocupar las celdas del profesor NUEVO.
 *   3. Reapuntar la assignment  ← esta escritura es la que CONFIRMA el cambio.
 *   4. Liberar las celdas del profesor ANTERIOR.
 *   5. Scoring y notificaciones (best-effort: si fallan, el cambio ya está hecho).
 *
 * Antes se liberaba primero al profesor anterior y la assignment se actualizaba
 * en tercer lugar, sin comprobar el error de ninguna escritura. Si la assignment
 * fallaba, el alumno quedaba fuera del calendario viejo, dentro del nuevo, y
 * asignado al profesor viejo — sin ningún aviso. Eso es lo que le pasó a Izaro
 * Gaztañaga (julio 2026).
 *
 * Con el orden nuevo, un fallo antes del paso 3 deja el sistema COHERENTE: el
 * alumno sigue con su profesor de siempre y lo único que queda es una celda de
 * más en el calendario del profesor nuevo, que se ve y se corrige a mano.
 */
export async function dbChangeStudentTeacher(p: ChangeTeacherParams): Promise<void> {
  const completed: string[] = [];
  const log = (msg: string) => console.log(`[transfer ${p.studentName}] ${msg}`);

  // ── 1) Validaciones previas: nada se escribe hasta que todo esto pase ───────
  if (!p.newSlots.length) {
    throw new TransferError('validación', [], new Error('no se indicó ningún horario para el profesor nuevo'));
  }
  if (p.from.id === p.to.id) {
    throw new TransferError('validación', [], new Error('el profesor de origen y el de destino son el mismo'));
  }

  const [asgRow, newGrid, oldGrid] = await Promise.all([
    supabase.from('assignments').select('id').eq('id', p.assignmentId).maybeSingle(),
    dbGetTeacherGrid(p.to.id),
    dbGetTeacherGrid(p.from.id),
  ]);
  if (asgRow.error || !asgRow.data) {
    throw new TransferError('validación', [], new Error(`la assignment ${p.assignmentId} ya no existe`));
  }

  // Ninguna celda destino puede tener YA un alumno recurrente distinto: pisarla
  // borraría a ese alumno de su horario sin dejar rastro.
  const ocupadas = p.newSlots
    .map(s => ({ key: `${s.day}_${s.hour}`, owner: baseStudentOf(newGrid[`${s.day}_${s.hour}`]) }))
    .filter(x => x.owner && !_cellIsStudent(x.owner, p.studentName));
  if (ocupadas.length) {
    const detalle = ocupadas.map(x => `${x.key} (${x.owner})`).join(', ');
    throw new TransferError('validación', [], new Error(`${p.to.name} ya tiene alumno en ${detalle}`));
  }
  log('validaciones OK');

  // ── 2) Ocupar las celdas del profesor NUEVO ────────────────────────────────
  const updatedNew: Grid = { ...newGrid };
  for (const s of p.newSlots) {
    updatedNew[`${s.day}_${s.hour}`] = withBaseState(updatedNew[`${s.day}_${s.hour}`], 'ocupado', p.studentName);
  }
  try {
    await saveTeacherGridOrThrow(p.to.id, updatedNew);
    completed.push(`se ocuparon los horarios en el calendario de ${p.to.name}`);
    log(`calendario de ${p.to.name} ocupado`);
  } catch (err) {
    throw new TransferError(`ocupar el calendario de ${p.to.name}`, completed, err);
  }

  // ── 3) Reapuntar la assignment — ESTA es la que confirma el cambio ─────────
  //    Se reinicia el email de presentación: created_at = ahora (el contador de
  //    24 h se ancla en created_at, ver getPresentationEmailStatus) y se borra el
  //    estado de enviado, para que el NUEVO profesor tenga sus 24 h completas para
  //    presentarse sin penalización de scoring.
  const { error: asgError } = await supabase.from('assignments').update({
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
  if (asgError) {
    throw new TransferError('reapuntar la ficha del alumno al profesor nuevo', completed, asgError);
  }
  completed.push(`el alumno quedó asignado a ${p.to.name}`);
  log(`assignment reapuntada a ${p.to.name}`);

  // ── 4) Liberar las celdas del profesor ANTERIOR ────────────────────────────
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
  if (cleared > 0) {
    try {
      await saveTeacherGridOrThrow(p.from.id, updatedOld);
      completed.push(`se liberaron ${cleared} horario(s) de ${p.from.name}`);
      log(`calendario de ${p.from.name}: ${cleared} celda(s) liberadas`);
    } catch (err) {
      throw new TransferError(`liberar el calendario de ${p.from.name}`, completed, err);
    }
  }

  // ── 5) Scoring y notificaciones: BEST-EFFORT ───────────────────────────────
  // El cambio ya está hecho y es coherente. Un fallo acá no puede tirar abajo la
  // operación ni mostrarle un error al usuario: solo se registra para los logs.
  try {
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

    // Notificar al profesor NUEVO (misma notificación + email Resend que una
    // asignación nueva), con los datos del alumno y los horarios recién asignados.
    await dbNotifyNewAssignment(p.to.id, p.studentName, p.studentEmail, {
      plan: p.plan, level: p.level, slots: p.newSlots, startDate: p.startDate,
    });

    // Notificar al profesor ANTERIOR.
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
    log('scoring y notificaciones OK');
  } catch (err) {
    console.error(`[transfer ${p.studentName}] el cambio se completó, pero fallaron los avisos/scoring:`, err);
  }
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
  /** TODOS los student_id del grupo. Más de uno = el alumno está duplicado en `students`. */
  studentIds: string[];
  /** false = todas las assignments son del MISMO profesor (asignación duplicada). */
  variosProfesores: boolean;
  /** Emails distintos vistos en el grupo (evidencia para el admin). */
  emails: string[];
  assignments: Array<{ assignmentId: string; teacherId: string; teacherName: string; slots: AssignedSlot[]; startDate?: string }>;
}

/**
 * Detecta alumnos asignados a MÁS DE UN profesor. Función pura: opera sobre las
 * assignments ya cargadas en memoria.
 *
 * AGRUPA POR IDENTIDAD, no por una sola clave. La versión anterior usaba
 * `studentId || email || nombre`, la primera que hubiera, y eso se dejaba fuera
 * los duplicados de verdad: si el mismo alumno está dos veces en `students` con
 * ids distintos, cada assignment caía en un grupo diferente y no se detectaba
 * nada. Comprobado con datos reales (27/07/2026): detectaba 2 casos y había 3, y
 * de "Virginia Alfonso" mostraba 2 profesores cuando en realidad tenía 3.
 *
 * El email NO se usa para agrupar, solo como evidencia: hay alumnos que comparten
 * dirección (familia, o un dato mal metido) y agrupar por email juntaba a dos
 * personas distintas. Con un botón de "eliminar alumno" en ese panel, un falso
 * positivo así se paga caro.
 */
export function findDuplicateTeacherAssignments(assignments: Assignment[]): DuplicateAssignmentGroup[] {
  // Union-find sobre dos señales fuertes de identidad: mismo student_id o mismo
  // nombre normalizado.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string) => {
    parent.set(a, parent.get(a) ?? a);
    parent.set(b, parent.get(b) ?? b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const idOf   = (a: Assignment) => `id:${a.studentId}`;
  const nameOf = (a: Assignment) => `name:${_nk(a.studentName)}`;

  for (const a of assignments) {
    const señales = [a.studentId ? idOf(a) : '', _nk(a.studentName) ? nameOf(a) : ''].filter(Boolean);
    if (señales.length === 0) continue;
    señales.forEach(s => parent.set(s, parent.get(s) ?? s));
    if (señales.length === 2) union(señales[0], señales[1]);
  }

  const groups = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const señal = a.studentId ? idOf(a) : (_nk(a.studentName) ? nameOf(a) : '');
    if (!señal) continue;
    const root = find(señal);
    const arr = groups.get(root);
    if (arr) arr.push(a); else groups.set(root, [a]);
  }

  const out: DuplicateAssignmentGroup[] = [];
  for (const [key, arr] of groups) {
    // Se marca cuando hay VARIAS assignments, aunque sean del MISMO profesor:
    // "Marina de Castro" tenía dos idénticas con Daiana.M (mismo plan y mismos
    // slots, solo cambiaba start_date) y eso duplica la clase en finanzas igual
    // que tener dos profesores. Antes se exigía profesores distintos y no salía.
    if (arr.length <= 1) continue;
    out.push({
      key,
      studentId:    arr[0].studentId,
      studentName:  arr[0].studentName,
      studentEmail: arr[0].studentEmail,
      studentIds:   [...new Set(arr.map(a => a.studentId).filter(Boolean))],
      variosProfesores: new Set(arr.map(a => a.teacherId)).size > 1,
      emails:       [...new Set(arr.map(a => (a.studentEmail ?? '').trim()).filter(Boolean))],
      assignments:  arr.map(a => ({ assignmentId: a.id, teacherId: a.teacherId, teacherName: a.teacherName, slots: a.slots, startDate: a.startDate })),
    });
  }
  return out.sort((a, b) => b.assignments.length - a.assignments.length);
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
