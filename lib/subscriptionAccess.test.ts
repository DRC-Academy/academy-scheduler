import { describe, expect, it } from 'vitest';
import {
  isPauseVariationText, isPauseLineItem, hasPauseItem, resolveWooSubscriptions, wooStatusMeta,
  isActiveWooStatus, PAUSED_STATUS,
} from '@/lib/subscriptionAccess';

/** Línea de suscripción de Woo con el atributo de variación elegido. */
const linea = (variacion: string, extra: Array<{ key: string; value: string }> = []) => ({
  name: `Curso de inglés general - ${variacion}`,
  variation_id: 123,
  meta_data: [{ key: 'pa_horas', value: variacion.toLowerCase(), display_key: 'Horas', display_value: variacion }, ...extra],
});
const sub = (status: string, variacion: string) => ({ status, line_items: [linea(variacion)] });

describe('variación Pausa', () => {
  it('sin mayúsculas ni tildes', () => {
    expect(isPauseVariationText('Pausa')).toBe(true);
    expect(isPauseVariationText('PAUSA')).toBe(true);
    expect(isPauseVariationText('Páusa (20 €/mes)')).toBe(true);
    expect(isPauseVariationText('2h semanales')).toBe(false);
    expect(isPauseVariationText(null)).toBe(false);
  });

  it('solo mira el atributo, no el nombre del producto ni las metas internas', () => {
    expect(isPauseLineItem(linea('Pausa'))).toBe(true);
    expect(isPauseLineItem({ name: 'Curso Pausa activa', meta_data: [{ key: 'pa_horas', value: '2h', display_value: '2h semanales' }] })).toBe(false);
    expect(isPauseLineItem({ name: 'Curso', meta_data: [{ key: '_nota', value: 'pausa' }] })).toBe(false);
    expect(hasPauseItem([linea('2h semanales'), linea('Pausa')])).toBe(true);
    expect(hasPauseItem(undefined)).toBe(false);
  });

  it('por ID de Woo (#35634), sea el del producto o el de la variación', () => {
    expect(isPauseLineItem({ product_id: 35634, variation_id: 0, meta_data: [] })).toBe(true);
    expect(isPauseLineItem({ product_id: 100, variation_id: 35634, meta_data: [] })).toBe(true);
    expect(isPauseLineItem({ product_id: 100, variation_id: 200, meta_data: [] })).toBe(false);
  });
});

describe('resolveWooSubscriptions (más reciente primero)', () => {
  it('Pausa activa o pendiente de cancelar → en pausa', () => {
    expect(resolveWooSubscriptions([sub('active', 'Pausa')]).status).toBe(PAUSED_STATUS);
    expect(resolveWooSubscriptions([sub('pending-cancel', 'Pausa')]).status).toBe(PAUSED_STATUS);
  });

  it('otra suscripción normal que da acceso gana sobre la pausa', () => {
    expect(resolveWooSubscriptions([sub('active', 'Pausa'), sub('active', '2h semanales')]).status).toBe('active');
    expect(resolveWooSubscriptions([sub('active', 'Pausa'), sub('pending-cancel', '1h semanal')]).status).toBe('pending-cancel');
  });

  it('una Pausa cancelada no pone en pausa: manda su estado', () => {
    expect(resolveWooSubscriptions([sub('cancelled', 'Pausa')]).status).toBe('cancelled');
    expect(resolveWooSubscriptions([sub('on-hold', 'Pausa')]).status).toBe('on-hold');
  });

  it('vuelta a un plan normal (la suscripción ya no tiene la variación) → activo', () => {
    expect(resolveWooSubscriptions([sub('active', '2h semanales')]).status).toBe('active');
  });

  it('sin ninguna que dé acceso, la más reciente', () => {
    expect(resolveWooSubscriptions([sub('expired', '2h semanales'), sub('cancelled', '1h semanal')]).status).toBe('expired');
  });
});

describe('estado "En pausa"', () => {
  it('no da acceso a clases y tiene su badge amarillo', () => {
    expect(isActiveWooStatus(PAUSED_STATUS)).toBe(false);
    expect(wooStatusMeta(PAUSED_STATUS).label).toBe('En pausa');
    expect(wooStatusMeta(PAUSED_STATUS).bg).toBe('#FFC400');
  });
});
