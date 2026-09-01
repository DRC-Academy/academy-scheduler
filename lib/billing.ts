// ── Facturación por alumno y margen por profesor ─────────────────────────────
//
// Responde dos preguntas, en este orden:
//   1. ¿Cuánto factura un alumno en un mes?     → facturacionMensualDe
//   2. ¿Cuánto deja su profesor ese mes?        → margenDe
//
// Módulo PURO en el sentido que importa: no consulta nada. Trabaja sobre datos ya
// cargados (alumnos + filas de `product_prices`) para poder correr tanto en el
// endpoint externo como en cualquier panel sin consultas extra. Los precios se
// cargan A MANO en Supabase; no hay sincronización con WooCommerce (decisión del
// 11/08/2026).
//
// Comparte `addCalendarMonths` con lib/productUtils en vez de tener su propia
// copia: es la aritmética que decide dónde termina un plan, y dos versiones que
// se separen es exactamente el tipo de error que este archivo viene a evitar.
//
// NULL NO ES CERO. Es la regla que gobierna todo este archivo. Un alumno sin
// precio resuelto devuelve `null` = "no lo sabemos", nunca 0 = "no paga". Si se
// confundieran, el margen de un profesor con la mitad del catálogo sin cargar
// saldría espectacular y nadie se enteraría de que falta la mitad de los datos.
// Por eso `margenDe` devuelve además alumnosConPrecio/alumnosTotales, y el
// dashboard puede avisar de que lo que muestra está incompleto.

import type { Student, ProductPrice } from '@/types';
import { addCalendarMonths } from '@/lib/productUtils';

// ── Emparejado alumno → fila de precio ───────────────────────────────────────

export type PriceMatchStatus =
  /** Hay fila activa: se puede facturar. */
  | 'ok'
  /** La fila que gana está marcada active=false: producto NO facturable. */
  | 'excluido'
  /** Ningún patrón casa con el nombre del producto. */
  | 'sin_match';

export interface PriceMatch {
  status: PriceMatchStatus;
  row: ProductPrice | null;
}

const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase();

/**
 * La fila que le corresponde a un producto. GANA EL PATRÓN MÁS LARGO.
 *
 * Sin esa regla el sistema no funciona: "Inglés general" es subcadena de "Curso
 * de inglés general - 2h semanales, B1", de "Intensivos Inglés general" y de
 * "Matricula DRC Academy - Inglés General". Una sola fila corta se comería medio
 * catálogo y cobraría a todos el precio equivocado.
 *
 * LAS FILAS INACTIVAS COMPITEN IGUAL, y si ganan devuelven 'excluido' en vez de
 * dejar paso a una más corta. Ese matiz es el que resuelve el caso real de la
 * matrícula: "Matricula DRC Academy - Inglés General" es un cobro de alta única.
 * Si su fila simplemente no existiera, el alumno caería en "Inglés general" —más
 * corta, pero también subcadena de su producto— y se le facturaría un plan
 * mensual completo todos los meses. Cargarla con active=false la hace ganar el
 * match y cortar ahí.
 */
export function resolveProductPrice(
  productName: string | null | undefined,
  prices: ProductPrice[],
): PriceMatch {
  const hay = norm(productName);
  if (!hay.trim()) return { status: 'sin_match', row: null };

  let best: ProductPrice | null = null;
  for (const p of prices) {
    const needle = norm(p.productNameContains);
    if (!needle) continue;
    if (!hay.includes(needle)) continue;
    if (!best || p.productNameContains.length > best.productNameContains.length) best = p;
  }

  if (!best) return { status: 'sin_match', row: null };
  return { status: best.active ? 'ok' : 'excluido', row: best };
}

