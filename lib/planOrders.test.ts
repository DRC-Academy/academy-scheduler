// Activación de pedidos de la oferta nueva. Los casos son pedidos REALES del
// 09–28/10/2026 (números de pedido y fechas de Woo).
import { describe, it, expect } from 'vitest';
import {
  planOrderEvents, planSubscriptionEvents, buildPlanEvents, eventKey,
  type WooOrderLite, type WooSubscriptionLite, type StudentLite, type ExistingEvent,
} from './planOrders';

const HOY = '2026-10-28';
const none = () => null;
const order = (o: Partial<WooOrderLite> & { id: number; productId: number }): WooOrderLite => ({
  status: 'completed', createdVia: 'checkout', datePaid: '2026-10-09', dateCreated: '2026-10-09',
  email: 'a@x.com', billingName: 'A', ...o,
  lineItems: [{ productId: o.productId, variationId: 0, name: 'Producto' }],
});
const stu = (s: Partial<StudentLite> = {}): StudentLite => ({
  id: 's1', name: 'Alumno', email: 'a@x.com', manual_active_until: null, product_name: 'Programa', woo_product_id: null, ...s,
});

describe('pago único', () => {
  it('Camila (35723, Fluidez 6m, pagado 09/10) sin fecha → activa hasta 09/04/2027', () => {
    const [e] = planOrderEvents(order({ id: 35723, productId: 35653 }), stu(), none, HOY);
    expect(e.result).toBe('activado');
    expect(e.start).toBe('2026-10-09');
    expect(e.finalUntil).toBe('2027-04-09');
    expect(e.studentWrite).toMatchObject({ manual_active_until: '2027-04-09', product_type: 'one_time', woo_product_id: 35653 });
  });

  it('nunca recorta: María Hijón (Platino 13/10 → 13/07) conserva su 27/07/2027', () => {
    const [e] = planOrderEvents(order({ id: 35777, productId: 35658, datePaid: '2026-10-13' }), stu({ manual_active_until: '2027-07-27' }), none, HOY);
    expect(e.result).toBe('conserva_fecha');
    expect(e.finalUntil).toBe('2027-07-27');
    expect(e.studentWrite).not.toHaveProperty('manual_active_until');
    expect(e.studentWrite).toMatchObject({ woo_product_id: 35658, product_type: 'one_time' });
  });

  it('amplía una fecha más corta: Judith (Acelerado 15/10, tenía 28/02/2027) → 15/04/2027', () => {
    const [e] = planOrderEvents(order({ id: 35793, productId: 35655, datePaid: '2026-10-15' }), stu({ manual_active_until: '2027-02-28' }), none, HOY);
    expect(e.result).toBe('ampliado');
    expect(e.finalUntil).toBe('2027-04-15');
  });

  it('la fecha de inicio es la de PAGO, no la de creación (Bárbara: creado 12/10, pagado 13/10)', () => {
    const [e] = planOrderEvents(order({ id: 35771, productId: 35773, dateCreated: '2026-10-12', datePaid: '2026-10-13' }), stu(), none, HOY);
    expect(e.start).toBe('2026-10-13');
    expect(e.finalUntil).toBe('2027-01-13');
  });

  it('idempotente: un pedido ya aplicado no vuelve a escribir', () => {
    const ex = (): ExistingEvent => ({ result: 'activado', applied_at: '2026-10-28T10:00:00Z' });
    const [e] = planOrderEvents(order({ id: 35723, productId: 35653 }), stu({ manual_active_until: '2026-11-01' }), ex, HOY);
    expect(e.result).toBe('ya_procesado');
    expect(e.studentWrite).toBeNull();
  });

  it('pedido fallido o pendiente: nada', () => {
    expect(planOrderEvents(order({ id: 35748, productId: 35652, status: 'failed' }), stu(), none, HOY)).toEqual([]);
    expect(planOrderEvents(order({ id: 1, productId: 35652, status: 'pending' }), stu(), none, HOY)).toEqual([]);
  });

  it('sin alumno con ese email (David Castillo) → aviso, y se reintenta', () => {
    const [e] = planOrderEvents(order({ id: 35750, productId: 35652 }), null, none, HOY);
    expect(e.result).toBe('sin_alumno');
    expect(e.needsAdmin).toBe(true);
    expect(e.applies).toBe(false);
  });

  it('plan de 2 personas: activa al comprador y avisa de la segunda', () => {
    const [e] = planOrderEvents(order({ id: 9, productId: 35522 }), stu(), none, HOY);
    expect(e.result).toBe('activado');
    expect(e.finalUntil).toBe('2027-04-09');
    expect(e.needsAdmin).toBe(true);
    expect(e.note).toMatch(/segunda persona/);
  });

  it('upsell sin datos (Lourdes, 35937) → aviso, sin tocar al alumno', () => {
    const [e] = planOrderEvents(order({ id: 35937, productId: 35905 }), stu(), none, HOY);
    expect(e.result).toBe('sin_regla');
    expect(e.studentWrite).toBeNull();
    expect(e.note).toBe('Producto sin regla: Producto — 35905');
  });

  it('pedido de un fraccionado o mensual: nada (de eso se ocupa la suscripción)', () => {
    expect(planOrderEvents(order({ id: 35901, productId: 35654 }), stu(), none, HOY)).toEqual([]);
    expect(planOrderEvents(order({ id: 35774, productId: 35706 }), null, none, HOY)).toEqual([]);
  });

  it('producto de la oferta anterior: ni evento', () => {
    expect(planOrderEvents(order({ id: 1, productId: 8247 }), stu(), none, HOY)).toEqual([]);
  });

  it('activado y luego reembolsado → aviso, sin quitar el acceso', () => {
    const ex = (): ExistingEvent => ({ result: 'activado', applied_at: 'x' });
    const [e] = planOrderEvents(order({ id: 2, productId: 35653, status: 'refunded' }), stu(), ex, HOY);
    expect(e.result).toBe('reembolsado');
    expect(e.studentWrite).toBeNull();
  });
});

