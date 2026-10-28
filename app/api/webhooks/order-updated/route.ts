// WooCommerce webhook "Pedido actualizado" → oferta nueva (lib/planOrders).
//
// Se configura en WooCommerce → Ajustes → Avanzado → Webhooks con el tema
// "Pedido actualizado" y el secreto de WOO_ORDER_WEBHOOK_SECRET. Woo firma el
// cuerpo con HMAC-SHA256 (base64) en la cabecera x-wc-webhook-signature.
//
// Del cuerpo solo se usa el ID del pedido: el pedido se vuelve a leer de Woo, que
// es la fuente fiable (los webhooks llegan en diferido y pueden traer un estado
// viejo). Un pedido de pago único pagado activa al alumno; uno de la oferta
// anterior no hace nada. Idempotente por número de pedido.
//
// Siempre 200 salvo firma inválida (401) o falta de configuración (503): un 5xx
// haría que Woo reintentara y, a la quinta, desactivara el webhook. Si algo falla
// por dentro, el barrido diario del cron check-ending-plans lo recoge.

import crypto from 'crypto';
import { secretsMatch } from '@/lib/externalAuth';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { processOneOrder } from '@/lib/planOrderStore';
import { madridToday } from '@/lib/subscriptionAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SECRET_ENV = 'WOO_ORDER_WEBHOOK_SECRET';

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();

  // Ping de WooCommerce al crear el webhook ("webhook_id=123", sin firma).
  if (/^webhook_id=\d+$/.test(rawBody.trim())) return new Response('ok', { status: 200 });

  const secret = process.env[SECRET_ENV];
  if (!secret) {
    console.error(`[webhook pedido] Falta ${SECRET_ENV}: el endpoint queda cerrado.`);
    return new Response('Not configured', { status: 503 });
  }
  const signature = req.headers.get('x-wc-webhook-signature') ?? '';
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  if (!signature || !secretsMatch(signature, expected)) {
    return new Response('Invalid signature', { status: 401 });
  }

  let id = 0;
  try { id = Number((JSON.parse(rawBody) as { id?: unknown }).id) || 0; } catch { /* sin JSON */ }
  if (!id) return new Response('ok', { status: 200 });

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error('[webhook pedido] Falta SUPABASE_SERVICE_ROLE_KEY.');
    return new Response('ok', { status: 200 });
  }

  try {
    const r = await processOneOrder(admin, id, madridToday());
    const resumen = r.events.map(e => `${e.productId}→${e.result}`).join(', ') || 'sin productos de la oferta nueva';
    console.log(`[webhook pedido] ${id}: ${resumen}${r.errors.length ? ` · errores: ${r.errors.join(' | ')}` : ''}`);
  } catch (err) {
    console.error(`[webhook pedido] ${id}: no se pudo procesar (lo recoge el barrido diario):`, err);
  }
  return new Response('ok', { status: 200 });
}
