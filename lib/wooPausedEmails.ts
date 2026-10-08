// Alumnos EN PAUSA, de una sola vez, para los procesos de servidor que recorren a
// muchos alumnos (escaneo de riesgo de baja, recordatorios de formulario y prueba
// de nivel). SOLO SERVIDOR: lleva las credenciales de WooCommerce.
//
// Las pantallas no usan esto: preguntan alumno por alumno a /api/check-subscription.
// Acá se leen TODAS las suscripciones en unas pocas páginas y se aplica la MISMA
// regla (lib/subscriptionAccess resolveWooSubscriptions + overrides), para no hacer
// una llamada a Woo por alumno.
//
// Si WooCommerce no contesta, lanza: el que llama decide. Los dos que hay hoy
// siguen como si nadie estuviera en pausa (mejor un recordatorio de más que
// dejar de avisar a todos por un fallo de Woo).

import 'server-only';

import { supabase } from '@/lib/supabase';
import {
  accessOverrideOf, madridToday, resolveWooSubscriptions, isPausedStatus,
  type WooSubLike,
} from '@/lib/subscriptionAccess';

const PER_PAGE = 100;
/** Cota dura: la tienda tiene unas 4 páginas. */
const MAX_PAGES = 20;
const TIMEOUT_MS = 15_000;

export interface WooSub extends WooSubLike {
  start_date?: unknown;
  date_created?: unknown;
  billing?: { email?: unknown } | null;
}

export function wcCreds(): { base: string; ck: string; cs: string } | null {
  const base = process.env.WOOCOMMERCE_URL;
  const ck   = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs   = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!base || !ck || !cs) return null;
  return { base: base.replace(/\/$/, ''), ck, cs };
}

const nkEmail = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const time = (v: unknown): number => {
  const d = typeof v === 'string' ? new Date(v.replace(' ', 'T')) : null;
  return d && !isNaN(d.getTime()) ? d.getTime() : 0;
};

async function fetchPage(c: { base: string; ck: string; cs: string }, page: number): Promise<WooSub[]> {
  // Por id ascendente: una suscripción nueva entre página y página va al final y
  // no corre la lista (ver lib/externalSubscriptions).
  const url =
    `${c.base}/wp-json/wc/v3/subscriptions?per_page=${PER_PAGE}&page=${page}&orderby=id&order=asc` +
    `&consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? (data as WooSub[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

/** Emails (normalizados) de los alumnos EN PAUSA ahora mismo. */
export async function fetchPausedEmails(): Promise<Set<string>> {
  const c = wcCreds();
  if (!c) throw new Error('WooCommerce no configurado');

  const byEmail = new Map<string, WooSub[]>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await fetchPage(c, page);
    for (const s of rows) {
      const e = nkEmail(s.billing?.email);
      if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), s]);
    }
    if (rows.length < PER_PAGE) break;
  }

  const paused = new Set<string>();
  for (const [e, subs] of byEmail) {
    // Más reciente primero, como en /api/check-subscription.
    const byRecent = [...subs].sort((a, b) => time(b.start_date ?? b.date_created) - time(a.start_date ?? a.date_created));
    if (isPausedStatus(resolveWooSubscriptions(byRecent).status)) paused.add(e);
  }
  if (paused.size === 0) return paused;

  // Oritalk vigente o activación manual ganan sobre la pausa (= Activo).
  const today = madridToday();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('students').select('*').order('id').range(from, from + 999);
    if (error) throw new Error(`students: ${error.message}`);
    for (const s of data ?? []) {
      const e = nkEmail(s.email);
      if (paused.has(e) && accessOverrideOf(s, today)) paused.delete(e);
    }
    if ((data ?? []).length < 1000) break;
  }
  return paused;
}

/** Igual que fetchPausedEmails, pero si Woo falla devuelve un conjunto vacío (y lo registra). */
export async function pausedEmailsOrEmpty(label: string): Promise<Set<string>> {
  try {
    return await fetchPausedEmails();
  } catch (err) {
    console.error(`[${label}] No se pudo saber quién está en pausa; se sigue sin excluir a nadie:`, err instanceof Error ? err.message : err);
    return new Set();
  }
}

// ── Lecturas por alumno (pausas y webhook de cancelación) ────────────────────

async function getJson(url: string): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}

/** Suscripciones de un email (todas, más reciente primero). Lanza si Woo falla. */
export async function fetchSubscriptionsByEmail(email: string): Promise<WooSub[]> {
  const c = wcCreds();
  if (!c) throw new Error('WooCommerce no configurado');
  const url =
    `${c.base}/wp-json/wc/v3/subscriptions?search=${encodeURIComponent(email)}&per_page=50` +
    `&consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;
  const subs = (await getJson(url)) as WooSub[];
  // search= busca en varios campos: nos quedamos con las de ESE email de facturación.
  const mine = subs.filter(s => nkEmail(s.billing?.email) === nkEmail(email));
  return mine.sort((a, b) => time(b.start_date ?? b.date_created) - time(a.start_date ?? a.date_created));
}

/** Pedidos de un email, del más reciente al más antiguo (hasta 30). Lanza si Woo falla. */
export async function fetchRecentOrdersByEmail(email: string): Promise<Array<{ line_items?: unknown; date_created?: unknown; date_paid?: unknown; billing?: { email?: unknown } | null }>> {
  const c = wcCreds();
  if (!c) throw new Error('WooCommerce no configurado');
  const url =
    `${c.base}/wp-json/wc/v3/orders?search=${encodeURIComponent(email)}&per_page=30&orderby=date&order=desc` +
    `&consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;
  const orders = (await getJson(url)) as Array<{ line_items?: unknown; date_created?: unknown; date_paid?: unknown; billing?: { email?: unknown } | null }>;
  return orders.filter(o => nkEmail(o.billing?.email) === nkEmail(email));
}
