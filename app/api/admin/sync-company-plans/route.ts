// Regularización de los PLANES DE EMPRESA (pago único con duración en meses).
//
// Recorre los alumnos con un producto "Empresas *", lee de WooCommerce el último
// pedido, saca la duración del nombre de la variación ("B1 · 1h semanal · 6
// Meses"), calcula el fin (fecha del pedido + N meses de calendario) y activa al
// alumno hasta esa fecha escribiendo `manual_active_until` — que es el campo que
// ya lee la regla única de acceso (lib/subscriptionAccess) y la pestaña
// "Próximos a cancelar" (lib/endingPlans).
//
// GET  → SIMULACIÓN: calcula y devuelve la tabla, sin escribir NADA.
// POST → aplica.
//
// Es el mismo par preview/aplicar de /api/admin/clean-ai-dashes. Acá importa más
// todavía: esto toca el acceso a clase de personas, y conviene ver la tabla antes.
//
// CRITERIO "NUNCA RECORTA" — la decisión de si se escribe o no vive en
// lib/productUtils.resolveCompanyPlanUpdate, compartida con check-subscription.
// Un alumno con fecha manual vigente MÁS LARGA que la del plan conserva la suya.

import { supabase } from '@/lib/supabase';
import {
  detectCompanyPlan, resolveCompanyPlanUpdate, isCompanyProduct, baseProductName,
  type CompanyPlanAction,
} from '@/lib/productUtils';
import { madridToday } from '@/lib/subscriptionAccess';

export const maxDuration = 300;

const TIMEOUT_MS = 10_000;
/** Pedidos a WooCommerce en paralelo. Bajo a propósito: son pocos alumnos. */
const CHUNK = 4;

function wcCreds(): { base: string; ck: string; cs: string } | null {
  const base = process.env.WOOCOMMERCE_URL;
  const ck   = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs   = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!base || !ck || !cs) return null;
  return { base: base.replace(/\/$/, ''), ck, cs };
}

function parseWcDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.startsWith('0000')) return null;
  const d = new Date(t.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}
function toDateStr(raw: unknown): string | null {
  const d = parseWcDate(raw);
  return d ? new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) : null;
}
function firstNonEmpty(...vals: unknown[]): unknown {
  return vals.find(v => typeof v === 'string' && v.trim() && !v.trim().startsWith('0000'));
}

// Variación = los display_value de los meta sin "_" inicial, igual que en
// check-subscription. Es el texto donde vive la duración contratada.
interface WcMeta { key?: unknown; display_value?: unknown; value?: unknown }

function variationFromMeta(metaData: unknown[]): string | null {
  const parts: string[] = [];
  for (const raw of metaData) {
    const m = (raw ?? {}) as WcMeta;
    if (String(m.key ?? '').startsWith('_')) continue;
    const dv = m.display_value ?? m.value;
    if (typeof dv === 'string' && dv.trim() && !dv.trim().startsWith('http')) parts.push(dv.trim());
  }
  return parts.length ? parts.join(' · ') : null;
}

interface LastOrder { name: string | null; variation: string | null; orderDate: string | null }

