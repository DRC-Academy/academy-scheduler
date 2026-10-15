// Pestaña Testimoniales del admin (V6, 15/10/2026): recortes de los transcripts
// por tandas y UNA pareja por alumno, todo por código (sin IA ni coste). Ver
// lib/testimonialSegmentsStore.
//
// Auth del panel en el cliente, igual que el resto de /api/admin: la ruta es
// pública, pero solo procesa transcripts PENDIENTES y no gasta nada.
//
// Acciones (POST { action }):
//   · 'estado'     → contadores (y crea las filas pendientes que falten).
//   · 'tanda'      → procesa hasta 20 transcripts y rehace las parejas de sus alumnos.
//   · 'emparejar'  → rehace todas las parejas y la auditoría (tras cambiar un umbral).

import { ensureTranscriptRows, segmentsStatus, runSegmentsBatch, syncSegmentPairs } from '@/lib/testimonialSegmentsStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Plan Hobby: 60 s como mucho. La tanda se para a los 45 s y deja lo que falte.
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let body: { action?: string } = {};
  try { body = await request.json(); } catch { /* cuerpo vacío = estado */ }

  try {
    switch (body.action) {
      case 'tanda':
        return Response.json(await runSegmentsBatch({ deadline: startedAt + 45_000 }));
      case 'emparejar': {
        const r = await syncSegmentPairs();
        return Response.json({ ...r, status: await segmentsStatus() });
      }
      default: {
        const created = await ensureTranscriptRows();
        return Response.json({ created, status: await segmentsStatus() });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[testimonial-prepare]', msg);
    const sinSql = /testimonial_(segments|audit)|segments_at|segment_stats/.test(msg) && /exist|schema cache|column/i.test(msg);
    return Response.json({ error: sinSql ? 'Falta correr supabase-testimoniales-v6.sql en Supabase.' : msg }, { status: 500 });
  }
}
