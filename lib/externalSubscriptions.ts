// ── Conteo agregado de suscripciones para el dashboard financiero externo ────
//
// Alimenta /api/external/subscriptions, que consume drc-financial-dashboard.
//
// Devuelve DOS cosas que NO son la misma y que conviene no mezclar:
//
//   1. La foto CRUDA de WooCommerce, contada por estado de suscripción. Es un
//      recuento de SUSCRIPCIONES, no de personas: un alumno con dos productos
//      aparece dos veces, y una suscripción de alguien que nunca se dio de alta
//      en la academia también cuenta.
//   2. Los alumnos ACTIVOS de verdad, contados por PERSONA, según la regla única
//      del sistema (lib/subscriptionAccess). Además de WooCommerce contempla las
//      activaciones manuales y Oritalk, dos orígenes que no existen en Woo.
//
// REGLA CENTRAL: quién está activo lo deciden `accessOverrideOf` e
// `isActiveWooStatus` (lib/subscriptionAccess.ts), las mismas funciones con las
// que /api/check-subscription decide si un alumno puede entrar a clase. Acá no
// se reimplementa el criterio. Es el mismo motivo que en lib/externalPayouts: una
// segunda definición de "activo" viviendo en el endpoint externo termina
// divergiendo de la de la app, y nadie se entera hasta que el número no cuadra.
//
// De ahí salen dos consecuencias que el dashboard tiene que saber:
//   · 'pending-cancel' CUENTA como activa (canceló la renovación, pero el
//     periodo pagado sigue vivo). Por eso `dan_acceso` ≠ `por_estado.active`.
//   · 'scheduled' NO cuenta (pagada, pero empieza en el futuro).
//
// COSTE / EGRESS: una sola pasada paginada por WooCommerce pidiendo únicamente
// `status` y `billing.email` (vía `_fields`, que WordPress aplica en SU lado, así
// que los `line_items` ni viajan), y un SELECT de 6 columnas a Supabase — nunca
// `dbGetStudents()`, que hace `select('*')` y traería notas, planes y teléfonos
// que acá no se miran. El resultado se cachea 60 s en memoria para que varias
// tarjetas del dashboard no golpeen WooCommerce en cadena.

import { supabase } from '@/lib/supabase';
import { accessOverrideOf, isActiveWooStatus, madridToday, WOO_STATUS } from '@/lib/subscriptionAccess';

// ── WooCommerce ──────────────────────────────────────────────────────────────

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const PER_PAGE = 100;
/** Tope duro de páginas (100 suscripciones cada una). Un fallo de paginación no
 *  puede dejar la función pidiendo páginas hasta agotar `maxDuration`. */
const MAX_PAGES = 50;
/** Páginas en paralelo. Bajo a propósito, igual que en sync-company-plans: la
 *  API de Woo de esta instalación no es rápida y no conviene apurarla. */
const CHUNK = 4;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function wcCreds(): { base: string; ck: string; cs: string } | null {
  const base = process.env.WOOCOMMERCE_URL;
  const ck   = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs   = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!base || !ck || !cs) return null;
  return { base: base.replace(/\/$/, ''), ck, cs };
}

/** Lo ÚNICO que se pide de cada suscripción. Todo lo demás (line_items, notas,
 *  direcciones) no hace falta para contar y multiplicaría el tamaño de cada
 *  página por veinte. */
interface WooSub { status?: unknown; billing?: { email?: unknown } | null }

