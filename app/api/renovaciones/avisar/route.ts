// Envío MANUAL del aviso de renovación de UN alumno, para probar sin esperar a
// la corrida diaria. Protegido con CRON_SECRET (Authorization: Bearer o ?secret=).
//
//   ?student=<id o email>   el programa más reciente de ese alumno, o
//   ?order=<nº de pedido>   ese pedido concreto.
//   &dry=1                  devuelve el mensaje SIN enviarlo ni marcarlo.
//   &marcar=1               además de enviarlo, lo marca como avisado (el cron ya no lo repite).
//   &force=1                envía aunque el pedido esté cancelado/reembolsado o la
//                           suscripción cancelada (por defecto se niega).
//
// Para probar se ignoran la ventana de 28 días y la marca de "ya avisado". Antes
// de armar el mensaje relee el pedido en Woo y guarda su estado de ahora en
// student_programs (eso sí escribe, también en dry: es la misma sincronización
// del cron, solo que de un pedido).

import { requireCronSecret, requireAdminClient } from '@/lib/cronAuth';
import { madridToday } from '@/lib/subscriptionAccess';
import { wooCreds, loadAllPrograms, refreshProgramOrders } from '@/lib/programSync';
import {
  loadRenewalContext, buildRenewalPayload, postRenewal, markRenewalNotified, siblingsOf, renewalWebhook,
} from '@/lib/renewalNotice';
import { renewalSkipReason, isOrderPaid, RENEWAL_SKIP_TEXT, type StudentProgramRow } from '@/lib/programRenewal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

/** El programa que manda: el pagado que termina más tarde; si ninguno está pagado, el más reciente. */
function latestProgram(rows: StudentProgramRow[]): StudentProgramRow | null {
  const byEnd = [...rows].sort((a, b) => (b.end_date ?? '').localeCompare(a.end_date ?? '') || b.order_id - a.order_id);
  return byEnd.find(r => isOrderPaid(r.order_status)) ?? byEnd[0] ?? null;
}

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
  const ids = orderQ && mine.length === 0 ? [orderQ] : mine.map(r => Number(r.order_id));
  if (ids.length === 0) {
    return json({ error: 'Ese alumno no tiene ningún programa sincronizado. Lanza /api/cron/renovaciones?solo_sync=1 primero.' }, 404);
  }
  const creds = wooCreds();
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

  const row = orderQ ? mine[0] : latestProgram(mine);
  if (!row) return json({ error: 'No se encontró el programa.' }, 404);

  const reason = renewalSkipReason(row, siblingsOf(row, all), today, { ignoreWindow: true, ignoreNotified: true });
  const blocking = reason === 'pedido_no_pagado' || reason === 'suscripcion_cancelada';
  const cronReason = renewalSkipReason(row, siblingsOf(row, all), today);

  const ctx = await loadRenewalContext(admin, all);
  const payload = buildRenewalPayload(row, ctx, today);
  const hook = renewalWebhook();
  const info = {
    pedido: row.order_id,
    el_cron_lo_avisaria_hoy: cronReason === null,
    motivo_cron: cronReason ? RENEWAL_SKIP_TEXT[cronReason] : null,
    webhook: hook.ok ? 'configurado (Slack)' : hook.reason,
  };

  if (dry) return json({ ok: true, dry: true, ...info, payload });
  if (blocking && !force) {
    return json({ ok: false, ...info, error: `No se envía: ${RENEWAL_SKIP_TEXT[reason!]}. Añade &force=1 para enviarlo igual.`, payload }, 409);
  }

  const fail = await postRenewal(payload);
  if (fail) {
    console.warn(`[renovaciones/avisar] No enviado (pedido ${row.order_id}): ${fail}`);
    return json({ ok: false, ...info, error: `No se envió: ${fail}`, payload }, 502);
  }
  const markErr = marcar ? await markRenewalNotified(admin, row) : null;
  return json({ ok: true, enviado: true, marcado: marcar && !markErr, error_marca: markErr, ...info, payload });
}

export const GET = handle;
export const POST = handle;
