// Sincronización masiva de planes: para un LOTE de alumnos, consulta el último
// producto comprado en WooCommerce y, si difiere del plan guardado, actualiza
// students.plan / product_name / product_type / level en Supabase.
//
// El cliente (panel admin) envía lotes de ~5 alumnos con delay entre lotes, para
// mostrar progreso real y no exceder el timeout de una sola función serverless
// ni sobrecargar la API de WooCommerce.

import { supabase } from '@/lib/supabase';
import { detectLevel } from '@/lib/productUtils';

// Productos de PAGO ÚNICO (igual criterio que check-subscription).
const ONE_TIME_PRODUCTS = [
  'intensivo fce', 'intensivo pet', 'intensivo general', 'intensivo cae',
  'empresas preparacion de examenes', 'empresas ingles general', 'empresas intensivos',
];
function isOneTimeProduct(name: string): boolean {
  const n = (name ?? '').toLowerCase();
  return ONE_TIME_PRODUCTS.some(p => n.includes(p));
}

const TIMEOUT_MS = 10_000;

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
    if (key.startsWith('_')) continue;
    const dv = m?.display_value ?? m?.value;
    if (typeof dv === 'string' && dv.trim() && !dv.trim().startsWith('http')) parts.push(dv.trim());
  }
  return parts.length ? parts.join(' · ') : null;
}

interface WooProduct {
  productName: string | null;
  productFullName: string | null;
  productType: 'subscription' | 'one_time' | null;
  detectedLevel: string | null;
}

async function fetchProduct(c: { base: string; ck: string; cs: string }, email: string): Promise<WooProduct | null> {
  const url =
    `${c.base}/wp-json/wc/v3/orders?search=${encodeURIComponent(email)}&per_page=1&orderby=date&order=desc` +
    `&consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!res.ok) return null;
    const arr = await res.json();
    const li = Array.isArray(arr) ? arr[0]?.line_items?.[0] : null;
    const name = (typeof li?.name === 'string' && li.name.trim()) ? li.name.trim() : null;
    if (!name) return null;
    const metaData = Array.isArray(li?.meta_data) ? li.meta_data : [];
    const variation = variationFromMeta(metaData);
    const fullName = variation ? `${name} — ${variation}` : name;
    return {
      productName: name,
      productFullName: fullName,
      productType: isOneTimeProduct(name) ? 'one_time' : 'subscription',
      detectedLevel: detectLevel(fullName, metaData),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface BatchStudent { id: string; email: string; plan?: string | null; level?: string | null }

export async function POST(request: Request): Promise<Response> {
  const creds = wcCreds();
  if (!creds) return Response.json({ error: 'WooCommerce no configurado' }, { status: 500 });

  let body: { students?: BatchStudent[] };
  try { body = await request.json(); }
  catch { return Response.json({ error: 'JSON inválido' }, { status: 400 }); }

  const students = Array.isArray(body?.students) ? body.students : [];
  if (students.length === 0) return Response.json({ updated: 0, unchanged: 0, notFound: 0, details: [] });

  let updated = 0, unchanged = 0, notFound = 0;
  const details: Array<{ id: string; email: string; result: 'updated' | 'unchanged' | 'not_found'; plan?: string }> = [];

  // Se procesan en paralelo (el lote ya es pequeño; el cliente controla el ritmo).
  await Promise.all(students.map(async (s) => {
    const email = (s.email ?? '').trim();
    if (!email) { notFound++; details.push({ id: s.id, email, result: 'not_found' }); return; }

    const prod = await fetchProduct(creds, email.toLowerCase());
    if (!prod?.productFullName) { notFound++; details.push({ id: s.id, email, result: 'not_found' }); return; }

    const currentPlan = (s.plan ?? '').trim();
    if (currentPlan === prod.productFullName) {
      unchanged++; details.push({ id: s.id, email, result: 'unchanged', plan: prod.productFullName });
      return;
    }

    const updates: Record<string, unknown> = {
      plan: prod.productFullName,
      product_name: prod.productName,
      product_type: prod.productType,
    };
    // Solo completa el nivel si se detectó y el alumno no tiene uno cargado.
    if (prod.detectedLevel && !(s.level ?? '').trim()) updates.level = prod.detectedLevel;

    const { error } = await supabase.from('students').update(updates).eq('id', s.id);
    if (error) {
      // Reintento resiliente: al menos el plan (por si faltan columnas product_*).
      await supabase.from('students').update({ plan: prod.productFullName }).eq('id', s.id);
    }
    updated++; details.push({ id: s.id, email, result: 'updated', plan: prod.productFullName });
  }));

  return Response.json({ updated, unchanged, notFound, details });
}
