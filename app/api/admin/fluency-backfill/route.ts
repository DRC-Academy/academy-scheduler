// "Analizar clases pasadas" de la pestaña Testimoniales del admin. Ver
// lib/fluencyBackfill. Auth del panel en el cliente, igual que el resto de
// /api/admin: la ruta es pública, pero solo analiza filas PENDIENTES y nunca
// vuelve a analizar las que ya tienen nota, así que lo máximo que se puede
// gastar es el propio atraso (~25 $), una sola vez.
//
// Acciones (POST { action }):
//   · 'estado'   → contadores para la barra de progreso.
//   · 'preparar' → crea las filas 'pending' que falten (sin IA).
//   · 'tanda'    → analiza hasta 5 transcripts y pasa la detección de parejas.
//                  { retryFailed: true } reintenta los fallidos.

import { backfillStatus, prepareBackfill, runBatch } from '@/lib/fluencyBackfill';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una tanda: 5 análisis en paralelo (peor caso ~50 s) + detección. La revisión de
// parejas con IA solo se lanza si queda margen (lib/testimonialStore REVIEW_MIN_MS).
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let body: { action?: string; retryFailed?: boolean } = {};
  try { body = await request.json(); } catch { /* cuerpo vacío = estado */ }

  try {
    switch (body.action) {
      case 'preparar': {
        const created = await prepareBackfill();
        return Response.json({ created, status: await backfillStatus() });
      }
      case 'tanda':
        return Response.json(await runBatch({ retryFailed: !!body.retryFailed, deadline: startedAt + 55_000 }));
      default:
        return Response.json({ status: await backfillStatus() });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[fluency-backfill]', msg);
    // Sin la tabla de la fase 1 todo falla: mensaje claro en vez de un 500 mudo.
    const sinTabla = /transcript_fluency/.test(msg) && /exist|schema cache/i.test(msg);
    return Response.json({ error: sinTabla ? 'Falta correr supabase-testimoniales.sql.' : msg }, { status: 500 });
  }
}
