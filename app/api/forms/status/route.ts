// Pantalla final de un formulario YA completado, cuando el alumno vuelve a abrir
// su enlace. También resuelve el enlace de un formulario reemplazado por un
// "Regenerar todo" ('redirect' al vigente, o 'replaced'). PÚBLICO (solo el token). Devuelve lo mismo que /api/forms/submit:
// si la prueba de nivel está por empezar, a medias o terminada, con su enlace.
// Si el alumno no tiene prueba vigente (nunca la tuvo o caducó), se le crea una
// en este momento, para que el botón lleve siempre a algún sitio.

import { supabase } from '@/lib/supabase';
import { finalTestFor } from '@/lib/formFinalScreen';
import { findLatestFormToken } from '@/lib/formTokenServer';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token')?.trim();
  if (!token) return Response.json({ error: 'Falta el token.' }, { status: 400 });

  const { data: tk, error } = await supabase
    .from('form_tokens')
    .select('token, status, superseded_at, student_id, student_name, student_email, teacher_id, teacher_name, assignment_id, plan, level')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    console.error('[forms/status] Error al leer el token:', error);
    return Response.json({ error: 'Error del servidor.' }, { status: 500 });
  }
  if (!tk) return Response.json({ status: 'invalid' }, { status: 404 });

  // Historial de un "Regenerar todo": el formulario vigente del alumno es otro.
  // La página redirige a él; si no lo hubiera, dice que tiene un enlace nuevo.
  if (tk.superseded_at) {
    const actual = await findLatestFormToken(supabase, { id: tk.student_id, name: tk.student_name });
    if (actual && actual.token !== tk.token) return Response.json({ status: 'redirect', token: actual.token });
    return Response.json({ status: 'replaced' });
  }
  // Solo para formularios terminados: uno pendiente se rellena, no tiene final.
  if (tk.status !== 'completed') return Response.json({ status: tk.status });

  return Response.json({
    status: 'completed',
    studentName: tk.student_name,
    test: await finalTestFor(tk, request),
  });
}