async function fetchLastOrder(c: { base: string; ck: string; cs: string }, email: string): Promise<LastOrder> {
  const url =
    `${c.base}/wp-json/wc/v3/orders?search=${encodeURIComponent(email)}&per_page=1&orderby=date&order=desc` +
    `&consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    const order = Array.isArray(arr) ? arr[0] : null;
    const li = order?.line_items?.[0];
    const metaData = Array.isArray(li?.meta_data) ? li.meta_data : [];
    return {
      name: (typeof li?.name === 'string' && li.name.trim()) ? li.name.trim() : null,
      variation: variationFromMeta(metaData),
      orderDate: toDateStr(firstNonEmpty(order?.date_completed, order?.date_paid, order?.date_created)),
    };
  } finally {
    clearTimeout(timer);
  }
}

type RowResult = CompanyPlanAction | 'not_company' | 'no_months' | 'no_order' | 'error';

interface Row {
  id: string;
  name: string;
  email: string;
  product: string | null;
  variation: string | null;
  months: number | null;
  start: string | null;
  /** Fin calculado (start + months). */
  computedUntil: string | null;
  /** Fecha de acceso que tenía antes. */
  currentUntil: string | null;
  /** Fecha con la que queda. */
  finalUntil: string | null;
  result: RowResult;
  reason: string;
}

async function run(apply: boolean): Promise<Response> {
  const creds = wcCreds();
  if (!creds) return Response.json({ error: 'WooCommerce no configurado' }, { status: 500 });

  const today = madridToday();

  // Preselección AMPLIA desde la base (`ilike %empresa%`) y confirmación ESTRICTA
  // más abajo contra el nombre real del producto en Woo. La preselección solo
  // decide a quién le preguntamos; quién entra en la lógica lo decide
  // isCompanyProduct sobre el dato fresco.
  //
  // `product_name` guarda a veces el nombre con la variación pegada y a veces sin
  // ella, según qué endpoint lo escribió (check-subscription vs
  // sync-student-plans): por eso el filtro mira las dos columnas.
  const { data, error } = await supabase
    .from('students')
    .select('id,name,email,plan,product_name,manual_active_until')
    .or('plan.ilike.%empresa%,product_name.ilike.%empresa%');

  if (error) return Response.json({ error: `No se pudieron leer los alumnos: ${error.message}` }, { status: 500 });

  const candidates = (data ?? []).filter(s => (s.email ?? '').trim());
  const rows: Row[] = [];

  for (let i = 0; i < candidates.length; i += CHUNK) {
    const batch = candidates.slice(i, i + CHUNK);
    const done = await Promise.all(batch.map(async (s): Promise<Row> => {
      const email = (s.email ?? '').trim().toLowerCase();
      const base: Row = {
        id: s.id, name: s.name, email,
        product: null, variation: null, months: null, start: null,
        computedUntil: null, currentUntil: s.manual_active_until ?? null, finalUntil: s.manual_active_until ?? null,
        result: 'error', reason: '',
      };

      let order: LastOrder;
      try {
        order = await fetchLastOrder(creds, email);
      } catch (e) {
        return { ...base, result: 'error', reason: `WooCommerce no respondió (${e instanceof Error ? e.message : 'error'})` };
      }

      base.product = order.name;
      base.variation = order.variation;

      // DOBLE FILTRO, primera mitad — sobre el nombre del producto a secas, nunca
      // sobre la variación (que lleva texto libre escrito por el cliente).
      if (!isCompanyProduct(baseProductName(order.name))) {
        return { ...base, result: 'not_company', reason: `"${order.name ?? 'sin producto'}" no es un producto de empresa` };
      }
      if (!order.orderDate) {
        return { ...base, result: 'no_order', reason: 'el pedido no trae fecha' };
      }

      const plan = detectCompanyPlan({ productName: order.name, productVariation: order.variation, orderDate: order.orderDate });
      if (!plan) {
        return { ...base, result: 'no_months', reason: `la variación no dice la duración: "${order.variation ?? ''}"` };
      }

      const decision = resolveCompanyPlanUpdate(plan.until, s.manual_active_until, today);
      const row: Row = {
        ...base,
        months: plan.months, start: plan.start, computedUntil: plan.until,
        finalUntil: decision.until, result: decision.action, reason: decision.reason,
      };

      if (apply) {
        const updates: Record<string, unknown> = { company_plan_months: plan.months, company_plan_start: plan.start };
        if (decision.writes) updates.manual_active_until = decision.until;
        const { error: upErr } = await supabase.from('students').update(updates).eq('id', s.id);
        if (upErr) {
          // Sin las columnas nuevas (SQL sin correr) el UPDATE entero falla. La
          // activación es lo que no puede perderse: se reintenta sola.
          if (decision.writes) {
            const { error: retryErr } = await supabase.from('students').update({ manual_active_until: decision.until }).eq('id', s.id);
            if (retryErr) return { ...row, result: 'error', reason: `no se pudo guardar: ${retryErr.message}` };
            return { ...row, reason: `${decision.reason} · ojo: faltan las columnas company_plan_* (correr supabase-company-plans.sql)` };
          }
          return { ...row, result: 'error', reason: `no se pudo guardar: ${upErr.message}` };
        }
      }
      return row;
    }));
    rows.push(...done);
  }

  const count = (r: RowResult) => rows.filter(x => x.result === r).length;
  return Response.json({
    applied: apply,
    today,
    scanned: candidates.length,
    activated: count('set'),
    extended: count('extend'),
    keptManual: count('keep_manual'),
    unchanged: count('unchanged'),
    skipped: count('not_company') + count('no_months') + count('no_order'),
    errors: count('error'),
    rows: rows.sort((a, b) => a.name.localeCompare(b.name, 'es')),
  });
}

/** SIMULACIÓN — calcula y devuelve la tabla sin escribir nada. */
export async function GET(): Promise<Response> {
  return run(false);
}

/** APLICA — escribe las fechas calculadas con el criterio "nunca recorta". */
export async function POST(): Promise<Response> {
  return run(true);
}
