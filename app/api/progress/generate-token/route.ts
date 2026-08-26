// Genera (o reutiliza) el link público de progreso de un alumno.
//
// Nota de seguridad: como el resto del sistema, la autenticación es del lado del
// cliente y se usa la clave anónima de Supabase. El link creado es de SOLO
// LECTURA y expira a los 30 días, pero cualquiera que lo tenga puede abrirlo.

import { supabase } from '@/lib/supabase';
import { publicBase } from '@/lib/appUrl';

interface Body {
  studentId?: string;
  studentName?: string;
  teacherId?: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const studentName = body.studentName?.trim();
  const teacherId   = body.teacherId?.trim();
  const studentId   = body.studentId?.trim() || null;

  if (!studentName || !teacherId) {
    return Response.json(
      { error: 'Faltan datos obligatorios (studentName, teacherId).' },
      { status: 400 },
    );
  }

  // Reutilizamos el token vigente del alumno: así el link que ya compartió el
  // profesor no deja de funcionar cada vez que vuelve a pulsar "Compartir".
  const existingQuery = supabase
    .from('progress_tokens')
    .select('token, expires_at')
    .eq('teacher_id', teacherId)
    .order('created_at', { ascending: false })
    .limit(1);

  const { data: existing, error: readError } = studentId
    ? await existingQuery.eq('student_id', studentId)
    : await existingQuery.ilike('student_name', studentName);

  if (readError && readError.code === 'PGRST205') {
    return Response.json(
      { error: 'La tabla progress_tokens no existe. Ejecutá supabase-progress-tokens.sql en el SQL editor de Supabase.' },
      { status: 500 },
    );
  }

  const current = existing?.[0];
  const stillValid = current && (!current.expires_at || new Date(current.expires_at).getTime() > Date.now());
  if (stillValid) {
    return Response.json({ token: current.token, progressUrl: `${publicBase(request)}/progreso/${current.token}` });
  }

  const token = crypto.randomUUID();
  const id    = `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const { error } = await supabase.from('progress_tokens').insert({
    id, token, student_id: studentId, student_name: studentName, teacher_id: teacherId,
  });

  if (error) {
    console.error('[progress/generate-token] Error al insertar el token:', error);
    if (error.code === 'PGRST205') {
      return Response.json(
        { error: 'La tabla progress_tokens no existe. Ejecutá supabase-progress-tokens.sql en el SQL editor de Supabase.' },
        { status: 500 },
      );
    }
    return Response.json({ error: `No se pudo generar el link: ${error.message}` }, { status: 500 });
  }

  return Response.json({ token, progressUrl: `${publicBase(request)}/progreso/${token}` });
}
