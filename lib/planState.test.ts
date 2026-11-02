import { describe, expect, it } from 'vitest';
import { planStateOf, isClassWithoutPlan } from './planState';

const TODAY = '2026-11-02';

describe('planStateOf', () => {
  it('pago único vigente → "Activa · pago único · hasta"', () => {
    const s = planStateOf({ today: TODAY, monthYear: '2026-10',
      student: { productType: 'subscription', wooProductId: 34660, manualActiveUntil: '2027-06-18' } });
    expect(s).toMatchObject({ label: 'Activa · pago único · hasta 18/06/2027', tone: 'ok' });
  });

  it('pago único de la oferta anterior SIN activar no sale "No encontrada"', () => {
    const s = planStateOf({ today: TODAY, monthYear: '2026-10',
      student: { wooProductId: 34660, manualActiveUntil: null }, lastSeen: { status: 'not_found', date: '2026-10-20' } });
    expect(s.label).toBe('Pago único sin activar');
  });

  it('intensivo 5h (suscripción) guardado como one_time: manda el catálogo y la verificación de hoy', () => {
    const s = planStateOf({ today: TODAY, monthYear: '2026-10',
      student: { productType: 'one_time', wooProductId: 26744 }, live: { status: 'active', productType: 'subscription' } });
    expect(s).toMatchObject({ label: 'Activa', tone: 'ok', source: 'hoy' });
  });

  it('pending-cancel cuenta como activa (Ramón Blasco)', () => {
    const s = planStateOf({ today: TODAY, monthYear: '2026-10', student: { wooProductId: 26744 }, live: { status: 'pending-cancel' } });
    expect(s.label).toBe('Activa · pendiente de cancelación');
  });

  it('cancelada (Miryam Ventura): badge gris y la explicación del cupo', () => {
    const s = planStateOf({ today: TODAY, monthYear: '2026-10', student: { wooProductId: 26744 },
      live: { status: 'cancelled', subscriptionEndedAt: '2026-11-02' },
      planName: 'Curso intensivo de ingles - OFERTA - 5h semanales', planHours: 5, quotaLimit: 25 });
    expect(s).toMatchObject({ label: 'Cancelada', tone: 'gris', endedAt: '2026-11-02' });
    expect(s.detail).toBe('Suscripción cancelada el 02/11/2026 · el cupo de octubre se calcula con el plan que tenía: Curso intensivo de ingles - OFERTA - 5h semanales (5h semanales, cupo 25)');
  });

  it('sin verificación de hoy, el último ingreso con su fecha', () => {
    const s = planStateOf({ today: TODAY, monthYear: '2026-10', student: {}, lastSeen: { status: 'active', date: '2026-10-30' } });
    expect(s).toMatchObject({ label: 'Activa · visto el 30/10/2026', source: 'ingreso' });
  });
});

describe('isClassWithoutPlan', () => {
  it('clase después del fin de la suscripción (Alberto, fin 18/10)', () => {
    expect(isClassWithoutPlan('2026-10-20', { endedAt: '2026-10-18' })).toBe(true);
    expect(isClassWithoutPlan('2026-10-18', { endedAt: '2026-10-18' })).toBe(false);
    expect(isClassWithoutPlan('2026-10-10', { endedAt: '2026-10-18' })).toBe(false);
  });
  it('una activación manual que cubre el día le da plan', () => {
    expect(isClassWithoutPlan('2026-10-20', { endedAt: '2026-10-18' }, '2026-10-31')).toBe(false);
  });
  it('sin fecha de fin, nunca', () => {
    expect(isClassWithoutPlan('2026-10-20', { endedAt: null })).toBe(false);
  });
});
