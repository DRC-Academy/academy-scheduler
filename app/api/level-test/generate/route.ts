// Genera un link único de Test de Nivel para un candidato/alumno.
// Lo llaman el admin o el profesor (ya logueados; auth client-side, igual que el
// resto del sistema). Espejo de app/api/forms/generate-token.

import { supabase } from '@/lib/supabase';
import { EXPIRES_DEFAULT_DAYS, START_DIFFICULTY } from '@/lib/levelTest/constants';

interface Body {
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

function publicBase(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
  if (envUrl) return envUrl;
  try { return new URL(request.url).origin; }
  catch { return 'https://academy-scheduler-aqpt.vercel.app'; }
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'JSON inválido' }, { status: 400 }); }

  const studentName = body.studentName?.trim() || '';
  const candidateName = body.candidateName?.trim() || studentName;
  const candidateEmail = body.candidateEmail?.trim() || body.studentEmail?.trim() || '';

  if (!candidateName) {
    return Response.json({ error: 'Falta el nombre del candidato (candidateName o studentName).' }, { status: 400 });
  }

  const token = crypto.randomUUID();
  const days = Number.isFinite(body.expiresInDays) ? Number(body.expiresInDays) : EXPIRES_DEFAULT_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase.from('level_test_sessions').insert({
    token,
    candidate_name:  candidateName,
    candidate_email: candidateEmail,
    candidate_phone: body.candidatePhone?.trim() || null,
    student_id:      body.studentId?.trim() || null,
    student_name:    studentName || null,
    student_email:   body.studentEmail?.trim() || null,
    teacher_id:      body.teacherId?.trim() || null,
    teacher_name:    body.teacherName?.trim() || null,
    assignment_id:   body.assignmentId?.trim() || null,
    plan:            body.plan?.trim() || null,
    level:           body.level?.trim() || null,
    status:          'pending',
    expires_at:      expiresAt,
    current_difficulty: START_DIFFICULTY,
  });

  if (error) {
    console.error('[level-test/generate] Error al insertar la sesión:', error);
    if (error.code === 'PGRST205') {
      return Response.json(
        { error: 'La tabla level_test_sessions no existe. Ejecutá supabase-level-test.sql en el SQL editor de Supabase.' },
        { status: 500 },
      );
    }
    return Response.json({ error: `No se pudo generar el link: ${error.message}` }, { status: 500 });
  }

  const url = `${publicBase(request)}/test/${token}`;
  return Response.json({ token, url });
}
