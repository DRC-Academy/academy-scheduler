// ── Sincronización de programas desde WooCommerce ────────────────────────────
//
// Llena `student_programs` (una fila por pedido de origen) a partir de los
// pedidos pagados de los 7 productos de lib/programs. SOLO SERVIDOR.
//
// QUÉ SE TRAE
//   · `orders?product=<id>&status=processing,completed` de cada producto,
//     paginado. Cancelados, reembolsados y fallidos ni se piden.
//   · Las RENOVACIONES de suscripción se descartan: Woo las crea con
//     `created_via = 'subscription'` y el metadato `_subscription_renewal`. El
//     pedido de origen de un fraccionado es el de alta (cuota de alta).
//   · Fraccionado: la suscripción del pedido, para su estado y su end_date.
//
// QUÉ SE REFRESCA
//   · Filas que estaban pagadas y que esta pasada ya no trae: su pedido cambió
//     de estado (cancelado/reembolsado). Se relee por ID y se guarda el estado
//     nuevo: así quedan fuera del acceso y del aviso.
//   · El estado de TODAS las suscripciones conocidas (on-hold, cancelada…), en
//     lotes con `include=`.
//
// ENLACE CON EL ALUMNO: por email (facturación = students.email). Un enlace
// MANUAL (link_source = 'manual') no se pisa nunca: es el caso de los programas
// de menores, donde factura el padre.
//
// FECHAS DE WOO: la API v3 devuelve las de suscripción como `*_gmt` (end_date_gmt,
// start_date_gmt…). El código anterior pedía `end_date` a secas, y probablemente
// por eso la auditoría del 07/08/2026 nunca vio una fecha de fin. Acá se leen
// las dos formas (lib/programs.firstWooDate).

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PROGRAM_PRODUCT_IDS, programOfProductId, firstWooDate, computedEndDate,
  isOrderPaid, type StudentProgramRow,
} from '@/lib/programs';

const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 600;
const PER_PAGE = 100;
const MAX_PAGES = 30;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface WooCreds { base: string; ck: string; cs: string }

export function wooCreds(): WooCreds | null {
  const base = process.env.WOOCOMMERCE_URL;
  const ck = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!base || !ck || !cs) return null;
  return { base: base.replace(/\/$/, ''), ck, cs };
}

/** GET a la API de Woo con timeout y reintentos. Lanza si no hay respuesta válida. */
async function wooGet(c: WooCreds, path: string, params: Record<string, string | number> = {}): Promise<unknown> {
  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    consumer_key: c.ck, consumer_secret: c.cs,
  });
  const url = `${c.base}/wp-json/wc/v3/${path}?${qs}`;
  let last = 'error desconocido';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
      // 404 no mejora reintentando (pedido inexistente, endpoint que no existe).
      if (res.status === 404 || res.status === 400) break;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      last = err?.name === 'AbortError' ? `timeout tras ${TIMEOUT_MS}ms` : String(err?.message ?? e);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  throw new Error(`Woo ${path}: ${last}`);
}

async function wooList(c: WooCreds, path: string, params: Record<string, string | number>): Promise<WooObj[]> {
  const out: WooObj[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await wooGet(c, path, { ...params, per_page: PER_PAGE, page });
    const arr = Array.isArray(data) ? (data as WooObj[]) : [];
    out.push(...arr);
    if (arr.length < PER_PAGE) break;
  }
  return out;
}

type WooObj = Record<string, unknown>;

interface WooLine { product_id?: unknown; variation_id?: unknown }
interface WooMeta { key?: unknown; value?: unknown }

const RENEWAL_META = new Set(['_subscription_renewal', '_subscription_switch']);

/** ¿Es una renovación (o un cambio) de suscripción y no un pedido de origen? */
export function isRenewalOrder(order: WooObj): boolean {
  if (order.created_via === 'subscription') return true;
  const meta = Array.isArray(order.meta_data) ? (order.meta_data as WooMeta[]) : [];
  return meta.some(m => RENEWAL_META.has(String(m?.key ?? '')));
}

