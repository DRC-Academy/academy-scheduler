// ── Oferta nueva: lectura de Woo + escritura en la base (servidor) ────────────
//
// Las reglas viven en lib/planOrders (puras). Acá solo se trae lo que esas
// reglas necesitan —pedidos, suscripciones, alumnos, lo ya procesado— y se
// escribe lo que deciden. Tres entradas usan esto y nada más:
//
//   · /api/webhooks/order-updated  → un pedido, en el acto (autoOnly)
//   · cron check-ending-plans      → barrido diario de respaldo (autoOnly)
//   · /api/admin/planes-oferta     → puesta al día: GET simula, POST aplica
//
// SIN la tabla `woo_plan_events` (SQL sin correr) se puede SIMULAR pero no
// aplicar: sin registro de lo procesado no hay idempotencia, y escribir así
// podría correr fechas con cada webhook repetido. Se corta con un error claro.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildPlanEvents, eventKey, isFixedTermProgram, assignmentProgramDecision, assignmentProgramEvent,
  type ExistingEvent, type PlanEvent, type StudentLite, type AssignmentProgramDecision,
  type WooOrderLite, type WooSubscriptionLite, type WooLineItemLite,
} from '@/lib/planOrders';
import { catalogProduct } from '@/lib/productCatalog';

const TIMEOUT_MS = 15_000;
const PER_PAGE = 100;
const MAX_PAGES = 20;
/** Lo más viejo que mira cualquier pasada: el lanzamiento de la oferta nueva. */
export const OFFER_START = '2026-10-06';

export class PlanSyncError extends Error {}

// ── WooCommerce ──────────────────────────────────────────────────────────────

function wcCreds(): { base: string; ck: string; cs: string } | null {
  const base = process.env.WOOCOMMERCE_URL;
  const ck   = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs   = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!base || !ck || !cs) return null;
  return { base: base.replace(/\/$/, ''), ck, cs };
}

async function wooGet(path: string, params: Record<string, string | number>): Promise<unknown> {
  const c = wcCreds();
  if (!c) throw new PlanSyncError('WooCommerce no configurado');
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), consumer_key: c.ck, consumer_secret: c.cs });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${c.base}/wp-json/wc/v3/${path}?${qs}`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new PlanSyncError(`WooCommerce respondió ${res.status} en ${path}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function wooList(path: string, params: Record<string, string | number>): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await wooGet(path, { ...params, per_page: PER_PAGE, page });
    const arr = Array.isArray(data) ? data : [];
    all.push(...arr);
    if (arr.length < PER_PAGE) break;
  }
  return all;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function lineItemsOf(raw: Raw): WooLineItemLite[] {
  const items = Array.isArray(raw.line_items) ? (raw.line_items as Raw[]) : [];
  return items.map(li => ({ productId: Number(li.product_id) || 0, variationId: Number(li.variation_id) || 0, name: str(li.name).trim() }));
}

function billingOf(raw: Raw): { email: string; name: string } {
  const b = (raw.billing ?? {}) as Raw;
  return { email: str(b.email).trim().toLowerCase(), name: `${str(b.first_name)} ${str(b.last_name)}`.trim() };
}

/** Pedido de la API v3 → lo que usan las reglas. `date_paid` está en hora de la tienda (Madrid). */
export function toOrderLite(raw: Raw): WooOrderLite {
  const b = billingOf(raw);
  return {
    id: Number(raw.id), status: str(raw.status), createdVia: str(raw.created_via) || null,
    datePaid: str(raw.date_paid).slice(0, 10) || null, dateCreated: str(raw.date_created).slice(0, 10) || null,
    email: b.email, billingName: b.name, lineItems: lineItemsOf(raw),
  };
}

/**
 * Suscripción de la API v3 → lo que usan las reglas. La v3 NO trae `end_date`
 * ni `start_date`: solo sus versiones `_gmt` (comprobado con la 35902).
 */
export function toSubscriptionLite(raw: Raw): WooSubscriptionLite {
  const b = billingOf(raw);
  return {
    id: Number(raw.id), status: str(raw.status), parentId: Number(raw.parent_id) || null,
    email: b.email, billingName: b.name, lineItems: lineItemsOf(raw),
    endDate: str(raw.end_date_gmt).slice(0, 10) || null,
    startDate: (str(raw.start_date_gmt) || str(raw.date_created)).slice(0, 10) || null,
  };
}

export async function fetchOrdersSince(since: string): Promise<WooOrderLite[]> {
  return (await wooList('orders', { after: `${since}T00:00:00`, status: 'any', orderby: 'date', order: 'asc' })).map(r => toOrderLite(r as Raw));
}

