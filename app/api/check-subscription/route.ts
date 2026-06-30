// Verifica el acceso de un alumno en WooCommerce antes de permitir el ingreso a
// clase. Detecta si el último producto comprado es de SUSCRIPCIÓN recurrente o
// de PAGO ÚNICO, y aplica la lógica correspondiente. Nunca bloquea de forma dura:
// ante un error de conexión devuelve { active: null } para que el profesor decida.

import { supabase } from '@/lib/supabase';
import { parseHoursFromText, parseHoursFromMeta } from '@/lib/productUtils';

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
  productVariation: string | null;
  productFullName: string | null;
  productType: ProductType;
  hoursFromApi: number | null;    // horas detectadas desde WooCommerce
  manualActiveUntil: string | null;
  metaData: any[];                // meta_data crudo del line_item
  phone: string | null;
}

interface RichProduct {
  name: string | null;
  variation: string | null;
  fullName: string | null;
  hours: number | null;
  metaData: any[];
  productType: ProductType;
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
  planName: null, productName: null, productVariation: null, productFullName: null,
  productType: null, hoursFromApi: null, manualActiveUntil: null, metaData: [], phone: null,
};

// Cache en memoria (por instancia serverless): 5 min por email.
const TTL_MS = 5 * 60 * 1000;
const productCache = new Map<string, { product: RichProduct; ts: number }>();
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

// Variación (display_value) de los atributos del line_item (metas sin "_" inicial).
function variationFromMeta(metaData: any[]): string | null {
  const parts: string[] = [];
  for (const m of metaData) {
    const key = String(m?.key ?? '');
    if (key.startsWith('_')) continue; // metas internas de WooCommerce
    const dv = m?.display_value ?? m?.value;
    if (typeof dv === 'string' && dv.trim() && !dv.trim().startsWith('http')) parts.push(dv.trim());
  }
  return parts.length ? parts.join(' · ') : null;
}

// Último producto comprado (line_items[0] del pedido más reciente), con
// variación, horas detectadas (meta + nombre) y meta_data crudo.
async function fetchLastProduct(c: { base: string; ck: string; cs: string }, email: string): Promise<RichProduct> {
  const url =
    `${c.base}/wp-json/wc/v3/orders?search=${encodeURIComponent(email)}&per_page=1&orderby=date&order=desc` +
    `&consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;
  const arr = await fetchWoo(url, email, 'orders');
  const li = arr[0]?.line_items?.[0];
  const name = (typeof li?.name === 'string' && li.name.trim()) ? li.name.trim() : null;
  if (!name) return { name: null, variation: null, fullName: null, hours: null, metaData: [], productType: null };

  const metaData = Array.isArray(li?.meta_data) ? li.meta_data : [];
  const variation = li?.variation_id ? variationFromMeta(metaData) : variationFromMeta(metaData);
  const fullName = variation ? `${name} — ${variation}` : name;

  // Horas: meta_data → variación → nombre → concatenación amplia.
  const broad = `${name} ${metaData.map((m: any) => m?.display_value ?? m?.value ?? '').join(' ')}`;
  const hours = parseHoursFromMeta(metaData) ?? parseHoursFromText(variation) ?? parseHoursFromText(name) ?? parseHoursFromText(broad);

  const productType: ProductType = isOneTimeProduct(name) ? 'one_time' : 'subscription';
  return { name, variation, fullName, hours, metaData, productType };
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
  // ?full=1 → fuerza traer la info rica del pedido (variación + horas + meta),
  // usado por los formularios de asignación. Sin él se usa lo persistido (liviano).
  const full = new URL(request.url).searchParams.get('full') === '1';

  // 2) Producto: usa lo persistido; trae el pedido (info rica) si se pide `full`
  //    o si no hay tipo persistido. Lo detectado se persiste (incl. plan).
  let productName = student?.product_name ?? null;
  let productType = (student?.product_type as ProductType) ?? null;
  let rich: RichProduct | null = null;

  if (full || !productType) {
    const cached = productCache.get(email);
    if (cached && Date.now() - cached.ts < TTL_MS) {
      rich = cached.product;
    } else if (creds) {
      try {
        rich = await fetchLastProduct(creds, email);
        productCache.set(email, { product: rich, ts: Date.now() });
        if (student?.id && rich.name) {
          const updates: Record<string, unknown> = { product_type: rich.productType, product_name: rich.fullName, plan: rich.fullName };
          supabase.from('students').update(updates).eq('id', student.id).then(() => {}, () => {});
        }
      } catch {
        if (!productType) return Response.json({ ...ERROR_RESULT, manualActiveUntil: manualUntil ?? null });
      }
    } else if (!productType) {
      console.error('[check-subscription] WooCommerce no configurado');
      return Response.json({ ...ERROR_RESULT, manualActiveUntil: manualUntil ?? null });
    }
  }

  if (rich?.name) { productName = rich.name; productType = rich.productType; }
  const productVariation = rich?.variation ?? null;
  const productFullName  = rich?.fullName ?? productName;
  const hoursFromApi     = rich?.hours ?? null;
  const metaData         = rich?.metaData ?? [];

  // Constructor de respuesta con todos los campos de producto ya resueltos.
  const make = (o: Partial<SubResult>): SubResult => ({
    active: false, status: 'error', endDate: null, daysRemaining: null,
    planName: productName, productName, productVariation, productFullName,
    productType, hoursFromApi, manualActiveUntil: null, metaData, phone: null,
    ...o,
  });

  // 3) Ningún producto comprado → not_found.
  if (!productType) return Response.json(make({ active: false, status: 'not_found' }));

  // 4) PAGO ÚNICO → solo cuenta el acceso manual (manual_active_until).
  if (productType === 'one_time') {
    if (manualActive && manualUntil) {
      const endDate = new Date(manualUntil + 'T23:59:59');
      return Response.json(make({ active: true, status: 'manual_active', endDate: endDate.toISOString(), daysRemaining: daysFromNow(endDate), manualActiveUntil: manualUntil }));
    }
    return Response.json(make({ active: false, status: 'one_time_no_access', manualActiveUntil: manualUntil ?? null }));
  }

  // 5) SUSCRIPCIÓN. La activación manual sigue teniendo prioridad (override).
  if (manualActive && manualUntil) {
    const endDate = new Date(manualUntil + 'T23:59:59');
    return Response.json(make({ active: true, status: 'manual_override', endDate: endDate.toISOString(), daysRemaining: daysFromNow(endDate), manualActiveUntil: manualUntil }));
  }

  if (!creds) return Response.json(make({ active: null, status: 'error' }));

  let sub = subCache.get(email)?.result ?? null;
  if (!sub || Date.now() - (subCache.get(email)?.ts ?? 0) >= TTL_MS) {
    try {
      sub = await fetchSubStatus(creds, email);
      subCache.set(email, { result: sub, ts: Date.now() });
    } catch {
      return Response.json(make({ active: null, status: 'error' }));
    }
  }

  return Response.json(make({
    active: sub.active, status: sub.status, endDate: sub.endDate, daysRemaining: sub.daysRemaining, phone: sub.phone,
  }));
}
