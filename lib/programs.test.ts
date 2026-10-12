import { describe, it, expect } from 'vitest';
import {
  programOfProductId, wooDateToMadrid, firstWooDate, computedEndDate, daysBetween, formatDateEs,
  programAccessOf, currentProgram, renewalSkipReason, paymentsLabel, buildRenewalText,
  currentProgramKeys, hasProgramKey, isProgramCurrent,
  type StudentProgramRow,
} from '@/lib/programs';
import { isActiveWooStatus, wooStatusMeta } from '@/lib/subscriptionAccess';
import { isRenewalOrder } from '@/lib/programSync';

const TODAY = '2026-10-12';

function row(over: Partial<StudentProgramRow> = {}): StudentProgramRow {
  return {
    id: 'x', order_id: 1000, customer_id: 5, email: 'ana@x.com', billing_name: 'Ana Pérez', billing_phone: '+34600',
    student_id: 's1', link_source: 'email', product_id: 35652, program: 'desbloqueo', payment_mode: 'unico', months: 6,
    start_date: '2026-05-01', end_date: '2026-11-01', end_date_source: 'calculada',
    order_status: 'completed', subscription_id: null, subscription_status: null,
    renewal_notified_at: null, renewal_notified_for: null,
    ...over,
  };
}

describe('catálogo', () => {
  it('reconoce los 7 productos', () => {
    expect(programOfProductId(35652)).toEqual({ program: 'desbloqueo', months: 6, paymentMode: 'unico' });
    expect(programOfProductId(35635)?.paymentMode).toBe('fraccionado');
    expect(programOfProductId(35658)).toEqual({ program: 'platino', months: 9, paymentMode: 'unico' });
    expect(programOfProductId(999, 35656)?.program).toBe('acelerado');
    expect(programOfProductId(35634)).toBeNull(); // la Pausa no es programa
  });
});

describe('fechas', () => {
  it('pasa las _gmt a hora de Madrid', () => {
    // 23:30 UTC del 31/03 = 01:30 del 01/04 en Madrid (verano).
    expect(wooDateToMadrid('2026-03-31T23:30:00', true)).toBe('2026-04-01');
    expect(wooDateToMadrid('2026-10-12T08:00:00', false)).toBe('2026-10-12');
    expect(wooDateToMadrid('0000-00-00 00:00:00', true)).toBeNull();
    expect(wooDateToMadrid(null, true)).toBeNull();
  });
  it('prefiere el campo _gmt y cae al local', () => {
    expect(firstWooDate({ end_date_gmt: '2027-04-14T09:00:00' }, 'end_date')).toBe('2027-04-14');
    expect(firstWooDate({ end_date: '2027-04-14 09:00:00' }, 'end_date')).toBe('2027-04-14');
    expect(firstWooDate({ end_date_gmt: '', end_date: '' }, 'end_date')).toBeNull();
  });
  it('fin de pago único = inicio + meses de calendario', () => {
    expect(computedEndDate('2026-10-12', 6)).toBe('2027-04-12');
    expect(computedEndDate('2026-08-31', 6)).toBe('2027-02-28');
    expect(computedEndDate('2026-10-12', 9)).toBe('2027-07-12');
  });
  it('días y formato', () => {
    expect(daysBetween('2026-10-12', '2026-11-09')).toBe(28);
    expect(daysBetween('2026-10-20', '2026-10-30')).toBe(10); // cruza el cambio de hora
    expect(formatDateEs('2027-04-14')).toBe('14/04/2027');
  });
});

describe('acceso', () => {
  it('pago único: vigente hasta el último día incluido', () => {
    expect(programAccessOf(row({ end_date: TODAY }), TODAY)).toMatchObject({ active: true, status: 'program_active' });
    expect(programAccessOf(row({ end_date: '2026-10-11' }), TODAY)).toMatchObject({ active: false, status: 'program_ended' });
  });
  it('pedido cancelado o reembolsado: sin acceso', () => {
    expect(programAccessOf(row({ order_status: 'refunded' }), TODAY)).toMatchObject({ active: false, status: 'program_cancelled' });
    expect(programAccessOf(row({ order_status: 'cancelled' }), TODAY).active).toBe(false);
  });
  it('fraccionado: manda la suscripción (prueba = active; on-hold sin acceso)', () => {
    const f = row({ payment_mode: 'fraccionado', subscription_id: 77, subscription_status: 'active', end_date: '2027-04-12' });
    expect(programAccessOf(f, TODAY)).toMatchObject({ active: true, status: 'active' });
    expect(programAccessOf(f, TODAY, 'on-hold')).toMatchObject({ active: false, status: 'on-hold' });
    expect(programAccessOf(f, TODAY, 'expired')).toMatchObject({ active: false, status: 'expired' });
    expect(programAccessOf({ ...f, end_date: '2026-10-01' }, TODAY, 'active')).toMatchObject({ active: false, status: 'program_ended' });
  });
  it('los estados de programa los entiende el mapa único de acceso', () => {
    expect(isActiveWooStatus('program_active')).toBe(true);
    expect(isActiveWooStatus('program_ended')).toBe(false);
    expect(wooStatusMeta('program_cancelled').label).toMatch(/cancelado/);
  });
  it('elige el programa que da acceso, si no el pagado más reciente', () => {
    const viejo = row({ order_id: 1, start_date: '2025-01-01', end_date: '2025-07-01' });
    const vigente = row({ order_id: 2, start_date: '2026-06-01', end_date: '2026-12-01' });
    const reembolsado = row({ order_id: 3, start_date: '2026-09-01', end_date: '2027-03-01', order_status: 'refunded' });
    expect(currentProgram([viejo, vigente, reembolsado], TODAY)?.order_id).toBe(2);
    expect(currentProgram([viejo, reembolsado], TODAY)?.order_id).toBe(1);
    expect(currentProgram([], TODAY)).toBeNull();
  });
});

