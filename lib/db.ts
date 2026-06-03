import { supabase } from './supabase';
import { Teacher, Student, Assignment, AppUser, Grid, TeacherStatus } from '@/types';

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

// ── TEACHERS ─────────────────────────────────────────────────────────────────

export async function dbGetTeachers(): Promise<Teacher[]> {
  // Fetch teachers and their calendars in parallel
  const [teachersRes, calendarsRes] = await Promise.all([
    supabase.from('teachers').select('*').order('name'),
    supabase.from('teacher_calendars').select('teacher_id, grid'),
  ]);

  if (teachersRes.error || !teachersRes.data) return [];

  // Build a map of grids by teacher_id
  const gridMap: Record<string, Grid> = {};
  if (calendarsRes.data) {
    for (const row of calendarsRes.data) {
      gridMap[row.teacher_id] = row.grid as Grid;
    }
  }

  return teachersRes.data.map(row => {
    const grid = gridMap[row.id] ?? {};
    const { status, freeSpots, ocupadoSpots, weeklyLoad } = calcStatusFromGrid(grid);

    // Build upcomingClasses from occupied grid cells
    const upcomingClasses = Object.entries(grid)
      .filter(([, cell]) => cell.state === 'ocupado')
      .map(([key, cell]) => {
        const [day, time] = key.split('_');
        return {
          id: key,
          studentName: cell.student ?? '—',
          day,
          time,
          duration: 1,
          type: 'Clase',
        };
      });

    // Build timeSlots from libre cells (for weekly overview in admin)
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
      id:             row.id,
      name:           row.name,
      email:          row.email,
      avatar:         row.avatar,
      status,
      weeklyLoad,
      maxWeeklyLoad:  20,
      freeSpots,
      totalSpots:     freeSpots + ocupadoSpots,
      specialties:    row.specialties ?? ['Inglés'],
      timeSlots,
      blockedSlots:   [],
      vacations:      [],
      upcomingClasses,
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
  });
}
