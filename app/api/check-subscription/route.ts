// Verifica el acceso de un alumno en WooCommerce antes de permitir el ingreso a
// clase. Detecta si el último producto comprado es de SUSCRIPCIÓN recurrente o
// de PAGO ÚNICO, y aplica la lógica correspondiente. Nunca bloquea de forma dura:
// ante un error de conexión devuelve { active: null } para que el profesor decida.

import { supabase } from '@/lib/supabase';
import { parseHoursFromText, parseHoursFromMeta, detectLevel } from '@/lib/productUtils';
// La regla de "activo" (Woo OR manual OR Oritalk) vive en un módulo puro para
// que exista una sola definición. Ver lib/subscriptionAccess.ts.
import { accessOverrideOf, isActiveWooStatus, madridToday } from '@/lib/subscriptionAccess';

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
  status: string;                 // 'active'|'cancelled'|'on-hold'|'expired'|'pending-cancel'|'not_found'|'error'|'manual_override'|'manual_active'|'one_time_no_access'|'oritalk'
  endDate: string | null;
  daysRemaining: number | null;
  planName: string | null;        // = productName (compat hacia atrás)
  productName: string | null;
  productVariation: string | null;
  productFullName: string | null;
  productType: ProductType;
  hoursFromApi: number | null;    // horas detectadas desde WooCommerce
  manualActiveUntil: string | null;
  oritalkUntil: string | null;    // fecha de fin de Oritalk (null si no es de Oritalk)
  metaData: any[];                // meta_data crudo del line_item
  phone: string | null;
  billingName: string | null;            // nombre del cliente (billing) para autocompletar
  subscriptionStartDate: string | null;  // 'YYYY-MM-DD' — inicio de la suscripción / compra
  detectedLevel: string | null;          // nivel A1–C2 detectado del producto/meta
}

