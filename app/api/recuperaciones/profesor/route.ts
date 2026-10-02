// Recuperaciones y reservas de UN profesor, para su agenda y su calendario.
// GET ?teacherId=…  Solo profesores beta: para el resto ni se consulta la tabla.

import { isRecoveryBetaTeacher, spainMonthOf } from '@/lib/classRecoveries';
import { reservationsOf, mapRecovery, expireIfDue } from '@/lib/classRecoveryStore';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const teacherId = new URL(request.url).searchParams.get('teacherId') ?? '';
  if (!isRecoveryBetaTeacher(teacherId)) return Response.json({ beta: false, recoveries: [], reservations: [] });

  const desde = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('class_recoveries').select('*')
    .eq('teacher_id', teacherId).gte('original_date', desde).order('original_date', { ascending: false });
  if (error) return Response.json({ beta: true, recoveries: [], reservations: [], error: error.message });

  const recoveries = await Promise.all((data ?? []).map(r => expireIfDue(mapRecovery(r))));
  const mes = spainMonthOf(Date.now());
  const sinAntelacionEsteMes = new Set(recoveries
    .filter(r => r.late && r.status !== 'anulada' && spainMonthOf(r.cancelledAt) === mes)
    .map(r => r.groupId)).size;
  const reservations = (await reservationsOf(teacherId)).map(({ date, hour, studentName }) => ({ date, hour, studentName }));
  return Response.json({ beta: true, recoveries, reservations, sinAntelacionEsteMes }, { headers: { 'Cache-Control': 'no-store' } });
}
