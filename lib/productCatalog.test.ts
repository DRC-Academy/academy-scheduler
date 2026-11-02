// Catálogo de la oferta nueva (oct/2026). Lo que fijan estos tests es la REGLA
// DE ORO: un producto que no está en el catálogo se comporta como antes —mismo
// tipo de producto, mismo cupo— y uno que sí está manda sobre el nombre y sobre
// las casillas del calendario.
import { describe, it, expect } from 'vitest';
import {
  catalogProduct, isUnknownNewProduct, productTypeFor, quotaWeeklyHours, planTypeLabel, fixedMonthlyQuota,
} from './productCatalog';
import { isCompanyProduct, baseProductName } from './productUtils';

const byNameSub = () => 'subscription' as const;
const byNameOne = () => 'one_time' as const;

describe('catálogo', () => {
  it('los programas llevan sus meses y horas', () => {
    expect(catalogProduct(35653)).toMatchObject({ kind: 'pago_unico', months: 6, weeklyHours: 2 });
    expect(catalogProduct(35658)).toMatchObject({ kind: 'pago_unico', months: 9, weeklyHours: 2 });
    expect(catalogProduct(35654)).toMatchObject({ kind: 'fraccionado', months: 6, weeklyHours: 2 });
    expect(catalogProduct(36385)).toMatchObject({ kind: 'fraccionado', months: 9, weeklyHours: 2 });
    expect(catalogProduct(35660)).toMatchObject({ kind: 'mensual', months: null, weeklyHours: 2 });
    expect(catalogProduct(35523)).toMatchObject({ kind: 'pago_unico', months: 9, weeklyHours: 2, persons: 2 });
    expect(catalogProduct(35773)).toMatchObject({ kind: 'pago_unico', months: 3, weeklyHours: 3 });
  });

  it('productos de la oferta anterior: fuera del catálogo y sin aviso', () => {
    expect(catalogProduct(8247)).toBeNull();          // Curso de inglés general
    expect(isUnknownNewProduct(8247)).toBe(false);
    expect(isUnknownNewProduct(29782)).toBe(false);   // Matrícula
  });

  it('producto nuevo sin regla → aviso', () => {
    expect(isUnknownNewProduct(35796)).toBe(true);    // Personalizado 2h (sin datos)
    expect(isUnknownNewProduct(35653)).toBe(false);
  });
});

describe('productTypeFor', () => {
  it('pago único del catálogo es one_time aunque el nombre no esté en la lista', () => {
    expect(productTypeFor(35658, 0, byNameSub)).toBe('one_time');
  });
  it('fraccionado y mensual son suscripción', () => {
    expect(productTypeFor(35654, 0, byNameOne)).toBe('subscription');
    expect(productTypeFor(35660, 0, byNameOne)).toBe('subscription');
  });
  it('fuera del catálogo (o sin datos) decide el nombre, como siempre', () => {
    expect(productTypeFor(8247, 8248, byNameSub)).toBe('subscription');
    expect(productTypeFor(35905, 0, byNameSub)).toBe('subscription'); // upsell sin datos
  });
});

describe('oferta anterior con regla por ID (02/11/2026)', () => {
  it('26744 (intensivo OFERTA) es suscripción aunque el nombre diga pago único', () => {
    expect(productTypeFor(26744, 26756, byNameOne)).toBe('subscription');
    expect(catalogProduct(26744)).toMatchObject({ kind: 'mensual', weeklyHours: 5 });
    expect(fixedMonthlyQuota(26744)).toBe(25);
  });
  it('pagos únicos con sus meses y horas', () => {
    for (const id of [34660, 34661, 35111]) expect(catalogProduct(id)).toMatchObject({ kind: 'pago_unico', months: 9, weeklyHours: 2 });
    for (const id of [34659, 34878]) expect(catalogProduct(id)).toMatchObject({ kind: 'pago_unico', months: 6, weeklyHours: 3 });
    for (const id of [30779, 30781, 30782, 30783]) expect(catalogProduct(id)).toMatchObject({ kind: 'pago_unico', months: 3, weeklyHours: 4 });
    expect(productTypeFor(34660, 35141, byNameSub)).toBe('one_time');
    expect(catalogProduct(30780)).toBeNull();
  });
  it('el cupo fijo solo existe para el producto del mapa', () => {
    expect(fixedMonthlyQuota(35660)).toBeNull();
    expect(fixedMonthlyQuota(null)).toBeNull();
  });
});

describe('quotaWeeklyHours', () => {
  it('con producto del catálogo, las horas del plan (Judith: Acelerado con 4 casillas → 3)', () => {
    expect(quotaWeeklyHours(4, 35655)).toBe(3);
  });
  it('sin producto (o fuera del catálogo, o sin datos), las casillas como siempre', () => {
    expect(quotaWeeklyHours(4, undefined)).toBe(4);
    expect(quotaWeeklyHours(4, null)).toBe(4);
    expect(quotaWeeklyHours(4, 8247)).toBe(4);
    expect(quotaWeeklyHours(2, 35986)).toBe(2);    // Plan Maria Ahumada: sin datos
  });
});

describe('planTypeLabel', () => {
  const isCompany = (n: string) => isCompanyProduct(baseProductName(n));
  it('oferta nueva por ID', () => {
    expect(planTypeLabel({ wooProductId: 35653, productName: 'x', isCompany })).toBe('Programa único');
    expect(planTypeLabel({ wooProductId: 35654, isCompany })).toBe('Programa fraccionado');
    expect(planTypeLabel({ wooProductId: 35660, isCompany })).toBe('Mensual');
  });
  it('empresa, antiguo y manual', () => {
    expect(planTypeLabel({ productName: 'Empresas Ingles General — B1 · 6 Meses', isCompany })).toBe('Empresa');
    expect(planTypeLabel({ productName: 'Curso de inglés general - 2h semanales', isCompany })).toBeNull();
    expect(planTypeLabel({ isOritalk: true, isCompany })).toBe('Manual');
    expect(planTypeLabel({ manualActiveUntil: '2026-12-31', isCompany })).toBe('Manual');
    expect(planTypeLabel({ isCompany })).toBeNull();
  });
});
