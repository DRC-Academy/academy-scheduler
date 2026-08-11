// PROBE de solo lectura: ¿se puede leer el precio efectivo de cada alumno desde
// WooCommerce sin hacer 174 consultas individuales?
//
// NO ESCRIBE NADA. Ni en Supabase ni en WooCommerce. Se puede correr las veces que
// haga falta. Existe para responder, con datos de producción, las cuatro cosas que
// deciden el diseño del sync de precios (11/08/2026) y que no se pueden verificar
// desde local, porque las credenciales de Woo solo viven en Vercel:
//
//   1. ¿`/wc/v3/subscriptions` SIN `search=` devuelve el listado completo paginado?
//      De eso depende todo: si funciona, son ~4 llamadas en vez de 174.
//   2. ¿Los objetos traen `total`, `billing_period` y `billing_interval`?
//      Sin periodo no se puede normalizar a €/mes y una suscripción anual de 600 €
//      se contaría como 600 €/mes.
//   3. ¿Cuántos de nuestros alumnos casan por email de facturación? El que no casa
//      factura 0 € y hunde en silencio el margen de su profesor.
//   4. LA PREGUNTA QUE DECIDE EL DISEÑO: ¿dos alumnos con el mismo producto y la
//      misma variación pagan importes DISTINTOS? Si es que sí, el precio no está
//      en el catálogo —está congelado en cada suscripción, o hay cupones— y
//      sincronizar la tabla de precios del catálogo daría números inflados el día
//      de cada subida de tarifas.
//
// GATEADO POR SECRETO a propósito. Devuelve la facturación de la academia entera;
// el resto de /api/admin/* no lleva guardián porque el panel está detrás de la UI,
// pero esto es otra cosa. Se acepta el secreto por cabecera (servidor a servidor)
// o por `?secret=` para poder abrirlo una vez desde el navegador.

import { supabase } from '@/lib/supabase';
import { timingSafeEqual } from 'node:crypto';
import {
  parseAmount, monthlyFromSubscription, emailKey, isBillingPeriod,
} from '@/lib/wooPrices';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

/** Páginas de suscripciones como mucho. Cota dura: esto es un diagnóstico, no un sync. */
const PER_PAGE = 50;
const MAX_PAGES = 6;
/** Pausa entre páginas: una sola conexión a Woo a la vez, para no pisar check-subscription. */
const PAGE_GAP_MS = 300;
/** Pedidos de pago único que se prueban de muestra (no los 26). */
const ONE_TIME_SAMPLE = 3;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Guardián ─────────────────────────────────────────────────────────────────

