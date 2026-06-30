// Verifica el acceso de un alumno en WooCommerce antes de permitir el ingreso a
// clase. Detecta si el último producto comprado es de SUSCRIPCIÓN recurrente o
// de PAGO ÚNICO, y aplica la lógica correspondiente. Nunca bloquea de forma dura:
// ante un error de conexión devuelve { active: null } para que el profesor decida.

import { supabase } from '@/lib/supabase';

// Productos de PAGO ÚNICO (case-insensitive, match por "contiene"). Cualquier
// otro producto se considera de suscripción recurrente.
const ONE_TIME_PRODUCTS = [
  'intensivo fce',
  'intensivo pet',
  'intensivo general',
  'intensivo cae',
  'empresas preparacion de examenes',
  'empresas ingles general',
  'empresas intensivos',
];
function isOneTimeProduct(name: string): boolean {
  const n = (name ?? '').toLowerCase();
  return ONE_TIME_PRODUCTS.some(p => n.includes(p));
}

type ProductType = 'subscription' | 'one_time' | null;

interface SubResult {
  active: boolean | null;
  status: string;                 // 'active'|'cancelled'|'on-hold'|'expired'|'pending-cancel'|'not_found'|'error'|'manual_override'|'manual_active'|'one_time_no_access'
  endDate: string | null;
  daysRemaining: number | null;
  planName: string | null;        // = productName (compat hacia atrás)
  productName: string | null;
  productType: ProductType;
  manualActiveUntil: string | null;
  phone: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Fecha de hoy (YYYY-MM-DD) en hora de España.
function madridTodayStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function daysFromNow(d: Date): number {
  return Math.max(0, Math.ceil((d.getTime() - Date.now()) / DAY_MS));
}

const ERROR_RESULT: SubResult = {
  active: null, status: 'error', endDate: null, daysRemaining: null,
  planName: null, productName: null, productType: null, manualActiveUntil: null, phone: null,
};

// Cache en memoria (por instancia serverless): 5 min por email.
const TTL_MS = 5 * 60 * 1000;
const productCache = new Map<string, { productName: string | null; productType: ProductType; ts: number }>();
const subCache     = new Map<string, { result: { active: boolean; status: string; endDate: string | null; daysRemaining: number | null; phone: string | null; planName: string | null }; ts: number }>();

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const TIMEOUT_MS = 10_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

// GET genérico a WooCommerce con timeout + reintentos. Devuelve un array, o lanza.
async function fetchWoo(url: string, email: string, label: string): Promise<any[]> {
  let lastErr: { status?: number; message: string } = { message: 'unknown error' };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
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
  console.error(`[check-subscription] ${label} de "${email}" falló tras ${MAX_ATTEMPTS} intentos: ${lastErr.message}`);
  throw new Error(lastErr.message);
}

function wcCreds(): { base: string; ck: string; cs: string } | null {
  const base = process.env.WOOCOMMERCE_URL;
  const ck   = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs   = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!base || !ck || !cs) return null;
  return { base: base.replace(/\/$/, ''), ck, cs };
}

// Último producto comprado (line_items[0].name del pedido más reciente).
async function fetchLastProductName(c: { base: string; ck: string; cs: string }, email: string): Promise<string | null> {
  const url =
    `${c.base}/wp-json/wc/v3/orders?search=${encodeURIComponent(email)}&per_page=1&orderby=date&order=desc` +
    `&consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;
  const arr = await fetchWoo(url, email, 'orders');
  const name = arr[0]?.line_items?.[0]?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

// Estado de la suscripción recurrente (como antes).
async function fetchSubStatus(c: { base: string; ck: string; cs: string }, email: string) {
  const url =
    `${c.base}/wp-json/wc/v3/subscriptions?search=${encodeURIComponent(email)}` +
    `&consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;
  const subs = await fetchWoo(url, email, 'subscriptions');
  if (subs.length === 0) {
    return { active: false, status: 'not_found', endDate: null, daysRemaining: null, phone: null, planName: null };
  }
  const chosen = subs.find(s => s?.status === 'active') ?? subs[0];
  const status = String(chosen?.status ?? 'cancelled');
  const endDate = parseWcDate(firstNonEmpty(chosen?.end_date, chosen?.next_payment_date));
  const planName = (Array.isArray(chosen?.line_items) && typeof chosen.line_items[0]?.name === 'string') ? chosen.line_items[0].name : null;
  const phone = (typeof chosen?.billing?.phone === 'string' && chosen.billing.phone.trim()) ? chosen.billing.phone.trim() : null;
  return {
    active: status === 'active',
    status,
    endDate: endDate ? endDate.toISOString() : null,
    daysRemaining: endDate ? daysFromNow(endDate) : null,
    phone, planName,
  };
}

