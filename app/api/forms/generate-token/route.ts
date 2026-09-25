// Genera un token único para que un alumno complete el formulario inicial.
// Pensado para llamarse desde la app (profesor o setter, ya logueados).
//
// Nota de seguridad: como el resto del sistema, la autenticación es del lado del
// cliente (sessionStorage) y se usa la clave anónima de Supabase. Este endpoint
// valida los datos mínimos; no expone información sensible (solo crea un link).

import { supabase } from '@/lib/supabase';
import { publicBase } from '@/lib/appUrl';
import { createFormToken } from '@/lib/formTokenServer';

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

  const result = await createFormToken(supabase, {
    studentId:    body.studentId,
    studentName,
    studentEmail: body.studentEmail,
    teacherId,
    teacherName,
    assignmentId: body.assignmentId,
    plan:         body.plan,
    level:        body.level,
  });

  if (!result.ok) {
    console.error('[generate-token] Error al insertar el token:', result);
    // PGRST205 = la tabla no existe todavía (falta correr la migración SQL).
    if (result.code === 'PGRST205') {
      return Response.json(
        { error: 'La tabla form_tokens no existe. Ejecutá supabase-form-tokens.sql en el SQL editor de Supabase.' },
        { status: 500 },
      );
    }
    return Response.json(
      { error: `No se pudo generar el link: ${result.error}` },
      { status: 500 },
    );
  }

  const { token, id } = result;
  const formUrl = `${publicBase(request)}/formulario/${token}`;
  return Response.json({ token, formUrl, id, expiredCount });
}
