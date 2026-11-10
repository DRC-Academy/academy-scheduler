// ── Sincronización de programas desde WooCommerce → student_programs ─────────
//
// Llena `student_programs` (una fila por pedido de ORIGEN) con los pedidos de
// los programas con aviso de renovación (lib/programRenewal.RENEWAL_PROGRAMS,
// sobre el catálogo de lib/productCatalog). SOLO SERVIDOR. Solo la usa el aviso
// de renovación: NO toca `students` ni el acceso.
//
// QUÉ SE TRAE
//   · `orders?product=<id>&status=processing,completed` de cada producto,
//     paginado. Cancelados, reembolsados y fallidos ni se piden.
//   · Las RENOVACIONES de suscripción se descartan (`created_via =
//     'subscription'` o metadato `_subscription_renewal`): el pedido de origen
//     de un fraccionado es el de alta.
//   · Fraccionado: su suscripción, para el estado y el end_date_gmt.
//
// QUÉ SE REFRESCA
//   · Filas que estaban pagadas y esta pasada ya no trae: su pedido cambió de
//     estado (cancelado/reembolsado). Se relee por ID y se guarda el estado
//     nuevo, así quedan fuera del aviso.
//   · El estado de las suscripciones conocidas, en lotes con `include=`.
//
// FECHAS: ver lib/programRenewal (oneTimeProgramDates / splitProgramDates).
//
// ENLACE CON EL ALUMNO: por email (facturación = students.email). Un enlace
// MANUAL (link_source = 'manual') no se pisa nunca.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  RENEWAL_PRODUCT_IDS, renewalProgramOf, firstWooDate, isOrderPaid,
  oneTimeProgramDates, splitProgramDates,
  type StudentProgramRow, type GestionPlan, type EndDateOrigin,
} from '@/lib/programRenewal';

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
      // 404/400 no mejoran reintentando (pedido inexistente, endpoint que no existe).
      if (res.status === 404 || res.status === 400) break;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      last = err?.name === 'AbortError' ? `timeout tras ${TIMEOUT_MS}ms` : String(err?.message ?? e);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  // Nunca se incluye la URL: lleva las claves de Woo en la query.
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

