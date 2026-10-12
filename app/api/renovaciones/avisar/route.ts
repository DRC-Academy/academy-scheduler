// Envío MANUAL del aviso de renovación de UN alumno, para probar sin esperar al
// cron de las 10:00. Protegido con CRON_SECRET (cabecera Authorization: Bearer
// o ?secret=), igual que los crons.
//
//   ?student=<id o email>   el programa vigente de ese alumno, o
//   ?order=<nº de pedido>   ese pedido concreto.
//   &dry=1                  devuelve el mensaje sin enviarlo.
//   &marcar=1               además lo marca como avisado (el cron ya no lo repite).
//   &force=1                envía aunque el pedido esté cancelado/reembolsado o la
//                           suscripción cancelada (por defecto se niega).
//
// Antes de armar el mensaje relee el pedido en Woo: el aviso sale con el estado
// de pago de ahora, no con el de la última sincronización.

import { requireCronSecret, requireAdminClient } from '@/lib/cronAuth';
import { madridToday } from '@/lib/subscriptionAccess';
import { wooCreds, loadAllPrograms, refreshProgramOrders } from '@/lib/programSync';
import {
  loadRenewalContext, buildRenewalPayload, postRenewal, markRenewalNotified, siblingsOf,
} from '@/lib/renewalNotice';
import { currentProgram, renewalSkipReason, RENEWAL_SKIP_TEXT, type StudentProgramRow } from '@/lib/programs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

async function handle(request: Request): Promise<Response> {
  const denied = requireCronSecret(request, 'renovaciones/avisar');
  if (denied) return denied;
  const { admin, error: sinAdmin } = requireAdminClient('renovaciones/avisar');
  if (!admin) return sinAdmin;

  const q = new URL(request.url).searchParams;
  const studentQ = q.get('student')?.trim() ?? '';
  const orderQ = Number(q.get('order'));
  const dry = q.get('dry') === '1';
  const marcar = q.get('marcar') === '1';
  const force = q.get('force') === '1';
  if (!studentQ && !orderQ) return json({ error: 'Falta ?student=<id o email> o ?order=<nº de pedido>' }, 400);

  const today = madridToday();
  let all = await loadAllPrograms(admin);

  // Programas candidatos.
  let mine: StudentProgramRow[];
  if (orderQ) {
    mine = all.filter(r => Number(r.order_id) === orderQ);
  } else {
    const email = studentQ.includes('@') ? studentQ.toLowerCase() : null;
    let sid = email ? null : studentQ;
    if (email) {
      const { data } = await admin.from('students').select('id').ilike('email', email).limit(1).maybeSingle();
      sid = data?.id ? String(data.id) : null;
    }
    mine = all.filter(r => (sid && r.student_id === sid) || (email && r.email === email));
  }

  // Releer de Woo (o traerlo, si es un pedido aún sin sincronizar).
  const creds = wooCreds();
  const ids = orderQ && mine.length === 0 ? [orderQ] : mine.map(r => Number(r.order_id));
  if (ids.length === 0) {
    return json({ error: 'Ese alumno no tiene ningún programa sincronizado. Lanza /api/cron/renovaciones?solo_sync=1 o enlaza el pedido a mano.' }, 404);
  }
  if (creds) {
    try {
      const fresh = await refreshProgramOrders(admin, creds, ids);
      all = await loadAllPrograms(admin);
      mine = all.filter(r => fresh.some(f => f.order_id === r.order_id));
    } catch (e) {
      if (mine.length === 0) return json({ error: e instanceof Error ? e.message : String(e) }, 502);
      console.error('[renovaciones/avisar] No se pudo releer de Woo, se usa lo sincronizado:', e);
    }
  }

  const row = orderQ ? mine[0] : currentProgram(mine, today);
  if (!row) return json({ error: 'No se encontró el programa.' }, 404);

  // Para probar se ignoran la ventana de 28 días y la marca de "ya avisado"; lo
  // que nunca se avisa sin force es un pedido no pagado o una suscripción cancelada.
  const reason = renewalSkipReason(row, siblingsOf(row, all), today, { ignoreWindow: true, ignoreNotified: true });
  const blocking = reason === 'pedido_no_pagado' || reason === 'suscripcion_cancelada';
  const cronReason = renewalSkipReason(row, siblingsOf(row, all), today);

  const ctx = await loadRenewalContext(admin, all);
  const payload = buildRenewalPayload(row, ctx, today, true);
  const info = {
    pedido: row.order_id,
    el_cron_lo_avisaria: cronReason === null,
    motivo_cron: cronReason ? RENEWAL_SKIP_TEXT[cronReason] : null,
  };

  if (dry) return json({ ok: true, dry: true, ...info, payload });
  if (blocking && !force) {
    return json({ ok: false, ...info, error: `No se envía: ${RENEWAL_SKIP_TEXT[reason!]}. Añade &force=1 para enviarlo igual.`, payload }, 409);
  }

  const fail = await postRenewal(payload);
  if (fail) return json({ ok: false, ...info, error: `El webhook falló: ${fail}`, payload }, 502);
  const markErr = marcar ? await markRenewalNotified(admin, row) : null;
  return json({ ok: true, enviado: true, marcado: marcar && !markErr, error_marca: markErr, ...info, payload });
}

export const GET = handle;
export const POST = handle;
