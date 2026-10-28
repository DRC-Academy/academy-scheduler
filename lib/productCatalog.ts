// ── Catálogo de productos de la OFERTA NUEVA (oct/2026) ──────────────────────
//
// FUENTE ÚNICA de qué es cada producto nuevo de WooCommerce: tipo de pago,
// meses del programa y horas semanales. Se busca por ID de producto (nunca por
// el nombre: el nombre de un mismo producto ya cambió de puntuación entre
// pedidos — "Desbloqueo: 1 clase" vs "Desbloqueo – 1 clase").
//
// Módulo PURO (sin red ni base): lo usan el servidor (check-subscription, la
// activación de pedidos, el cron) y el navegador (etiqueta del panel, finanzas).
//
// REGLA DE ORO: un producto que NO está acá se comporta EXACTAMENTE como antes
// de que existiera este archivo. Los planes de la oferta anterior (Curso de
// inglés general, niños, exámenes, intensivos, empresas) no tienen entrada a
// propósito: su acceso, sus fechas y su cupo siguen saliendo de donde salían.
//
// Datos de Facundo, 28/10/2026.

export type CatalogKind =
  /** Pago único: el pedido pagado activa al alumno hasta inicio + meses. */
  | 'pago_unico'
  /** Suscripción que dura todo el programa (un snippet de WP la mantiene active). */
  | 'fraccionado'
  /** Suscripción mensual sin fin, cancelable. */
  | 'mensual'
  /** Producto nuevo SIN datos: no activa ni cambia el cupo, solo genera aviso. */
  | 'sin_datos';

export interface CatalogProduct {
  id: number;
  name: string;
  kind: CatalogKind;
  /** Duración del programa. null = sin fecha de fin (mensual) o sin datos. */
  months: number | null;
  /** Horas por semana: fijan el cupo mensual. null = sin datos (no cambia el cupo). */
  weeklyHours: number | null;
  /** Plan para dos personas: se activa al comprador y se avisa de la segunda. */
  persons?: 2;
}

const P = (id: number, name: string, kind: CatalogKind, months: number | null, weeklyHours: number | null, extra?: Partial<CatalogProduct>): CatalogProduct =>
  ({ id, name, kind, months, weeklyHours, ...extra });

export const PRODUCT_CATALOG: Readonly<Record<number, CatalogProduct>> = {
  // Programas de pago único
  35652: P(35652, 'Programa Desbloqueo (pago único)', 'pago_unico', 6, 1),
  35653: P(35653, 'Programa Fluidez (pago único)',    'pago_unico', 6, 2),
  35655: P(35655, 'Programa Acelerado (pago único)',  'pago_unico', 6, 3),
  35658: P(35658, 'Plan Platino (pago único)',        'pago_unico', 9, 2),
  // Programas de pago fraccionado (suscripción que dura todo el programa)
  35635: P(35635, 'Programa Desbloqueo (fraccionado)', 'fraccionado', 6, 1),
  35654: P(35654, 'Programa Fluidez (fraccionado)',    'fraccionado', 6, 2),
  35656: P(35656, 'Programa Acelerado (fraccionado)',  'fraccionado', 6, 3),
  36385: P(36385, 'Plan Platino (fraccionado)',        'fraccionado', 9, 2),
  // Mensuales: "1h" = 1 hora POR SEMANA, igual que los planes antiguos.
  35661: P(35661, 'Mensual 1h', 'mensual', null, 1),
  35660: P(35660, 'Mensual 2h', 'mensual', null, 2),
  35706: P(35706, 'Mensual 3h', 'mensual', null, 3),
  35707: P(35707, 'Mensual 4h', 'mensual', null, 4),
  35708: P(35708, 'Mensual 5h', 'mensual', null, 5),
  // Otros de pago único
  35522: P(35522, 'Plan 6 meses · 2h semanales · 2 personas', 'pago_unico', 6, 2, { persons: 2 }),
  35523: P(35523, 'Plan 9 meses · 2h semanales · 2 personas', 'pago_unico', 9, 2, { persons: 2 }),
  35773: P(35773, 'Plan Personalizado · 3 meses x 3h semanales', 'pago_unico', 3, 3),
  // Sin datos todavía: aviso en el admin, ni se activan ni cambian el cupo.
  35905: P(35905, 'Programa Platino Alumno (upsell)', 'sin_datos', null, null),
  36027: P(36027, 'Programa Fluidez 1h/sem (upsell)', 'sin_datos', null, null),
  35986: P(35986, 'Plan Maria Ahumada', 'sin_datos', null, null),
};