/** La primera línea del pedido que es un programa con aviso. */
export function programLineOf(order: WooObj) {
  const lines = Array.isArray(order.line_items) ? (order.line_items as WooLine[]) : [];
  for (const li of lines) {
    const p = renewalProgramOf(li.product_id, li.variation_id);
    if (p) return p;
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** Fecha de pago del pedido (Madrid). */
export function orderPaidDate(order: WooObj): string | null {
  return firstWooDate(order, 'date_paid') ?? firstWooDate(order, 'date_completed') ?? firstWooDate(order, 'date_created');
}

/** La suscripción que nació de este pedido (fraccionado). null si Woo no la da. */
async function subscriptionForOrder(c: WooCreds, orderId: number, email: string | null, productId: number): Promise<WooObj | null> {
  try {
    const data = await wooGet(c, `orders/${orderId}/subscriptions`);
    if (Array.isArray(data) && data.length) return data[0] as WooObj;
  } catch { /* se prueba la siguiente vía */ }
  try {
    const data = await wooGet(c, 'subscriptions', { parent: orderId, status: 'any' });
    const arr = Array.isArray(data) ? (data as WooObj[]) : [];
    const hit = arr.find(s => Number(s.parent_id) === orderId);
    if (hit) return hit;
  } catch { /* idem */ }
  if (email) {
    try {
      const data = await wooGet(c, 'subscriptions', { search: email, status: 'any' });
      const arr = Array.isArray(data) ? (data as WooObj[]) : [];
      const hit = arr.find(s => Number(s.parent_id) === orderId)
        ?? arr.find(s => (Array.isArray(s.line_items) ? (s.line_items as WooLine[]) : [])
          .some(li => renewalProgramOf(li.product_id, li.variation_id)?.productId === productId));
      if (hit) return hit;
    } catch { /* sin suscripción */ }
  }
  return null;
}

// ── Alumnos de Gestión ───────────────────────────────────────────────────────

interface StudentLite extends GestionPlan { id: string; email: string | null }

interface Students {
  byId: Map<string, StudentLite>;
  byEmail: Map<string, StudentLite>;
}

const STUDENT_COLS = 'id, email, woo_product_id, company_plan_start, manual_active_until';
const STUDENT_COLS_BASE = 'id, email, manual_active_until';

async function loadStudents(admin: SupabaseClient): Promise<Students> {
  const byId = new Map<string, StudentLite>();
  const byEmail = new Map<string, StudentLite>();
  let cols = STUDENT_COLS;
  for (let from = 0; ; from += 1000) {
    let res = await admin.from('students').select(cols).order('id').range(from, from + 999);
    // Sin las columnas de la oferta nueva se sigue con lo básico: el pago único
    // cae en "pago + meses", que es lo que había antes.
    if (res.error && cols === STUDENT_COLS && (res.error.code === '42703' || res.error.code === 'PGRST204')) {
      cols = STUDENT_COLS_BASE;
      res = await admin.from('students').select(cols).order('id').range(from, from + 999);
    }
    if (res.error) throw new Error(`students: ${res.error.message}`);
    const data = (res.data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const s of data) {
      const st: StudentLite = {
        id: String(s.id),
        email: str(s.email)?.toLowerCase() ?? null,
        woo_product_id: num(s.woo_product_id),
        company_plan_start: str(s.company_plan_start),
        manual_active_until: str(s.manual_active_until),
      };
      byId.set(st.id, st);
      if (st.email && !byEmail.has(st.email)) byEmail.set(st.email, st);
    }
    if (data.length < 1000) break;
  }
  return { byId, byEmail };
}

export async function loadAllPrograms(admin: SupabaseClient): Promise<StudentProgramRow[]> {
  const { data, error } = await admin.from('student_programs').select('*').order('start_date', { ascending: false });
  if (error) throw new Error(`student_programs: ${error.message}`);
  return (data ?? []) as StudentProgramRow[];
}

/** Enlace que le corresponde a una fila: el manual se respeta; si no, por email. */
function linkFor(
  existing: Pick<StudentProgramRow, 'link_source' | 'student_id'> | undefined, email: string | null, st: Students,
): { student_id: string | null; link_source: 'email' | 'manual' | null } {
  if (existing?.link_source === 'manual') return { student_id: existing.student_id, link_source: 'manual' };
  const sid = email ? st.byEmail.get(email)?.id ?? null : null;
  return { student_id: sid, link_source: sid ? 'email' : null };
}

/** Pedido pagado conocido, para decidir cuál es el ÚLTIMO de un producto por alumno. */
interface KnownOrder { orderId: number; studentId: string | null; productId: number; paid: string | null }

/**
 * Las fechas de Gestión valen para este pedido solo si el alumno tiene apuntado
 * ESTE producto y no hay un pedido pagado más nuevo del mismo producto suyo.
 */
function gestionFor(
  studentId: string | null, productId: number, orderId: number, paid: string | null,
  st: Students, known: KnownOrder[],
): GestionPlan | null {
  if (!studentId) return null;
  const s = st.byId.get(studentId);
  if (!s || s.woo_product_id !== productId) return null;
  const newer = known.some(k => k.orderId !== orderId && k.studentId === studentId && k.productId === productId
    && ((k.paid ?? '') > (paid ?? '') || ((k.paid ?? '') === (paid ?? '') && k.orderId > orderId)));
  return newer ? null : s;
}

type ProgramFields = Omit<StudentProgramRow,
  'id' | 'student_id' | 'link_source' | 'linked_by' | 'linked_at' | 'renewal_notified_at' | 'renewal_notified_for'>;

export interface BuiltProgram { fields: ProgramFields; link: ReturnType<typeof linkFor>; origin: EndDateOrigin | null }

async function buildProgram(
  c: WooCreds, order: WooObj, prev: StudentProgramRow | undefined, st: Students, known: KnownOrder[],
  subsById?: Map<number, WooObj>,
): Promise<BuiltProgram | null> {
  const line = programLineOf(order);
  if (!line) return null;
  const orderId = Number(order.id);
  const billing = (order.billing ?? {}) as WooObj;
  const email = str(billing.email)?.toLowerCase() ?? null;
  const name = [str(billing.first_name), str(billing.last_name)].filter(Boolean).join(' ') || null;
  const paid = orderPaidDate(order);
  const link = linkFor(prev, email, st);

  let subscriptionId: number | null = null;
  let subscriptionStatus: string | null = null;
  let dates;
  if (line.paymentMode === 'fraccionado') {
    const knownSubId = prev?.subscription_id ?? null;
    let sub: WooObj | null = knownSubId ? subsById?.get(Number(knownSubId)) ?? null : null;
    if (knownSubId && !sub) {
      try { sub = (await wooGet(c, `subscriptions/${knownSubId}`)) as WooObj; } catch { sub = null; }
    }
    sub ??= await subscriptionForOrder(c, orderId, email, line.productId);
    if (sub) { subscriptionId = num(sub.id); subscriptionStatus = str(sub.status); }
    dates = splitProgramDates(paid, line.months, sub);
  } else {
    dates = oneTimeProgramDates(paid, line.months, gestionFor(link.student_id, line.productId, orderId, paid, st, known));
  }

  return {
    fields: {
      order_id: orderId,
      customer_id: num(order.customer_id),
      email,
      billing_name: name,
      billing_phone: str(billing.phone),
      product_id: line.productId,
      program: line.program,
      payment_mode: line.paymentMode,
      months: line.months,
      start_date: dates.start,
      end_date: dates.end,
      end_date_source: dates.source,
      order_status: str(order.status),
      subscription_id: subscriptionId,
      subscription_status: subscriptionStatus,
      synced_at: new Date().toISOString(),
    },
    link,
    origin: dates.origin,
  };
}

// ── Sincronización completa ──────────────────────────────────────────────────

export interface SyncSummary {
  ordersSeen: number;
  renewalsSkipped: number;
  upserted: number;
  refreshedOrders: number;
  refreshedSubscriptions: number;
  linked: number;
  unlinked: number;
  /** Pedido → de dónde salió su fecha de fin (para el modo dry). */
  endOrigin: Record<number, EndDateOrigin | null>;
  errors: string[];
}

export async function syncPrograms(admin: SupabaseClient, c: WooCreds): Promise<SyncSummary> {
  const summary: SyncSummary = {
    ordersSeen: 0, renewalsSkipped: 0, upserted: 0, refreshedOrders: 0,
    refreshedSubscriptions: 0, linked: 0, unlinked: 0, endOrigin: {}, errors: [],
  };
  const existing = new Map((await loadAllPrograms(admin)).map(r => [Number(r.order_id), r]));
  const st = await loadStudents(admin);

  // 1) Pedidos pagados de cada producto (un pedido con dos programas sale dos veces).
  const orders = new Map<number, WooObj>();
  for (const pid of RENEWAL_PRODUCT_IDS) {
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

  // 1-bis) Suscripciones ya conocidas, en lotes de 100: una llamada por cada 100
  //   fraccionados, no una por alumno (corre dentro de los 60 s de otro cron).
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

  // Pedidos pagados de esta pasada, para saber cuál es el último de cada alumno.
  const known: KnownOrder[] = [...orders.values()].map(o => {
    const line = programLineOf(o);
    const email = str(((o.billing ?? {}) as WooObj).email)?.toLowerCase() ?? null;
    return {
      orderId: Number(o.id),
      studentId: linkFor(existing.get(Number(o.id)), email, st).student_id,
      productId: line?.productId ?? 0,
      paid: orderPaidDate(o),
    };
  });

  const rows: Record<string, unknown>[] = [];
  for (const [orderId, order] of orders) {
    try {
      const built = await buildProgram(c, order, existing.get(orderId), st, known, subsById);
      if (!built) continue;
      if (built.fields.subscription_id && subsById.has(built.fields.subscription_id)) summary.refreshedSubscriptions++;
      summary.endOrigin[orderId] = built.origin;
      rows.push({ ...built.fields, ...built.link });
    } catch (e) {
      summary.errors.push(`pedido ${orderId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2) Filas que estaban pagadas y ya no salen: el pedido cambió de estado. Si
  //    algún producto falló arriba no se distingue "no salió" de "no se pidió":
  //    entonces no se toca nada.
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

  // 3) Estado de las suscripciones de filas que no salieron en el paso 1.
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
    if (r.student_id) summary.linked++;
    else summary.unlinked++;
  }
  return summary;
}

/**
 * Relee de Woo los pedidos indicados y los guarda. La usa el envío manual para
 * no trabajar con datos de ayer.
 */
export async function refreshProgramOrders(admin: SupabaseClient, c: WooCreds, orderIds: number[]): Promise<StudentProgramRow[]> {
  const all = await loadAllPrograms(admin);
  const existing = new Map(all.map(r => [Number(r.order_id), r]));
  const st = await loadStudents(admin);
  const known: KnownOrder[] = all.filter(r => isOrderPaid(r.order_status)).map(r => ({
    orderId: Number(r.order_id), studentId: r.student_id, productId: Number(r.product_id), paid: r.start_date,
  }));
  const out: StudentProgramRow[] = [];
  for (const id of orderIds) {
    const order = (await wooGet(c, `orders/${id}`)) as WooObj;
    if (isRenewalOrder(order)) throw new Error(`El pedido #${id} es una renovación de suscripción, no un pedido de origen.`);
    const built = await buildProgram(c, order, existing.get(id), st, known);
    if (!built) throw new Error(`El pedido #${id} no contiene ningún programa con aviso de renovación.`);
    const { data, error } = await admin.from('student_programs')
      .upsert({ ...built.fields, ...built.link }, { onConflict: 'order_id' }).select('*').single();
    if (error) throw new Error(`guardado del pedido #${id}: ${error.message}`);
    out.push(data as StudentProgramRow);
  }
  return out;
}
