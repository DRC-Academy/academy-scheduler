// La cuenta atrás del diploma.
//
// Lo que fijan estos tests y no puede cambiar sin querer:
//   · la fecha del diploma son seis meses DE CALENDARIO desde el inicio, con el
//     día acotado al último del mes (31 de agosto → 28 de febrero);
//   · los días se cuentan entre etiquetas de día, sin horas de por medio;
//   · los umbrales de las fases (30 y 7 días) y el titular de cada una, con la
//     concordancia del verbo.

import { describe, expect, it } from 'vitest';
import {
  comoDia, sumarMeses, diasEntre, fechaDelDiploma, mesesYDias, faseDe,
  calcularPlazo, titularPlazo, MESES_DE_CURSO,
} from './diplomaPlazo';

describe('comoDia — solo fechas de verdad', () => {
  it('acepta YYYY-MM-DD', () => expect(comoDia('2026-08-10')).toBe('2026-08-10'));
  it('recorta un ISO completo', () => expect(comoDia('2026-08-10T00:00:00+00:00')).toBe('2026-08-10'));
  it('ignora espacios', () => expect(comoDia('  2026-08-10 ')).toBe('2026-08-10'));
  it('rechaza null, vacío y basura', () => {
    expect(comoDia(null)).toBeNull();
    expect(comoDia(undefined)).toBeNull();
    expect(comoDia('')).toBeNull();
    expect(comoDia('10/08/2026')).toBeNull();
    expect(comoDia('pronto')).toBeNull();
  });
  it('rechaza días que no existen', () => {
    expect(comoDia('2026-02-30')).toBeNull();
    expect(comoDia('2026-13-01')).toBeNull();
  });
});

describe('sumarMeses — meses de calendario, día acotado', () => {
  it('conserva el día del mes', () => expect(sumarMeses('2026-08-10', 6)).toBe('2027-02-10'));
  it('cruza el año', () => expect(sumarMeses('2026-09-16', 6)).toBe('2027-03-16'));
  it('31 de agosto + 6 = 28 de febrero, no 3 de marzo', () => expect(sumarMeses('2026-08-31', 6)).toBe('2027-02-28'));
  it('respeta el bisiesto', () => expect(sumarMeses('2027-08-31', 6)).toBe('2028-02-29'));
  it('30 de abril + 6 = 30 de octubre', () => expect(sumarMeses('2026-04-30', 6)).toBe('2026-10-30'));
  it('1 mes desde el 31 de enero es el 28 de febrero', () => expect(sumarMeses('2026-01-31', 1)).toBe('2026-02-28'));
});

describe('diasEntre — días naturales', () => {
  it('mismo día', () => expect(diasEntre('2026-09-17', '2026-09-17')).toBe(0));
  it('hacia delante', () => expect(diasEntre('2026-09-17', '2026-09-20')).toBe(3));
  it('hacia atrás es negativo', () => expect(diasEntre('2026-09-17', '2026-09-10')).toBe(-7));
  it('a través del cambio de hora de octubre no pierde un día', () => expect(diasEntre('2026-10-24', '2026-10-26')).toBe(2));
  it('a través del cambio de hora de marzo tampoco', () => expect(diasEntre('2027-03-27', '2027-03-29')).toBe(2));
});

describe('fechaDelDiploma', () => {
  it(`es el inicio más ${MESES_DE_CURSO} meses`, () => expect(fechaDelDiploma('2026-08-10')).toBe('2027-02-10'));
  it('sin inicio no hay fecha', () => {
    expect(fechaDelDiploma(null)).toBeNull();
    expect(fechaDelDiploma('no es una fecha')).toBeNull();
  });
});

describe('mesesYDias — meses enteros de calendario y el resto en días', () => {
  it('17 de septiembre → 29 de enero: 4 meses y 12 días', () =>
    expect(mesesYDias('2026-09-17', '2027-01-29')).toEqual({ meses: 4, diasSueltos: 12 }));
  it('meses justos, cero días sueltos', () =>
    expect(mesesYDias('2026-09-17', '2027-03-17')).toEqual({ meses: 6, diasSueltos: 0 }));
  it('menos de un mes: cero meses y los días', () =>
    expect(mesesYDias('2026-09-17', '2026-10-10')).toEqual({ meses: 0, diasSueltos: 23 }));
  it('desde fin de mes: el 31 de enero al 31 de marzo son 2 meses', () =>
    expect(mesesYDias('2026-01-31', '2026-03-31')).toEqual({ meses: 2, diasSueltos: 0 }));
  it('desde fin de mes con resto: el 31 de enero al 2 de marzo es 1 mes y 2 días', () =>
    expect(mesesYDias('2026-01-31', '2026-03-02')).toEqual({ meses: 1, diasSueltos: 2 }));
  it('ya pasado: ceros', () => expect(mesesYDias('2026-09-17', '2026-09-01')).toEqual({ meses: 0, diasSueltos: 0 }));
});