export async function GET(request: Request): Promise<Response> {
  const email = new URL(request.url).searchParams.get('email')?.trim().toLowerCase();
  if (!email) return Response.json({ ...ERROR_RESULT, status: 'error' }, { status: 400 });

  // 1) Alumno en Supabase: manual_active_until + producto persistido + plan local.
  let student: { id?: string; manual_active_until?: string | null; product_type?: string | null; product_name?: string | null; plan?: string | null } | null = null;
  try {
    // select('*') para tolerar que product_type/product_name aún no existan en la
    // BD (migración pendiente): las columnas faltantes simplemente vienen undefined.
    const { data } = await supabase
      .from('students')
      .select('*')
      .ilike('email', email).limit(1).maybeSingle();
    student = data;
  } catch { /* sin fila → seguimos */ }

  const today = madridTodayStr();
  const manualUntil = student?.manual_active_until ?? null;
  const manualActive = !!manualUntil && manualUntil >= today;

  const creds = wcCreds();

  // 2) Tipo + nombre de producto: usar el persistido; si no hay, detectarlo
  //    consultando el último pedido (y persistirlo para futuras consultas).
  let productName = student?.product_name ?? null;
  let productType = (student?.product_type as ProductType) ?? null;

  if (!productType) {
    const cached = productCache.get(email);
    if (cached && Date.now() - cached.ts < TTL_MS) {
      productName = cached.productName; productType = cached.productType;
    } else if (creds) {
      try {
        const name = await fetchLastProductName(creds, email);
        productName = name;
        productType = name ? (isOneTimeProduct(name) ? 'one_time' : 'subscription') : null;
        productCache.set(email, { productName, productType, ts: Date.now() });
        // Persistir (incluye plan = productName) — fire-and-forget.
        if (student?.id) {
          const updates: Record<string, unknown> = { product_type: productType, product_name: productName };
          if (productName) updates.plan = productName;
          supabase.from('students').update(updates).eq('id', student.id).then(() => {}, () => {});
        }
      } catch {
        return Response.json({ ...ERROR_RESULT, manualActiveUntil: manualUntil ?? null });
      }
    } else {
      console.error('[check-subscription] WooCommerce no configurado');
      return Response.json({ ...ERROR_RESULT, manualActiveUntil: manualUntil ?? null });
    }
  }

  // 3) Ningún producto comprado → not_found.
  if (!productType) {
    return Response.json({ active: false, status: 'not_found', endDate: null, daysRemaining: null, planName: productName, productName, productType: null, manualActiveUntil: null, phone: null } satisfies SubResult);
  }

  // 4) PAGO ÚNICO → solo cuenta el acceso manual (manual_active_until).
  if (productType === 'one_time') {
    if (manualActive && manualUntil) {
      const endDate = new Date(manualUntil + 'T23:59:59');
      return Response.json({ active: true, status: 'manual_active', endDate: endDate.toISOString(), daysRemaining: daysFromNow(endDate), planName: productName, productName, productType: 'one_time', manualActiveUntil: manualUntil, phone: null } satisfies SubResult);
    }
    return Response.json({ active: false, status: 'one_time_no_access', endDate: null, daysRemaining: null, planName: productName, productName, productType: 'one_time', manualActiveUntil: manualUntil ?? null, phone: null } satisfies SubResult);
  }

  // 5) SUSCRIPCIÓN. La activación manual sigue teniendo prioridad (override).
  if (manualActive && manualUntil) {
    const endDate = new Date(manualUntil + 'T23:59:59');
    return Response.json({ active: true, status: 'manual_override', endDate: endDate.toISOString(), daysRemaining: daysFromNow(endDate), planName: productName, productName, productType: 'subscription', manualActiveUntil: manualUntil, phone: null } satisfies SubResult);
  }

  if (!creds) return Response.json({ ...ERROR_RESULT, productName, productType: 'subscription', manualActiveUntil: null });

  let sub = subCache.get(email)?.result ?? null;
  if (!sub || Date.now() - (subCache.get(email)?.ts ?? 0) >= TTL_MS) {
    try {
      sub = await fetchSubStatus(creds, email);
      subCache.set(email, { result: sub, ts: Date.now() });
    } catch {
      return Response.json({ ...ERROR_RESULT, productName, productType: 'subscription', manualActiveUntil: null });
    }
  }

  return Response.json({
    active: sub.active, status: sub.status, endDate: sub.endDate, daysRemaining: sub.daysRemaining,
    planName: productName ?? sub.planName, productName: productName ?? sub.planName,
    productType: 'subscription', manualActiveUntil: null, phone: sub.phone,
  } satisfies SubResult);
}
