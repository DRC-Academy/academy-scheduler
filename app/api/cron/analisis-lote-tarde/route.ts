// Análisis de transcripts en lote, pasada de la tarde (15:00 UTC = 17:00 en
// España). Misma rutina que /api/cron/analisis-lote: es otra ruta solo porque el
// plan Hobby de Vercel no admite un cron más frecuente que diario.

import { runAnalysisBatchCron } from '@/lib/analysisBatchCron';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  return runAnalysisBatchCron(request, 'analisis-lote-tarde', maxDuration);
}
export async function POST(request: Request): Promise<Response> {
  return runAnalysisBatchCron(request, 'analisis-lote-tarde', maxDuration);
}
