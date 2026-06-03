import { supabase } from './supabase';
import { Teacher, Student, Assignment, AppUser, Grid } from '@/types';

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

// ── TEACHERS ─────────────────────────────────────────────────────────────────

export async function dbGetTeachers(): Promise<Teacher[]> {
  const { data, error } = await supabase
    .from('teachers')
    .select('*')
    .order('name');

  if (error || !data) return [];

  return data.map(row => ({
    id:             row.id,
    name:           row.name,
    email:          row.email,
    avatar:         row.avatar,
    status:         'no_availability' as const,
    weeklyLoad:     0,
    maxWeeklyLoad:  20,
    freeSpots:      0,
    totalSpots:     0,
    specialties:    row.specialties ?? ['Inglés'],
    timeSlots:      [],
    blockedSlots:   [],
    vacations:      [],
    upcomingClasses: [],
  }));
}

export async function dbAddTeacher(teacher: Teacher, username: string): Promise<void> {
  // Insert into teachers table
  await supabase.from('teachers').insert({
    id:         teacher.id,
    name:       teacher.name,
    email:      teacher.email,
    avatar:     teacher.avatar,
    username:   username,
    password:   'profe123',
    specialties: ['Inglés'],
  });

  // Insert into app_users
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
