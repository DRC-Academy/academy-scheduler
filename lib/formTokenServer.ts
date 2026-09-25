// Tokens del formulario inicial (form_tokens), del lado del SERVIDOR.
//
// El INSERT vivía dentro de /api/forms/generate-token. Ahora lo comparten esa
// ruta (el modal de presentación del profesor, el setter…) y el email de
// bienvenida automático (lib/welcomeEmailSend), para que los dos creen el
// enlace exactamente igual. Los follow-ups (lib/formReminders) cuentan desde el
// created_at de este token, así que da igual quién lo haya creado.
//
// El cliente de Supabase entra por parámetro: la ruta usa el anon, como siempre;
// la bienvenida usa el service role.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface FormTokenPayload {
  studentId?: string | null;
  studentName: string;
  studentEmail?: string | null;
  teacherId: string;
  teacherName: string;
  assignmentId?: string | null;
  plan?: string | null;
  level?: string | null;
}

export interface FormTokenRow {
  id: string;
  token: string;
  status: string;
  expires_at: string | null;
  completed_at: string | null;
  student_id: string | null;
  student_name: string;
}

export type CreateFormTokenResult =
  | { ok: true; token: string; id: string }
  | { ok: false; error: string; code?: string };

/** Inserta un token nuevo en estado 'pending'. */
export async function createFormToken(client: SupabaseClient, body: FormTokenPayload): Promise<CreateFormTokenResult> {
  const token = crypto.randomUUID();
  const id = `ft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const { error } = await client.from('form_tokens').insert({
    id,
    token,
    student_id:    body.studentId?.trim() || null,
    student_name:  body.studentName.trim(),
    student_email: body.studentEmail?.trim() || null,
    teacher_id:    body.teacherId.trim(),
    teacher_name:  body.teacherName.trim(),
    assignment_id: body.assignmentId?.trim() || null,
    plan:          body.plan?.trim() || null,
    level:         body.level?.trim() || null,
    status:        'pending',
  });

  if (error) return { ok: false, error: error.message, code: error.code };
  return { ok: true, token, id };
}

/**
 * El token más reciente del alumno: por student_id y, si no hay, por nombre
 * (hay tokens viejos creados sin student_id). Misma regla que lookupToken en
 * lib/formClient, que es la que usa el modal de presentación.
 */
export async function findLatestFormToken(
  client: SupabaseClient, student: { id?: string | null; name: string },
): Promise<FormTokenRow | null> {
  const cols = 'id, token, status, expires_at, completed_at, student_id, student_name';
  if (student.id) {
    const { data } = await client.from('form_tokens').select(cols)
      .eq('student_id', student.id).order('created_at', { ascending: false }).limit(1);
    if (data?.[0]) return data[0] as FormTokenRow;
  }
  const name = student.name.trim();
  if (!name) return null;
  const { data } = await client.from('form_tokens').select(cols)
    .ilike('student_name', name).order('created_at', { ascending: false }).limit(1);
  return (data?.[0] as FormTokenRow | undefined) ?? null;
}

/** ¿Algún token del alumno está completado? (formulario ya hecho, aunque luego se regenerara). */
export async function hasCompletedFormToken(
  client: SupabaseClient, student: { id?: string | null; name: string },
): Promise<boolean> {
  if (student.id) {
    const { data } = await client.from('form_tokens').select('id')
      .eq('student_id', student.id).eq('status', 'completed').limit(1);
    if (data?.length) return true;
  }
  const name = student.name.trim();
  if (!name) return false;
  const { data } = await client.from('form_tokens').select('id')
    .ilike('student_name', name).eq('status', 'completed').limit(1);
  return Boolean(data?.length);
}

/** Estado de un token, con la misma regla que formStateOf (lib/formClient). */
export function formTokenState(t: FormTokenRow, now: number = Date.now()): 'pending' | 'completed' | 'expired' {
  if (t.status === 'completed') return 'completed';
  if (t.status === 'expired') return 'expired';
  if (t.expires_at && new Date(t.expires_at).getTime() < now) return 'expired';
  return 'pending';
}