interface RichProduct {
  name: string | null;
  variation: string | null;
  fullName: string | null;
  hours: number | null;
  metaData: any[];
  productType: ProductType;
  billingName: string | null;
  orderDate: string | null;       // 'YYYY-MM-DD' — fecha de compra (fallback de inicio)
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(d: Date): number {
  return Math.max(0, Math.ceil((d.getTime() - Date.now()) / DAY_MS));
}

const ERROR_RESULT: SubResult = {
  active: null, status: 'error', endDate: null, daysRemaining: null,
  planName: null, productName: null, productVariation: null, productFullName: null,
  productType: null, hoursFromApi: null, manualActiveUntil: null, oritalkUntil: null,
  metaData: [], phone: null,
  billingName: null, subscriptionStartDate: null, detectedLevel: null,
};

// Convierte una fecha WooCommerce (ISO / 'YYYY-MM-DD HH:mm:ss') a 'YYYY-MM-DD'.
function toDateStr(raw: unknown): string | null {
  const d = parseWcDate(raw);
  if (!d) return null;
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Nombre del cliente a partir del objeto billing (first + last).
function billingNameFrom(billing: any): string | null {
  const first = String(billing?.first_name ?? '').trim();
  const last  = String(billing?.last_name ?? '').trim();
  const full = `${first} ${last}`.trim();
  return full || null;
}

// Cache en memoria (por instancia serverless): 5 min por email.
const TTL_MS = 5 * 60 * 1000;
const productCache = new Map<string, { product: RichProduct; ts: number }>();
const subCache     = new Map<string, { result: { active: boolean; status: string; endDate: string | null; daysRemaining: number | null; phone: string | null; planName: string | null; startDate: string | null }; ts: number }>();

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
  const order = arr[0];
  const li = order?.line_items?.[0];
  const billingName = billingNameFrom(order?.billing);
  // Fecha de compra: pago completado → pagado → creación (fallback de inicio).
  const orderDate = toDateStr(firstNonEmpty(order?.date_completed, order?.date_paid, order?.date_created));
  const name = (typeof li?.name === 'string' && li.name.trim()) ? li.name.trim() : null;
  if (!name) return { name: null, variation: null, fullName: null, hours: null, metaData: [], productType: null, billingName, orderDate };

  const metaData = Array.isArray(li?.meta_data) ? li.meta_data : [];
  const variation = li?.variation_id ? variationFromMeta(metaData) : variationFromMeta(metaData);
  const fullName = variation ? `${name} — ${variation}` : name;

  // Horas: meta_data → variación → nombre → concatenación amplia.
  const broad = `${name} ${metaData.map((m: any) => m?.display_value ?? m?.value ?? '').join(' ')}`;
  const hours = parseHoursFromMeta(metaData) ?? parseHoursFromText(variation) ?? parseHoursFromText(name) ?? parseHoursFromText(broad);

  const productType: ProductType = isOneTimeProduct(name) ? 'one_time' : 'subscription';
  return { name, variation, fullName, hours, metaData, productType, billingName, orderDate };
}

// Estado de la suscripción recurrente (como antes).
async function fetchSubStatus(c: { base: string; ck: string; cs: string }, email: string) {
  const url =
    `${c.base}/wp-json/wc/v3/subscriptions?search=${encodeURIComponent(email)}` +
    `&consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;
  const subs = await fetchWoo(url, email, 'subscriptions');
  if (subs.length === 0) {
    return { active: false, status: 'not_found', endDate: null, daysRemaining: null, phone: null, planName: null, startDate: null };
  }
  // Más reciente por start_date; se prioriza una que dé acceso si existe.
  const byRecent = [...subs].sort((a, b) => {
    const da = parseWcDate(a?.start_date)?.getTime() ?? 0;
    const db = parseWcDate(b?.start_date)?.getTime() ?? 0;
    return db - da;
  });
  // Antes acá solo se buscaba `status === 'active'`. Un alumno con una
  // 'pending-cancel' vigente y una 'cancelled' más nueva se quedaba con la
  // cancelada, cuando la que manda es la que todavía le da acceso.
  const chosen = byRecent.find(s => isActiveWooStatus(s?.status)) ?? byRecent[0];
  const status = String(chosen?.status ?? 'cancelled');
  const endDate = parseWcDate(firstNonEmpty(chosen?.end_date, chosen?.next_payment_date));
  const startDate = toDateStr(firstNonEmpty(chosen?.start_date, chosen?.date_created));
  const planName = (Array.isArray(chosen?.line_items) && typeof chosen.line_items[0]?.name === 'string') ? chosen.line_items[0].name : null;
  const phone = (typeof chosen?.billing?.phone === 'string' && chosen.billing.phone.trim()) ? chosen.billing.phone.trim() : null;
  return {
    // 'active' y 'pending-cancel' dan acceso; 'on-hold', 'cancelled' y 'expired'
    // no. El criterio vive en lib/subscriptionAccess y lo comparten el badge, el
    // popup de ingreso y finanzas.
    active: isActiveWooStatus(status),
    status,
    endDate: endDate ? endDate.toISOString() : null,
    daysRemaining: endDate ? daysFromNow(endDate) : null,
    phone, planName, startDate,
  };
}

export async function GET(request: Request): Promise<Response> {
  const email = new URL(request.url).searchParams.get('email')?.trim().toLowerCase();
  if (!email) return Response.json({ ...ERROR_RESULT, status: 'error' }, { status: 400 });

  // 1) Alumno en Supabase: overrides de acceso + producto persistido + plan local.
  let student: {
    id?: string; manual_active_until?: string | null;
    is_oritalk?: boolean | null; oritalk_until?: string | null;
    product_type?: string | null; product_name?: string | null; plan?: string | null;
  } | null = null;
  try {
    // select('*') para tolerar que product_type/product_name/is_oritalk aún no
    // existan en la BD (migración pendiente): las columnas faltantes vienen
    // undefined y accessOverrideOf las trata como "sin override".
    const { data } = await supabase
      .from('students')
      .select('*')
      .ilike('email', email).limit(1).maybeSingle();
    student = data;
  } catch { /* sin fila → seguimos */ }

  const today = madridToday();
  // Regla única de acceso: Oritalk vigente > activación manual vigente > Woo.
  const override = accessOverrideOf(student, today);
  const manualUntil = student?.manual_active_until ?? null;
  const oritalkUntil = student?.is_oritalk ? (student.oritalk_until ?? null) : null;

  const creds = wcCreds();
  // ?full=1 → fuerza traer la info rica del pedido (variación + horas + meta),
  // usado por los formularios de asignación. Sin él se usa lo persistido (liviano).
  const full = new URL(request.url).searchParams.get('full') === '1';

  // 2) ORITALK — se resuelve ANTES de tocar WooCommerce.
  //
  // Un alumno de Oritalk es, por definición, uno que Woo da como "sin verificar":
  // preguntarle a Woo no aporta nada y, peor, si la API está caída o el alumno no
  // tiene ningún pedido, las ramas de abajo cortan con `error`/`not_found` y el
  // alumno perdería su acceso por un motivo que nada tiene que ver con él.
  //
  // Excepción: con ?full=1 sí se sigue, porque los formularios de asignación
  // necesitan la info rica del pedido. Ahí Oritalk se aplica más abajo, sobre
  // `make()`, sin perder el producto.
  if (override?.kind === 'oritalk' && !full) {
    const end = new Date(override.until + 'T23:59:59');
    return Response.json({
      ...ERROR_RESULT,
      active: true,
      status: 'oritalk',
      endDate: end.toISOString(),
      daysRemaining: daysFromNow(end),
      // Lo persistido: un alumno de Oritalk no tiene producto en Woo, pero puede
      // tener plan cargado a mano y la lista lo muestra en su columna.
      planName:        student?.product_name ?? student?.plan ?? null,
      productName:     student?.product_name ?? student?.plan ?? null,
      productFullName: student?.product_name ?? student?.plan ?? null,
      productType:     (student?.product_type as ProductType) ?? null,
      manualActiveUntil: manualUntil,
      oritalkUntil:      override.until,
    } satisfies SubResult);
  }

  // 3) Producto: usa lo persistido; trae el pedido (info rica) si se pide `full`
  //    o si no hay tipo persistido. Lo detectado se persiste (incl. plan).
  let productName = student?.product_name ?? null;
  let productType = (student?.product_type as ProductType) ?? null;
  let rich: RichProduct | null = null;

  // Woo no contestó y no hay producto persistido. Un override vigente vale igual:
  // el acceso de Oritalk / manual no puede caerse porque WooCommerce esté caído.
  const woocommerceDown = (): Response => {
    if (override) {
      const end = new Date(override.until + 'T23:59:59');
      return Response.json({
        ...ERROR_RESULT,
        active: true,
        status: override.kind === 'oritalk' ? 'oritalk' : 'manual_override',
        endDate: end.toISOString(),
        daysRemaining: daysFromNow(end),
        manualActiveUntil: manualUntil,
        oritalkUntil,
      } satisfies SubResult);
    }
    return Response.json({ ...ERROR_RESULT, manualActiveUntil: manualUntil ?? null, oritalkUntil });
  };

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
        if (!productType) return woocommerceDown();
      }
    } else if (!productType) {
      console.error('[check-subscription] WooCommerce no configurado');
      return woocommerceDown();
    }
  }

  if (rich?.name) { productName = rich.name; productType = rich.productType; }
  const productVariation = rich?.variation ?? null;
  const productFullName  = rich?.fullName ?? productName;
  const hoursFromApi     = rich?.hours ?? null;
  const metaData         = rich?.metaData ?? [];
  const billingName      = rich?.billingName ?? null;
  const orderDate        = rich?.orderDate ?? null;     // fallback de fecha de inicio
  const detectedLevel    = detectLevel(productFullName, metaData);

  // Constructor de respuesta con todos los campos de producto ya resueltos.
  // subscriptionStartDate por defecto = fecha de compra; la suscripción la refina.
  const make = (o: Partial<SubResult>): SubResult => ({
    active: false, status: 'error', endDate: null, daysRemaining: null,
    planName: productName, productName, productVariation, productFullName,
    productType, hoursFromApi, manualActiveUntil: null, oritalkUntil, metaData, phone: null,
    billingName, subscriptionStartDate: orderDate, detectedLevel,
    ...o,
  });

  // Respuesta de un override vigente (Oritalk o manual). El `status` cambia según
  // el origen para que el badge sepa de cuál se trata; el `active` es el mismo.
  const overrideResult = (kind: 'oritalk' | 'manual', until: string) => {
    const end = new Date(until + 'T23:59:59');
    return make({
      active: true,
      status: kind === 'oritalk' ? 'oritalk' : (productType === 'one_time' ? 'manual_active' : 'manual_override'),
      endDate: end.toISOString(),
      daysRemaining: daysFromNow(end),
      manualActiveUntil: kind === 'manual' ? until : manualUntil,
      oritalkUntil: kind === 'oritalk' ? until : oritalkUntil,
    });
  };

  // 4) Oritalk vigente (solo se llega acá con ?full=1: sin él ya se resolvió arriba).
  //    Gana sobre todo lo demás, incluso sobre una suscripción activa: es una
  //    decisión explícita del admin y tiene su propio badge.
  if (override?.kind === 'oritalk') return Response.json(overrideResult('oritalk', override.until));

  // 5) Ningún producto comprado → not_found.
  if (!productType) return Response.json(make({ active: false, status: 'not_found' }));

  // 6) PAGO ÚNICO → solo cuenta el acceso manual (manual_active_until).
  if (productType === 'one_time') {
    if (override?.kind === 'manual') return Response.json(overrideResult('manual', override.until));
    return Response.json(make({ active: false, status: 'one_time_no_access', manualActiveUntil: manualUntil ?? null }));
  }

  // 7) SUSCRIPCIÓN. La activación manual sigue teniendo prioridad (override).
  if (override?.kind === 'manual') return Response.json(overrideResult('manual', override.until));

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
    subscriptionStartDate: sub.startDate ?? orderDate,
  }));
}
