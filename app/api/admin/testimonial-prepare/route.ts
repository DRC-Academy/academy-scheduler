// Pestaña Testimoniales del admin (V5): análisis de los transcripts antiguos por
// tandas y emparejamiento por código. Ver lib/testimonialMomentsStore.
//
// Auth del panel en el cliente, igual que el resto de /api/admin: la ruta es
// pública, pero solo analiza transcripts PENDIENTES (cada uno una vez, ~1 céntimo)
// y el emparejamiento no usa IA.
//
// Acciones (POST { action }):
//   · 'estado'     → contadores (y crea las filas 'pending' que falten, sin IA).
//   · 'tanda'      → analiza hasta 6 transcripts y rehace sus parejas.
//                    { retryFailed: true } reintenta los fallidos.
//   · 'emparejar'  → rehace todas las parejas (sin IA).

import { ensureMomentRows, momentsStatus, runMomentsBatch, syncPairs } from '@/lib/testimonialMomentsStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una tanda: 6 llamadas a Haiku en paralelo (40 s como mucho cada una) y sus parejas.
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let body: { action?: string; retryFailed?: boolean } = {};
  try { body = await request.json(); } catch { /* cuerpo vacío = estado */ }

  try {
    switch (body.action) {
      case 'tanda':
        return Response.json(await runMomentsBatch({ deadline: startedAt + 55_000, retryFailed: !!body.retryFailed }));
      case 'emparejar': {
        const r = await syncPairs();
        return Response.json({ ...r, status: await momentsStatus() });
      }
      default: {
        const created = await ensureMomentRows();
        return Response.json({ created, status: await momentsStatus() });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[testimonial-prepare]', msg);
    const sinTabla = /testimonial_(transcripts|moments)/.test(msg) && /exist|schema cache/i.test(msg);
    return Response.json({ error: sinTabla ? 'Falta correr supabase-testimoniales-v5.sql en Supabase.' : msg }, { status: 500 });
  }
}