const nkEmail = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Una página de suscripciones + el total de páginas que anuncia WordPress. */
async function fetchPage(
  c: { base: string; ck: string; cs: string }, page: number,
): Promise<{ rows: WooSub[]; totalPages: number }> {
  // orderby=id&order=asc NO es cosmético: el endpoint ordena por `date desc` por
  // defecto, y las páginas 2-4 se piden en paralelo un instante después de la 1
  // (ver fetchAllSubscriptions). Con orden por fecha, una suscripción creada en
  // ese hueco corre la lista entera hacia abajo y una fila del final de la página
  // 1 reaparece al principio de la 2 — se cuenta dos veces. Por `id` ascendente
  // las altas nuevas se van SIEMPRE al final y no mueven a las que ya se leyeron.
  const url =
    `${c.base}/wp-json/wc/v3/subscriptions?per_page=${PER_PAGE}&page=${page}` +
    `&orderby=id&order=asc` +
    `&_fields=${encodeURIComponent('status,billing.email')}` +
    `&consumer_key=${encodeURIComponent(c.ck)}&consumer_secret=${encodeURIComponent(c.cs)}`;

  let lastErr = 'error desconocido';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
      } else {
        const data = await res.json();
        return {
          rows: Array.isArray(data) ? (data as WooSub[]) : [],
          totalPages: Number(res.headers.get('x-wp-totalpages')) || 0,
        };
      }
    } catch (err) {
      clearTimeout(timer);
      const e = err as { name?: string; message?: string };
      lastErr = e?.name === 'AbortError' ? `timeout tras ${TIMEOUT_MS}ms` : String(e?.message ?? err);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  throw new Error(`página ${page}: ${lastErr}`);
}

/**
 * Todas las suscripciones de la tienda.
 *
 * WordPress manda el total de páginas en la cabecera `X-WP-TotalPages`, y con
 * ella el resto se pide en paralelo. Si esa cabecera no llega (algún plugin de
 * caché las recorta) se cae a un recorrido secuencial hasta que una página vuelve
 * incompleta, que es el final de la lista. Sin ese respaldo, un header ausente
 * haría que el endpoint contara SOLO las primeras 100 suscripciones y devolviera
 * un número plausible pero falso, que es la peor forma de fallar para algo que
 * alimenta un gráfico.
 */
async function fetchAllSubscriptions(
  c: { base: string; ck: string; cs: string },
): Promise<{ rows: WooSub[]; paginas: number }> {
  const first = await fetchPage(c, 1);
  const rows = [...first.rows];

  if (first.totalPages > 0) {
    const last = Math.min(first.totalPages, MAX_PAGES);
    for (let p = 2; p <= last; p += CHUNK) {
      const nums: number[] = [];
      for (let n = p; n < p + CHUNK && n <= last; n++) nums.push(n);
      const pages = await Promise.all(nums.map(n => fetchPage(c, n)));
      for (const pg of pages) rows.push(...pg.rows);
    }
    if (first.totalPages > MAX_PAGES) {
      console.error(`[external/subscriptions] la tienda tiene ${first.totalPages} páginas y el tope es ${MAX_PAGES}: el recuento sale corto.`);
    }
    return { rows, paginas: last };
  }

  let page = 1;
  while (rows.length >= PER_PAGE * page && page < MAX_PAGES) {
    page++;
    const pg = await fetchPage(c, page);
    rows.push(...pg.rows);
    if (pg.rows.length < PER_PAGE) break;
  }
  return { rows, paginas: page };
}

export interface WooCount {
  /** false → no se pudo leer WooCommerce. Los recuentos de abajo van en 0/null. */
  ok: boolean;
  total: number;
  /** Un contador por cada estado conocido por WOO_STATUS, siempre presentes. */
  por_estado: Record<string, number>;
  /** Estados que la app no mapea ('switched'…). Vacío lo normal. */
  otros_estados: Record<string, number>;
  /** Suscripciones que DAN ACCESO: active + pending-cancel (isActiveWooStatus). */
  dan_acceso: number;
  /**
   * Emails DISTINTOS entre las suscripciones que dan acceso. Junto a `dan_acceso`
   * es lo que mide cuánta gente tiene MÁS DE UNA suscripción activa a la vez:
   * `dan_acceso - emails_con_acceso` = suscripciones de más. Sin este número la
   * distancia entre las suscripciones y las personas hay que auditarla a mano
   * (ver la nota de `descuadres`). Con Woo caído va 0, como el resto del bloque.
   */
  emails_con_acceso: number;
  paginas_leidas: number;
  error: string | null;
}

interface WooResult {
  conteo: WooCount;
  /** email normalizado → nº de suscripciones suyas que dan acceso. */
  accesoPorEmail: Map<string, number>;
  /** Suscripciones con acceso y sin email: no hay forma de cruzarlas. */
  conAccesoSinEmail: number;
}

