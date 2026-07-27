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
  /** "Regenerar enlace": invalida los links anteriores del alumno antes de crear
   *  el nuevo. El link viejo deja de funcionar. */
  expirePrevious?: boolean;
}

/**
 * Marca como 'expired' los tokens vigentes del alumno. Se busca por student_id y,
 * como respaldo, por nombre (mismo criterio tolerante que el resto del sistema:
 * hay alumnos antiguos cuyo token se creó sin student_id).
 */
async function expirePreviousTokens(studentId: string | undefined, studentName: string): Promise<number> {
  const patch = { status: 'expired' };
  let expired = 0;

  if (studentId) {
    const { data, error } = await supabase.from('form_tokens').update(patch)
      .eq('student_id', studentId).neq('status', 'expired').select('id');
    if (error) console.error('[generate-token] Error al expirar por student_id:', error);
    expired += data?.length ?? 0;
  }
  const { data, error } = await supabase.from('form_tokens').update(patch)
    .ilike('student_name', studentName).neq('status', 'expired').select('id');
  if (error) console.error('[generate-token] Error al expirar por nombre:', error);
  expired += data?.length ?? 0;

  return expired;
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

  // Regenerar: el enlace anterior deja de funcionar ANTES de crear el nuevo, para
  // que nunca queden dos links vivos del mismo alumno.
  let expiredCount = 0;
  if (body.expirePrevious) {
    expiredCount = await expirePreviousTokens(body.studentId?.trim() || undefined, studentName);
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
    // PGRST205 = la tabla no existe todavía (falta correr la migración SQL).
    if (error.code === 'PGRST205') {
      return Response.json(
        { error: 'La tabla form_tokens no existe. Ejecutá supabase-form-tokens.sql en el SQL editor de Supabase.' },
        { status: 500 },
      );
    }
    return Response.json(
      { error: `No se pudo generar el link: ${error.message}` },
      { status: 500 },
    );
  }

  const formUrl = `${publicBase(request)}/formulario/${token}`;
  return Response.json({ token, formUrl, id, expiredCount });
}
