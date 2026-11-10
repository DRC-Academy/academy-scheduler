import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  RENEWAL_PROGRAMS, RENEWAL_PRODUCT_IDS, renewalProgramOf, wooDateToMadrid, daysBetween, formatDateEs,
  oneTimeProgramDates, splitProgramDates, renewalSkipReason, renewalNoticeSent, paymentsLabel,
  buildRenewalText, RENEWAL_NOTICE_DAYS, type StudentProgramRow,
} from '@/lib/programRenewal';
import { PRODUCT_CATALOG } from '@/lib/productCatalog';
import { isRenewalOrder, programLineOf, orderPaidDate } from '@/lib/programSync';
import { renewalWebhook, siblingsOf, buildRenewalPayload, dueRenewals, type RenewalContext } from '@/lib/renewalNotice';

const TODAY = '2026-11-10';

function row(over: Partial<StudentProgramRow> = {}): StudentProgramRow {
  return {
    id: 'x', order_id: 1000, customer_id: 5, email: 'ana@x.com', billing_name: 'Ana Pérez', billing_phone: '+34600',
    student_id: 's1', link_source: 'email', product_id: 35652, program: 'desbloqueo', payment_mode: 'unico', months: 6,
    start_date: '2026-05-20', end_date: '2026-11-20', end_date_source: 'calculada',
    order_status: 'completed', subscription_id: null, subscription_status: null,
    renewal_notified_at: null, renewal_notified_for: null,
    ...over,
  };
}

describe('catálogo: usa el de la oferta nueva, sin duplicarlo', () => {
  it('los 8 programas están en lib/productCatalog con su tipo y sus meses', () => {
    expect(RENEWAL_PRODUCT_IDS).toHaveLength(8);
    for (const id of RENEWAL_PRODUCT_IDS) {
      const c = PRODUCT_CATALOG[id];
      expect(c, `falta ${id} en el catálogo`).toBeTruthy();
      expect(['pago_unico', 'fraccionado']).toContain(c.kind);
      expect(c.months).toBeGreaterThan(0);
    }
  });

  it('duración y forma de pago salen del catálogo', () => {
    expect(renewalProgramOf(35652)).toMatchObject({ program: 'desbloqueo', paymentMode: 'unico', months: 6 });
    expect(renewalProgramOf(35635)).toMatchObject({ program: 'desbloqueo', paymentMode: 'fraccionado', months: 6 });
    expect(renewalProgramOf(35658)).toMatchObject({ program: 'platino', paymentMode: 'unico', months: 9 });
    expect(renewalProgramOf(36385)).toMatchObject({ program: 'platino', paymentMode: 'fraccionado', months: 9 });
    expect(renewalProgramOf(0, 35656)).toMatchObject({ program: 'acelerado', paymentMode: 'fraccionado' });
  });

  it('lo que no es programa con renovación no entra', () => {
    expect(renewalProgramOf(35660)).toBeNull();  // Mensual 2h
    expect(renewalProgramOf(35522)).toBeNull();  // 2 personas
    expect(renewalProgramOf(35773)).toBeNull();  // Personalizado
    expect(renewalProgramOf(35905)).toBeNull();  // sin datos
    expect(renewalProgramOf(8247, 35634)).toBeNull(); // Pausa
    expect(Object.values(RENEWAL_PROGRAMS).sort()).toEqual(
      ['acelerado', 'acelerado', 'desbloqueo', 'desbloqueo', 'fluidez', 'fluidez', 'platino', 'platino'],
    );
  });
});

describe('fechas', () => {
  it('gmt → Madrid (un fin a las 23:30 UTC es el día siguiente en España)', () => {
    expect(wooDateToMadrid('2027-04-20T00:00:00', true)).toBe('2027-04-20');
    expect(wooDateToMadrid('2027-04-19T23:30:00', true)).toBe('2027-04-20');
    expect(wooDateToMadrid('2027-07-19T22:30:00', true)).toBe('2027-07-20'); // verano: UTC+2
    expect(wooDateToMadrid('2026-11-05T15:56:41', false)).toBe('2026-11-05');
    expect(wooDateToMadrid('0000-00-00 00:00:00', true)).toBeNull();
    expect(wooDateToMadrid(null, true)).toBeNull();
  });

  it('daysBetween y formato', () => {
    expect(daysBetween('2026-11-10', '2026-12-08')).toBe(28);
    expect(daysBetween('2027-03-27', '2027-03-29')).toBe(2); // cruza el cambio de hora
    expect(formatDateEs('2027-04-20')).toBe('20/04/2027');
  });

  it('fecha de pago del pedido: date_paid_gmt en Madrid', () => {
    expect(orderPaidDate({ date_paid_gmt: '2026-10-28T23:10:00' })).toBe('2026-10-29');
    expect(orderPaidDate({ date_paid: '2026-10-28T10:21:09' })).toBe('2026-10-28');
  });
});

