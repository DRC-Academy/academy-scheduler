// Handler común de los dos crons del análisis en lote. SOLO SERVIDOR.
//
// Son DOS rutas (/api/cron/analisis-lote y /api/cron/analisis-lote-tarde) con el
// mismo handler porque el plan Hobby de Vercel solo admite crons diarios: una
// pasada de madrugada recoge todo lo subido la tarde y la noche anteriores, y
// otra a media tarde de España lo subido por la mañana. El informe llega como
// mucho unas horas después de subir el transcript.
//
//   GET|POST /api/cron/analisis-lote        cabecera Authorization: Bearer <CRON_SECRET>
//   ?dry=1 → solo cuenta lo que hay en la cola, sin tocar nada.

import 'server-only';

import { requireCronSecret } from '@/lib/cronAuth';
import { runAnalysisBatchCycle } from '@/lib/analysisBatch';
import { supabase } from '@/lib/supabase';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function runAnalysisBatchCron(request: Request, label: string, maxDurationS: number): Promise<Response> {
  const startedAt = Date.now();
  const denied = requireCronSecret(request, label);
  if (denied) return denied;

  if (new URL(request.url).searchParams.get('dry') === '1') {
    const { data, error } = await supabase.from('ai_analysis_queue').select('status');
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500, headers: NO_STORE });
    const counts: Record<string, number> = {};
    for (const r of data ?? []) counts[r.status as string] = (counts[r.status as string] ?? 0) + 1;
    return Response.json({ ok: true, dry: true, counts }, { headers: NO_STORE });
  }

  // 20 s de margen para responder antes de que la plataforma corte la función.
  const report = await runAnalysisBatchCycle(startedAt + (maxDurationS - 20) * 1000);
  console.log(`[${label}]`, report);
  return Response.json({ ok: report.errors.length === 0, ...report }, { headers: NO_STORE });
}
