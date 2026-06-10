import { supabase } from './supabase';
import { Teacher, Student, Assignment, AppUser, Grid, TeacherStatus, ScoringEvent } from '@/types';

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
  const cells = Object.values(grid);
  const freeSpots    = cells.filter(c => c.state === 'libre').length;
  const ocupadoSpots = cells.filter(c => c.state === 'ocupado').length;
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
      .filter(([, cell]) => cell.state === 'ocupado')
      .map(([key, cell]) => {
        const [day, time] = key.split('_');
        return { id: key, studentName: cell.student ?? '—', day, time, duration: 1, type: 'Clase' };
      });

    const liberDays: Record<string, number[]> = {};
    Object.entries(grid)
      .filter(([, cell]) => cell.state === 'libre')
      .forEach(([key]) => {
        const [day, hour] = key.split('_');
        if (!liberDays[day]) liberDays[day] = [];
        liberDays[day].push(parseInt(hour));
      });

    const timeSlots = Object.entries(liberDays).map(([day, hours]) => ({
      day,
      from: Math.min(...hours).toString().padStart(2, '0') + ':00',
      to:   (Math.max(...hours) + 1).toString().padStart(2, '0') + ':00',
      spots: hours.length,
      usedSpots: 0,
    }));

    return {
      id:                  row.id,
      name:                row.name,
      email:               row.email,
      avatar:              row.avatar,
      status,
      weeklyLoad,
      maxWeeklyLoad:       20,
      freeSpots,
      totalSpots:          freeSpots + ocupadoSpots,
      specialties:         row.specialties ?? ['Inglés'],
      timeSlots,
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

// ── STUDENTS ─────────────────────────────────────────────────────────────────

export async function dbGetStudents(): Promise<Student[]> {
  const { data, error } = await supabase
    .from('students')
    .select('*')
    .order('name');

  if (error || !data) return [];

  return data.map(row => ({
    id:         row.id,
    name:       row.name,
    email:      row.email,
    phone:      row.phone ?? undefined,
    level:      row.level,
    plan:       row.plan,
    notes:      row.notes ?? undefined,
    createdAt:  row.created_at,
  }));
}

export async function dbUpsertStudent(student: Student): Promise<void> {
  await supabase.from('students').upsert({
    id:         student.id,
    name:       student.name,
    email:      student.email,
    phone:      student.phone ?? null,
    level:      student.level,
    plan:       student.plan ?? 'Plan Individual',
    notes:      student.notes ?? null,
  }, { onConflict: 'email' });
}

// ── ASSIGNMENTS ───────────────────────────────────────────────────────────────

export async function dbGetAssignments(): Promise<Assignment[]> {
  const { data, error } = await supabase
    .from('assignments')
    .select('*')
    .order('created_at', { ascending: false });

  if (error || !data) return [];

  return data.map(row => ({
    id:            row.id,
    teacherId:     row.teacher_id,
    teacherName:   row.teacher_name,
    teacherEmail:  row.teacher_email,
    studentId:     row.student_id,
    studentName:   row.student_name,
    studentEmail:  row.student_email,
    studentLevel:  row.student_level,
    slots:         row.slots,
    objetivo:      row.objetivo ?? '',
    plan:          row.plan ?? '',
    weeklyHours:   row.weekly_hours,
    availability:  row.availability ?? '',
    notes:         row.notes ?? '',
    startDate:     row.start_date ?? undefined,
    createdAt:     row.created_at,
  }));
}

export async function dbAddAssignment(a: Assignment): Promise<void> {
  await supabase.from('assignments').insert({
    id:            a.id,
    teacher_id:    a.teacherId,
    teacher_name:  a.teacherName,
    teacher_email: a.teacherEmail,
    student_id:    a.studentId,
    student_name:  a.studentName,
    student_email: a.studentEmail,
    student_level: a.studentLevel,
    slots:         a.slots,
    objetivo:      a.objetivo,
    plan:          a.plan,
    weekly_hours:  a.weeklyHours,
    availability:  a.availability,
    notes:         a.notes,
    start_date:    a.startDate ?? null,
  });
}

export async function dbUpdateTeacherRating(teacherId: string, rating: number): Promise<void> {
  await supabase.from('teachers').update({ internal_rating: rating }).eq('id', teacherId);
}

export async function dbDeleteStudent(studentId: string, studentName: string): Promise<void> {
  const firstName = studentName.split(' ')[0];

  const [byId, byName] = await Promise.all([
    supabase.from('assignments').select('teacher_id').eq('student_id', studentId),
    supabase.from('assignments').select('teacher_id').eq('student_name', studentName),
  ]);

  const teacherIds = new Set<string>();
  for (const row of [...(byId.data ?? []), ...(byName.data ?? [])]) {
    teacherIds.add(row.teacher_id);
  }

  console.log(
    `[dbDeleteStudent] "${studentName}" (id: ${studentId}) — ` +
    `assignments: ${byId.data?.length ?? 0} por id + ${byName.data?.length ?? 0} por nombre → ` +
    `profesores afectados: [${[...teacherIds].join(', ')}]`
  );

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

  await supabase.from('assignments').delete().eq('student_id', studentId);
  await supabase.from('assignments').delete().eq('student_name', studentName);
  await supabase.from('students').delete().eq('id', studentId);

  console.log(`[dbDeleteStudent] Alumno "${studentName}" eliminado correctamente`);
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
};

export const EVENT_EUROS: Record<string, number> = {
  upsell:          20,
  bonus_retencion: 30,
};

// ── RETENTION RATE ────────────────────────────────────────────────────────────

export async function calcRetentionRate(teacherId: string): Promise<number> {
  const { data } = await supabase
    .from('assignments')
    .select('created_at, start_date')
    .eq('teacher_id', teacherId);

  const assignments = data ?? [];
  const activeStudents = assignments.length;
  if (activeStudents === 0) return 100;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const retained = assignments.filter((a: any) => {
    const date = a.start_date ? new Date(a.start_date) : new Date(a.created_at);
    return date < thirtyDaysAgo;
  }).length;

  return (retained / activeStudents) * 100;
}

// ── SCORE RECALCULATION ───────────────────────────────────────────────────────

async function dbRecalculateTeacherScore(teacherId: string): Promise<void> {
  const [evRes, asRes, calRes] = await Promise.all([
    supabase.from('scoring_events').select('points, euros').eq('teacher_id', teacherId),
    supabase.from('assignments').select('created_at, start_date').eq('teacher_id', teacherId),
    supabase.from('teacher_calendars').select('grid').eq('teacher_id', teacherId).single(),
  ]);

  const manualPoints = (evRes.data ?? []).reduce((s: number, e: any) => s + (e.points ?? 0), 0);
  const manualEuros  = (evRes.data ?? []).reduce((s: number, e: any) => s + (e.euros ?? 0), 0);

  const as = asRes.data ?? [];
  const activeStudents = as.length;
  const grid = ((calRes.data?.grid ?? {}) as Grid);
  const ocupado = Object.values(grid).filter(c => c.state === 'ocupado').length;
  const monthlyHours = ocupado * 4;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const retained = as.filter((a: any) => {
    const date = a.start_date ? new Date(a.start_date) : new Date(a.created_at);
    return date < thirtyDaysAgo;
  }).length;
  const ret = activeStudents > 0 ? (retained / activeStudents) * 100 : 100;

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

export async function dbGetScoringEvents(teacherId?: string): Promise<ScoringEvent[]> {
  let q = supabase.from('scoring_events').select('*').order('created_at', { ascending: false });
  if (teacherId) q = (q as any).eq('teacher_id', teacherId);
  const { data } = await q;
  if (!data) return [];
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