describe('pago único: fin = inicio + duración', () => {
  it('sin datos de Gestión: pago + meses', () => {
    expect(oneTimeProgramDates('2026-10-12', 9, null)).toMatchObject({ start: '2026-10-12', end: '2027-07-12', origin: 'pago_mas_meses' });
    expect(oneTimeProgramDates('2026-08-31', 6, null).end).toBe('2027-02-28'); // fin de mes
  });

  it('inicio real del setter (posterior al pago) → inicio + meses', () => {
    // Caso real 10/11/2026: Platino pagado el 05/11, empieza el 01/12.
    const g = { woo_product_id: 35658, company_plan_start: '2026-12-01', manual_active_until: '2027-09-01' };
    expect(oneTimeProgramDates('2026-11-05', 9, g)).toMatchObject({ start: '2026-12-01', end: '2027-09-01', origin: 'inicio_gestion_mas_meses' });
  });

  it('acceso alargado en Gestión → manda la fecha más lejana', () => {
    // Caso real: Desbloqueo pagado el 12/10, acceso hasta el 02/05 (pago + 6 = 12/04).
    const g = { woo_product_id: 35652, company_plan_start: '2026-10-12', manual_active_until: '2027-05-02' };
    expect(oneTimeProgramDates('2026-10-12', 6, g)).toMatchObject({ start: '2026-10-12', end: '2027-05-02', origin: 'acceso_gestion' });
  });

  it('nunca acorta: un acceso de Gestión más corto no adelanta el aviso', () => {
    const g = { woo_product_id: 35652, company_plan_start: '2026-10-12', manual_active_until: '2027-01-01' };
    expect(oneTimeProgramDates('2026-10-12', 6, g).end).toBe('2027-04-12');
  });

  it('un inicio de Gestión ANTERIOR al pago no vale (es de otro plan)', () => {
    const g = { woo_product_id: 35652, company_plan_start: '2026-01-01', manual_active_until: null };
    expect(oneTimeProgramDates('2026-10-12', 6, g)).toMatchObject({ start: '2026-10-12', end: '2027-04-12' });
  });
});

describe('fraccionado: fin = end_date_gmt de la suscripción', () => {
  it('suscripción real 35902 (Fluidez fraccionado): fin 20/04/2027 = inicio + 6 meses', () => {
    const sub = {
      id: 35902, status: 'active', parent_id: 35901,
      start_date_gmt: '2026-10-20T00:00:00', trial_end_date_gmt: '2027-01-20T00:00:00',
      next_payment_date_gmt: '2027-01-20T01:00:00', end_date_gmt: '2027-04-20T00:00:00',
    };
    const d = splitProgramDates('2026-10-20', 6, sub);
    expect(d).toMatchObject({ start: '2026-10-20', end: '2027-04-20', source: 'woo', origin: 'woo' });
  });

  it('sin end_date en Woo: inicio + meses, marcado como calculada', () => {
    expect(splitProgramDates('2026-10-20', 6, { start_date_gmt: '2026-10-20T00:00:00', end_date_gmt: '' }))
      .toMatchObject({ end: '2027-04-20', source: 'calculada' });
    expect(splitProgramDates('2026-10-20', 9, null)).toMatchObject({ end: '2027-07-20', source: 'calculada' });
  });
});

describe('pedidos de Woo', () => {
  it('las renovaciones de suscripción no son pedidos de origen', () => {
    expect(isRenewalOrder({ created_via: 'subscription' })).toBe(true);
    expect(isRenewalOrder({ created_via: 'checkout', meta_data: [{ key: '_subscription_renewal', value: '35902' }] })).toBe(true);
    expect(isRenewalOrder({ created_via: 'checkout', meta_data: [] })).toBe(false);
  });

  it('encuentra la línea del programa aunque no sea la primera', () => {
    const o = { line_items: [{ product_id: 1234 }, { product_id: 35654, variation_id: 0 }] };
    expect(programLineOf(o)).toMatchObject({ productId: 35654, paymentMode: 'fraccionado' });
    expect(programLineOf({ line_items: [{ product_id: 35660 }] })).toBeNull();
  });
});

