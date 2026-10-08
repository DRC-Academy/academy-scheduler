// ── La variación "Pausa" de WooCommerce: ÚNICA fuente de los IDs ─────────────
//
// Cada producto de suscripción tiene una variación "Pausa" (20 €/mes). Mientras
// la línea de la suscripción sea una de ellas, el alumno sigue pagando y Woo dice
// 'active', pero para nosotros está EN PAUSA: no toma clases. Al volver a una
// variación normal, vuelve solo a Activo.
//
// Para añadir una Pausa nueva basta con sumar su ID a PAUSE_VARIATION_IDS. Se
// compara contra product_id y variation_id de la línea, así que vale tanto el ID
// de la variación como el de un producto entero de pausa.
//
// Además del ID se mira el atributo de la variación ("Pausa", sin mayúsculas ni
// tildes): es el respaldo si mañana se crea una Pausa y nadie añade el ID acá.
//
// Módulo PURO y sin imports: lo usan el servidor, el cliente y los tests, y
// lib/subscriptionAccess lo reexporta.

/** IDs de WooCommerce de las variaciones "Pausa" (dato de Facundo, 06/10/2026). */
export const PAUSE_VARIATION_IDS: readonly number[] = [
  35634, 35639, 35640, 35642, 35643, 35644, 35646,
];

/** Precio mensual de la Pausa: lo que factura un alumno en pausa. */
export const PAUSE_MONTHLY_PRICE_EUR = 20;

/** Línea de producto de una suscripción o pedido de Woo (lo que se usa de ella). */
export interface WooLineItem {
  name?: unknown;
  product_id?: unknown;
  variation_id?: unknown;
  meta_data?: Array<{ key?: unknown; value?: unknown; display_key?: unknown; display_value?: unknown }> | unknown;
}

/** Texto comparable: sin tildes, en minúsculas. */
const plain = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** ¿Este valor de atributo de variación es la "Pausa"? Sin mayúsculas ni tildes. */
export function isPauseVariationText(text: string | null | undefined): boolean {
  return !!text && plain(text).includes('pausa');
}

/**
 * ¿La línea es la variación "Pausa"? Por ID o por el atributo de la variación.
 * Del texto se mira SOLO el atributo (las metas sin "_" delante, que es como Woo
 * guarda los atributos elegidos), no el nombre del producto: un producto con
 * "pausa" en el nombre por otro motivo no se confunde.
 */
export function isPauseLineItem(li: WooLineItem | null | undefined): boolean {
  if (PAUSE_VARIATION_IDS.includes(Number(li?.product_id)) || PAUSE_VARIATION_IDS.includes(Number(li?.variation_id))) return true;
  const meta = Array.isArray(li?.meta_data) ? li!.meta_data as Array<Record<string, unknown>> : [];
  return meta.some(m => {
    const key = String(m?.key ?? '');
    if (key.startsWith('_')) return false;
    const v = m?.display_value ?? m?.value;
    return typeof v === 'string' && isPauseVariationText(v);
  });
}

/** ¿Alguna línea de esta suscripción (o pedido) es la variación Pausa? */
export function hasPauseItem(lineItems: unknown): boolean {
  return Array.isArray(lineItems) && lineItems.some(li => isPauseLineItem(li as WooLineItem));
}

/**
 * ¿Esta suscripción es de Pausa? Solo mira la línea, NO el estado: una Pausa
 * cancelada sigue siendo "de Pausa", pero no pone al alumno en pausa. Quién
 * manda entre varias suscripciones lo decide resolveWooSubscriptions
 * (lib/subscriptionAccess).
 */
export function isPausedSubscription(sub: { line_items?: unknown } | null | undefined): boolean {
  return hasPauseItem(sub?.line_items);
}