const WOO_CAIDO = (msg: string): WooResult => ({
  conteo: {
    ok: false, total: 0,
    por_estado: Object.fromEntries(Object.keys(WOO_STATUS).map(k => [k, 0])),
    otros_estados: {}, dan_acceso: 0, emails_con_acceso: 0, paginas_leidas: 0, error: msg,
  },
  accesoPorEmail: new Map(),
  conAccesoSinEmail: 0,
});

async function contarWoo(): Promise<WooResult> {
  const creds = wcCreds();
  if (!creds) {
    console.error('[external/subscriptions] WooCommerce no configurado.');
    return WOO_CAIDO('woocommerce_no_configurado');
  }

  let rows: WooSub[];
  let paginas: number;
  try {
    ({ rows, paginas } = await fetchAllSubscriptions(creds));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    console.error('[external/subscriptions] WooCommerce no respondió:', msg);
    return WOO_CAIDO(msg);
  }

  // Los estados salen de WOO_STATUS y no de una lista escrita acá: si mañana se
  // añade uno al mapa único, este endpoint lo reporta sin tocarlo. Lo que no esté
  // en el mapa cae en `otros_estados` en vez de desaparecer del recuento.
  const porEstado: Record<string, number> = Object.fromEntries(Object.keys(WOO_STATUS).map(k => [k, 0]));
  const otros: Record<string, number> = {};
  const accesoPorEmail = new Map<string, number>();
  let danAcceso = 0;
  let conAccesoSinEmail = 0;

  for (const s of rows) {
    const status = typeof s?.status === 'string' ? s.status : '';
    // Object.hasOwn y no `status in porEstado`: `in` recorre la cadena de
    // prototipos, así que un estado llamado 'toString' o 'constructor' daría true
    // y el ++ escribiría NaN sobre un contador que no existe. Con los slugs de
    // Woo no puede pasar hoy, pero el coste de blindarlo es cero.
    if (Object.hasOwn(porEstado, status)) porEstado[status]++;
    else otros[status || 'sin_estado'] = (otros[status || 'sin_estado'] ?? 0) + 1;

    if (!isActiveWooStatus(status)) continue;
    danAcceso++;
    const email = nkEmail(s?.billing?.email);
    if (!email) { conAccesoSinEmail++; continue; }
    accesoPorEmail.set(email, (accesoPorEmail.get(email) ?? 0) + 1);
  }

  return {
    conteo: {
      ok: true, total: rows.length, por_estado: porEstado, otros_estados: otros,
      dan_acceso: danAcceso, emails_con_acceso: accesoPorEmail.size,
      paginas_leidas: paginas, error: null,
    },
    accesoPorEmail,
    conAccesoSinEmail,
  };
}

// ── Alumnos ──────────────────────────────────────────────────────────────────

interface StudentRow {
  id: string;
  email?: string | null;
  manual_active_until?: string | null;
  is_oritalk?: boolean | null;
  oritalk_until?: string | null;
  company_plan_months?: number | null;
}

// Columnas en orden de preferencia. Las migraciones de Oritalk y de planes de
// empresa pueden no estar corridas en una instalación dada, y un SELECT explícito
// falla ENTERO si una columna no existe — por eso el resto del repo usa
// `select('*')`. Acá se prefiere degradar el detalle antes que traer la fila
// completa de cada alumno solo por si acaso: sin `is_oritalk` el desglose pierde
// el bucket de Oritalk, no el total.
const SELECTS = [
  'id,email,manual_active_until,is_oritalk,oritalk_until,company_plan_months',
  'id,email,manual_active_until,is_oritalk,oritalk_until',
  'id,email,manual_active_until',
] as const;

/** Tamaño de página del SELECT. PostgREST corta en 1000 filas por defecto y lo
 *  hace en silencio: sin paginar, pasar de mil alumnos deflactaría el recuento
 *  sin ningún error de por medio. */
const DB_PAGE = 1000;

