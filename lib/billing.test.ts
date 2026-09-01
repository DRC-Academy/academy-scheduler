// Facturación de un alumno en un mes: reparto por días del pago único, escalera
// del ancla y validador de ventana dudosa.
//
// Casi todos los casos son ALUMNOS REALES de agosto/2026, con sus fechas tal como
// están en la base. No son ejemplos inventados: los tres primeros son los que la
// auditoría del 31/08/2026 encontró facturando 0 € mientras daban clase.

import { describe, it, expect } from 'vitest';
import { facturacionMensualDe, margenDe, resolveProductPrice, addMonths, VENTANA_DUDOSA_DIAS } from './billing';
import type { ProductPrice } from '@/types';

const precio = (
  productNameContains: string, price: number, billingMonths = 1, active = true,
): ProductPrice => ({ id: 1, productNameContains, price, billingMonths, active } as ProductPrice);

const PRICES: ProductPrice[] = [
  precio('Curso de inglés general - 2h semanales', 104),
  precio('Inglés general', 0, 1, false),
  precio('intensivo PET', 540, 3),
  precio('Intensivo general', 540, 3),
  precio('Intensivo FCE', 540, 2),
  precio('Empresas Ingles General — B1 · 2h semanales', 208, 3),
  precio('Empresas Ingles General — B1 · 3h semanales', 278, 3),
  precio('Empresas Ingles General — B2 · 1h semanal', 178, 3),
  precio('Matricula DRC Academy - Inglés General', 20, 1, false),
];

const suma2 = (n: number) => Math.round(n * 100) / 100;

describe('resolveProductPrice', () => {
  it('gana el patrón más largo', () => {
    const m = resolveProductPrice('Curso de inglés general - 2h semanales, B1', PRICES);
    expect(m.status).toBe('ok');
    expect(m.row!.price).toBe(104);
  });

  // El caso de Manuel Gómez: la matrícula gana el match por ser más larga y corta
  // ahí, en vez de caer en "Inglés general" y facturarse todos los meses.
  it('una fila inactiva gana igual el match y devuelve excluido', () => {
    const m = resolveProductPrice('Matricula DRC Academy - Inglés General — 17.30 · Miércoles', PRICES);
    expect(m.status).toBe('excluido');
  });

  it('sin match no inventa nada', () => {
    expect(resolveProductPrice('Plan mensual de inglés para niños - 1h semanal', PRICES).status).toBe('sin_match');
  });
});

describe('addMonths', () => {
  it('cruza el año', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-02', -3)).toBe('2025-11');
  });
  it('rechaza un mes inválido', () => {
    expect(addMonths('2026-13', 1)).toBeNull();
    expect(addMonths('', 1)).toBeNull();
  });
});

describe('recurrente', () => {
  it('cobra el precio tal cual todos los meses', () => {
    const r = facturacionMensualDe(
      { productName: 'Curso de inglés general - 2h semanales, B1', createdAt: '2026-01-15' },
      '2026-08', PRICES,
    );
    expect(r.eur).toBe(104);
    expect(r.kind).toBe('recurrente');
    expect(r.warning).toBeNull();
  });

  it('un producto no facturable devuelve null, nunca 0', () => {
    const r = facturacionMensualDe({ productName: 'Matricula DRC Academy - Inglés General' }, '2026-08', PRICES);
    expect(r.eur).toBeNull();
  });
});

// ── LOS TRES QUE FACTURABAN 0 € DANDO CLASE ─────────────────────────────────
//
// Anclando hacia atrás desde `manual_active_until`, el colchón de días que pone
// el admin cruzaba el fin de mes y corría la ventana entera: la de Izaro quedaba
// en 2026-09..2026-11 y agosto —sus 20 clases— caía fuera.