// ── Aritmética de meses ('YYYY-MM') ──────────────────────────────────────────

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Suma (o resta, con n negativo) meses de calendario a un 'YYYY-MM'. */
export function addMonths(monthYear: string, n: number): string | null {
  const m = MONTH_RE.exec((monthYear ?? '').slice(0, 7));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ── Facturación de UN alumno en UN mes ───────────────────────────────────────

export type BillingKind = 'recurrente' | 'pago_unico' | null;

/**
 * Lo mínimo que hace falta de un alumno para facturarlo.
 *
 * `plan` y `createdAt` van OPCIONALES aunque en `Student` sean obligatorios,
 * porque acá los dos son respaldos y no datos exigidos: `plan` respalda a
 * `productName` (`productName ?? plan ?? ''`) y `createdAt` respalda a
 * `companyPlanStart` como ancla. Exigirlos obligaba a inventar valores a quien
 * llama con lo que de verdad tiene.
 */
export type BillableStudent =
  Pick<Student, 'productName' | 'manualActiveUntil' | 'companyPlanMonths' | 'companyPlanStart'>
  & { plan?: string; createdAt?: string };

/** De dónde salió la fecha de inicio del pago único, por orden de confianza. */
export type AnchorSource =
  /** `company_plan_start`: la fecha del pedido de WooCommerce. El dato real. */
  | 'pedido'
  /** `created_at`: el alta del alumno. Aproximación; ver `facturacionMensualDe`. */
  | 'alta';

export interface BillingResult {
  /** €/mes. null = desconocido (nunca 0 por defecto). 0 = pago único fuera de ventana. */
  eur: number | null;
  kind: BillingKind;
  /** Por qué salió ese número. Va a los logs y al detalle del admin, no al dashboard. */
  reason: string;
  /** Patrón de `product_prices` que ganó el match, si hubo alguno. */
  matched: string | null;
  /** Solo en pago único: los meses que toca el reparto ('YYYY-MM'). */
  window: { from: string; to: string } | null;
  /** Solo en pago único: la fecha de inicio usada y de dónde salió. */
  anchor: { date: string; source: AnchorSource } | null;
  /**
   * VENTANA DUDOSA. El plan calculado y el acceso concedido no se parecen, así
   * que el número de este mes puede estar corrido. null = sin sospecha.
   *
   * No anula la facturación a propósito: un importe con una advertencia al lado
   * es más útil que un `null`, porque el `null` ya significa otra cosa distinta
   * ("no sabemos el precio") y mezclarlos borraría la diferencia.
   */
  warning: string | null;
}

const unknown = (reason: string, matched: string | null = null): BillingResult =>
  ({ eur: null, kind: null, reason, matched, window: null, anchor: null, warning: null });

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── Fechas de calendario ('YYYY-MM-DD') ──────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * 'YYYY-MM-DD' → milisegundos UTC, o null si no es una fecha REAL.
 *
 * El round-trip no es paranoia: WooCommerce devuelve '0000-00-00 00:00:00' en los
 * pedidos sin completar, y eso pasa cualquier validación de forma. Anclar ahí
 * daría una ventana que arranca en el año 0 y factura 0 € para siempre — el mismo
 * cero silencioso que este módulo existe para evitar.
 */
function parseISODate(raw: string | null | undefined): number | null {
  const s = (raw ?? '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s) return null;
  return ms;
}

/** Primer día del mes 'YYYY-MM', en ms UTC. */
function monthStartMs(monthYear: string): number {
  return Date.UTC(Number(monthYear.slice(0, 4)), Number(monthYear.slice(5, 7)) - 1, 1);
}

/**
 * Cuántos días puede separarse el fin calculado del acceso concedido antes de
 * considerar la ventana dudosa.
 *
 * UN MES. El colchón legítimo que pone el admin está medido: hasta +14 días sobre
 * la fecha del plan (ver el criterio "nunca recorta" en
 * lib/productUtils.resolveCompanyPlanUpdate), así que un mes deja holgura de
 * sobra y no marca a nadie por un margen normal. Sobre los datos de agosto/2026
 * levanta exactamente a los tres sospechosos —Héctor (+34 d), Mercedez (−41 d) y
 * Armando (−67 d)— y a ningún alumno con la fecha del pedido, que dan 0 clavado.
 *
 * Bajarlo a 25 sumaría a Blanca, David y Elizabeth (−26, −29, −29 d), que también
 * tienen el alta posterior al inicio real de su plan de empresa. Quedan por
 * debajo del umbral a propósito: se ven en `reason` y su importe está corrido un
 * mes, no equivocado.
 */
export const VENTANA_DUDOSA_DIAS = 31;

/**
 * Lo que factura un alumno en `monthYear` ('YYYY-MM').
 *
 * RECURRENTE (billing_months = 1) → `price` tal cual, todos los meses.
 *
 * PAGO ÚNICO (billing_months > 1) → el importe se reparte POR DÍAS sobre el
 * intervalo [inicio, inicio + meses); fuera de él, 0 €. Un intensivo de 540 €
 * imputado entero al mes de la compra haría que el margen de su profesor
 * pareciera enorme ese mes y negativo los dos siguientes, dando las mismas clases
 * los tres.
 *
 * ── POR QUÉ POR DÍAS Y NO price/meses (auditoría del 31/08/2026) ─────────────
 *
 * Repartir en escalón —un doceavo entero a cada mes que toque la ventana— hace
 * que un error de UN DÍA en la fecha de inicio mueva 180 € de un mes a otro. Con
 * el reparto por días, ese mismo error de un día mueve 6 €. La regla deja de ser
 * un acantilado y pasa a ser una pendiente, que es lo único que hace seguro
 * anclar a una fecha que a veces es aproximada.
 *
 * Arregla además una distorsión que el escalón tenía en las dos direcciones: un
 * alumno que empieza el 24 del mes facturaba el mes ENTERO. Carla Seco, alta el
 * 24/08/2026, pasaba de 270 € a los 71 € que le corresponden.
 *
 * El redondeo se hace sobre el ACUMULADO, no sobre la cuota de cada mes, para que
 * los céntimos se cancelen entre meses consecutivos y la suma de toda la ventana
 * dé el precio exacto. Redondeando cada mes por separado, tres meses de 540/3
 * pueden sumar 539,99.
 *
 * ── DE DÓNDE SALE EL INICIO ─────────────────────────────────────────────────
 *
 *   1. `company_plan_start` — la fecha del pedido de WooCommerce. El dato real.
 *   2. `created_at` — el alta del alumno.
 *
 * Y NO se cuenta hacia atrás desde `manual_active_until`, que es lo que se hacía
 * hasta el 31/08/2026. `until` lo pone el admin CON COLCHÓN, y un colchón que
 * cruza el fin de mes corre la ventana entera un mes hacia adelante: Izaro
 * Gaztañaga, Laia Pi y Héctor Guerra facturaron 0 € en agosto/2026 habiendo dado
 * 20, 18 y 11 clases ese mes, porque su ventana quedó empezando en septiembre.
 *
 * Ojo con la historia de este archivo: el comentario anterior decía que anclar al
 * inicio dejaba fuera el último mes de acceso (el alumno de empresa con acceso
 * hasta el 29/08 que dejaba de facturar en julio). Eso NO era un problema del
 * ancla — era un off-by-one dentro del propio conteo hacia atrás (`until − meses`
 * en vez de `until − (meses − 1)`). Anclando al inicio, ese alumno factura agosto
 * igual; hay un test que lo fija.
 *
 * Sin ninguna de las dos fechas → `null`. Un alumno de pago único sin inicio no
 * tiene ventana que calcular, y ponerle una inventada es peor que decir que no se
 * sabe.
 *
 * ── VENTANA DUDOSA ──────────────────────────────────────────────────────────
 *
 * `manual_active_until` no desaparece: baja de ancla a VALIDADOR. Si el fin
 * calculado y el acceso concedido se llevan más de un mes, el `warning` lo dice.
 * Ahí caen los dos modos de fallo que quedan: un `created_at` rancio (alumno
 * viejo que renovó, cuya alta es de mucho antes que el plan de hoy) y una
 * duración contratada que no coincide con el acceso dado (Héctor: 2 meses de
 * producto contra 3 meses y 4 días de acceso).
 *
 * `company_plan_months` (duración real contratada, extraída de la variación de
 * Woo) pisa a `billing_months` de la tabla — un dato por alumno le gana siempre a
 * una constante. Solo se aplica si el producto YA es de pago único: si la tabla
 * dice que es recurrente, manda la tabla.
 */
export function facturacionMensualDe(
  student: BillableStudent,
  monthYear: string,
  prices: ProductPrice[],
): BillingResult {
  if (!MONTH_RE.test((monthYear ?? '').slice(0, 7))) return unknown(`mes inválido: ${monthYear}`);

  // `product_name` es lo que escribe check-subscription; `plan` es el respaldo de
  // los alumnos cargados a mano, que no tienen producto de Woo.
  const productName = student.productName ?? student.plan ?? '';
  const { status, row } = resolveProductPrice(productName, prices);

  if (status === 'sin_match') return unknown('ningún patrón de product_prices casa con el producto');
  if (status === 'excluido') return unknown(`producto no facturable (${row!.productNameContains})`, row!.productNameContains);

  const price = row!.price;
  const patron = row!.productNameContains;

  // ── Recurrente ────────────────────────────────────────────────────────────
  if (row!.billingMonths <= 1) {
    return {
      eur: round2(price), kind: 'recurrente', reason: `plan recurrente · ${patron}`,
      matched: patron, window: null, anchor: null, warning: null,
    };
  }

  // ── Pago único ────────────────────────────────────────────────────────────
  const meses = (student.companyPlanMonths && student.companyPlanMonths >= 1)
    ? student.companyPlanMonths
    : row!.billingMonths;

  // Escalera del ancla. El pedido primero; el alta como respaldo.
  let inicio = (student.companyPlanStart ?? '').slice(0, 10);
  let source: AnchorSource = 'pedido';
  if (parseISODate(inicio) == null) {
    inicio = (student.createdAt ?? '').slice(0, 10);
    source = 'alta';
  }
  const iniMs = parseISODate(inicio);
  if (iniMs == null) {
    return unknown(`pago único sin fecha de pedido ni de alta (${patron})`, patron);
  }

  // Intervalo SEMIABIERTO [inicio, fin): "3 meses desde el 27" son los días del
  // 27 al 27. Es un día menos que `manual_active_until`, que por convención marca
  // el último día INCLUIDO — la diferencia es de un día sobre ~92 y no vale la
  // pena arrastrar dos convenciones por ella.
  const fin = addCalendarMonths(inicio, meses);
  const finMs = fin == null ? null : parseISODate(fin);
  if (fin == null || finMs == null) return unknown(`no se pudo calcular la ventana (${patron})`, patron);

  const totalDias = (finMs - iniMs) / DAY_MS;

  /** Días del intervalo transcurridos hasta `ms`, recortado a [0, totalDias]. */
  const transcurridos = (ms: number): number =>
    Math.min(totalDias, Math.max(0, (ms - iniMs) / DAY_MS));
  /** Importe acumulado hasta `ms`. Redondear ACÁ hace que la suma telescope. */
  const acumulado = (ms: number): number => round2(price * transcurridos(ms) / totalDias);

  const mesIni = monthStartMs(monthYear);
  const mesFin = Date.UTC(new Date(mesIni).getUTCFullYear(), new Date(mesIni).getUTCMonth() + 1, 1);
  const eur = round2(acumulado(mesFin) - acumulado(mesIni));

  // Meses que toca el reparto. El último es el del día ANTERIOR a `fin`, porque
  // el intervalo es semiabierto: un plan que termina el 01/10 no toca octubre.
  const from = inicio.slice(0, 7);
  const to = new Date(finMs - DAY_MS).toISOString().slice(0, 7);

  // ── Validador: `until` ya no ancla nada, pero sí contradice ───────────────
  let warning: string | null = null;
  const untilMs = parseISODate(student.manualActiveUntil);
  if (untilMs != null) {
    const desvio = Math.round((untilMs - finMs) / DAY_MS);
    if (Math.abs(desvio) > VENTANA_DUDOSA_DIAS) {
      const signo = desvio > 0 ? 'después' : 'antes';
      warning =
        `ventana dudosa: el plan de ${meses} meses desde ${inicio} (${source}) termina el ${fin}, ` +
        `pero el acceso llega hasta el ${student.manualActiveUntil!.slice(0, 10)} — ` +
        `${Math.abs(desvio)} días ${signo}${eur === 0 ? ', y este mes factura 0 €' : ''}`;
    }
  }

  const origen = source === 'pedido' ? 'inicio real del pedido' : 'alta del alumno';
  const dentro = eur > 0;

  return {
    eur,
    kind: 'pago_unico',
    reason:
      `pago único ${price} € / ${meses} meses · ${inicio}..${fin} (${origen}) · ` +
      `reparto por días${dentro ? '' : ' · fuera de ventana'}`,
    matched: patron,
    window: { from, to },
    anchor: { date: inicio, source },
    warning,
  };
}

// ── Margen de un profesor ────────────────────────────────────────────────────

export interface MargenResult {
  /** Suma de lo que facturan sus alumnos con precio resuelto. */
  facturacion: number;
  /** facturacion − totalAPagar. null si NINGÚN alumno tiene precio. */
  margen: number | null;
  alumnosConPrecio: number;
  alumnosTotales: number;
  /** ¿Falta el precio de al menos un alumno? El dashboard tiene que avisarlo. */
  facturacionParcial: boolean;
  /**
   * Alumnos cuya ventana de pago único no cuadra con su acceso. Su importe SÍ
   * está sumado en `facturacion` — esto no dice "falta un dato" (para eso está
   * `facturacionParcial`), dice "este dato puede estar corrido de mes".
   */
  ventanasDudosas: number;
  /** Detalle por alumno, para poder auditar de dónde sale el número. */
  detalle: Array<{ studentName: string; eur: number | null; reason: string; warning: string | null }>;
}

/**
 * Facturación y margen de un profesor en un mes.
 *
 * `margen` es null cuando NINGUNO de sus alumnos tiene precio: ahí la resta no
 * significa nada (sería "0 − lo que le pagamos" = pérdida inventada). Con al
 * menos uno se devuelve el número y `facturacionParcial` avisa de que es un piso,
 * no el total.
 *
 * Un alumno de pago único FUERA de su ventana cuenta como "con precio": su
 * facturación de ese mes es 0 € de verdad, no un dato que falte.
 */
export function margenDe(args: {
  students: Array<BillableStudent & Pick<Student, 'name'>>;
  monthYear: string;
  prices: ProductPrice[];
  totalAPagar: number;
}): MargenResult {
  let facturacion = 0;
  let conPrecio = 0;
  let dudosas = 0;
  const detalle: MargenResult['detalle'] = [];

  for (const s of args.students) {
    const r = facturacionMensualDe(s, args.monthYear, args.prices);
    detalle.push({ studentName: s.name, eur: r.eur, reason: r.reason, warning: r.warning });
    if (r.warning) dudosas++;
    if (r.eur == null) continue;
    facturacion += r.eur;
    conPrecio++;
  }

  return {
    facturacion: round2(facturacion),
    margen: conPrecio === 0 ? null : round2(facturacion - args.totalAPagar),
    alumnosConPrecio: conPrecio,
    alumnosTotales: args.students.length,
    facturacionParcial: conPrecio < args.students.length,
    ventanasDudosas: dudosas,
    detalle,
  };
}
