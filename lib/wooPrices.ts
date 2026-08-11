// ── Precio efectivo de cada alumno (facturación) ─────────────────────────────
//
// Módulo PURO: normaliza a €/mes lo que cobra WooCommerce, sea cual sea la forma
// en que lo cobre. Lo comparten el probe (/api/admin/woo-price-probe), el cron de
// sincronización y el cálculo de margen por profesor, para que los tres digan el
// mismo número.
//
// POR QUÉ EL PRECIO NO SE LEE DEL CATÁLOGO (decisión del 11/08/2026)
//
// La intuición es que el precio de un alumno es el precio de su producto. En
// WooCommerce Subscriptions no lo es: el importe vive en el line item de LA
// SUSCRIPCIÓN y queda congelado al comprarla. Si mañana se sube el plan mensual
// de 60 a 70 €, los suscriptores actuales siguen pagando 60 hasta que cancelen y
// vuelvan a comprar.
//
// Leer el catálogo, entonces, haría justo lo contrario de lo que se busca: el día
// del aumento la facturación calculada saltaría de golpe para todos sin que se
// hubiera cobrado un euro más, e inflaría el margen de todos los profesores. Lo
// mismo con los cupones, que viven en el pedido y no en el producto.
//
// Por eso la fuente es, por orden:
//   1. la suscripción del alumno (importe real, ya con descuentos y precio viejo);
//   2. su pedido, si es de pago único;
//   3. el catálogo, SOLO como respaldo para quien no casa con ninguno de los dos.
//
// Ver supabase-woo-prices.sql y el diseño en la conversación del 11/08/2026.

// ── Importes ─────────────────────────────────────────────────────────────────

