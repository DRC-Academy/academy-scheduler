// Toggle "No enviar más" del follow-up de la prueba de nivel (pestaña Tests de
// nivel del admin). Marca o desmarca students.followup_opt_out y deja quién y
// cuándo. Con la marca puesta, ni el cron (app/api/cron/followups-nivel) ni el
// botón "Recordar" le escriben al alumno.
//
// Es lo que hace el equipo cuando un alumno responde al correo semanal pidiendo
// que no le escribamos más (ver README, sección de crons).
//
// Lo llama el admin ya logueado (auth client-side, igual que el resto de rutas
// del panel). Body: { studentId: string, optOut: boolean, by?: string }.

import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let body: { studentId?: unknown; optOut?: unknown; by?: unknown };
  try { body = await request.json(); }
  catch { return Response.json({ error: 'JSON inválido' }, { status: 400 }); }

  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : '';
  if (!studentId) return Response.json({ error: 'Falta studentId.' }, { status: 400 });
  const optOut = body.optOut === true;
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'admin';

  const { data, error } = await supabase
    .from('students')
    .update({
      followup_opt_out:    optOut,
      followup_opt_out_at: optOut ? new Date().toISOString() : null,
      followup_opt_out_by: optOut ? by : null,
    })
    .eq('id', studentId)
    .select('id');

  if (error) {
    const faltaColumna = error.code === '42703' || error.code === 'PGRST204';
    console.error('[forms/optout] No se pudo guardar la marca:', error);
    return Response.json(
      { error: faltaColumna
        ? 'Falta correr supabase-plazo-24h-followups.sql en Supabase: sin la columna followup_opt_out no se puede marcar.'
        : 'No se pudo guardar la marca.' },
      { status: 500 },
    );
  }
  if (!data || data.length === 0) return Response.json({ error: 'No existe ese alumno.' }, { status: 404 });

  return Response.json({ ok: true, studentId, optOut });
}