describe('¿toca avisar?', () => {
  it('a 28 días sí, a 29 no', () => {
    expect(RENEWAL_NOTICE_DAYS).toBe(28);
    expect(renewalSkipReason(row({ end_date: '2026-12-08' }), [], TODAY)).toBeNull();
    expect(renewalSkipReason(row({ end_date: '2026-12-09' }), [], TODAY)).toBe('fuera_de_ventana');
  });

  it('pedido cancelado, reembolsado, fallido o borrado: no', () => {
    for (const s of ['cancelled', 'refunded', 'failed', 'deleted', 'pending', null]) {
      expect(renewalSkipReason(row({ order_status: s }), [], TODAY)).toBe('pedido_no_pagado');
    }
  });

  it('fraccionado con la suscripción cancelada o vencida: no; on-hold sí', () => {
    const f = { payment_mode: 'fraccionado' as const, product_id: 35654, program: 'fluidez' as const, subscription_id: 9 };
    expect(renewalSkipReason(row({ ...f, subscription_status: 'cancelled' }), [], TODAY)).toBe('suscripcion_cancelada');
    expect(renewalSkipReason(row({ ...f, subscription_status: 'expired' }), [], TODAY)).toBe('suscripcion_cancelada');
    expect(renewalSkipReason(row({ ...f, subscription_status: 'on-hold' }), [], TODAY)).toBeNull();
  });

  it('no se repite por la misma fecha de fin; si la fecha cambia, vuelve a avisarse', () => {
    const avisado = row({ renewal_notified_at: '2026-11-01T08:00:00Z', renewal_notified_for: '2026-11-20' });
    expect(renewalNoticeSent(avisado)).toBe(true);
    expect(renewalSkipReason(avisado, [], TODAY)).toBe('ya_avisado');
    const corrida = { ...avisado, end_date: '2026-11-27' };
    expect(renewalNoticeSent(corrida)).toBe(false);
    expect(renewalSkipReason(corrida, [], TODAY)).toBeNull();
  });

  it('ya terminado o sin fecha: no', () => {
    expect(renewalSkipReason(row({ end_date: '2026-11-09' }), [], TODAY)).toBe('ya_terminado');
    expect(renewalSkipReason(row({ end_date: null }), [], TODAY)).toBe('sin_fecha_fin');
    expect(renewalSkipReason(row({ end_date: TODAY }), [], TODAY)).toBeNull(); // termina hoy: aún se avisa
  });

  it('si ya compró otro programa que termina después, ya renovó', () => {
    const viejo = row({ order_id: 1 });
    const nuevo = row({ order_id: 2, product_id: 35658, program: 'platino', months: 9, end_date: '2027-08-20' });
    expect(renewalSkipReason(viejo, siblingsOf(viejo, [viejo, nuevo]), TODAY)).toBe('ya_renovado');
    const reembolsado = { ...nuevo, order_status: 'refunded' };
    expect(renewalSkipReason(viejo, siblingsOf(viejo, [viejo, reembolsado]), TODAY)).toBeNull();
  });

  it('dueRenewals cuenta los descartes por motivo', () => {
    const r = dueRenewals([row({ order_id: 1 }), row({ order_id: 2, order_status: 'refunded', email: 'b@x.com', student_id: 's2' }),
      row({ order_id: 3, end_date: '2027-06-01', email: 'c@x.com', student_id: 's3' })], TODAY);
    expect(r.due.map(x => x.order_id)).toEqual([1]);
    expect(r.skipped).toEqual({ pedido_no_pagado: 1, fuera_de_ventana: 1 });
  });
});

