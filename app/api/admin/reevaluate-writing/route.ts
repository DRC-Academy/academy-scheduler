// Reevaluar las redacciones de la prueba de nivel que la IA no pudo evaluar
// (botón de la pestaña Tests de nivel del admin). Ver lib/levelTest/reevaluate.
//
//   GET  → { pendientes }                 cuántas quedan
//   POST → { items, remaining }           procesa una TANDA pequeña
//          body: { skip?: string[] }      ids que ya fallaron en esta pasada
//
// Por tandas porque cada evaluación son unos segundos de IA: el botón llama en
// bucle hasta que no quedan (o solo quedan las que siguen fallando) y va
// sumando. Auth del panel en el cliente, igual que el resto de /api/admin.

import { countPendingWritings, reevaluatePendingWritings } from '@/lib/levelTest/reevaluate';

export const dynamic = 'force-dynamic';

const POR_TANDA = 3;

export async function GET(): Promise<Response> {
  return Response.json({ pendientes: await countPendingWritings() });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { skip?: unknown };
  const skip = Array.isArray(body.skip) ? body.skip.filter((x): x is string => typeof x === 'string') : [];
  return Response.json(await reevaluatePendingWritings({ limit: POR_TANDA, skip }));
}
