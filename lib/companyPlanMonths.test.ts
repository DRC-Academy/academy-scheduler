import { describe, it, expect } from 'vitest';
import { parseMonthsFromText, detectCompanyPlan } from './productUtils';

// Planes de empresa por fases (11/11/2026): la duración es la suma de las fases.
describe('parseMonthsFromText', () => {
  it('suma las fases de un plan "2 Meses x 5h + 4 Meses x 3h"', () => {
    expect(parseMonthsFromText('2 Meses x 5h + 4 Meses x 3h')).toBe(6);
    expect(parseMonthsFromText('B1 · 2 meses 5h/sem + 4 meses 3h/sem')).toBe(6);
  });

  it('sigue leyendo bien las variaciones de una sola duración', () => {
    expect(parseMonthsFromText('B1 · 1h semanal · 6 Meses')).toBe(6);
    expect(parseMonthsFromText('3 Meses')).toBe(3);
    expect(parseMonthsFromText('1 mes')).toBe(1);
    expect(parseMonthsFromText('1 Año')).toBe(12);
    expect(parseMonthsFromText('Plan mensual Niños - 1h semanal')).toBeNull();
    expect(parseMonthsFromText('2h semanales')).toBeNull();
  });

  it('un "+" sin varias duraciones no cambia nada', () => {
    expect(parseMonthsFromText('6 Meses + material')).toBe(6);
  });

  it('el fin de un plan por fases cae seis meses después', () => {
    const plan = detectCompanyPlan({
      productName: 'Empresas Ingles General',
      productVariation: '2 Meses x 5h + 4 Meses x 3h',
      orderDate: '2026-09-13',
    } as Parameters<typeof detectCompanyPlan>[0]);
    if (plan) expect(plan.months).toBe(6);
  });
});
