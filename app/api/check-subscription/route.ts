// Verifica el estado de suscripción de un alumno en WooCommerce antes de
// permitir el ingreso a clase. Nunca bloquea de forma dura: ante un error de
// conexión devuelve { active: null } para que el profesor pueda decidir.

import { supabase } from '@/lib/supabase';

interface SubResult {
  active: boolean | null;
  status: string;            // 'active' | 'cancelled' | 'on-hold' | 'expired' | 'pending-cancel' | 'switched' | 'not_found' | 'error' | 'manual_override'
  endDate: string | null;    // ISO — fin definitivo (end_date, o next_payment_date como fallback)
  daysRemaining: number | null;
  planName: string | null;
  phone: string | null;      // billing.phone de WooCommerce
}

// Fecha de hoy (YYYY-MM-DD) en hora de España — referencia para la activación manual.
function madridTodayStr(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA → 'YYYY-MM-DD'
}

// Si el alumno tiene manual_active_until en el futuro (o hoy), devolvemos una
// suscripción "manual_override" activa sin consultar WooCommerce.
async function checkManualOverride(email: string): Promise<SubResult | null> {
  try {
    const { data } = await supabase
      .from('students')
      .select('manual_active_until')
      .ilike('email', email)
      .not('manual_active_until', 'is', null)
      .limit(1)
      .maybeSingle();

    const until = data?.manual_active_until as string | null | undefined;
    if (!until) return null;

    const today = madridTodayStr();
    if (until < today) return null; // ya venció → se vuelve a consultar WooCommerce

    const endDate = new Date(until + 'T23:59:59');
    const daysRemaining = Math.max(0, Math.ceil((endDate.getTime() - Date.now()) / DAY_MS));
    return { active: true, status: 'manual_override', endDate: endDate.toISOString(), daysRemaining, planName: null, phone: null };
  } catch {
    return null; // ante cualquier error de Supabase, seguimos con WooCommerce
  }
}

const ERROR_RESULT: SubResult = { active: null, status: 'error', endDate: null, daysRemaining: null, planName: null, phone: null };

// Cache simple en memoria (por instancia serverless): 5 minutos por email.
// Solo se cachean resultados EXITOSOS — los errores nunca se cachean para que
// el próximo intento (reintento o recarga) vuelva a consultar.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { result: SubResult; ts: number }>();

const DAY_MS = 24 * 60 * 60 * 1000;

// Reintentos / timeout para la llamada a WooCommerce.
const MAX_ATTEMPTS = 3;       // 1 intento + 2 reintentos
const RETRY_DELAY_MS = 500;   // backoff simple
const TIMEOUT_MS = 10_000;    // 10s por intento

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

// Llama a WooCommerce con timeout explícito y reintentos. Devuelve el array de
// suscripciones, o lanza un error (tras agotar los intentos) ya logueado.
async function fetchWooSubscriptions(url: string, email: string): Promise<any[]> {
  let lastErr: { status?: number; message: string } = { message: 'unknown error' };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        lastErr = { status: res.status, message: `HTTP ${res.status}` };
      } else {
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      }
    } catch (err: any) {
      clearTimeout(timer);
      lastErr = { message: err?.name === 'AbortError' ? `timeout tras ${TIMEOUT_MS}ms` : String(err?.message ?? err) };
    }

    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  console.error(
    `[check-subscription] Falló la verificación de "${email}" tras ${MAX_ATTEMPTS} intentos — ` +
    `${lastErr.status ? `status HTTP ${lastErr.status}` : 'sin respuesta'}: ${lastErr.message}` +
    (lastErr.status === 429 ? ' (rate limit)' : lastErr.status === 401 ? ' (auth)' : '')
  );
  throw new Error(lastErr.message);
}

export async function GET(request: Request): Promise<Response> {
  const email = new URL(request.url).searchParams.get('email')?.trim().toLowerCase();

  if (!email) {
    return Response.json({ ...ERROR_RESULT, status: 'error' } satisfies SubResult, { status: 400 });
  }

  // Activación manual: tiene prioridad sobre WooCommerce y sobre el cache, para
  // que el acceso se refleje de inmediato tras activarlo. No se cachea.
  const manual = await checkManualOverride(email);
  if (manual) return Response.json(manual);

  // Hit de cache vigente
  const cached = cache.get(email);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return Response.json(cached.result);
  }

  const base = process.env.WOOCOMMERCE_URL;
  const ck   = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs   = process.env.WOOCOMMERCE_CONSUMER_SECRET;

  if (!base || !ck || !cs) {
    console.error('[check-subscription] Variables de entorno de WooCommerce no configuradas');
    return Response.json(ERROR_RESULT); // no se cachea
  }

  const url =
    `${base.replace(/\/$/, '')}/wp-json/wc/v3/subscriptions` +
    `?search=${encodeURIComponent(email)}` +
    `&consumer_key=${encodeURIComponent(ck)}` +
    `&consumer_secret=${encodeURIComponent(cs)}`;

  let subs: any[];
  try {
    subs = await fetchWooSubscriptions(url, email);
  } catch {
    // Error tras reintentos → no bloquear y NO cachear.
    return Response.json(ERROR_RESULT);
  }

  if (subs.length === 0) {
    const result: SubResult = { active: false, status: 'not_found', endDate: null, daysRemaining: null, planName: null, phone: null };
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

  const phone: string | null =
    (typeof chosen?.billing?.phone === 'string' && chosen.billing.phone.trim())
      ? chosen.billing.phone.trim()
      : null;

  const result: SubResult = { active, status, endDate: endDateIso, daysRemaining, planName, phone };
  cache.set(email, { result, ts: Date.now() });
  return Response.json(result);
}
