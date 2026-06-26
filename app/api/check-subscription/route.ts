// Verifica el estado de suscripción de un alumno en WooCommerce antes de
// permitir el ingreso a clase. Nunca bloquea de forma dura: ante un error de
// conexión devuelve { active: null } para que el profesor pueda decidir.

interface SubResult {
  active: boolean | null;
  status: string; // 'active' | 'cancelled' | 'on-hold' | 'expired' | 'pending-cancel' | 'not_found' | 'error'
}

// Cache simple en memoria (por instancia serverless): 5 minutos por email.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { result: SubResult; ts: number }>();

export async function GET(request: Request): Promise<Response> {
  const email = new URL(request.url).searchParams.get('email')?.trim().toLowerCase();

  if (!email) {
    return Response.json({ active: null, status: 'error' } satisfies SubResult, { status: 400 });
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
    return Response.json({ active: null, status: 'error' } satisfies SubResult);
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
      return Response.json({ active: null, status: 'error' } satisfies SubResult);
    }

    const data = await res.json();
    const subs: any[] = Array.isArray(data) ? data : [];

    let result: SubResult;
    if (subs.length === 0) {
      result = { active: false, status: 'not_found' };
    } else if (subs.some(s => s?.status === 'active')) {
      result = { active: true, status: 'active' };
    } else {
      // Sin activas: reportamos el estado de la primera (cancelled/on-hold/expired/…)
      result = { active: false, status: subs[0]?.status ?? 'cancelled' };
    }

    cache.set(email, { result, ts: Date.now() });
    return Response.json(result);
  } catch {
    // Error de conexión → no bloquear.
    return Response.json({ active: null, status: 'error' } satisfies SubResult);
  }
}
