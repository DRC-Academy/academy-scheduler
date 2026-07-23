// Creación (y reutilización) de una sesión de Test de Nivel — server-side.
// Compartido por la ruta /api/level-test/generate (link manual desde admin/profe)
// y por el submit del formulario inicial (ofrece el test al terminar el formulario).
//
// `getOrCreateTestSession` reutiliza una sesión vigente del mismo alumno (para no
// generar links duplicados), y solo crea una nueva si no hay o la anterior expiró.

import { supabase } from '@/lib/supabase';
import { EXPIRES_DEFAULT_DAYS, START_DIFFICULTY } from './constants';

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

// Reutiliza la sesión vigente más reciente del alumno (misma persona → mismo link)
// y solo crea una nueva si no existe o la anterior ya expiró.
export async function getOrCreateTestSession(input: TestSessionInput): Promise<CreateSessionResult> {
  const studentId = input.studentId?.trim();
  const studentName = input.studentName?.trim() || input.candidateName?.trim() || '';

  let query = supabase
    .from('level_test_sessions')
    .select('token, status, expires_at')
    .order('created_at', { ascending: false })
    .limit(1);
  query = studentId ? query.eq('student_id', studentId) : query.ilike('student_name', studentName);

  const { data } = await query.maybeSingle();
  if (data?.token) {
    const expired = data.status === 'expired'
      || (data.expires_at && new Date(data.expires_at).getTime() < Date.now());
    if (!expired) return { token: data.token };
  }
  return createTestSession(input);
}
