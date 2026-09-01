// Ancla de inicio del pago único: lo que decide si un alumno tiene con qué
// calcular su ventana de facturación en lib/billing.
//
// Los casos con nombre propio son alumnos reales de agosto/2026, los mismos que
// destapó la auditoría del 31/08. No son ejemplos inventados: si alguno de estos
// se rompe, hay un profesor cobrando de menos.

import { describe, it, expect } from 'vitest';
import { isOneTimeProduct, resolveOneTimeStart } from './productUtils';

describe('isOneTimeProduct', () => {
  it('reconoce los intensivos', () => {
    expect(isOneTimeProduct('Intensivo general - 3h semanales')).toBe(true);
    expect(isOneTimeProduct('intensivo PET')).toBe(true);
    expect(isOneTimeProduct('Intensivo FCE')).toBe(true);
    expect(isOneTimeProduct('Intensivo CAE')).toBe(true);
  });

  it('reconoce los productos de empresa', () => {
    expect(isOneTimeProduct('Empresas Ingles General')).toBe(true);
    expect(isOneTimeProduct('Empresas Intensivos')).toBe(true);
    expect(isOneTimeProduct('Empresas Preparacion de Examenes')).toBe(true);
  });

  // La corrección del 07/08/2026 que vivía solo en check-subscription. Este es el
  // caso que hacía divergir las dos listas: 8 alumnos salían con un tipo distinto
  // según qué endpoint los hubiera escrito último.
  it('reconoce "Curso intensivo de ingles - OFERTA", que no dice "intensivo general" ni "PET"', () => {
    expect(isOneTimeProduct('Curso intensivo de ingles - OFERTA - 5h semanales')).toBe(true);
  });

  it('deja como suscripción todo lo demás', () => {
    expect(isOneTimeProduct('Curso de inglés general - 2h semanales')).toBe(false);
    expect(isOneTimeProduct('Preparación B2 First Certificate - 2h semanales')).toBe(false);
    expect(isOneTimeProduct('Plan mensual Niños - 1h semanal')).toBe(false);
    expect(isOneTimeProduct(null)).toBe(false);
    expect(isOneTimeProduct('')).toBe(false);
  });
});

describe('resolveOneTimeStart', () => {
  it('guarda la fecha del pedido de un intensivo, sin inventar meses', () => {
    // Izaro Gaztañaga: alta 27/07, 1ª clase 03/08, 20 clases en agosto. Sin ancla
    // facturaba 0 € porque la ventana se contaba hacia atrás desde el 06/11.
    expect(resolveOneTimeStart({
      productName: 'intensivo PET',
      orderDate: '2026-08-03',
    })).toEqual({ months: null, start: '2026-08-03' });
  });

  // La duración de un intensivo NO está en Woo: vive en product_prices. Un número
  // acá le ganaría a la tabla, porque facturacionMensualDe prefiere el dato por
  // alumno sobre la constante.
  it('nunca escribe meses para un producto que no es de empresa', () => {
    expect(resolveOneTimeStart({
      productName: 'Intensivo FCE',
      orderDate: '2026-07-30',
      currentMonths: 6,
    })).toEqual({ months: null, start: '2026-07-30' });
  });

  // Mismo plan, fecha de inicio mejor: no hay motivo para tirar la duración que
  // ya se había leído de una variación anterior.
  it('conserva los meses de un producto de empresa cuya variación no parseó', () => {
    expect(resolveOneTimeStart({
      productName: 'Empresas Ingles General',
      orderDate: '2026-08-11',
      currentMonths: 6,
      currentStart: '2026-07-03',
    })).toEqual({ months: 6, start: '2026-08-11' });
  });

  it('acepta el nombre con la variación pegada', () => {
    expect(resolveOneTimeStart({
      productName: 'Empresas Ingles General — B1 · 2h semanales',
      orderDate: '2026-08-11',
      currentMonths: 3,
    })).toEqual({ months: 3, start: '2026-08-11' });
  });

  // No pisar un ancla buena con null es la mitad del valor de esta función: Woo
  // devuelve pedidos sin fecha completada más seguido de lo que parece.
  it('no toca nada si el pedido no trae fecha', () => {
    expect(resolveOneTimeStart({ productName: 'intensivo PET', orderDate: null, currentStart: '2026-08-03' })).toBeNull();
    expect(resolveOneTimeStart({ productName: 'intensivo PET', orderDate: '' })).toBeNull();
    expect(resolveOneTimeStart({ productName: 'intensivo PET', orderDate: '0000-00-00 00:00:00' })).toBeNull();
  });

  // Sin esto, cada verificación de un alumno reescribiría las mismas columnas: el
  // pedido se cachea 5 minutos pero el cálculo corre en cada petición.
  it('no escribe si el resultado es idéntico a lo guardado', () => {
    expect(resolveOneTimeStart({
      productName: 'intensivo PET',
      orderDate: '2026-08-03',
      currentMonths: null,
      currentStart: '2026-08-03',
    })).toBeNull();
  });

  it('sí escribe si cambia la fecha, aunque los meses sigan igual', () => {
    expect(resolveOneTimeStart({
      productName: 'intensivo PET',
      orderDate: '2026-08-03',
      currentStart: '2026-07-27',
    })).toEqual({ months: null, start: '2026-08-03' });
  });

  // Renovación de un intensivo por parte de un alumno que venía de un plan de
  // empresa: los meses viejos tienen que caer, o la ventana saldría de 6 meses.
  it('limpia los meses del plan de empresa anterior al pasar a un intensivo', () => {
    expect(resolveOneTimeStart({
      productName: 'Intensivo general',
      orderDate: '2026-08-24',
      currentMonths: 6,
      currentStart: '2026-02-24',
    })).toEqual({ months: null, start: '2026-08-24' });
  });

  it('recorta un timestamp completo a la fecha', () => {
    expect(resolveOneTimeStart({
      productName: 'Intensivo general',
      orderDate: '2026-08-24T14:32:11',
    })).toEqual({ months: null, start: '2026-08-24' });
  });
});