describe('faseDe — los umbrales', () => {
  it('negativo es vencido', () => expect(faseDe(-1)).toBe('vencido'));
  it('cero es hoy', () => expect(faseDe(0)).toBe('hoy'));
  it('1 a 7 es la última semana', () => {
    expect(faseDe(1)).toBe('ultima-semana');
    expect(faseDe(7)).toBe('ultima-semana');
  });
  it('8 a 30 se dice en días', () => {
    expect(faseDe(8)).toBe('dias');
    expect(faseDe(30)).toBe('dias');
  });
  it('31 en adelante se dice en meses', () => expect(faseDe(31)).toBe('meses'));
});

describe('calcularPlazo — el conjunto', () => {
  it('un alumno a mitad de curso', () => {
    const p = calcularPlazo('2026-07-29', '2026-09-17');
    expect(p).toEqual({
      inicio: '2026-07-29', fechaDiploma: '2027-01-29', dias: 134, meses: 4, diasSueltos: 12, fase: 'meses',
    });
  });
  it('vencido: días negativos y sin meses', () => {
    const p = calcularPlazo('2025-07-04', '2026-09-17');
    expect(p?.fase).toBe('vencido');
    expect(p?.fechaDiploma).toBe('2026-01-04');
    expect(p?.dias).toBeLessThan(0);
    expect(p?.meses).toBe(0);
  });
  it('el día del diploma cuenta como hoy, no como vencido', () => {
    expect(calcularPlazo('2026-03-17', '2026-09-17')?.fase).toBe('hoy');
  });
  it('el día siguiente ya está vencido', () => {
    expect(calcularPlazo('2026-03-16', '2026-09-17')?.fase).toBe('vencido');
  });
  it('acepta el inicio como ISO completo (la columna fue texto)', () => {
    expect(calcularPlazo('2026-07-29T00:00:00+00:00', '2026-09-17')?.fechaDiploma).toBe('2027-01-29');
  });
  it('sin inicio válido no hay plazo', () => {
    expect(calcularPlazo(null, '2026-09-17')).toBeNull();
    expect(calcularPlazo('', '2026-09-17')).toBeNull();
    expect(calcularPlazo('2026-02-30', '2026-09-17')).toBeNull();
  });
  it('sin un hoy válido tampoco', () => expect(calcularPlazo('2026-07-29', 'hoy')).toBeNull());
});

describe('titularPlazo — la frase y la concordancia', () => {
  const t = (inicio: string, hoy: string) => titularPlazo(calcularPlazo(inicio, hoy)!);

  it('meses y días', () => expect(t('2026-07-29', '2026-09-17')).toBe('Te quedan 4 meses y 12 días'));
  it('meses justos', () => expect(t('2026-09-17', '2026-09-17')).toBe('Te quedan 6 meses'));
  // Del 17 de octubre al 17 de noviembre van 31 días: un mes de calendario justo.
  it('un mes justo, en singular', () => expect(t('2026-05-17', '2026-10-17')).toBe('Te queda 1 mes'));
  it('un mes y un día: dos cosas, en plural', () => expect(t('2026-05-18', '2026-10-17')).toBe('Te quedan 1 mes y 1 día'));
  it('un mes y varios días', () => expect(t('2026-04-29', '2026-09-17')).toBe('Te quedan 1 mes y 12 días'));
  it('varios meses y un día', () => expect(t('2026-07-18', '2026-09-17')).toBe('Te quedan 4 meses y 1 día'));
  it('31 días ya se dice en meses', () => expect(t('2026-04-18', '2026-09-17')).toBe('Te quedan 1 mes y 1 día'));
  it('30 días se dice en días', () => expect(t('2026-04-17', '2026-09-17')).toBe('Te quedan 30 días'));
  it('23 días', () => expect(t('2026-04-10', '2026-09-17')).toBe('Te quedan 23 días'));
  it('8 días, todavía sin "última semana"', () => expect(t('2026-03-25', '2026-09-17')).toBe('Te quedan 8 días'));
  it('7 días es la última semana', () => expect(t('2026-03-24', '2026-09-17')).toBe('¡Última semana! Te quedan 7 días'));
  it('3 días', () => expect(t('2026-03-20', '2026-09-17')).toBe('¡Última semana! Te quedan 3 días'));
  it('1 día, en singular', () => expect(t('2026-03-18', '2026-09-17')).toBe('¡Última semana! Te queda 1 día'));
  it('el día del diploma', () => expect(t('2026-03-17', '2026-09-17')).toBe('Tu diploma es hoy'));
  it('vencido no lleva titular', () => expect(t('2026-03-16', '2026-09-17')).toBeNull());
});
