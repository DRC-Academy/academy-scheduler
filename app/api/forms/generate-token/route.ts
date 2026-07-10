// Genera un token único para que un alumno complete el formulario inicial.
// Pensado para llamarse desde la app (profesor o setter, ya logueados).
//
// Nota de seguridad: como el resto del sistema, la autenticación es del lado del
// cliente (sessionStorage) y se usa la clave anónima de Supabase. Este endpoint
// valida los datos mínimos; no expone información sensible (solo crea un link).

import { supabase } from '@/lib/supabase';

interface Body {
  studentId?: string;
  studentName?: string;
  studentEmail?: string;
  teacherId?: string;
  teacherName?: string;
  assignmentId?: string;
  plan?: string;
  level?: string;
}

// Base pública del formulario. Se prioriza el origin de la request (funciona en
// local y en cualquier deploy); si no, la variable de entorno o el dominio prod.
function publicBase(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
  if (envUrl) return envUrl;
  try {
    return new URL(request.url).origin;
  } catch {
    return 'https://academy-scheduler-aqpt.vercel.app';
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const teacherId = body.teacherId?.trim();
  const studentName = body.studentName?.trim();
  const teacherName = body.teacherName?.trim();

  if (!teacherId || !studentName || !teacherName) {
    return Response.json(
      { error: 'Faltan datos obligatorios (teacherId, studentName, teacherName).' },
      { status: 400 },
    );
  }

  const token = crypto.randomUUID();
  const id = `ft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const { error } = await supabase.from('form_tokens').insert({
    id,
    token,
    student_id:    body.studentId?.trim() || null,
    student_name:  studentName,
    student_email: body.studentEmail?.trim() || null,
    teacher_id:    teacherId,
    teacher_name:  teacherName,
    assignment_id: body.assignmentId?.trim() || null,
    plan:          body.plan?.trim() || null,
    level:         body.level?.trim() || null,
    status:        'pending',
  });

  if (error) {
    console.error('[generate-token] Error al insertar el token:', error);
    return Response.json({ error: 'No se pudo generar el link. Intentá de nuevo.' }, { status: 500 });
  }

  const formUrl = `${publicBase(request)}/formulario/${token}`;
  return Response.json({ token, formUrl, id });
}