describe('regresión: los alumnos que facturaban 0 € en agosto/2026', () => {
  it('Izaro Gaztañaga: intensivo PET, alta 27/07, acceso hasta el 06/11', () => {
    const r = facturacionMensualDe(
      { productName: 'intensivo PET', createdAt: '2026-07-27', manualActiveUntil: '2026-11-06' },
      '2026-08', PRICES,
    );
    expect(r.eur).toBeGreaterThan(0);
    // 31 de los 92 días del intervalo 27/07..27/10. Es un céntimo menos que
    // 540·31/92 porque el redondeo va sobre el acumulado, no sobre el mes: ese
    // céntimo es el que hace que los cuatro meses sumen 540 € exactos.
    expect(r.eur).toBe(181.95);
    expect(r.anchor).toEqual({ date: '2026-07-27', source: 'alta' });
    expect(r.warning).toBeNull();   // 10 días de colchón: dentro de lo normal
  });

  it('Laia Pi: intensivo general, alta 29/07, acceso hasta el 03/11', () => {
    const r = facturacionMensualDe(
      { productName: 'Intensivo general', createdAt: '2026-07-29', manualActiveUntil: '2026-11-03' },
      '2026-08', PRICES,
    );
    expect(r.eur).toBeCloseTo(181.96, 2);
    expect(r.warning).toBeNull();
  });

  // Héctor tiene 2 meses de producto contra 3 meses y 4 días de acceso: los datos
  // se contradicen solos. Factura agosto igual, pero el validador tiene que
  // levantar la mano — ningún ancla arregla una duración mal cargada.
  it('Héctor Guerra: Intensivo FCE de 2 meses con 3 meses de acceso → factura y avisa', () => {
    const r = facturacionMensualDe(
      { productName: 'Intensivo FCE', createdAt: '2026-07-30', manualActiveUntil: '2026-11-03' },
      '2026-08', PRICES,
    );
    expect(r.eur).toBeGreaterThan(0);
    expect(r.warning).toContain('ventana dudosa');
    expect(r.warning).toContain('34 días después');
  });
});

// ── EL CASO DE JULIO QUE MOTIVÓ LA REGLA VIEJA ──────────────────────────────
//
// El alumno de empresa con acceso hasta el 29/08 que "dejaba de facturar en
// julio". Nunca fue un problema de anclar al inicio: era un off-by-one dentro del
// conteo hacia atrás. Este test fija que anclando al inicio factura los dos meses.

describe('regresión: el alumno de empresa con acceso hasta el 29/08', () => {
  const david = {
    productName: 'Empresas Ingles General — B1 · 2h semanales',
    createdAt: '2026-06-27',
    manualActiveUntil: '2026-08-29',
  };

  it('factura julio', () => {
    expect(facturacionMensualDe(david, '2026-07', PRICES).eur).toBeGreaterThan(0);
  });

  it('factura agosto, que es lo que la regla vieja perdía', () => {
    expect(facturacionMensualDe(david, '2026-08', PRICES).eur).toBeGreaterThan(0);
  });

  it('no factura mayo, antes de empezar', () => {
    expect(facturacionMensualDe(david, '2026-05', PRICES).eur).toBe(0);
  });
});

// ── REPARTO POR DÍAS ────────────────────────────────────────────────────────

describe('reparto por días', () => {
  // Carla Seco, alta el 24/08: con el reparto en escalón se le facturaba el mes
  // ENTERO (270 €) por 7 días.
  it('un alumno que empieza el 24 no factura el mes entero', () => {
    const r = facturacionMensualDe(
      { productName: 'Intensivo FCE', createdAt: '2026-08-24' },
      '2026-08', PRICES,
    );
    expect(r.eur).toBeCloseTo(70.82, 2);
    expect(r.eur).toBeLessThan(270);
  });

  it('Luz M. López, alta el 21/08: 10 días de agosto, no 31', () => {
    const r = facturacionMensualDe(
      { productName: 'Intensivo FCE', createdAt: '2026-08-21' },
      '2026-08', PRICES,
    );
    expect(r.eur).toBeCloseTo(97.38, 2);
  });

  // La propiedad que justifica redondear sobre el acumulado: los céntimos se
  // cancelan entre meses y la ventana entera suma el precio EXACTO.
  it('la suma de todos los meses da el precio exacto', () => {
    const alumno = { productName: 'intensivo PET', createdAt: '2026-07-27' };
    const meses = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
    const total = meses.reduce((acc, m) => acc + (facturacionMensualDe(alumno, m, PRICES).eur ?? 0), 0);
    expect(suma2(total)).toBe(540);
  });

  it('la suma exacta también cuando el inicio cae el día 1', () => {
    const alumno = { productName: 'Intensivo general', createdAt: '2026-07-01' };
    const meses = ['2026-07', '2026-08', '2026-09', '2026-10'];
    const total = meses.reduce((acc, m) => acc + (facturacionMensualDe(alumno, m, PRICES).eur ?? 0), 0);
    expect(suma2(total)).toBe(540);
    // Intervalo semiabierto: 01/07 + 3 meses = 01/10, que ya no toca octubre.
    expect(facturacionMensualDe(alumno, '2026-10', PRICES).eur).toBe(0);
  });

  it('fuera de la ventana devuelve 0, no null', () => {
    const r = facturacionMensualDe(
      { productName: 'intensivo PET', createdAt: '2026-01-10' },
      '2026-08', PRICES,
    );
    expect(r.eur).toBe(0);
    expect(r.kind).toBe('pago_unico');
  });
});