/**
 * Los productos de la oferta nueva empiezan en este ID (35522 es el primero).
 * Todo producto con un ID igual o mayor que NO esté en el catálogo es un
 * producto nuevo sin regla y genera aviso, en vez de ignorarse en silencio. Los
 * IDs de WordPress son correlativos, así que ningún producto de la oferta
 * anterior llega hasta acá.
 */
export const NEW_OFFER_MIN_PRODUCT_ID = 35500;

function toId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Entrada del catálogo de un producto (o de su variación). */
export function catalogProduct(productId: unknown, variationId?: unknown): CatalogProduct | null {
  const p = toId(productId), v = toId(variationId);
  return (p != null ? PRODUCT_CATALOG[p] : undefined) ?? (v != null ? PRODUCT_CATALOG[v] : undefined) ?? null;
}

/** ¿Es un producto de la oferta nueva que no tiene regla en el catálogo? */
export function isUnknownNewProduct(productId: unknown): boolean {
  const id = toId(productId);
  return id != null && id >= NEW_OFFER_MIN_PRODUCT_ID && !PRODUCT_CATALOG[id];
}

/**
 * Tipo de producto que se guarda en `students.product_type`.
 *
 * Con un producto del catálogo manda el catálogo; sin él, la clasificación por
 * nombre de siempre (`byName`). Un 'sin_datos' también cae en el nombre: no hay
 * regla que aplicarle, así que se queda como estaba.
 */
export function productTypeFor(
  productId: unknown, variationId: unknown, byName: () => 'one_time' | 'subscription',
): 'one_time' | 'subscription' {
  const c = catalogProduct(productId, variationId);
  if (c?.kind === 'pago_unico') return 'one_time';
  if (c?.kind === 'fraccionado' || c?.kind === 'mensual') return 'subscription';
  return byName();
}

/**
 * Horas semanales con las que se calcula el CUPO mensual de un alumno.
 *
 * Alumno con producto del catálogo (y horas conocidas): las del plan comprado,
 * tenga las casillas que tenga en el calendario. Cualquier otro alumno: las de
 * su asignación, exactamente como antes.
 */
export function quotaWeeklyHours(assignmentWeeklyHours: number, wooProductId: unknown): number {
  const h = catalogProduct(wooProductId)?.weeklyHours;
  return h != null && h >= 1 ? h : assignmentWeeklyHours;
}

// ── Etiqueta de tipo de plan (panel de admin) ────────────────────────────────

export type PlanTypeLabel = 'Programa único' | 'Programa fraccionado' | 'Mensual' | 'Plan antiguo' | 'Empresa' | 'Manual';

export interface PlanTypeInput {
  wooProductId?: number | null;
  productName?: string | null;
  plan?: string | null;
  isOritalk?: boolean | null;
  manualActiveUntil?: string | null;
  isCompany: (name: string) => boolean;
}

/**
 * Tipo de plan que se muestra en el listado de alumnos. Solo informativo: no
 * decide acceso ni cupo.
 *
 *   · producto del catálogo → Programa único / Programa fraccionado / Mensual
 *   · producto de empresa → Empresa
 *   · sin producto de Woo pero con acceso puesto a mano (manual u Oritalk) → Manual
 *   · cualquier otro producto de Woo → Plan antiguo
 *   · nada de nada → null (no se pinta)
 */
export function planTypeLabel(s: PlanTypeInput): PlanTypeLabel | null {
  const c = catalogProduct(s.wooProductId);
  if (c?.kind === 'pago_unico') return 'Programa único';
  if (c?.kind === 'fraccionado') return 'Programa fraccionado';
  if (c?.kind === 'mensual') return 'Mensual';
  const name = (s.productName ?? '').trim() || (s.plan ?? '').trim();
  if (name && s.isCompany(name)) return 'Empresa';
  if ((s.productName ?? '').trim()) return 'Plan antiguo';
  if (s.isOritalk || (s.manualActiveUntil ?? '').trim()) return 'Manual';
  return name ? 'Plan antiguo' : null;
}

export function planTypeLabelStyle(label: PlanTypeLabel): { color: string; bg: string } {
  switch (label) {
    case 'Programa único':       return { color: '#7c3aed', bg: 'rgba(124,58,237,0.10)' };
    case 'Programa fraccionado': return { color: '#0e7490', bg: 'rgba(14,116,144,0.10)' };
    case 'Mensual':              return { color: '#1E9E3A', bg: 'rgba(30,158,58,0.10)' };
    case 'Empresa':              return { color: '#b45309', bg: 'rgba(180,83,9,0.10)' };
    case 'Manual':               return { color: '#2563eb', bg: 'rgba(37,99,235,0.10)' };
    default:                     return { color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
  }
}
