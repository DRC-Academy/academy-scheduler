// Sincronización masiva de fechas de inicio: para un LOTE de asignaciones,
// consulta WooCommerce por el email del alumno y obtiene la fecha real en que
// empezó la suscripción (o, para pago único, la fecha del pedido completado) y
// actualiza assignments.start_date en Supabase.
//
// Igual que sync-student-plans, el cliente (panel admin) envía lotes de ~5 con
// delay entre lotes: así muestra progreso real y no excede el timeout de una
// función serverless ni sobrecarga la API de WooCommerce.
//
// Prioridad de la fecha detectada:
//   1) subscriptions?search=EMAIL  → start_date de la suscripción (más reciente,
//      priorizando una activa).
//   2) orders?...status=completed  → date_completed del último pedido pagado.
//
// El flag `force` lo controla el cliente al elegir qué asignaciones enviar
// (solo las de start_date vacía, o todas). El endpoint actualiza toda
// asignación del lote para la que obtenga una fecha.

import { supabase } from '@/lib/supabase';

const TIMEOUT_MS = 10_000;

function wcCreds(): { base: string; ck: string; cs: string } | null {
  const base = process.env.WOOCOMMERCE_URL;
  const ck   = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs   = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!base || !ck || !cs) return null;
  return { base: base.replace(/\/$/, ''), ck, cs };
}

// Convierte una fecha WooCommerce (ISO / 'YYYY-MM-DD HH:mm:ss') a Date.
function parseWcDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('0000')) return null;
  const d = new Date(trimmed.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}
function toDateStr(raw: unknown): string | null {
  const d = parseWcDate(raw);
  if (!d) return null;
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function firstNonEmpty(...vals: unknown[]): unknown {
  return vals.find(v => typeof v === 'string' && v.trim() && !v.trim().startsWith('0000'));
}

async function wooGet(url: string): Promise<any[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fecha de inicio detectada para un email: suscripción (start_date) → pedido
// completado (date_completed). Devuelve 'YYYY-MM-DD' o null si no hay datos.
// Lanza si la API de WooCommerce falla (para distinguir "no encontrado" de "error").
async function fetchStartDate(c: { base: string; ck: string; cs: string }, email: string): Promise<string | null> {
  const creds = `consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;

  // 1) Suscripción: la más reciente por start_date, priorizando una activa.
  const subs = await wooGet(`${c.base}/wp-json/wc/v3/subscriptions?search=${encodeURIComponent(email)}&${creds}`);
  if (subs === null) throw new Error('woo subscriptions failed');
  if (subs.length > 0) {
    const byRecent = [...subs].sort((a, b) => {
      const da = parseWcDate(a?.start_date)?.getTime() ?? 0;
      const db = parseWcDate(b?.start_date)?.getTime() ?? 0;
      return db - da;
    });
    const chosen = byRecent.find(s => s?.status === 'active') ?? byRecent[0];
    const startDate = toDateStr(firstNonEmpty(chosen?.start_date, chosen?.date_created));
    if (startDate) return startDate;
  }

  // 2) Pago único (o suscripción sin start_date): último pedido completado.
  const orders = await wooGet(
    `${c.base}/wp-json/wc/v3/orders?search=${encodeURIComponent(email)}&per_page=1&orderby=date&order=desc&status=completed&${creds}`,
  );
  if (orders === null) throw new Error('woo orders failed');
  const order = orders[0];
  return toDateStr(firstNonEmpty(order?.date_completed, order?.date_paid, order?.date_created));
}

interface BatchAssignment { id: string; email: string }

export async function POST(request: Request): Promise<Response> {
  const creds = wcCreds();
  if (!creds) return Response.json({ error: 'WooCommerce no configurado' }, { status: 500 });

  let body: { assignments?: BatchAssignment[] };
  try { body = await request.json(); }
  catch { return Response.json({ error: 'JSON inválido' }, { status: 400 }); }

  const assignments = Array.isArray(body?.assignments) ? body.assignments : [];
  const total = assignments.length;
  if (total === 0) return Response.json({ updated: 0, notFound: 0, errors: 0, total: 0, details: [] });

  let updated = 0, notFound = 0, errors = 0;
  const details: Array<{ id: string; email: string; result: 'updated' | 'not_found' | 'error'; startDate?: string }> = [];

  // El lote ya es pequeño; se procesa en paralelo (el cliente controla el ritmo).
  await Promise.all(assignments.map(async (a) => {
    const email = (a.email ?? '').trim().toLowerCase();
    if (!email) { notFound++; details.push({ id: a.id, email: '', result: 'not_found' }); return; }

    let startDate: string | null;
    try {
      startDate = await fetchStartDate(creds, email);
    } catch {
      errors++; details.push({ id: a.id, email, result: 'error' }); return;
    }

    if (!startDate) { notFound++; details.push({ id: a.id, email, result: 'not_found' }); return; }

    const { error } = await supabase.from('assignments').update({ start_date: startDate }).eq('id', a.id);
    if (error) { errors++; details.push({ id: a.id, email, result: 'error' }); return; }

    updated++; details.push({ id: a.id, email, result: 'updated', startDate });
  }));

  return Response.json({ updated, notFound, errors, total, details });
}
