// WooCommerce webhook "Suscripción actualizada" → pago pendiente (on-hold).
//
// Se configura en WooCommerce → Ajustes → Avanzado → Webhooks con el tema
// "Suscripción actualizada" y el secreto de WOO_STATUS_WEBHOOK_SECRET. Woo firma
// el cuerpo con HMAC-SHA256 (base64) en la cabecera x-wc-webhook-signature.
//
// El cuerpo solo dice A QUIÉN mirar (billing.email). El estado NO se toma del
// webhook: se resuelve con la regla única (/api/check-subscription en el mismo
// proceso), porque un alumno puede tener varias suscripciones, Oritalk o una
// activación manual, y porque Woo entrega los webhooks en diferido: cuando llega
// el de "En espera" de una renovación, el cobro puede haber entrado ya.
//
// Siempre 200 salvo firma inválida (401) o falta de configuración (503): un 5xx
// haría que Woo reintentara, y a la quinta lo desactiva.

import crypto from 'crypto';
import { secretsMatch } from '@/lib/externalAuth';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { syncStudentHold, processHoldNotices } from '@/lib/paymentHoldStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SECRET_ENV = 'WOO_STATUS_WEBHOOK_SECRET';

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();

  // Ping de WooCommerce al crear el webhook ("webhook_id=123", sin firma). Si no
  // se contesta 200, Woo no deja guardarlo como activo. No hace nada más.
  if (/^webhook_id=\d+$/.test(rawBody.trim())) return new Response('ok', { status: 200 });

  const secret = process.env[SECRET_ENV];
  if (!secret) {
    console.error(`[webhook estado] Falta ${SECRET_ENV}: el endpoint queda cerrado.`);
    return new Response('Not configured', { status: 503 });
  }
  const signature = req.headers.get('x-wc-webhook-signature') ?? '';
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  if (!signature || !secretsMatch(signature, expected)) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: { id?: unknown; status?: unknown; billing?: { email?: unknown } } | null = null;
  try { payload = JSON.parse(rawBody); } catch { payload = null; }
  const email = typeof payload?.billing?.email === 'string' ? payload.billing.email.trim().toLowerCase() : '';
  if (!email) return new Response('ok', { status: 200 });

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error('[webhook estado] Falta SUPABASE_SERVICE_ROLE_KEY.');
    return new Response('ok', { status: 200 });
  }

  const now = Date.now();
  const r = await syncStudentHold(admin, email, 'webhook', { nowMs: now });
  console.log(`[webhook estado] suscripción ${String(payload?.id ?? '?')} (${String(payload?.status ?? '?')}) · ${email} → ${r.accion}${r.status ? ` (${r.status})` : ''}`);

  // La reactivación sale en el acto. El "suspendido" espera a que el episodio
  // lleve SUSPENDED_EMAIL_GRACE_MIN abierto, y lo manda el barrido.
  if (r.accion === 'cerrado' && r.studentId) {
    try { await processHoldNotices(admin, now, { studentId: r.studentId }); }
    catch (err) { console.error('[webhook estado] Avisos fallidos:', err); }
  }
  return new Response('ok', { status: 200 });
}