function programLineOf(order: WooObj) {
  const lines = Array.isArray(order.line_items) ? (order.line_items as WooLine[]) : [];
  for (const li of lines) {
    const p = programOfProductId(li.product_id, li.variation_id);
    if (!p) continue;
    const productId = PROGRAM_PRODUCT_IDS.includes(Number(li.product_id)) ? Number(li.product_id) : Number(li.variation_id);
    return { product: p, productId };
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** La suscripción que nació de este pedido (fraccionado). null si Woo no la da. */
async function subscriptionForOrder(c: WooCreds, orderId: number, email: string | null, productId: number): Promise<WooObj | null> {
  // 1) Endpoint propio de WooCommerce Subscriptions.
  try {
    const data = await wooGet(c, `orders/${orderId}/subscriptions`);
    if (Array.isArray(data) && data.length) return data[0] as WooObj;
  } catch { /* se prueba la siguiente vía */ }
  // 2) Filtro por pedido padre.
  try {
    const data = await wooGet(c, 'subscriptions', { parent: orderId });
    const arr = Array.isArray(data) ? (data as WooObj[]) : [];
    const hit = arr.find(s => Number(s.parent_id) === orderId);
    if (hit) return hit;
  } catch { /* idem */ }
  // 3) Búsqueda por email, quedándose con la del mismo pedido padre o producto.
  if (email) {
    try {
      const data = await wooGet(c, 'subscriptions', { search: email });
      const arr = Array.isArray(data) ? (data as WooObj[]) : [];
      const hit = arr.find(s => Number(s.parent_id) === orderId)
        ?? arr.find(s => (Array.isArray(s.line_items) ? (s.line_items as WooLine[]) : []).some(li => Number(li.product_id) === productId));
      if (hit) return hit;
    } catch { /* sin suscripción */ }
  }
  return null;
}

type ProgramFields = Omit<StudentProgramRow,
  'id' | 'student_id' | 'link_source' | 'linked_by' | 'linked_at' | 'renewal_notified_at' | 'renewal_notified_for'>;

/** Fila (sin enlace ni aviso) a partir de un pedido de programa. null si no lo es. */
export async function programFieldsFromOrder(
  c: WooCreds, order: WooObj, knownSubId?: number | null,
  /** Suscripciones ya traídas en lote (syncPrograms): evita una llamada por pedido. */
  subsById?: Map<number, WooObj>,
): Promise<ProgramFields | null> {
  const line = programLineOf(order);
  if (!line) return null;
  const orderId = Number(order.id);
  const billing = (order.billing ?? {}) as WooObj;
  const email = str(billing.email)?.toLowerCase() ?? null;
  const name = [str(billing.first_name), str(billing.last_name)].filter(Boolean).join(' ') || null;
  const start = firstWooDate(order, 'date_paid') ?? firstWooDate(order, 'date_completed') ?? firstWooDate(order, 'date_created');

  let subscriptionId: number | null = null;
  let subscriptionStatus: string | null = null;
  let end: string | null = null;
  let source: 'woo' | 'calculada' = 'calculada';

  if (line.product.paymentMode === 'fraccionado') {
    let sub: WooObj | null = knownSubId ? subsById?.get(knownSubId) ?? null : null;
    if (knownSubId && !sub) {
      try { sub = (await wooGet(c, `subscriptions/${knownSubId}`)) as WooObj; } catch { sub = null; }
    }
    sub ??= await subscriptionForOrder(c, orderId, email, line.productId);
    if (sub) {
      subscriptionId = num(sub.id);
      subscriptionStatus = str(sub.status);
      const subEnd = firstWooDate(sub, 'end_date');
      if (subEnd) { end = subEnd; source = 'woo'; }
    }
  }
  end ??= computedEndDate(start, line.product.months);

  return {
    order_id: orderId,
    customer_id: num(order.customer_id),
    email,
    billing_name: name,
    billing_phone: str(billing.phone),
    product_id: line.productId,
    program: line.product.program,
    payment_mode: line.product.paymentMode,
    months: line.product.months,
    start_date: start,
    end_date: end,
    end_date_source: source,
    order_status: str(order.status),
    subscription_id: subscriptionId,
    subscription_status: subscriptionStatus,
    synced_at: new Date().toISOString(),
  };
}

// ── Alumnos ──────────────────────────────────────────────────────────────────

async function studentIdsByEmail(admin: SupabaseClient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('students').select('id, email').order('id').range(from, from + 999);
    if (error) throw new Error(`students: ${error.message}`);
    for (const s of data ?? []) {
      const e = String(s.email ?? '').trim().toLowerCase();
      if (e && !out.has(e)) out.set(e, String(s.id));
    }
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

export async function loadAllPrograms(admin: SupabaseClient): Promise<StudentProgramRow[]> {
  const { data, error } = await admin.from('student_programs').select('*').order('start_date', { ascending: false });
  if (error) throw new Error(`student_programs: ${error.message}`);
  return (data ?? []) as StudentProgramRow[];
}

/** Enlace que le corresponde a una fila: el manual se respeta, si no, por email. */
function linkFor(
  existing: StudentProgramRow | undefined, email: string | null, byEmail: Map<string, string>,
): { student_id: string | null; link_source: 'email' | 'manual' | null } {
  if (existing?.link_source === 'manual') {
    return { student_id: existing.student_id, link_source: 'manual' };
  }
  const sid = email ? byEmail.get(email) ?? null : null;
  return { student_id: sid, link_source: sid ? 'email' : null };
}

// ── Sincronización completa ──────────────────────────────────────────────────

export interface SyncSummary {
  ordersSeen: number;
  renewalsSkipped: number;
  upserted: number;
  refreshedOrders: number;
  refreshedSubscriptions: number;
  linkedByEmail: number;
  unlinked: number;
  errors: string[];
}

export async function syncPrograms(admin: SupabaseClient, c: WooCreds): Promise<SyncSummary> {
  const summary: SyncSummary = {
    ordersSeen: 0, renewalsSkipped: 0, upserted: 0, refreshedOrders: 0,
    refreshedSubscriptions: 0, linkedByEmail: 0, unlinked: 0, errors: [],
  };
  const existing = new Map((await loadAllPrograms(admin)).map(r => [Number(r.order_id), r]));
  const byEmail = await studentIdsByEmail(admin);

  // 1) Pedidos pagados de cada producto. Un pedido con dos programas sale en dos
  //    listados: se procesa una vez.
  const orders = new Map<number, WooObj>();
  for (const pid of PROGRAM_PRODUCT_IDS) {
    try {
      const list = await wooList(c, 'orders', { product: pid, status: 'processing,completed' });
      for (const o of list) {
        summary.ordersSeen++;
        if (isRenewalOrder(o)) { summary.renewalsSkipped++; continue; }
        orders.set(Number(o.id), o);
      }
    } catch (e) {
      summary.errors.push(`producto ${pid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 1-bis) Las suscripciones YA CONOCIDAS, en lotes de 100 con `include=`. Así
  //   la sincronización hace una llamada por cada 100 fraccionados, no una por
  //   alumno: corre dentro del cron followups-nivel y comparte sus 60 s. Solo
  //   los pedidos nuevos buscan su suscripción uno a uno (subscriptionForOrder).
  const subsById = new Map<number, WooObj>();
  const knownSubIds = [...existing.values()].filter(r => r.subscription_id).map(r => Number(r.subscription_id));
  for (let i = 0; i < knownSubIds.length; i += PER_PAGE) {
    const ids = knownSubIds.slice(i, i + PER_PAGE);
    try {
      for (const sub of await wooList(c, 'subscriptions', { include: ids.join(','), status: 'any' })) {
        subsById.set(Number(sub.id), sub);
      }
    } catch (e) {
      summary.errors.push(`refresco de suscripciones: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const rows: Record<string, unknown>[] = [];
  for (const [orderId, order] of orders) {
    const prev = existing.get(orderId);
    try {
      const fields = await programFieldsFromOrder(c, order, prev?.subscription_id ?? null, subsById);
      if (!fields) continue;
      if (fields.subscription_id && subsById.has(fields.subscription_id)) summary.refreshedSubscriptions++;
      rows.push({ ...fields, ...linkFor(prev, fields.email, byEmail) });
    } catch (e) {
      summary.errors.push(`pedido ${orderId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2) Filas que estaban pagadas y ya no salen: el pedido cambió de estado. Si
  //    algún producto falló arriba no se puede distinguir "no salió" de "no se
  //    pidió", así que en ese caso no se toca nada.
  const productFailed = summary.errors.some(e => e.startsWith('producto '));
  const missing = productFailed ? [] : [...existing.values()]
    .filter(r => isOrderPaid(r.order_status) && !orders.has(Number(r.order_id)))
    .map(r => Number(r.order_id));
  for (let i = 0; i < missing.length; i += PER_PAGE) {
    const ids = missing.slice(i, i + PER_PAGE);
    try {
      const list = await wooList(c, 'orders', { include: ids.join(','), status: 'any' });
      const seen = new Set<number>();
      for (const o of list) {
        seen.add(Number(o.id));
        rows.push({ order_id: Number(o.id), order_status: str(o.status), synced_at: new Date().toISOString() });
        summary.refreshedOrders++;
      }
      // Pedido borrado en Woo: deja de contar como pagado.
      for (const id of ids) {
        if (!seen.has(id)) rows.push({ order_id: id, order_status: 'deleted', synced_at: new Date().toISOString() });
      }
    } catch (e) {
      summary.errors.push(`refresco de pedidos: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3) Estado de las suscripciones de filas que no salieron en el paso 1 (pedido
  //    ya no pagado): sale del lote del paso 1-bis, sin más llamadas.
  for (const r of existing.values()) {
    if (!r.subscription_id || orders.has(Number(r.order_id))) continue;
    const sub = subsById.get(Number(r.subscription_id));
    if (!sub) continue;
    rows.push({ order_id: Number(r.order_id), subscription_status: str(sub.status), synced_at: new Date().toISOString() });
    summary.refreshedSubscriptions++;
  }

  // Un upsert por forma de fila: PostgREST exige las mismas columnas en un lote.
  const full = rows.filter(r => 'program' in r);
  const partial = rows.filter(r => !('program' in r));
  if (full.length) {
    const { error } = await admin.from('student_programs').upsert(full, { onConflict: 'order_id' });
    if (error) summary.errors.push(`guardado: ${error.message}`);
    else summary.upserted += full.length;
  }
  for (const r of partial) {
    const { order_id, ...upd } = r;
    const { error } = await admin.from('student_programs').update(upd).eq('order_id', order_id as number);
    if (error) summary.errors.push(`pedido ${order_id}: ${error.message}`);
  }

  for (const r of full) {
    if (r.student_id) summary.linkedByEmail += r.link_source === 'email' ? 1 : 0;
    else summary.unlinked++;
  }
  return summary;
}

/**
 * Relee de Woo los pedidos indicados (estado, suscripción, fechas) y los guarda.
 * La usan el envío manual y el enlace manual para no trabajar con datos de ayer.
 */
export async function refreshProgramOrders(admin: SupabaseClient, c: WooCreds, orderIds: number[]): Promise<StudentProgramRow[]> {
  const existing = new Map((await loadAllPrograms(admin)).map(r => [Number(r.order_id), r]));
  const byEmail = await studentIdsByEmail(admin);
  const out: StudentProgramRow[] = [];
  for (const id of orderIds) {
    const order = (await wooGet(c, `orders/${id}`)) as WooObj;
    // Una renovación no es un pedido de origen: no se guarda.
    if (isRenewalOrder(order)) throw new Error(`El pedido #${id} es una renovación de suscripción, no un pedido de origen.`);
    const prev = existing.get(id);
    const fields = await programFieldsFromOrder(c, order, prev?.subscription_id ?? null);
    if (!fields) throw new Error(`El pedido #${id} no contiene ningún producto de programa.`);
    const row = { ...fields, ...linkFor(prev, fields.email, byEmail) };
    const { data, error } = await admin.from('student_programs')
      .upsert(row, { onConflict: 'order_id' }).select('*').single();
    if (error) throw new Error(`guardado del pedido #${id}: ${error.message}`);
    out.push(data as StudentProgramRow);
  }
  return out;
}

/** Enlace manual de un pedido de programa a un alumno (o lo quita, con studentId null). */
export async function linkProgramManually(
  admin: SupabaseClient, c: WooCreds | null, orderId: number, studentId: string | null, by: string,
): Promise<StudentProgramRow> {
  if (studentId) {
    const { data: st, error } = await admin.from('students').select('id').eq('id', studentId).maybeSingle();
    if (error) throw new Error(`students: ${error.message}`);
    if (!st) throw new Error('Ese alumno no existe en Gestión.');
  }

  // Si el pedido todavía no está sincronizado, se trae de Woo.
  const { data: found } = await admin.from('student_programs').select('order_id').eq('order_id', orderId).maybeSingle();
  if (!found) {
    if (!c) throw new Error('WooCommerce no está configurado y el pedido aún no está sincronizado.');
    await refreshProgramOrders(admin, c, [orderId]);
  }

  const upd = studentId
    ? { student_id: studentId, link_source: 'manual', linked_by: by, linked_at: new Date().toISOString() }
    // Quitar el enlace manual: la próxima sincronización lo volverá a enlazar por
    // email si coincide con algún alumno.
    : { student_id: null, link_source: null, linked_by: by, linked_at: new Date().toISOString() };
  const { data, error } = await admin.from('student_programs').update(upd).eq('order_id', orderId).select('*').single();
  if (error) throw new Error(`enlace del pedido #${orderId}: ${error.message}`);
  return data as StudentProgramRow;
}

/** Estado de UNA suscripción en el momento (para el acceso). Lanza si Woo falla. */
export async function liveSubscriptionStatus(c: WooCreds, subscriptionId: number): Promise<string | null> {
  const sub = (await wooGet(c, `subscriptions/${subscriptionId}`)) as WooObj;
  return str(sub?.status);
}