describe('mensaje de Slack', () => {
  const base = {
    studentName: 'Ana Pérez', program: 'fluidez', paymentMode: 'fraccionado', teacherName: 'Mauricio',
    endDate: '2026-12-08', daysLeft: 28, phone: '+34 600 000 000', email: 'ana@x.com', payments: 'Al día', linked: true,
  };

  it('formato exacto', () => {
    expect(buildRenewalText(base)).toBe([
      '🔔 *Renovación en 28 días*',
      '*Ana Pérez* termina su *Programa Fluidez* (fraccionado) el *08/12/2026*.',
      '👩‍🏫 *Profe:* Mauricio',
      '📱 *Teléfono:* +34 600 000 000',
      '✉️ *Email:* ana@x.com',
      '💳 *Pagos:* Al día',
    ].join('\n'));
  });

  it('no enlazado: "sin asignar" + advertencia', () => {
    const t = buildRenewalText({ ...base, linked: false, teacherName: null, paymentMode: 'unico', program: 'platino' });
    expect(t).toContain('termina su *Plan Platino* (pago único)');
    expect(t).toContain('👩‍🏫 *Profe:* sin asignar');
    expect(t.split('\n').at(-1)).toBe('⚠️ No está enlazado con ningún alumno de Gestión');
  });

  it('enlazado sin profe, 1 día, hoy y datos vacíos', () => {
    expect(buildRenewalText({ ...base, teacherName: null })).toContain('*Profe:* sin asignar');
    expect(buildRenewalText({ ...base, daysLeft: 1 }).split('\n')[0]).toBe('🔔 *Renovación en 1 día*');
    expect(buildRenewalText({ ...base, daysLeft: 0 }).split('\n')[0]).toBe('🔔 *Renovación hoy*');
    const t = buildRenewalText({ ...base, phone: ' ', email: '' });
    expect(t).toContain('📱 *Teléfono:* —');
    expect(t).toContain('✉️ *Email:* —');
  });

  it('un asterisco en el nombre no rompe la negrita', () => {
    expect(buildRenewalText({ ...base, studentName: 'Ana *Pérez*' }).split('\n')[1]).toMatch(/^\*Ana Pérez\* termina/);
  });

  it('estado de pago', () => {
    expect(paymentsLabel({ payment_mode: 'unico', subscription_status: null })).toBe('Pagado (pago único)');
    expect(paymentsLabel({ payment_mode: 'fraccionado', subscription_status: 'active' })).toBe('Al día');
    expect(paymentsLabel({ payment_mode: 'fraccionado', subscription_status: 'on-hold' })).toBe('Cuota pendiente');
    expect(paymentsLabel({ payment_mode: 'fraccionado', subscription_status: null })).toBe('Sin datos de la suscripción');
  });
});

describe('payload y destino', () => {
  const ctx = (over: Partial<RenewalContext> = {}): RenewalContext => ({
    programs: [],
    students: new Map([['s1', { id: 's1', name: 'Ana Pérez', email: 'ana@x.com', phone: '+34 611', manual_active_until: '2026-11-20' }]]),
    teacherByStudent: new Map([['s1', 'Mauricio']]),
    teacherByEmail: new Map(),
    ...over,
  });

  it('enlazado: nombre, teléfono y profe de Gestión', () => {
    const p = buildRenewalPayload(row(), ctx(), TODAY);
    expect(p).toMatchObject({ alumno: 'Ana Pérez', profe: 'Mauricio', telefono: '+34 611', dias_restantes: 10, enlazado: true, fecha_fin: '20/11/2026' });
    expect(p.coincide_con_aviso_7_dias).toBe(false);
  });

  it('no enlazado: datos de facturación y sin profe aunque el email tenga asignación', () => {
    const p = buildRenewalPayload(row({ student_id: null }), ctx({ teacherByEmail: new Map([['ana@x.com', 'Otro']]) }), TODAY);
    expect(p).toMatchObject({ alumno: 'Ana Pérez', profe: 'sin asignar', telefono: '+34600', enlazado: false });
    expect(p.text).toContain('⚠️ No está enlazado');
  });

  it('marca la posible coincidencia con el aviso de 7 días', () => {
    const p = buildRenewalPayload(row({ end_date: '2026-11-15' }), ctx({
      students: new Map([['s1', { id: 's1', name: 'Ana', email: 'ana@x.com', phone: null, manual_active_until: '2026-11-15' }]]),
    }), TODAY);
    expect(p.dias_restantes).toBe(5);
    expect(p.coincide_con_aviso_7_dias).toBe(true);
  });

  describe('webhook', () => {
    afterEach(() => vi.unstubAllEnvs());
    it('solo un Incoming Webhook de Slack', () => {
      expect(renewalWebhook('https://hooks.slack.com/services/T/B/x').ok).toBe(true);
      expect(renewalWebhook('')).toMatchObject({ ok: false });
      expect(renewalWebhook('   ')).toMatchObject({ ok: false });
      expect(renewalWebhook('https://hooks.zapier.com/hooks/catch/1/abc/')).toMatchObject({ ok: false });
    });
    it('lee SLACK_RENOVACIONES_WEBHOOK_URL', () => {
      vi.stubEnv('SLACK_RENOVACIONES_WEBHOOK_URL', '');
      expect(renewalWebhook().ok).toBe(false);
      vi.stubEnv('SLACK_RENOVACIONES_WEBHOOK_URL', 'https://hooks.slack.com/services/T/B/x');
      expect(renewalWebhook().ok).toBe(true);
    });
  });
});