export async function fetchSubscriptionsSince(since: string): Promise<WooSubscriptionLite[]> {
  return (await wooList('subscriptions', { after: `${since}T00:00:00` })).map(r => toSubscriptionLite(r as Raw));
}

export async function fetchOrder(id: number): Promise<WooOrderLite> {
  return toOrderLite((await wooGet(`orders/${id}`, {})) as Raw);
}

// ── Base de datos ────────────────────────────────────────────────────────────

const isMissing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || e.code === '42703' || /does not exist|could not find/i.test(e.message ?? ''));

/** Alumnos por email (minúsculas). Tolera que falte la columna woo_product_id. */
export async function loadStudentsByEmail(admin: SupabaseClient): Promise<Map<string, StudentLite>> {
  const cols = 'id,name,email,manual_active_until,product_name,woo_product_id';
  let { data, error } = await admin.from('students').select(cols).order('created_at');
  if (isMissing(error)) ({ data, error } = await admin.from('students').select('id,name,email,manual_active_until,product_name').order('created_at') as unknown as { data: typeof data; error: typeof error });
  if (error) throw new PlanSyncError(`No se pudieron leer los alumnos: ${error.message}`);
  const map = new Map<string, StudentLite>();
  for (const r of (data ?? []) as unknown as Raw[]) {
    const email = str(r.email).trim().toLowerCase();
    // Con emails repetidos se queda el PRIMERO creado: es el alumno original.
    if (!email || map.has(email)) continue;
    map.set(email, {
      id: str(r.id), name: str(r.name), email,
      manual_active_until: str(r.manual_active_until) || null,
      product_name: str(r.product_name) || null,
      woo_product_id: r.woo_product_id != null ? Number(r.woo_product_id) : null,
    });
  }
  return map;
}

/** Lo ya procesado. `tableMissing` = falta correr el SQL. */
export async function loadExistingEvents(admin: SupabaseClient): Promise<{ existing: Map<string, ExistingEvent>; tableMissing: boolean }> {
  const { data, error } = await admin.from('woo_plan_events').select('source_type,source_id,product_id,result,applied_at');
  if (isMissing(error)) return { existing: new Map(), tableMissing: true };
  if (error) throw new PlanSyncError(`No se pudo leer woo_plan_events: ${error.message}`);
  const existing = new Map<string, ExistingEvent>();
  for (const r of (data ?? []) as Raw[]) {
    existing.set(eventKey(r.source_type as 'order' | 'subscription', Number(r.source_id), Number(r.product_id)),
      { result: r.result as ExistingEvent['result'], applied_at: str(r.applied_at) || null });
  }
  return { existing, tableMissing: false };
}

export interface ApplyOutcome { event: PlanEvent; written: boolean; error?: string }

/**
 * Escribe lo que deciden las reglas. Por evento: primero el alumno, después la
 * fila del evento. Al revés, un fallo al escribir el alumno dejaría el pedido
 * marcado como aplicado sin haberlo aplicado, y no habría segunda oportunidad.
 */
export async function applyPlanEvents(admin: SupabaseClient, events: PlanEvent[]): Promise<ApplyOutcome[]> {
  const out: ApplyOutcome[] = [];
  const now = new Date().toISOString();
  for (const e of events) {
    if (e.result === 'ya_procesado') { out.push({ event: e, written: false }); continue; }
    if (e.studentWrite && e.studentId) {
      const { error } = await admin.from('students').update(e.studentWrite).eq('id', e.studentId);
      if (error) { out.push({ event: e, written: false, error: `alumno: ${error.message}` }); continue; }
    }
    const row: Record<string, unknown> = {
      source_type: e.sourceType, source_id: e.sourceId, product_id: e.productId,
      product_name: e.productName, kind: e.kind, woo_status: e.wooStatus,
      email: e.email, billing_name: e.billingName, student_id: e.studentId,
      start_date: e.start, computed_until: e.computedUntil, previous_until: e.previousUntil, final_until: e.finalUntil,
      result: e.result, needs_admin: e.needsAdmin, note: e.note, updated_at: now,
    };
    if (e.applies) row.applied_at = now;
    const { error } = await admin.from('woo_plan_events').upsert(row, { onConflict: 'source_type,source_id,product_id' });
    out.push(error ? { event: e, written: false, error: `evento: ${error.message}` } : { event: e, written: true });
  }
  return out;
}

// ── Entradas ─────────────────────────────────────────────────────────────────

