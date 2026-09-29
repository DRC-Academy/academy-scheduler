// Creación (y reutilización) de una sesión de Test de Nivel — server-side.
// Compartido por la ruta /api/level-test/generate (link manual desde admin/profe)
// y por el submit del formulario inicial (ofrece el test al terminar el formulario).
//
// `getOrCreateTestSession` reutiliza la prueba principal del alumno (para no
// generar links duplicados) y solo crea una nueva si no tiene ninguna.

import { supabase } from '@/lib/supabase';
import { EXPIRES_DEFAULT_DAYS, START_DIFFICULTY } from './constants';
import { pickCanonical, type SessionSummary } from './canonical';

export interface TestSessionInput {
  candidateName?: string;
  candidateEmail?: string;
  candidatePhone?: string;
  studentId?: string;
  studentName?: string;
  studentEmail?: string;
  teacherId?: string;
  teacherName?: string;
  assignmentId?: string;
  plan?: string;
  level?: string;
  expiresInDays?: number;
}

export interface CreateSessionResult {
  token?: string;
  error?: string;
  code?: string;
}

// Inserta SIEMPRE una sesión nueva. Devuelve el token o un error legible.
export async function createTestSession(input: TestSessionInput): Promise<CreateSessionResult> {
  const studentName = input.studentName?.trim() || '';
  const candidateName = input.candidateName?.trim() || studentName;
  const candidateEmail = input.candidateEmail?.trim() || input.studentEmail?.trim() || '';

  if (!candidateName) {
    return { error: 'Falta el nombre del candidato (candidateName o studentName).' };
  }

  const token = crypto.randomUUID();
  const days = Number.isFinite(input.expiresInDays) ? Number(input.expiresInDays) : EXPIRES_DEFAULT_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase.from('level_test_sessions').insert({
    token,
    candidate_name:  candidateName,
    candidate_email: candidateEmail,
    candidate_phone: input.candidatePhone?.trim() || null,
    student_id:      input.studentId?.trim() || null,
    student_name:    studentName || null,
    student_email:   input.studentEmail?.trim() || null,
    teacher_id:      input.teacherId?.trim() || null,
    teacher_name:    input.teacherName?.trim() || null,
    assignment_id:   input.assignmentId?.trim() || null,
    plan:            input.plan?.trim() || null,
    level:           input.level?.trim() || null,
    status:          'pending',
    expires_at:      expiresAt,
    current_difficulty: START_DIFFICULTY,
  });

  if (error) {
    console.error('[level-test/createSession] Error al insertar la sesión:', error);
    if (error.code === 'PGRST205') {
      return { error: 'La tabla level_test_sessions no existe. Ejecuta supabase-level-test.sql en el SQL editor de Supabase.', code: error.code };
    }
    return { error: `No se pudo generar el link: ${error.message}`, code: error.code };
  }
  return { token };
}

/**
 * Todas las pruebas de un alumno con su número de respuestas: por student_id y,
 * si no hay, por nombre (tokens viejos sin id). Lanza si la base falla.
 */
export async function loadStudentSessions(input: TestSessionInput): Promise<SessionSummary[]> {
  const studentId = input.studentId?.trim();
  const studentName = input.studentName?.trim() || input.candidateName?.trim() || '';
  const cols = 'token, status, expires_at, created_at, student_id, teacher_id, level_test_answers(count)';

  let query = supabase.from('level_test_sessions').select(cols)
    .order('created_at', { ascending: false }).limit(20);
  if (studentId) query = query.eq('student_id', studentId);
  else if (studentName) query = query.ilike('student_name', studentName);
  else return [];

  const { data, error } = await query;
  if (error) throw new Error(`No se pudieron leer las pruebas del alumno: ${error.message}`);
  return (data ?? []).map((r: Record<string, unknown>) => {
    const cnt = r.level_test_answers as Array<{ count: number }> | undefined;
    return {
      token: String(r.token),
      status: String(r.status),
      expires_at: (r.expires_at as string | null) ?? null,
      created_at: String(r.created_at),
      student_id: (r.student_id as string | null) ?? null,
      teacher_id: (r.teacher_id as string | null) ?? null,
      answered: cnt?.[0]?.count ?? 0,
    };
  });
}

// La prueba principal del alumno (lib/levelTest/canonical: la terminada, o la
// abierta con más respuestas); solo crea una nueva si no tiene ninguna. La de un
// alumno no caduca por fecha, así que un recordatorio nunca le crea una prueba
// nueva por encima de la que dejó a medias.
export async function getOrCreateTestSession(input: TestSessionInput): Promise<CreateSessionResult> {
  let principal: ReturnType<typeof pickCanonical> = { kind: 'none' };
  try {
    principal = pickCanonical(await loadStudentSessions(input));
  } catch (e) {
    console.error('[level-test/createSession] No se pudieron leer las pruebas del alumno:', e);
  }
  if (principal.kind !== 'none') return { token: principal.token };
  return createTestSession(input);
}
