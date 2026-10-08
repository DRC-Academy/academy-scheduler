import { describe, expect, it } from 'vitest';
import {
  PAUSE_VARIATION_IDS, isPauseLineItem, hasPauseItem, isPausedSubscription,
} from '@/lib/subscriptions/pause';
import { PAUSE_VARIATION_IDS as REEXPORTADO } from '@/lib/subscriptionAccess';

describe('IDs de la Pausa', () => {
  it('son los 7 de Woo y subscriptionAccess reexporta la misma lista', () => {
    expect([...PAUSE_VARIATION_IDS].sort()).toEqual([35634, 35639, 35640, 35642, 35643, 35644, 35646]);
    expect(REEXPORTADO).toBe(PAUSE_VARIATION_IDS);
  });

  it.each([35634, 35639, 35640, 35642, 35643, 35644, 35646])('detecta %i como variación y como producto', id => {
    expect(isPauseLineItem({ product_id: 100, variation_id: id, meta_data: [] })).toBe(true);
    expect(isPauseLineItem({ product_id: id, variation_id: 0, meta_data: [] })).toBe(true);
    // Woo a veces manda los IDs como texto.
    expect(isPauseLineItem({ product_id: '100', variation_id: String(id) })).toBe(true);
  });

  it('una variación normal no es Pausa', () => {
    expect(isPauseLineItem({ product_id: 100, variation_id: 35641, meta_data: [] })).toBe(false);
    expect(isPauseLineItem(null)).toBe(false);
  });

  it('sin ID conocido, el atributo "Pausa" sigue valiendo de respaldo', () => {
    expect(isPauseLineItem({ product_id: 1, variation_id: 2, meta_data: [{ key: 'pa_plan', value: 'pausa', display_value: 'Pausa' }] })).toBe(true);
  });
});

describe('isPausedSubscription', () => {
  it('mira la línea, no el estado', () => {
    expect(isPausedSubscription({ line_items: [{ variation_id: 35640 }] })).toBe(true);
    expect(isPausedSubscription({ status: 'cancelled', line_items: [{ variation_id: 35640 }] } as { line_items: unknown })).toBe(true);
    expect(isPausedSubscription({ line_items: [{ variation_id: 1 }] })).toBe(false);
    expect(isPausedSubscription(undefined)).toBe(false);
    expect(hasPauseItem([{ variation_id: 1 }, { variation_id: 35646 }])).toBe(true);
  });
});
