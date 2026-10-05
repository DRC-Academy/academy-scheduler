// Análisis de transcripts en lote, pasada de madrugada (04:00 UTC = 06:00 en
// España). Ver lib/analysisBatchCron y lib/analysisBatch.

import { runAnalysisBatchCron } from '@/lib/analysisBatchCron';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  return runAnalysisBatchCron(request, 'analisis-lote', maxDuration);
}
export async function POST(request: Request): Promise<Response> {
  return runAnalysisBatchCron(request, 'analisis-lote', maxDuration);
}