async function leerAlumnos(): Promise<StudentRow[]> {
  for (const cols of SELECTS) {
    const rows: StudentRow[] = [];
    let ok = true;
    for (let page = 0; page < 20; page++) {
      const { data, error } = await supabase
        .from('students')
        .select(cols)
        .order('id')
        .range(page * DB_PAGE, (page + 1) * DB_PAGE - 1);
      if (error) {
        if (cols === SELECTS[0]) {
          console.error(`[external/subscriptions] faltan columnas opcionales (${error.message}); se reintenta con menos.`);
        }
        ok = false;
        break;
      }
      const lote = (data ?? []) as unknown as StudentRow[];
      rows.push(...lote);
      if (lote.length < DB_PAGE) break;
    }
    if (ok) return rows;
  }
  throw new Error('no se pudieron leer los alumnos');
}

// ── Resultado ────────────────────────────────────────────────────────────────

export interface SubscriptionsSnapshot {
  today_madrid: string;
  woocommerce: WooCount;
  alumnos: {
    en_base: number;
    /**
     * Activos totales. `null` cuando WooCommerce no contestó: sin su respuesta
     * falta uno de los tres orígenes y el total sería un piso, no el dato. Va
     * null explícito y NUNCA 0 para que un gráfico no dibuje una caída inventada.
     */
    activos: number | null;
    inactivos: number | null;
    /** Excluyentes por precedencia oritalk > manual > woo: suman `activos`. */
    por_origen: {
      suscripcion: number | null;
      manual: { total: number; plan_empresa: number; a_mano: number };
      oritalk: number;
    };
    /**
     * Alumnos que tienen override (manual u Oritalk) Y ADEMÁS una suscripción de
     * Woo que da acceso. NO es un descuadre: cuentan en su bucket de `por_origen`
     * por precedencia y por eso no están en `suscripcion`, que es correcto. Se
     * publica porque es la otra mitad —junto a `emails_con_acceso`— de por qué
     * `dan_acceso` no coincide con `por_origen.suscripcion`. null con Woo caído.
     */
    con_override_y_suscripcion: number | null;
  };
  descuadres: {
    /** Pagan en Woo pero no existen en la base: altas sin dar de alta. */
    suscripciones_activas_sin_alumno: number | null;
    /** Dan acceso pero Woo no trae email: imposible cruzarlas con nadie. */
    suscripciones_activas_sin_email: number | null;
    /** Alumnos sin email: nunca podrán contarse por suscripción. */
    alumnos_sin_email: number;
  };
}

/**
 * DE `dan_acceso` (SUSCRIPCIONES) A `por_origen.suscripcion` (PERSONAS).
 *
 * Los dos números están bien y casi nunca coinciden. Todo lo que hace falta para
 * cerrar la diferencia sin auditar a mano está publicado; con los datos reales
 * del 28/08/2026 entre paréntesis:
 *
 *   dan_acceso                                     (135)
 *   − suscripciones_activas_sin_email                (0)  Woo no trae el email
 *   − suscripciones_activas_sin_alumno               (5)  huérfanas: pagan y no
 *                                                         están dados de alta
 *   = suscripciones sobre emails que sí existen    (130)
 *
 *   S = por_origen.suscripcion + con_override_y_suscripcion
 *       → personas en la base que tienen alguna suscripción con acceso
 *   suscripciones de más por persona = 130 − S
 *       → gente con dos o más suscripciones activas a la vez
 *   emails huérfanos distintos = emails_con_acceso − S
 *
 * Y por el otro lado: `por_origen.suscripcion` cuenta FILAS de `students`, no
 * personas. Hoy los 189 alumnos tienen 189 emails distintos, así que da igual;
 * si algún día se duplica una fila, el número se infla y esta nota es el aviso.
 */

// Cache en memoria por instancia serverless. 60 s: el dato es un recuento que se
// mueve por hora, no por segundo, y sin cache cada tarjeta del dashboard pagaría
// su propia pasada completa por WooCommerce.
const TTL_MS = 60_000;
let cached: { snap: SubscriptionsSnapshot; ts: number } | null = null;

