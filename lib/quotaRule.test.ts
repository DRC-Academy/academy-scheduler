// Regla del cupo del 02/11/2026: consume cupo toda clase PAGABLE y solo esas, y
// el texto verde de la recuperación dice qué clase repone (ya no habla del cupo).
import { describe, expect, it } from 'vitest';
import { consumesQuota, quotaUnitsOf, quotaWouldExceed, recoveryCreditLabel } from './finance';

describe('consumesQuota / quotaUnitsOf', () => {
  it('solo la fila pagable consume, con todas sus horas', () => {
    expect(quotaUnitsOf({ status: 'pagable', billingUnits: 2 })).toBe(2);
    for (const status of ['a_revisar', 'vencida', 'excede_limite', 'excede_limite_tipo', 'no_cobrable'] as const) {
      expect(consumesQuota({ status })).toBe(false);
      expect(quotaUnitsOf({ status, billingUnits: 1 })).toBe(0);
    }
  });
});

describe('recoveryCreditLabel', () => {
  const base = { billingUnits: 1, recoveryUnits: 1, classType: 'recuperacion' as const };
  it('con fecha: "repone la clase perdida del DD/MM/AAAA"', () => {
    expect(recoveryCreditLabel({ ...base, recoveryForDates: ['2026-10-19'] }))
      .toBe('1h de recuperación — repone la clase perdida del 19/10/2026');
  });
  it('sesión mixta: igual, con las horas de recuperación', () => {
    expect(recoveryCreditLabel({ ...base, billingUnits: 2, recoveryForDates: ['2026-10-12'] }))
      .toBe('1h de recuperación — repone la clase perdida del 12/10/2026');
  });
  it('dos fechas', () => {
    expect(recoveryCreditLabel({ ...base, billingUnits: 2, recoveryUnits: 2, recoveryForDates: ['2026-09-30', '2026-10-19'] }))
      .toBe('2h de recuperación — repone las clases perdidas del 30/09/2026 y del 19/10/2026');
  });
  it('sin fecha registrada', () => {
    expect(recoveryCreditLabel({ ...base, recoveryForDates: [] }))
      .toBe('1h de recuperación — repone una clase perdida (sin fecha registrada)');
  });
  it('fila sin recuperación: null', () => {
    expect(recoveryCreditLabel({ ...base, recoveryUnits: 0, recoveryForDates: [] })).toBeNull();
  });
});

describe('quotaWouldExceed (aviso al ingresar)', () => {
  it('avisa cuando la próxima clase ya no entra en el cupo', () => {
    expect(quotaWouldExceed({ used: 9, limit: 9 })).toBe(true);
    expect(quotaWouldExceed({ used: 8, limit: 9 })).toBe(false);
    expect(quotaWouldExceed({ used: 8, limit: 9 }, 2)).toBe(true);   // sesión de 2 h
  });
  it('sin cupo (ex-alumno) o sin datos, nunca avisa', () => {
    expect(quotaWouldExceed({ used: 40, limit: null })).toBe(false);
    expect(quotaWouldExceed(null)).toBe(false);
  });
});