/**
 * Los importes de WooCommerce llegan como STRING ("60.00", "1250.5", "" para los
 * gratuitos, y a veces con coma decimal según la config de la tienda). Un
 * `Number()` a secas devuelve NaN en la mitad de esos casos y el NaN se propaga
 * en silencio hasta el total de facturación, que aparece vacío sin decir por qué.
 *
 * Devuelve null —no 0— cuando no hay importe legible: son cosas distintas. Un
 * alumno con precio 0 factura cero; uno con precio null es un dato que falta y
 * hay que ir a buscar.
 */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  // "1.250,50" (es-ES) vs "1250.50" (en-US). Si hay coma Y punto, el último
  // separador que aparece es el decimal.
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  let normalized = t;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot
      ? t.replace(/\./g, '').replace(',', '.')   // 1.250,50
      : t.replace(/,/g, '');                     // 1,250.50
  } else if (lastComma >= 0) {
    // Solo coma: decimal ("60,00") salvo que parezca separador de millar ("1,250").
    normalized = /,\d{3}$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// ── Normalización a €/mes ────────────────────────────────────────────────────

export type BillingPeriod = 'day' | 'week' | 'month' | 'year';

/**
 * Cuántos meses dura un periodo de facturación.
 *
 * La semana son 4,345 meses/12 y no 4: con 4 se pierde un cobro al año, que en
 * una suscripción semanal de 15 € son 195 € de facturación anual que no aparecen.
 */
const MONTHS_PER_PERIOD: Record<BillingPeriod, number> = {
  day: 1 / 30.4375,
  week: 1 / 4.348,
  month: 1,
  year: 12,
};

export function isBillingPeriod(v: unknown): v is BillingPeriod {
  return v === 'day' || v === 'week' || v === 'month' || v === 'year';
}

/**
 * Importe de una suscripción normalizado a €/mes.
 *
 * IMPRESCINDIBLE: una suscripción anual de 600 € son 50 €/mes, no 600. Sin
 * normalizar, UN SOLO alumno anual descuadra el margen de su profesor por un
 * factor de doce, y como el número no es absurdo a simple vista nadie lo nota.
 *
 * `interval` es el "cada cuántos periodos" de WooCommerce: period='month' con
 * interval=3 significa un cobro cada trimestre.
 *
 * Devuelve null si falta el importe o el periodo no se reconoce. Quien llame
 * decide qué hacer con el hueco; lo que no puede es inventarse un número.
 */
export function monthlyFromSubscription(args: {
  total: unknown;
  billingPeriod: unknown;
  billingInterval?: unknown;
}): number | null {
  const total = parseAmount(args.total);
  if (total == null) return null;
  if (!isBillingPeriod(args.billingPeriod)) return null;

  const rawInterval = typeof args.billingInterval === 'string'
    ? parseInt(args.billingInterval, 10)
    : args.billingInterval;
  const interval = typeof rawInterval === 'number' && Number.isFinite(rawInterval) && rawInterval >= 1
    ? rawInterval
    : 1;

  const months = MONTHS_PER_PERIOD[args.billingPeriod] * interval;
  if (!(months > 0)) return null;
  return round2(total / months);
}

// ── Pagos únicos: prorrateo ──────────────────────────────────────────────────
//
// Un intensivo de 450 € no es facturación de un mes: es un curso que se consume
// a lo largo de varios. Imputarlo entero al mes de la compra haría que el margen
// de ese profesor pareciera enorme en agosto y negativo en septiembre y octubre,
// cuando en realidad da las mismas clases los tres meses.
//
// La duración es FIJA POR TIPO DE PRODUCTO, no por clases efectivas (decisión de
// producto, 11/08/2026): las clases efectivas ya se cuentan en finanzas para
// pagarle al profesor, y mezclar las dos cosas haría que la facturación de un
// alumno dependiera de si vino a clase.

/**
 * Duración típica de cada intensivo, en meses. PENDIENTE DE VALIDACIÓN por el
 * dueño del producto — los valores de abajo son la propuesta del 11/08/2026.
 *
 * El match es por "contiene" sobre el nombre en minúsculas, igual criterio que
 * ONE_TIME_PRODUCTS en check-subscription. El orden IMPORTA: las claves más
 * específicas van primero, porque "intensivo general" también contiene
 * "intensivo" y el primero que casa es el que manda.
 *
 * Los productos de EMPRESA no están acá a propósito: su duración real viene en la
 * variación ("B1 · 1h semanal · 6 Meses"), ya la extrae detectCompanyPlan y ya
 * está guardada en students.company_plan_months. Un dato real por alumno siempre
 * gana a una constante. Ver prorateMonthsFor.
 */
export const PRORATE_MONTHS_BY_PRODUCT: Array<{ contains: string; months: number }> = [
  { contains: 'intensivo fce', months: 3 },
  { contains: 'intensivo cae', months: 3 },
  { contains: 'intensivo pet', months: 2 },
  { contains: 'intensivo general', months: 2 },
  // "Curso intensivo de ingles - OFERTA - 5h semanales": 5 h semanales es un
  // sprint corto, no un trimestre.
  { contains: 'curso intensivo de ingles', months: 1 },
];

/** Meses de reparto cuando el producto no casa con ninguna regla ni tiene duración propia. */
export const DEFAULT_PRORATE_MONTHS = 2;

/** Respaldo para un plan de empresa cuya variación no dijo la duración. */
export const DEFAULT_COMPANY_MONTHS = 6;

export interface ProrateResult {
  months: number;
  /** De dónde salió la duración. Va a la UI: un número calculado y uno supuesto no son lo mismo. */
  source: 'company_plan' | 'product_table' | 'company_default' | 'default';
}

/**
 * Sobre cuántos meses se reparte un pago único.
 *
 * PRIORIDAD 1 — `company_plan_months`. Es la duración que el cliente contrató de
 * verdad, escrita en la variación del producto y ya extraída por
 * productUtils.detectCompanyPlan. No hay constante que le gane a eso.
 *
 * PRIORIDAD 2 — la tabla por tipo de producto (los intensivos, cuya variación
 * lleva horario y no duración: "17 pm · Lunes, martes · 06/08/2026").
 */
export function prorateMonthsFor(args: {
  productName?: string | null;
  companyPlanMonths?: number | null;
  isCompany?: boolean;
}): ProrateResult {
  const months = args.companyPlanMonths;
  if (typeof months === 'number' && months >= 1) {
    return { months, source: 'company_plan' };
  }

  const name = (args.productName ?? '').toLowerCase();
  for (const rule of PRORATE_MONTHS_BY_PRODUCT) {
    if (name.includes(rule.contains)) return { months: rule.months, source: 'product_table' };
  }

  if (args.isCompany) return { months: DEFAULT_COMPANY_MONTHS, source: 'company_default' };
  return { months: DEFAULT_PRORATE_MONTHS, source: 'default' };
}

/** Importe mensual de un pago único, repartido sobre su duración. */
export function monthlyFromOneTime(amount: unknown, months: number): number | null {
  const total = parseAmount(amount);
  if (total == null) return null;
  if (!(months >= 1)) return null;
  return round2(total / months);
}

/**
 * Los meses de calendario ('YYYY-MM') a los que se imputa un pago único.
 *
 * Reparto PAREJO entre los N meses desde el de la compra, no proporcional por
 * días: es más fácil de explicar y el error de los bordes se compensa entre el
 * primer mes y el último.
 */
export function prorationMonths(startIso: string, months: number): string[] {
  const m = /^(\d{4})-(\d{2})/.exec((startIso ?? '').slice(0, 7));
  if (!m || !(months >= 1)) return [];
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const out: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(y, mo + i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// ── Emparejado alumno ↔ WooCommerce ──────────────────────────────────────────

/**
 * Clave de emparejado por email. El email de FACTURACIÓN de Woo puede venir con
 * mayúsculas y espacios; el nuestro también. Sin normalizar, un alumno con
 * "Nombre@Gmail.com " en la ficha no casa con su propia suscripción, factura 0 € y
 * hunde en silencio el margen del profesor que lo tiene.
 */
export function emailKey(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/** Nombre normalizado, mismo criterio tolerante que usa el resto del sistema. */
export function nameKey(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Frescura del sync ────────────────────────────────────────────────────────

export type Freshness = 'fresh' | 'stale' | 'never';

export interface FreshnessInfo {
  state: Freshness;
  ageMinutes: number | null;
  /** "Precios sincronizados hace 2 h" / "⚠️ Precios desactualizados — hace 19 h". */
  label: string;
}

/**
 * Cuán vieja es la última sincronización CON ÉXITO.
 *
 * El umbral es 2 ciclos y no 1: una corrida puede saltarse por un deploy o un
 * timeout puntual sin que eso signifique nada. Dos seguidas sí.
 *
 * "never" es su propio estado, distinto de "stale": nunca haber sincronizado y
 * llevar 19 horas sin hacerlo son dos problemas diferentes.
 */
export function syncFreshness(
  lastOkAt: string | Date | null | undefined,
  intervalHours: number,
  now: Date = new Date(),
): FreshnessInfo {
  if (!lastOkAt) {
    return { state: 'never', ageMinutes: null, label: 'Precios sin sincronizar todavía' };
  }
  const d = lastOkAt instanceof Date ? lastOkAt : new Date(lastOkAt);
  if (isNaN(d.getTime())) {
    return { state: 'never', ageMinutes: null, label: 'Precios sin sincronizar todavía' };
  }

  const ageMinutes = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000));
  const stale = ageMinutes > intervalHours * 60 * 2;
  const ago = humanAge(ageMinutes);
  return {
    state: stale ? 'stale' : 'fresh',
    ageMinutes,
    label: stale ? `⚠️ Precios desactualizados — última sync hace ${ago}` : `Precios sincronizados hace ${ago}`,
  };
}

/** "hace 2 min" / "hace 3 h" / "hace 2 días", mismo tono que components/LastUpdated. */
export function humanAge(minutes: number): string {
  if (minutes < 1) return 'un momento';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} días`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
