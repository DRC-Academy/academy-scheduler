// Verifica el estado de suscripción de un alumno en WooCommerce antes de
// permitir el ingreso a clase. Nunca bloquea de forma dura: ante un error de
// conexión devuelve { active: null } para que el profesor pueda decidir.

interface SubResult {
  active: boolean | null;
  status: string;            // 'active' | 'cancelled' | 'on-hold' | 'expired' | 'pending-cancel' | 'switched' | 'not_found' | 'error'
  endDate: string | null;    // ISO — fin definitivo (end_date, o next_payment_date como fallback)
  daysRemaining: number | null;
  planName: string | null;
}

const ERROR_RESULT: SubResult = { active: null, status: 'error', endDate: null, daysRemaining: null, planName: null };

// Cache simple en memoria (por instancia serverless): 5 minutos por email.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { result: SubResult; ts: number }>();

const DAY_MS = 24 * 60 * 60 * 1000;

// WooCommerce devuelve fechas como "2024-12-31 23:59:59" (o "" / "0000-00-00…"
// cuando no aplica). Devuelve una Date válida o null.
function parseWcDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('0000')) return null;
  const d = new Date(trimmed.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function firstNonEmpty(...vals: unknown[]): unknown {
  return vals.find(v => typeof v === 'string' && v.trim() && !v.trim().startsWith('0000'));
}

export async function GET(request: Request): Promise<Response> {
  const email = new URL(request.url).searchParams.get('email')?.trim().toLowerCase();

  if (!email) {
    return Response.json({ ...ERROR_RESULT, status: 'error' } satisfies SubResult, { status: 400 });
  }

  // Hit de cache vigente
  const cached = cache.get(email);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return Response.json(cached.result);
  }

  const base = process.env.WOOCOMMERCE_URL;
  const ck   = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs   = process.env.WOOCOMMERCE_CONSUMER_SECRET;

  if (!base || !ck || !cs) {
    // Sin configuración no podemos verificar; no bloqueamos al profesor.
    return Response.json(ERROR_RESULT);
  }

  try {
    const url =
      `${base.replace(/\/$/, '')}/wp-json/wc/v3/subscriptions` +
      `?search=${encodeURIComponent(email)}` +
      `&consumer_key=${encodeURIComponent(ck)}` +
      `&consumer_secret=${encodeURIComponent(cs)}`;

    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });

    if (!res.ok) {
      // No cacheamos errores: queremos reintentar cuando WooCommerce se recupere.
      return Response.json(ERROR_RESULT);
    }

    const data = await res.json();
    const subs: any[] = Array.isArray(data) ? data : [];

    if (subs.length === 0) {
      const result: SubResult = { active: false, status: 'not_found', endDate: null, daysRemaining: null, planName: null };
      cache.set(email, { result, ts: Date.now() });
      return Response.json(result);
    }

    // Preferimos una suscripción activa; si no hay, usamos la primera reportada.
    const chosen = subs.find(s => s?.status === 'active') ?? subs[0];
    const status = String(chosen?.status ?? 'cancelled');
    const active = status === 'active';

    const endDate = parseWcDate(firstNonEmpty(chosen?.end_date, chosen?.next_payment_date));
    const endDateIso = endDate ? endDate.toISOString() : null;
    const daysRemaining = endDate
      ? Math.max(0, Math.ceil((endDate.getTime() - Date.now()) / DAY_MS))
      : null;

    const planName: string | null =
      (Array.isArray(chosen?.line_items) && typeof chosen.line_items[0]?.name === 'string')
        ? chosen.line_items[0].name
        : null;

    const result: SubResult = { active, status, endDate: endDateIso, daysRemaining, planName };
    cache.set(email, { result, ts: Date.now() });
    return Response.json(result);
  } catch {
    // Error de conexión → no bloquear.
    return Response.json(ERROR_RESULT);
  }
}