function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function requireSecret(request: Request): Response | null {
  const expected = process.env.CRON_SECRET;
  // Sin variable configurada NO se abre. Un endpoint que se destranca solo porque
  // falta una env var es la forma habitual de publicar datos sin enterarse.
  if (!expected) {
    return Response.json({ error: 'CRON_SECRET no configurado' }, { status: 503 });
  }
  const header = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const query = new URL(request.url).searchParams.get('secret') ?? '';
  const got = header || query;
  if (!got || !secretsMatch(got, expected)) {
    return Response.json(
      { error: 'no_autorizado', hint: 'Pasá el CRON_SECRET como ?secret=… o en Authorization: Bearer …' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return null;
}

// ── WooCommerce ──────────────────────────────────────────────────────────────

function wcCreds(): { base: string; ck: string; cs: string } | null {
  const base = process.env.WOOCOMMERCE_URL;
  const ck = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!base || !ck || !cs) return null;
  return { base: base.replace(/\/$/, ''), ck, cs };
}

interface WooResponse {
  ok: boolean;
  status: number | null;
  data: unknown[];
  /** X-WP-Total / X-WP-TotalPages: dicen cuántas hay SIN tener que paginarlas todas. */
  total: number | null;
  totalPages: number | null;
  error: string | null;
}

/** GET con timeout + reintentos. Devuelve los headers de paginación, que es lo que se va a probar. */
async function wooGet(url: string, label: string): Promise<WooResponse> {
  let lastErr = 'error desconocido';
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastStatus = res.status;
      if (!res.ok) {
        // El cuerpo del error de Woo dice el motivo real ("woocommerce_rest_cannot_view").
        const body = await res.text().catch(() => '');
        lastErr = `HTTP ${res.status}${body ? ` · ${body.slice(0, 200)}` : ''}`;
      } else {
        const data = await res.json();
        const num = (h: string): number | null => {
          const v = res.headers.get(h);
          const n = v ? parseInt(v, 10) : NaN;
          return Number.isFinite(n) ? n : null;
        };
        return {
          ok: true,
          status: res.status,
          data: Array.isArray(data) ? data : [],
          total: num('x-wp-total'),
          totalPages: num('x-wp-totalpages'),
          error: null,
        };
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      const e = err as { name?: string; message?: string };
      lastErr = e?.name === 'AbortError' ? `timeout tras ${TIMEOUT_MS}ms` : String(e?.message ?? err);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  console.error(`[woo-price-probe] ${label} falló tras ${MAX_ATTEMPTS} intentos: ${lastErr}`);
  return { ok: false, status: lastStatus, data: [], total: null, totalPages: null, error: lastErr };
}

const auth = (c: { ck: string; cs: string }): string =>
  `consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;

// ── Lectura de campos del objeto suscripción ─────────────────────────────────

interface SubRow {
  id: number | null;
  status: string | null;
  email: string;
  total: unknown;
  billingPeriod: unknown;
  billingInterval: unknown;
  productName: string | null;
  variation: string | null;
  lineTotal: unknown;
  lineSubtotal: unknown;
  monthly: number | null;
}

/** Variación = los display_value de los meta sin "_" inicial, igual que check-subscription. */
function variationFromMeta(metaData: unknown[]): string | null {
  const parts: string[] = [];
  for (const raw of metaData) {
    const m = raw as { key?: unknown; display_value?: unknown; value?: unknown };
    if (String(m?.key ?? '').startsWith('_')) continue;
    const dv = m?.display_value ?? m?.value;
    if (typeof dv === 'string' && dv.trim() && !dv.trim().startsWith('http')) parts.push(dv.trim());
  }
  return parts.length ? parts.join(' · ') : null;
}

function readSub(raw: unknown): SubRow {
  const s = raw as Record<string, unknown>;
  const li = (Array.isArray(s?.line_items) ? s.line_items[0] : null) as Record<string, unknown> | null;
  const meta = Array.isArray(li?.meta_data) ? (li!.meta_data as unknown[]) : [];
  const billing = s?.billing as { email?: unknown } | undefined;

  return {
    id: typeof s?.id === 'number' ? s.id : null,
    status: typeof s?.status === 'string' ? s.status : null,
    email: emailKey(typeof billing?.email === 'string' ? billing.email : null),
    total: s?.total,
    billingPeriod: s?.billing_period,
    billingInterval: s?.billing_interval,
    productName: typeof li?.name === 'string' ? li.name.trim() : null,
    variation: variationFromMeta(meta),
    lineTotal: li?.total,
    lineSubtotal: li?.subtotal,
    monthly: monthlyFromSubscription({
      total: s?.total,
      billingPeriod: s?.billing_period,
      billingInterval: s?.billing_interval,
    }),
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  const denied = requireSecret(request);
  if (denied) return denied;

  const creds = wcCreds();
  if (!creds) {
    return Response.json({
      ok: false,
      error: 'WooCommerce no configurado',
      hint: 'Faltan WOOCOMMERCE_URL / _CONSUMER_KEY / _CONSUMER_SECRET en el entorno.',
    }, { status: 500 });
  }

  const t0 = Date.now();
  let wooCalls = 0;
  const conclusiones: string[] = [];

  // ── 1. ¿El listado paginado funciona sin `search=`? ────────────────────────
  const subs: SubRow[] = [];
  const paginas: Array<{ page: number; ok: boolean; status: number | null; recibidas: number; error: string | null }> = [];
  let totalHeader: number | null = null;
  let totalPagesHeader: number | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${creds.base}/wp-json/wc/v3/subscriptions?per_page=${PER_PAGE}&page=${page}&${auth(creds)}`;
    const res = await wooGet(url, `subscriptions page ${page}`);
    wooCalls++;
    paginas.push({ page, ok: res.ok, status: res.status, recibidas: res.data.length, error: res.error });

    if (!res.ok) break;
    if (page === 1) { totalHeader = res.total; totalPagesHeader = res.totalPages; }
    for (const raw of res.data) subs.push(readSub(raw));
    // Última página: vino incompleta o los headers dicen que no hay más.
    if (res.data.length < PER_PAGE) break;
    if (totalPagesHeader != null && page >= totalPagesHeader) break;
    await sleep(PAGE_GAP_MS);
  }

  const listadoOk = paginas.length > 0 && paginas[0].ok;
  if (!listadoOk) {
    conclusiones.push(
      '❌ PREGUNTA 1: el listado de suscripciones SIN `search=` NO funciona. ' +
      `Motivo: ${paginas[0]?.error ?? 'sin respuesta'}. El diseño de ~4 llamadas no es viable tal cual; ` +
      'habría que volver a consultar alumno por alumno o pedir permisos de lectura para el endpoint.',
    );
  } else {
    const alcanzadoElTope = paginas.length >= MAX_PAGES && subs.length >= MAX_PAGES * PER_PAGE;
    conclusiones.push(
      `✅ PREGUNTA 1: el listado paginado funciona. Leídas ${subs.length} suscripciones en ${paginas.length} llamada(s)` +
      (totalHeader != null ? `; la tienda declara ${totalHeader} en total (${totalPagesHeader ?? '?'} páginas de ${PER_PAGE})` : '; la tienda no devuelve cabeceras X-WP-Total') +
      (alcanzadoElTope ? '. ⚠️ Se llegó al tope del probe: hay más de las leídas.' : '.'),
    );
  }

  // ── 2. ¿Están los campos que hacen falta? ──────────────────────────────────
  const conTotal = subs.filter(s => parseAmount(s.total) != null).length;
  const conPeriodo = subs.filter(s => isBillingPeriod(s.billingPeriod)).length;
  const conEmail = subs.filter(s => s.email).length;
  const conLinea = subs.filter(s => s.productName).length;
  const conMensual = subs.filter(s => s.monthly != null).length;

  if (subs.length > 0) {
    const falta: string[] = [];
    if (conTotal < subs.length) falta.push(`total (${subs.length - conTotal} sin él)`);
    if (conPeriodo < subs.length) falta.push(`billing_period (${subs.length - conPeriodo} sin él)`);
    if (conEmail < subs.length) falta.push(`billing.email (${subs.length - conEmail} sin él)`);
    if (conLinea < subs.length) falta.push(`line_items (${subs.length - conLinea} sin él)`);
    conclusiones.push(
      falta.length === 0
        ? `✅ PREGUNTA 2: todos los campos necesarios están presentes en las ${subs.length} suscripciones. Se pudo normalizar a €/mes ${conMensual} de ${subs.length}.`
        : `⚠️ PREGUNTA 2: faltan campos en parte de las suscripciones → ${falta.join(', ')}. Solo se pudo normalizar a €/mes ${conMensual} de ${subs.length}.`,
    );
  }

  // ── 3. Emparejado con nuestros alumnos ─────────────────────────────────────
  // select('*') a propósito: tolera que company_plan_* u otras columnas de
  // migraciones recientes no existan todavía en esta base.
  const { data: studentRows, error: studentsError } = await supabase.from('students').select('*');
  const students = (studentRows ?? []) as Array<Record<string, unknown>>;

  const subsByEmail = new Map<string, SubRow[]>();
  for (const s of subs) {
    if (!s.email) continue;
    const arr = subsByEmail.get(s.email);
    if (arr) arr.push(s); else subsByEmail.set(s.email, [s]);
  }

  const sinMatch: Array<{ nombre: string; email: string; productType: string | null }> = [];
  const emailsDeAlumnos = new Set<string>();
  let conSub = 0;
  let oneTimeCount = 0;

  for (const st of students) {
    const email = emailKey(st.email as string | null);
    const productType = (st.product_type as string | null) ?? null;
    if (email) emailsDeAlumnos.add(email);
    if (productType === 'one_time') oneTimeCount++;

    if (email && subsByEmail.has(email)) { conSub++; continue; }
    // Un pago único no tiene por qué tener suscripción: su precio sale del pedido.
    if (productType === 'one_time') continue;
    sinMatch.push({ nombre: String(st.name ?? ''), email, productType });
  }

  const subsHuerfanas = [...subsByEmail.keys()].filter(e => !emailsDeAlumnos.has(e));

  if (studentsError) {
    conclusiones.push(`❌ PREGUNTA 3: no se pudieron leer los alumnos de Supabase: ${studentsError.message}`);
  } else {
    conclusiones.push(
      `PREGUNTA 3: ${conSub} de ${students.length} alumnos casan con una suscripción por email. ` +
      `${oneTimeCount} son de pago único (su precio sale del pedido, no de una suscripción). ` +
      `${sinMatch.length} alumno(s) de suscripción SIN match — esos facturarían 0 € y hundirían el margen de su profesor. ` +
      `${subsHuerfanas.length} suscripción(es) de Woo sin alumno nuestro.`,
    );
  }

  // ── 4. LA PREGUNTA QUE DECIDE EL DISEÑO ────────────────────────────────────
  // Mismo producto + misma variación con importes distintos = el precio NO está
  // en el catálogo (grandfathering al subir tarifas, o cupones).
  const porProducto = new Map<string, { clave: string; importes: Map<number, number> }>();
  for (const s of subs) {
    if (!s.productName) continue;
    const clave = s.variation ? `${s.productName} — ${s.variation}` : s.productName;
    const amount = parseAmount(s.total);
    if (amount == null) continue;
    const grupo = porProducto.get(clave) ?? { clave, importes: new Map<number, number>() };
    grupo.importes.set(amount, (grupo.importes.get(amount) ?? 0) + 1);
    porProducto.set(clave, grupo);
  }

  const gruposConDispersion = [...porProducto.values()]
    .filter(g => g.importes.size > 1)
    .map(g => ({
      producto: g.clave,
      alumnos: [...g.importes.values()].reduce((a, b) => a + b, 0),
      importes: [...g.importes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([importe, cuantos]) => ({ importe, alumnos: cuantos })),
    }))
    .sort((a, b) => b.importes.length - a.importes.length);

  if (subs.length > 0) {
    conclusiones.push(
      gruposConDispersion.length > 0
        ? `🔴 PREGUNTA 4 — CONFIRMADO: ${gruposConDispersion.length} producto(s) tienen alumnos pagando importes DISTINTOS por lo mismo. ` +
          `El precio efectivo NO es el del catálogo (precios congelados de antes de una subida, o cupones). ` +
          `Sincronizar el catálogo habría inflado la facturación el día de cada aumento. Confirma el diseño: la fuente es la suscripción.`
        : `🟢 PREGUNTA 4: hoy no hay dispersión de precios — cada producto tiene un único importe entre los ${subs.length} leídos. ` +
          `El catálogo daría el mismo número HOY, pero seguiría rompiéndose en el primer aumento de tarifas: leer de la suscripción cuesta lo mismo y no tiene ese riesgo.`,
    );
  }

  // ── 5. Muestra de pagos únicos (bounded) ───────────────────────────────────
  const oneTimeSample = students
    .filter(st => (st.product_type as string | null) === 'one_time' && emailKey(st.email as string | null))
    .slice(0, ONE_TIME_SAMPLE);

  const pagosUnicos: Array<{ alumno: string; email: string; producto: string | null; importe: number | null; fecha: string | null; error?: string }> = [];
  for (const st of oneTimeSample) {
    const email = emailKey(st.email as string | null);
    const url = `${creds.base}/wp-json/wc/v3/orders?search=${encodeURIComponent(email)}&per_page=1&orderby=date&order=desc&${auth(creds)}`;
    const res = await wooGet(url, `orders ${email}`);
    wooCalls++;
    if (!res.ok) {
      pagosUnicos.push({ alumno: String(st.name ?? ''), email, producto: null, importe: null, fecha: null, error: res.error ?? 'error' });
      continue;
    }
    const order = res.data[0] as Record<string, unknown> | undefined;
    const li = (Array.isArray(order?.line_items) ? order!.line_items[0] : null) as Record<string, unknown> | null;
    pagosUnicos.push({
      alumno: String(st.name ?? ''),
      email,
      producto: typeof li?.name === 'string' ? li.name : null,
      // `line_items[].total` ya viene con el descuento aplicado; `order.total`
      // incluiría otros conceptos si el pedido llevara más de una línea.
      importe: parseAmount(li?.total) ?? parseAmount(order?.total),
      fecha: typeof order?.date_created === 'string' ? order.date_created.slice(0, 10) : null,
    });
    await sleep(PAGE_GAP_MS);
  }

  const conImporte = pagosUnicos.filter(p => p.importe != null).length;
  if (pagosUnicos.length > 0) {
    conclusiones.push(
      `PAGOS ÚNICOS: se pudo leer el importe de ${conImporte} de ${pagosUnicos.length} pedidos de muestra. ` +
      'Recordá que el importe de un pedido cerrado no cambia nunca: se captura una vez y no se resincroniza.',
    );
  }

  // ── 6. Catálogo (respaldo) ─────────────────────────────────────────────────
  const catRes = await wooGet(
    `${creds.base}/wp-json/wc/v3/products?per_page=100&status=publish&${auth(creds)}`,
    'products',
  );
  wooCalls++;
  const productos = catRes.data as Array<Record<string, unknown>>;
  const variables = productos.filter(p => String(p?.type ?? '').includes('variable')).length;

  conclusiones.push(
    catRes.ok
      ? `CATÁLOGO (respaldo): ${productos.length} producto(s) publicados${catRes.total != null ? ` de ${catRes.total}` : ''}, ${variables} con variaciones. ` +
        `Poblar la tabla de respaldo costaría 1 + ${variables} llamadas; se puede correr a diario en vez de en cada sync.`
      : `CATÁLOGO: no se pudo leer (${catRes.error}). No es bloqueante: es el respaldo, no la fuente.`,
  );

  return Response.json({
    ok: listadoOk,
    generadoEn: new Date().toISOString(),
    duracionMs: Date.now() - t0,
    llamadasWoo: wooCalls,
    escribio: 'NADA. Este endpoint es de solo lectura.',

    conclusiones,

    suscripciones: {
      paginas,
      leidas: subs.length,
      totalDeclarado: totalHeader,
      paginasDeclaradas: totalPagesHeader,
      topeDelProbe: MAX_PAGES * PER_PAGE,
      campos: { conTotal, conPeriodo, conEmail, conLineItems: conLinea, normalizablesAMes: conMensual },
      estados: contar(subs.map(s => s.status ?? 'sin estado')),
      periodos: contar(subs.map(s => String(s.billingPeriod ?? 'sin periodo'))),
      muestra: subs.slice(0, 5).map(s => ({
        id: s.id, estado: s.status, producto: s.productName, variacion: s.variation,
        total: s.total, periodo: s.billingPeriod, intervalo: s.billingInterval,
        lineaTotal: s.lineTotal, lineaSubtotal: s.lineSubtotal, mensualCalculado: s.monthly,
      })),
    },

    dispersionDePrecios: {
      productosDistintos: porProducto.size,
      productosConImportesDistintos: gruposConDispersion.length,
      detalle: gruposConDispersion.slice(0, 15),
    },

    emparejado: {
      alumnosEnBase: students.length,
      conSuscripcion: conSub,
      dePagoUnico: oneTimeCount,
      sinMatch: sinMatch.slice(0, 30),
      sinMatchTotal: sinMatch.length,
      suscripcionesSinAlumno: subsHuerfanas.slice(0, 30),
      suscripcionesSinAlumnoTotal: subsHuerfanas.length,
    },

    pagosUnicos,

    catalogo: {
      ok: catRes.ok,
      productos: productos.length,
      totalDeclarado: catRes.total,
      conVariaciones: variables,
      llamadasParaPoblarlo: catRes.ok ? 1 + variables : null,
    },
  });
}

/** Recuento por valor, para los histogramas de estados y periodos. */
function contar(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