// ── ESCALERA DEL ANCLA ──────────────────────────────────────────────────────

describe('escalera del ancla', () => {
  // Alejandro Palomino: alta el 25/06 pero pedido el 11/08 — 47 días de desvío.
  // Es el caso que hace que el pedido tenga que ganar.
  it('la fecha del pedido le gana al alta', () => {
    const r = facturacionMensualDe(
      {
        productName: 'Empresas Ingles General — B1 · 2h semanales',
        companyPlanStart: '2026-08-11', companyPlanMonths: 3,
        createdAt: '2026-06-25', manualActiveUntil: '2026-11-11',
      },
      '2026-08', PRICES,
    );
    expect(r.anchor).toEqual({ date: '2026-08-11', source: 'pedido' });
    expect(r.eur).toBeCloseTo(47.48, 2);
    expect(r.warning).toBeNull();
  });

  it('sin pedido cae al alta', () => {
    const r = facturacionMensualDe(
      { productName: 'intensivo PET', createdAt: '2026-07-27' }, '2026-08', PRICES,
    );
    expect(r.anchor!.source).toBe('alta');
  });

  it('sin ninguna de las dos devuelve null, no una ventana inventada', () => {
    const r = facturacionMensualDe(
      { productName: 'intensivo PET', manualActiveUntil: '2026-11-06' }, '2026-08', PRICES,
    );
    expect(r.eur).toBeNull();
    expect(r.reason).toContain('sin fecha de pedido ni de alta');
  });

  // '0000-00-00' es lo que devuelve WooCommerce en un pedido sin completar.
  it('ignora la fecha cero de WooCommerce y cae al alta', () => {
    const r = facturacionMensualDe(
      { productName: 'intensivo PET', companyPlanStart: '0000-00-00', createdAt: '2026-07-27' },
      '2026-08', PRICES,
    );
    expect(r.anchor).toEqual({ date: '2026-07-27', source: 'alta' });
  });

  // LA GARANTÍA QUE SOSTIENE LA CARGA DE "Empresas Ingles General" (31/08/2026).
  //
  // Su precio es una TARIFA MENSUAL, no un total: en Woo el importe de cada
  // variante es tarifa × meses comprados, así que dividirlo otra vez por los
  // meses del alumno lo partía. Se cargó con billing_months=1, y eso solo es
  // seguro si la FILA le gana a `company_plan_months` como divisor.
  //
  // Krasimira compró 6 meses: si `companyPlanMonths` se usara igual, saldría
  // 104/6 = 17,33 €/mes en vez de los 104 € que paga.
  it('con billing_months=1 la fila manda: company_plan_months NO divide el precio', () => {
    const empresaMensual = [precio('Empresas Ingles General — B1 · 2h semanales', 104, 1)];
    const r = facturacionMensualDe(
      {
        productName: 'Empresas Ingles General — B1 · 2h semanales · 6 Meses',
        companyPlanStart: '2026-07-03', companyPlanMonths: 6, manualActiveUntil: '2027-01-03',
      },
      '2026-08', empresaMensual,
    );
    expect(r.eur).toBe(104);
    expect(r.kind).toBe('recurrente');
    expect(r.window).toBeNull();   // recurrente = sin ventana: el acceso lo acota el roster
  });

  it('company_plan_months le gana a billing_months de la tabla', () => {
    const r = facturacionMensualDe(
      {
        productName: 'Empresas Ingles General — B1 · 2h semanales',
        companyPlanStart: '2026-07-03', companyPlanMonths: 6,
        manualActiveUntil: '2027-01-03',
      },
      '2026-08', PRICES,
    );
    // 208 € repartidos sobre los 184 días de 6 meses, no sobre los 3 de la tabla.
    // Son 35,05 y no los 34,67 de 208/6: agosto tiene 31 de esos 184 días, y el
    // reparto por días no reconoce meses "iguales".
    expect(r.eur).toBe(35.05);
    expect(r.warning).toBeNull();
  });
});

// ── VALIDADOR DE VENTANA DUDOSA ─────────────────────────────────────────────