export interface PlanSyncResult {
  applied: boolean;
  since: string;
  today: string;
  tableMissing: boolean;
  events: PlanEvent[];
  errors: string[];
}

/**
 * Una pasada completa: pedidos y suscripciones desde `since`.
 * apply=false → solo calcula (no escribe NADA).
 */
export async function syncPlanOrders(admin: SupabaseClient, opts: {
  apply: boolean; since: string; today: string; autoOnly?: boolean;
}): Promise<PlanSyncResult> {
  const since = opts.since < OFFER_START ? OFFER_START : opts.since;
  const [orders, subscriptions, studentsByEmail, ev] = await Promise.all([
    fetchOrdersSince(since), fetchSubscriptionsSince(since), loadStudentsByEmail(admin), loadExistingEvents(admin),
  ]);
  if (opts.apply && ev.tableMissing) {
    throw new PlanSyncError('Falta la tabla woo_plan_events: corré supabase/migraciones/2026-10-28-oferta-nueva.sql antes de aplicar.');
  }
  const events = buildPlanEvents({ orders, subscriptions, studentsByEmail, existing: ev.existing, today: opts.today, autoOnly: opts.autoOnly });
  if (!opts.apply) return { applied: false, since, today: opts.today, tableMissing: ev.tableMissing, events, errors: [] };
  const done = await applyPlanEvents(admin, events);
  return {
    applied: true, since, today: opts.today, tableMissing: false, events,
    errors: done.filter(d => d.error).map(d => `${d.event.sourceType} ${d.event.sourceId}: ${d.error}`),
  };
}

/** Un solo pedido (webhook). Siempre autoOnly: lo de antes de AUTO_SINCE va por la puesta al día. */
export async function processOneOrder(admin: SupabaseClient, orderId: number, today: string): Promise<PlanSyncResult> {
  const [order, studentsByEmail, ev] = await Promise.all([fetchOrder(orderId), loadStudentsByEmail(admin), loadExistingEvents(admin)]);
  if (ev.tableMissing) throw new PlanSyncError('Falta la tabla woo_plan_events (SQL sin correr): no se aplica nada.');
  const events = buildPlanEvents({ orders: [order], subscriptions: [], studentsByEmail, existing: ev.existing, today, autoOnly: true });
  const done = await applyPlanEvents(admin, events);
  return { applied: true, since: today, today, tableMissing: false, events, errors: done.filter(d => d.error).map(d => d.error!) };
}

// ── Asignación de un programa de pago único (modal del setter) ───────────────

export interface AssignmentActivationInput {
  studentId: string;
  productId: number;
  orderId: number | null;
  /** 'YYYY-MM-DD' — inicio del programa elegido en el modal. */
  start: string;
  /** Fin editado a mano; null = inicio + meses del plan. */
  until: string | null;
  /** ¿Sesión de admin? Sin ella solo vale la fecha del plan con un pedido verificado. */
  isAdmin: boolean;
  today: string;
}

export interface AssignmentActivationResult {
  decision: AssignmentProgramDecision;
  /** ¿Se registró el pedido en woo_plan_events? */
  orderRegistered: boolean;
  warnings: string[];
}

/** Cuánto puede adelantarse el inicio respecto del pago, sin sesión de admin. */
const SETTER_MAX_START_DAYS = 90;

/**
 * Activa al alumno con las fechas del modal de asignación y registra el pedido
 * como procesado. Lanza PlanSyncError (con el mensaje para el modal) si no se
 * puede.
 *
 * Sin sesión de admin (setter) solo se acepta lo que el pedido respalda: un
 * pedido pagado de ese mismo email, de ese mismo programa, la fecha de fin del
 * plan (no una editada) y un inicio como mucho 90 días después del pago (o de
 * hoy, si es más tarde). Un inicio anterior al pago solo acorta, así que no se
 * limita. Así esta ruta no sirve para regalar acceso a cualquier alumno con
 * cualquier fecha.
 */
