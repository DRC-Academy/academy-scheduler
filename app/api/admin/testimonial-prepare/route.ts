// Pestaña Testimoniales del admin: detección de todos los alumnos y preparación
// de los clips, de una pareja por petición. Ver lib/testimonialStore.
//
// Auth del panel en el cliente, igual que el resto de /api/admin (y que
// fluency-backfill): la ruta es pública, pero solo prepara parejas que aún no lo
// están, una sola vez cada una, así que lo máximo que se puede gastar es eso.
//
// Acciones (POST { action }):
//   · 'detectar' → pasa la regla por todos los alumnos y crea las parejas nuevas (sin IA).
//   · 'preparar' → comprueba y prepara UNA pareja (Haiku). { retryFailed: true } coge una fallida.
// Las dos devuelven la cola: { pending, failed }.

import { detectAll, prepareNext, prepareQueue } from '@/lib/testimonialStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una pareja: hasta 6 transcripts leídos, la comparación a ciegas (15 s como
// mucho, una vez por pareja) y dos llamadas a Haiku de 25 s. Si no caben, la
// preparación sale con 'sin_tiempo' y la siguiente petición sigue donde quedó.
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let body: { action?: string; retryFailed?: boolean } = {};
  try { body = await request.json(); } catch { /* cuerpo vacío = solo la cola */ }

  try {
    switch (body.action) {
      case 'detectar': {
        const { counts } = await detectAll();
        if (counts.no_table) return Response.json({ error: 'Falta correr supabase-testimoniales-candidatos.sql.' }, { status: 500 });
        return Response.json({ created: counts.creada, queue: await prepareQueue() });
      }
      case 'preparar': {
        const outcome = await prepareNext({ deadline: startedAt + 56_000, retryFailed: !!body.retryFailed });
        return Response.json({ outcome, queue: await prepareQueue() });
      }
      default:
        return Response.json({ queue: await prepareQueue() });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[testimonial-prepare]', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
