// ── Facturación por alumno y margen por profesor ─────────────────────────────
//
// Responde dos preguntas, en este orden:
//   1. ¿Cuánto factura un alumno en un mes?     → facturacionMensualDe
//   2. ¿Cuánto deja su profesor ese mes?        → margenDe
//
// Módulo PURO: trabaja sobre datos ya cargados (alumnos + filas de
// `product_prices`) para poder correr tanto en el endpoint externo como en
// cualquier panel sin consultas extra. Los precios se cargan A MANO en Supabase;
// no hay sincronización con WooCommerce (decisión del 11/08/2026).
//
// NULL NO ES CERO. Es la regla que gobierna todo este archivo. Un alumno sin
// precio resuelto devuelve `null` = "no lo sabemos", nunca 0 = "no paga". Si se
// confundieran, el margen de un profesor con la mitad del catálogo sin cargar
// saldría espectacular y nadie se enteraría de que falta la mitad de los datos.
// Por eso `margenDe` devuelve además alumnosConPrecio/alumnosTotales, y el
// dashboard puede avisar de que lo que muestra está incompleto.

import type { Student, ProductPrice } from '@/types';

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

export interface BillingResult {
  /** €/mes. null = desconocido (nunca 0 por defecto). 0 = pago único fuera de ventana. */
  eur: number | null;
  kind: BillingKind;
  /** Por qué salió ese número. Va a los logs y al detalle del admin, no al dashboard. */
  reason: string;
  /** Patrón de `product_prices` que ganó el match, si hubo alguno. */
  matched: string | null;
  /** Solo en pago único: los meses en los que se reparte el importe. */
  window: { from: string; to: string } | null;
}

const unknown = (reason: string, matched: string | null = null): BillingResult =>
  ({ eur: null, kind: null, reason, matched, window: null });

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Lo que factura un alumno en `monthYear` ('YYYY-MM').
 *
 * RECURRENTE (billing_months = 1) → `price` tal cual, todos los meses.
 *
 * PAGO ÚNICO (billing_months > 1) → `price / meses`, pero SOLO dentro de su
 * ventana; fuera de ella devuelve 0. Un intensivo de 450 € imputado entero al mes
 * de la compra haría que el margen de su profesor pareciera enorme ese mes y
 * negativo los dos siguientes, dando las mismas clases los tres.
 *
 * DE DÓNDE SALE LA VENTANA (decisión del 11/08/2026, sobre datos reales):
 *
 *   1. `company_plan_start` — la fecha del pedido de WooCommerce, el dato más
 *      real que existe. Solo la tienen 3 de ~38 alumnos de pago único.
 *   2. `manual_active_until` — la fecha de fin de acceso que el admin puso a
 *      mano. Se cuenta hacia atrás desde ahí.
 *
 * Y NO se usa `created_at`, que era el candidato obvio: en los tres alumnos donde
 * se pudo comparar contra la fecha real del pedido, se desviaba 7, 26 y 47 días.
 * Un mes y medio de error mueve la ventana entera de mes.
 *
 * Sin ninguna de las dos → `null`. Un alumno de pago único sin fecha de inicio ni
 * de fin no tiene ventana que calcular, y ponerle una inventada es peor que decir
 * que no se sabe.
 *
 * `company_plan_months` (duración real contratada, extraída de la variación de
 * Woo) pisa a `billing_months` de la tabla — un dato por alumno le gana siempre a
 * una constante. Solo se aplica si el producto YA es de pago único: si la tabla
 * dice que es recurrente, manda la tabla.
 */
export function facturacionMensualDe(
  student: Pick<Student, 'productName' | 'plan' | 'manualActiveUntil' | 'companyPlanMonths' | 'companyPlanStart'>,
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
    return { eur: round2(price), kind: 'recurrente', reason: `plan recurrente · ${patron}`, matched: patron, window: null };
  }

  // ── Pago único ────────────────────────────────────────────────────────────
  const meses = (student.companyPlanMonths && student.companyPlanMonths >= 1)
    ? student.companyPlanMonths
    : row!.billingMonths;

  const start = (student.companyPlanStart ?? '').slice(0, 7);
  let from: string | null = null;
  let origen = '';

  if (MONTH_RE.test(start)) {
    from = start;
    origen = 'inicio real del pedido';
  } else {
    const until = (student.manualActiveUntil ?? '').slice(0, 7);
    if (MONTH_RE.test(until)) {
      // Se ancla al FINAL, no al principio: la ventana son los `meses` que
      // TERMINAN en el mes del fin de acceso. Anclando al principio
      // (until − meses, y contar hacia adelante) el último mes de acceso se
      // quedaba fuera — el caso real es un alumno de empresa con acceso hasta el
      // 29/08 que dejaba de facturar en julio, teniendo 29 días de clases en
      // agosto.
      from = addMonths(until, -(meses - 1));
      origen = 'contada hacia atrás desde el fin de acceso';
    }
  }

  if (!from) {
    return unknown(`pago único sin fecha de inicio ni de fin (${patron})`, patron);
  }

  const to = addMonths(from, meses - 1);
  if (!to) return unknown(`no se pudo calcular la ventana (${patron})`, patron);

  const dentro = monthYear >= from && monthYear <= to;
  const cuota = round2(price / meses);

  return {
    eur: dentro ? cuota : 0,
    kind: 'pago_unico',
    reason: `pago único ${price} € / ${meses} meses · ventana ${from}..${to} (${origen})${dentro ? '' : ' · fuera de ventana'}`,
    matched: patron,
    window: { from, to },
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
  /** Detalle por alumno, para poder auditar de dónde sale el número. */
  detalle: Array<{ studentName: string; eur: number | null; reason: string }>;
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
  students: Array<Pick<Student, 'name' | 'productName' | 'plan' | 'manualActiveUntil' | 'companyPlanMonths' | 'companyPlanStart'>>;
  monthYear: string;
  prices: ProductPrice[];
  totalAPagar: number;
}): MargenResult {
  let facturacion = 0;
  let conPrecio = 0;
  const detalle: MargenResult['detalle'] = [];

  for (const s of args.students) {
    const r = facturacionMensualDe(s, args.monthYear, args.prices);
    detalle.push({ studentName: s.name, eur: r.eur, reason: r.reason });
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
    detalle,
  };
}