describe('aviso de renovación', () => {
  const enVentana = row({ end_date: '2026-11-09' }); // faltan 28
  it('avisa a 28 días o menos', () => {
    expect(renewalSkipReason(enVentana, [], TODAY)).toBeNull();
    expect(renewalSkipReason(row({ end_date: '2026-11-10' }), [], TODAY)).toBe('fuera_de_ventana');
    expect(renewalSkipReason(row({ end_date: '2026-10-11' }), [], TODAY)).toBe('ya_terminado');
  });
  it('no repite por la misma fecha de fin, sí si cambia', () => {
    const avisado = { ...enVentana, renewal_notified_at: '2026-10-10T08:00:00Z', renewal_notified_for: '2026-11-09' };
    expect(renewalSkipReason(avisado, [], TODAY)).toBe('ya_avisado');
    expect(renewalSkipReason({ ...avisado, end_date: '2026-11-08' }, [], TODAY)).toBeNull();
  });
  it('no avisa pedidos cancelados/reembolsados ni suscripciones canceladas', () => {
    expect(renewalSkipReason({ ...enVentana, order_status: 'refunded' }, [], TODAY)).toBe('pedido_no_pagado');
    expect(renewalSkipReason({ ...enVentana, payment_mode: 'fraccionado', subscription_status: 'cancelled' }, [], TODAY)).toBe('suscripcion_cancelada');
  });
  it('sí avisa una suscripción en espera, con "Cuota pendiente"', () => {
    const espera = { ...enVentana, payment_mode: 'fraccionado' as const, subscription_status: 'on-hold' };
    expect(renewalSkipReason(espera, [], TODAY)).toBeNull();
    expect(paymentsLabel(espera)).toBe('Cuota pendiente');
    expect(paymentsLabel(enVentana)).toBe('Al día');
  });
  it('no avisa si ya compró otro programa que termina después', () => {
    const nuevo = row({ order_id: 2000, start_date: '2026-10-05', end_date: '2027-04-05' });
    expect(renewalSkipReason(enVentana, [nuevo], TODAY)).toBe('ya_renovado');
    expect(renewalSkipReason(enVentana, [{ ...nuevo, order_status: 'refunded' }], TODAY)).toBeNull();
  });
  it('el texto sale con el formato pedido y la advertencia si no está enlazado', () => {
    const t = buildRenewalText({
      studentName: 'Ana Pérez', programLabel: 'Programa Fluidez (fraccionado)', teacherName: null,
      endDate: '2026-11-09', daysLeft: 28, phone: '+34600', email: 'ana@x.com', payments: 'Cuota pendiente', linked: false,
    });
    expect(t).toBe([
      '🔔 Renovación en 4 semanas',
      'Alumno: Ana Pérez',
      'Programa: Programa Fluidez (fraccionado)',
      'Profe: sin asignar',
      'Fecha de fin: 09/11/2026 (faltan 28 días)',
      'Teléfono: +34600',
      'Email: ana@x.com',
      'Pagos: Cuota pendiente',
      '⚠️ No está enlazado con ningún alumno de Gestión',
    ].join('\n'));
  });
});

describe('exclusión de "Próximos a cancelar"', () => {
  it('solo programas vigentes, por id y por email', () => {
    const keys = currentProgramKeys([
      row({ student_id: 's1', email: 'ana@x.com' }),
      row({ student_id: 's2', email: 'old@x.com', end_date: '2026-01-01' }),
      row({ student_id: null, email: 'Padre@X.com' }),
    ], TODAY);
    expect(hasProgramKey(keys, { id: 's1' })).toBe(true);
    expect(hasProgramKey(keys, { id: 's2', email: 'old@x.com' })).toBe(false);
    expect(hasProgramKey(keys, { id: 'zz', email: 'padre@x.com' })).toBe(true);
    expect(isProgramCurrent(row({ payment_mode: 'fraccionado', subscription_status: 'on-hold' }), TODAY)).toBe(true);
  });
});

describe('renovaciones de Woo', () => {
  it('descarta renovaciones y cambios, no los pedidos de origen', () => {
    expect(isRenewalOrder({ created_via: 'subscription' })).toBe(true);
    expect(isRenewalOrder({ created_via: 'checkout', meta_data: [{ key: '_subscription_renewal', value: '9' }] })).toBe(true);
    expect(isRenewalOrder({ created_via: 'checkout', meta_data: [] })).toBe(false);
  });
});