export async function loadSubscriptionsSnapshot(force = false): Promise<SubscriptionsSnapshot> {
  if (!force && cached && Date.now() - cached.ts < TTL_MS) return cached.snap;

  const today = madridToday();
  // En paralelo: son dos sistemas distintos y ninguno depende del otro.
  const [woo, alumnos] = await Promise.all([contarWoo(), leerAlumnos()]);

  let porSuscripcion = 0;
  let manualEmpresa = 0;
  let manualAMano = 0;
  let oritalk = 0;
  let sinEmail = 0;
  let overrideConSuscripcion = 0;
  const emailsEnBase = new Set<string>();

  for (const a of alumnos) {
    const email = nkEmail(a.email);
    if (email) emailsEnBase.add(email); else sinEmail++;

    // Se calcula ANTES de mirar el override y no dentro de la última rama: la
    // pregunta "¿tiene suscripción con acceso?" es independiente de por qué se le
    // termina contando, y es justo lo que hay que saber de los que ganan por
    // override para poder explicar la distancia entre suscripciones y personas.
    const tieneSuscripcionConAcceso =
      woo.conteo.ok && !!email && woo.accesoPorEmail.has(email);

    // MISMA función que decide el acceso en check-subscription, con la misma
    // precedencia: Oritalk gana a la activación manual, y el override gana a
    // WooCommerce. Contar los buckets en otro orden los solaparía y el desglose
    // sumaría más que el total.
    const override = accessOverrideOf(a, today);
    // Con override cuenta en SU bucket y no en `suscripcion`, aunque además pague
    // en Woo. Eso es lo correcto (si no, sumaría dos veces), y a la vez es una de
    // las dos razones por las que dan_acceso > suscripcion: acá queda anotada.
    if (override && tieneSuscripcionConAcceso) overrideConSuscripcion++;
    if (override?.kind === 'oritalk') { oritalk++; continue; }
    if (override?.kind === 'manual') {
      // `company_plan_months` lo escribe la detección automática de planes de
      // empresa (lib/productUtils.detectCompanyPlan), así que es el único indicio
      // que separa "lo activó el sistema por su plan" de "lo activó alguien a
      // mano". Caso borde conocido: a un alumno de empresa al que además le
      // alargaron la fecha a mano se le sigue viendo el plan, y cae en
      // `plan_empresa`.
      if (a.company_plan_months != null) manualEmpresa++; else manualAMano++;
      continue;
    }
    // Sin override: manda WooCommerce. Sin email no hay forma de preguntarle.
    if (tieneSuscripcionConAcceso) porSuscripcion++;
  }

  const manualTotal = manualEmpresa + manualAMano;
  const activos = woo.conteo.ok ? porSuscripcion + manualTotal + oritalk : null;

  // Suscripciones con acceso cuyo email no es de ningún alumno. Se cuentan
  // SUSCRIPCIONES y no emails: dos productos de la misma persona son dos altas
  // pendientes de resolver, no una.
  let subsSinAlumno = 0;
  for (const [email, n] of woo.accesoPorEmail) {
    if (!emailsEnBase.has(email)) subsSinAlumno += n;
  }

  const snap: SubscriptionsSnapshot = {
    today_madrid: today,
    woocommerce: woo.conteo,
    alumnos: {
      en_base: alumnos.length,
      activos,
      inactivos: activos === null ? null : alumnos.length - activos,
      por_origen: {
        suscripcion: woo.conteo.ok ? porSuscripcion : null,
        manual: { total: manualTotal, plan_empresa: manualEmpresa, a_mano: manualAMano },
        oritalk,
      },
      con_override_y_suscripcion: woo.conteo.ok ? overrideConSuscripcion : null,
    },
    descuadres: {
      suscripciones_activas_sin_alumno: woo.conteo.ok ? subsSinAlumno : null,
      suscripciones_activas_sin_email: woo.conteo.ok ? woo.conAccesoSinEmail : null,
      alumnos_sin_email: sinEmail,
    },
  };

  // Una foto sin WooCommerce no se cachea: la siguiente petición tiene que poder
  // volver a intentarlo en vez de arrastrar el fallo un minuto entero.
  if (woo.conteo.ok) cached = { snap, ts: Date.now() };
  return snap;
}