describe('validador de ventana dudosa', () => {
  it('no marca a un alumno anclado al pedido: su fin coincide con el acceso', () => {
    const r = facturacionMensualDe(
      {
        productName: 'Empresas Ingles General — B1 · 2h semanales',
        companyPlanStart: '2026-08-11', companyPlanMonths: 3, manualActiveUntil: '2026-11-11',
      },
      '2026-08', PRICES,
    );
    expect(r.warning).toBeNull();
  });

  it('no marca un colchón normal del admin (+10 días)', () => {
    const r = facturacionMensualDe(
      { productName: 'intensivo PET', createdAt: '2026-07-27', manualActiveUntil: '2026-11-06' },
      '2026-08', PRICES,
    );
    expect(r.warning).toBeNull();
  });

  // Armando Henriquez: alta el 24/07 pero su plan de empresa venía de mayo. El
  // alta es un ancla rancia y el acceso lo delata por 67 días.
  it('marca un alta rancia: el acceso terminó mucho antes que la ventana', () => {
    const r = facturacionMensualDe(
      {
        productName: 'Empresas Ingles General — B2 · 1h semanal',
        createdAt: '2026-07-24', manualActiveUntil: '2026-08-18',
      },
      '2026-08', PRICES,
    );
    expect(r.warning).toContain('ventana dudosa');
    expect(r.warning).toContain('67 días antes');
  });

  it('Mercedez Morilla: 41 días de desvío, marcada', () => {
    const r = facturacionMensualDe(
      {
        productName: 'Empresas Ingles General — B1 · 3h semanales',
        createdAt: '2026-06-28', manualActiveUntil: '2026-08-18',
      },
      '2026-08', PRICES,
    );
    expect(r.warning).toContain('ventana dudosa');
  });

  it('dice cuando además el mes factura 0 €', () => {
    const r = facturacionMensualDe(
      {
        productName: 'Empresas Ingles General — B2 · 1h semanal',
        createdAt: '2026-01-24', manualActiveUntil: '2026-08-18',
      },
      '2026-08', PRICES,
    );
    expect(r.eur).toBe(0);
    expect(r.warning).toContain('este mes factura 0 €');
  });

  it('el umbral está donde dice la constante', () => {
    expect(VENTANA_DUDOSA_DIAS).toBe(31);
    const justo = facturacionMensualDe(   // fin 2026-10-01, acceso +31 días
      { productName: 'Intensivo general', createdAt: '2026-07-01', manualActiveUntil: '2026-11-01' },
      '2026-08', PRICES,
    );
    expect(justo.warning).toBeNull();
    const pasado = facturacionMensualDe(  // +32 días
      { productName: 'Intensivo general', createdAt: '2026-07-01', manualActiveUntil: '2026-11-02' },
      '2026-08', PRICES,
    );
    expect(pasado.warning).toContain('ventana dudosa');
  });

  it('sin manual_active_until no hay nada contra qué validar', () => {
    const r = facturacionMensualDe(
      { productName: 'intensivo PET', createdAt: '2026-07-27' }, '2026-08', PRICES,
    );
    expect(r.warning).toBeNull();
  });
});

// ── MARGEN ──────────────────────────────────────────────────────────────────

describe('margenDe', () => {
  const students = [
    { name: 'Izaro', productName: 'intensivo PET', createdAt: '2026-07-27', manualActiveUntil: '2026-11-06' },
    { name: 'Héctor', productName: 'Intensivo FCE', createdAt: '2026-07-30', manualActiveUntil: '2026-11-03' },
    { name: 'Bruna', productName: 'Plan mensual de inglés para niños - 1h semanal', createdAt: '2026-05-01' },
  ];

  it('cuenta las ventanas dudosas aparte de la facturación parcial', () => {
    const m = margenDe({ students, monthYear: '2026-08', prices: PRICES, totalAPagar: 100 });
    expect(m.ventanasDudosas).toBe(1);          // Héctor
    expect(m.facturacionParcial).toBe(true);    // Bruna no tiene precio
    expect(m.alumnosConPrecio).toBe(2);
    expect(m.alumnosTotales).toBe(3);
  });

  it('un alumno con ventana dudosa SÍ suma a la facturación', () => {
    const m = margenDe({ students, monthYear: '2026-08', prices: PRICES, totalAPagar: 0 });
    expect(m.facturacion).toBeGreaterThan(400);
  });

  it('sin ningún precio el margen es null, no una pérdida inventada', () => {
    const m = margenDe({ students: [students[2]], monthYear: '2026-08', prices: PRICES, totalAPagar: 500 });
    expect(m.margen).toBeNull();
  });

  it('el detalle lleva la advertencia de cada alumno', () => {
    const m = margenDe({ students, monthYear: '2026-08', prices: PRICES, totalAPagar: 0 });
    expect(m.detalle.find(d => d.studentName === 'Héctor')!.warning).toContain('ventana dudosa');
    expect(m.detalle.find(d => d.studentName === 'Izaro')!.warning).toBeNull();
  });
});
