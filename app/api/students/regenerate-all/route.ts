// "Regenerar todo" (30/09/2026): el alumno empieza de cero con el formulario
// inicial Y la prueba de nivel.
//
//   · Formularios y pruebas anteriores NO se borran: se marcan `superseded_at` y
//     quedan como historial (respuestas, nivel y fecha). Desde ese momento no
//     cuentan para nada (lib/levelTest/canonical): los enlaces viejos llevan a
//     los nuevos, y ni la pantalla final ni los recordatorios miran lo anterior.
//   · Las respuestas del formulario vivían solo en la ficha (una fila por alumno)
//     y el formulario nuevo las pisaría: antes de marcar, se copian al último
//     formulario completado (form_tokens.responses).
//   · El nivel de la ficha NO se toca: sigue el anterior hasta que termine la
//     prueba nueva (app/api/level-test/[token]/submit lo sustituye entonces, y
//     pasa la confirmación vieja del profe al historial).
//   · Los recordatorios vuelven a empezar por el primero: se borran los envíos
//     registrados del alumno en level_test_followups (Facundo, 30/09/2026).
//   · NO se envía nada al alumno: el profe copia el enlace nuevo.
//
// Como el resto del panel, la autenticación es del lado del cliente y se usa la
// clave anónima (RLS deshabilitado).

import { supabase } from '@/lib/supabase';
import { publicBase } from '@/lib/appUrl';
import { createFormToken } from '@/lib/formTokenServer';
import { createTestSession } from '@/lib/levelTest/createSession';

export const dynamic = 'force-dynamic';

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

/** Aplica el mismo UPDATE por student_id y por nombre. Devuelve cuántas filas tocó. */
async function updateBoth(
  table: 'form_tokens' | 'level_test_sessions', patch: Record<string, unknown>,
  student: { id: string | null; name: string }, extra?: { status: string },
): Promise<number> {
  let n = 0;
  const run = async (by: 'id' | 'name') => {
    let q = supabase.from(table).update(patch).is('superseded_at', null);
    q = by === 'id' ? q.eq('student_id', student.id!) : q.ilike('student_name', student.name);
    if (extra) q = q.eq('status', extra.status);
    const { data, error } = await q.select('id');
    if (error) throw new Error(`${table}: ${error.message}`);
    n += data?.length ?? 0;
  };
  if (student.id) await run('id');
  await run('name');
  return n;
}

/**
 * Copia las respuestas de la ficha al último formulario completado que no las
 * tenga (los completados antes del 30/09/2026 no las guardaban).
 */
async function backfillResponses(student: { id: string | null; name: string }): Promise<void> {
  let q = supabase.from('form_tokens').select('id, responses, completed_at')
    .eq('status', 'completed').is('superseded_at', null)
    .order('completed_at', { ascending: false }).limit(1);
  q = student.id ? q.eq('student_id', student.id) : q.ilike('student_name', student.name);
  const { data: tokens } = await q;
  const last = tokens?.[0];
  if (!last || last.responses) return;

  let p = supabase.from('student_profiles').select('form_responses')
    .not('form_responses', 'is', null).order('updated_at', { ascending: false }).limit(1);
  p = student.id ? p.eq('student_id', student.id) : p.ilike('student_name', student.name);
  const { data: profs } = await p;
  const raw = profs?.[0]?.form_responses;
  if (!raw) return;
  let responses: unknown = raw;
  if (typeof raw === 'string') {
    try { responses = JSON.parse(raw); } catch { responses = { _raw: raw }; }
  }
  const { error } = await supabase.from('form_tokens').update({ responses }).eq('id', last.id);
  if (error) console.error('[regenerate-all] No se pudieron copiar las respuestas al historial:', error);
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'JSON inválido' }, { status: 400 }); }

  const studentName = body.studentName?.trim();
  const teacherId = body.teacherId?.trim();
  const teacherName = body.teacherName?.trim();
  if (!studentName || !teacherId || !teacherName) {
    return Response.json({ error: 'Faltan datos obligatorios (studentName, teacherId, teacherName).' }, { status: 400 });
  }
  const student = { id: body.studentId?.trim() || null, name: studentName };
  const now = new Date().toISOString();

  // 1) Lo anterior pasa a historial (sin borrar nada).
  let formsArchived = 0, testsArchived = 0;
  try {
    await backfillResponses(student);
    // Un formulario pendiente deja de abrirse como tal (la marca manda igual).
    await updateBoth('form_tokens', { status: 'expired' }, student, { status: 'pending' });
    formsArchived = await updateBoth('form_tokens', { superseded_at: now }, student);
    testsArchived = await updateBoth('level_test_sessions', { superseded_at: now }, student);
  } catch (e) {
    console.error('[regenerate-all] Error al pasar lo anterior a historial:', e);
    return Response.json({ error: 'No se pudo regenerar. No se ha creado nada nuevo; vuelve a intentarlo.' }, { status: 500 });
  }

  // 2) Recordatorios desde el primero.
  let followupsReset = 0;
  if (student.id) {
    const { data, error } = await supabase.from('level_test_followups')
      .delete().eq('student_id', student.id).select('id');
    if (error && error.code !== '42P01') console.error('[regenerate-all] No se pudieron reiniciar los recordatorios:', error);
    followupsReset = data?.length ?? 0;
  }

  // 3) Formulario y prueba nuevos.
  const payload = {
    studentId: student.id, studentName, studentEmail: body.studentEmail,
    teacherId, teacherName, assignmentId: body.assignmentId, plan: body.plan, level: body.level,
  };
  const form = await createFormToken(supabase, payload);
  if (!form.ok) {
    console.error('[regenerate-all] No se pudo crear el formulario nuevo:', form);
    return Response.json({ error: `No se pudo crear el formulario nuevo: ${form.error}` }, { status: 500 });
  }
  const test = await createTestSession({
    studentId: student.id || undefined, studentName, studentEmail: body.studentEmail,
    teacherId, teacherName, assignmentId: body.assignmentId, plan: body.plan, level: body.level,
  });
  if (!test.token) {
    // El formulario nuevo ya existe; la pantalla final crea la prueba si falta.
    console.error('[regenerate-all] No se pudo crear la prueba nueva:', test.error);
  }

  console.log(`[regenerate-all] ${studentName}: ${formsArchived} formulario(s) y ${testsArchived} prueba(s) a historial, ${followupsReset} recordatorio(s) reiniciados.`);

  const base = publicBase(request);
  return Response.json({
    ok: true,
    formUrl: `${base}/formulario/${form.token}`,
    testUrl: test.token ? `${base}/test/${test.token}` : null,
    formsArchived, testsArchived, followupsReset,
  });
}