export async function activateFromAssignment(admin: SupabaseClient, input: AssignmentActivationInput): Promise<AssignmentActivationResult> {
  const product = catalogProduct(input.productId);
  if (!isFixedTermProgram(product)) throw new PlanSyncError('El plan no es un programa de pago único del catálogo.');

  const { data: row, error } = await admin.from('students')
    .select('id,name,email,manual_active_until,product_name').eq('id', input.studentId).maybeSingle();
  if (error) throw new PlanSyncError(`No se pudo leer el alumno: ${error.message}`);
  if (!row) throw new PlanSyncError('El alumno no existe (¿se guardó la asignación?).');
  const r = row as Raw;
  const student: StudentLite = {
    id: str(r.id), name: str(r.name), email: str(r.email).trim().toLowerCase(),
    manual_active_until: str(r.manual_active_until) || null, product_name: str(r.product_name) || null, woo_product_id: null,
  };

  const warnings: string[] = [];
  let order: WooOrderLite | null = null;
  if (input.orderId) {
    try {
      const o = await fetchOrder(input.orderId);
      const hasProduct = o.lineItems.some(li => catalogProduct(li.productId, li.variationId)?.id === product.id);
      const problems = [
        !['processing', 'completed'].includes(o.status) && `el pedido #${o.id} no está pagado (${o.status})`,
        o.email !== student.email && `el pedido #${o.id} es de otro email`,
        !hasProduct && `el pedido #${o.id} no es de este programa`,
      ].filter((x): x is string => !!x);
      if (problems.length === 0) order = o;
      else warnings.push(`Pedido no registrado: ${problems.join(', ')}.`);
    } catch (err) {
      warnings.push(`No se pudo leer el pedido #${input.orderId} en WooCommerce (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  if (!input.isAdmin) {
    if (!order) throw new PlanSyncError(`Sin un pedido pagado verificado solo un admin puede activar el programa. ${warnings.join(' ')}`.trim());
    if (input.until) throw new PlanSyncError('La fecha de fin editada a mano solo la guarda un admin.');
    const paid = order.datePaid ?? order.dateCreated ?? input.today;
    const limit = addDaysIso(paid > input.today ? paid : input.today, SETTER_MAX_START_DAYS);
    if (input.start > limit) throw new PlanSyncError(`La fecha de inicio está a más de ${SETTER_MAX_START_DAYS} días del pago: solo un admin puede guardarla.`);
  }

  const decision = assignmentProgramDecision({ product, start: input.start, until: input.until, currentUntil: student.manual_active_until, today: input.today });
  if (!decision) throw new PlanSyncError('Fecha de inicio no válida.');
  const event = assignmentProgramEvent({ product, decision, start: input.start, student, order });

  // Primero el alumno; la fila del pedido solo si el alumno quedó bien (ver applyPlanEvents).
  if (!order) {
    const { error: wErr } = await admin.from('students').update(event.studentWrite!).eq('id', student.id);
    if (wErr) throw new PlanSyncError(`No se pudo activar al alumno: ${wErr.message}`);
    return { decision, orderRegistered: false, warnings };
  }
  const [done] = await applyPlanEvents(admin, [event]);
  if (done.error?.startsWith('alumno')) throw new PlanSyncError(`No se pudo activar al alumno: ${done.error}`);
  if (done.error) warnings.push(`El alumno quedó activo, pero el pedido no se registró (${done.error}).`);
  return { decision, orderRegistered: done.written, warnings };
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Avisos del admin ─────────────────────────────────────────────────────────

export interface PlanAlert {
  key: string;
  sourceType: string; sourceId: number; productId: number; productName: string;
  result: string; note: string; email: string; billingName: string; createdAt: string;
}

export async function listPlanAlerts(admin: SupabaseClient): Promise<{ alerts: PlanAlert[]; tableMissing: boolean }> {
  const { data, error } = await admin.from('woo_plan_events')
    .select('source_type,source_id,product_id,product_name,result,note,email,billing_name,created_at')
    .eq('needs_admin', true).is('resolved_at', null).order('created_at', { ascending: false });
  if (isMissing(error)) return { alerts: [], tableMissing: true };
  if (error) throw new PlanSyncError(error.message);
  return {
    tableMissing: false,
    alerts: ((data ?? []) as Raw[]).map(r => ({
      key: eventKey(r.source_type as 'order' | 'subscription', Number(r.source_id), Number(r.product_id)),
      sourceType: str(r.source_type), sourceId: Number(r.source_id), productId: Number(r.product_id),
      productName: str(r.product_name), result: str(r.result), note: str(r.note),
      email: str(r.email), billingName: str(r.billing_name), createdAt: str(r.created_at),
    })),
  };
}

export async function resolvePlanAlert(admin: SupabaseClient, key: string, by: string): Promise<void> {
  const [t, id, pid] = key.split(':');
  if (!t || !id || !pid) throw new PlanSyncError('Aviso inválido');
  const { error } = await admin.from('woo_plan_events')
    .update({ resolved_at: new Date().toISOString(), resolved_by: by })
    .eq('source_type', t).eq('source_id', Number(id)).eq('product_id', Number(pid));
  if (error) throw new PlanSyncError(error.message);
}