describe('suscripciones', () => {
  const sub: WooSubscriptionLite = {
    id: 35902, status: 'active', parentId: 35901, email: 'a@x.com', billingName: 'Raquel', endDate: '2027-04-20', startDate: '2026-10-20',
    lineItems: [{ productId: 35654, variationId: 0, name: 'Programa Fluidez fraccionado' }],
  };

  it('Raquel (35902, Fluidez fraccionado): solo apunta el plan, no toca el acceso', () => {
    const [e] = planSubscriptionEvents(sub, stu(), none);
    expect(e.result).toBe('vinculado');
    expect(e.computedUntil).toBe('2027-04-20');
    expect(e.studentWrite).toEqual({ woo_product_id: 35654 });
  });

  it('cancelada: nada', () => {
    expect(planSubscriptionEvents({ ...sub, status: 'cancelled' }, stu(), none)).toEqual([]);
  });

  it('programada sin alumno (Valeria, 35775) → aviso', () => {
    const [e] = planSubscriptionEvents({ ...sub, id: 35775, status: 'scheduled', lineItems: [{ productId: 35706, variationId: 0, name: 'Mensual 3 h' }] }, null, none);
    expect(e.result).toBe('sin_alumno');
  });
});

describe('buildPlanEvents', () => {
  it('autoOnly deja fuera lo anterior a AUTO_SINCE salvo que ya tenga fila', () => {
    const viejo = order({ id: 35750, productId: 35652, datePaid: '2026-10-12' });
    expect(buildPlanEvents({ orders: [viejo], subscriptions: [], studentsByEmail: new Map([['a@x.com', stu()]]), existing: new Map(), today: HOY, autoOnly: true })).toEqual([]);
    const ex = new Map([[eventKey('order', 35750, 35652), { result: 'sin_alumno' as const, applied_at: null }]]);
    const [e] = buildPlanEvents({ orders: [viejo], subscriptions: [], studentsByEmail: new Map([['a@x.com', stu()]]), existing: ex, today: HOY, autoOnly: true });
    expect(e.result).toBe('activado');
  });

  it('el pedido inicial de una suscripción sin regla no avisa dos veces (Lourdes, 36037 + 36038)', () => {
    const evs = buildPlanEvents({
      orders: [order({ id: 36037, productId: 35986 })],
      subscriptions: [{ id: 36038, status: 'active', parentId: 36037, email: 'a@x.com', billingName: 'Lourdes', endDate: '2028-01-03', startDate: '2026-10-23',
        lineItems: [{ productId: 35986, variationId: 0, name: 'Plan Maria Ahumada' }] }],
      studentsByEmail: new Map([['a@x.com', stu()]]), existing: new Map(), today: HOY,
    });
    expect(evs.map(e => [e.sourceType, e.result])).toEqual([['subscription', 'sin_regla']]);
  });

  it('dos pedidos del mismo alumno se encadenan por fecha', () => {
    const evs = buildPlanEvents({
      orders: [order({ id: 2, productId: 35658, datePaid: '2026-10-20' }), order({ id: 1, productId: 35652, datePaid: '2026-10-10' })],
      subscriptions: [], studentsByEmail: new Map([['a@x.com', stu()]]), existing: new Map(), today: HOY,
    });
    expect(evs.map(e => [e.sourceId, e.result, e.finalUntil])).toEqual([
      [1, 'activado', '2027-04-10'],
      [2, 'ampliado', '2027-07-20'],
    ]);
  });
});
