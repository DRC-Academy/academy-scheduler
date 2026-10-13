// La antelación del aviso del alumno (lib/avisoAlumno).
//
// Lo que fijan estos tests y no puede cambiar sin querer:
//   · el umbral son 24 h: por debajo es tarde, exactamente 24 h es a tiempo;
//   · la hora de la clase es hora de pared ESPAÑOLA, y la cuenta se hace con
//     instantes reales: la víspera del cambio de hora (25/10/2026) tiene 25 h;
//   · el aviso del formulario no puede ser futuro.

import { describe, expect, it } from 'vitest';
import {
  antelacionDelAviso, tipoPorAntelacion, textoAntelacion, fraseAntelacion,
  avisoAhoraEnEspana, instanteDelAviso, problemaDelAviso, canceladoPorDelTipo,
} from './avisoAlumno';

// Martes 20/10/2026 a las 17:00 en España = 15:00 UTC (horario de verano, UTC+2).
const FECHA = '2026-10-20';
const HORA = '17:00';

describe('antelacionDelAviso — el umbral de 24 h', () => {
  it('23 h 59 min antes: tarde', () => {
    expect(antelacionDelAviso(FECHA, HORA, '2026-10-19T15:01:00Z')).toEqual({ minutos: 1439, tarde: true });
  });
  it('24 h 01 min antes: a tiempo', () => {
    expect(antelacionDelAviso(FECHA, HORA, '2026-10-19T14:59:00Z')).toEqual({ minutos: 1441, tarde: false });
  });
  it('exactamente 24 h antes: a tiempo', () => {
    expect(antelacionDelAviso(FECHA, HORA, '2026-10-19T15:00:00Z')).toEqual({ minutos: 1440, tarde: false });
  });
  it('23 h 59 min 30 s: tarde aunque se muestre como 23 h 59 min', () => {
    expect(antelacionDelAviso(FECHA, HORA, '2026-10-19T15:00:30Z')).toEqual({ minutos: 1439, tarde: true });
  });
  it('con la clase ya empezada: minutos negativos y tarde', () => {
    expect(antelacionDelAviso(FECHA, HORA, '2026-10-20T15:30:00Z')).toEqual({ minutos: -30, tarde: true });
  });
  it('acepta la hora del calendario sin minutos ("17")', () => {
    expect(antelacionDelAviso(FECHA, '17', '2026-10-19T15:00:00Z')?.minutos).toBe(1440);
  });
  it('null con datos que no se entienden', () => {
    expect(antelacionDelAviso('', HORA, Date.now())).toBeNull();
    expect(antelacionDelAviso(FECHA, 'pronto', Date.now())).toBeNull();
    expect(antelacionDelAviso(FECHA, HORA, 'ayer')).toBeNull();
  });
});

describe('antelacionDelAviso — cambio de hora del 25/10/2026', () => {
  // Domingo 25/10/2026 a las 10:00 en España = 09:00 UTC (ya en horario de
  // invierno, UTC+1). A las 03:00 del 25 el reloj vuelve a las 02:00.
  const CLASE = '2026-10-25';

  it('aviso el sábado a las 10:30 de España: 24 h 30 min reales, a tiempo', () => {
    // Por reloj de pared serían 23 h 30 min (tarde): el día del cambio tiene 25 h.
    const aviso = instanteDelAviso({ fecha: '2026-10-24', hora: '10:30' });
    expect(new Date(aviso).toISOString()).toBe('2026-10-24T08:30:00.000Z');
    expect(antelacionDelAviso(CLASE, '10:00', aviso)).toEqual({ minutos: 1470, tarde: false });
  });
  it('aviso el sábado a las 11:30 de España: 23 h 30 min reales, tarde', () => {
    const aviso = instanteDelAviso({ fecha: '2026-10-24', hora: '11:30' });
    expect(antelacionDelAviso(CLASE, '10:00', aviso)).toEqual({ minutos: 1410, tarde: true });
  });
});

describe('tipoPorAntelacion y textoAntelacion', () => {
  it('tarde → cancelación sobre la hora; a tiempo → reprogramada', () => {
    expect(tipoPorAntelacion({ minutos: 1439, tarde: true })).toBe('cancelacion_hora');
    expect(tipoPorAntelacion({ minutos: 1440, tarde: false })).toBe('reprogramada');
  });
  it('texto legible', () => {
    expect(textoAntelacion(1439)).toBe('23 h 59 min');
    expect(textoAntelacion(1500)).toBe('25 h');
    expect(textoAntelacion(40)).toBe('40 min');
    expect(textoAntelacion(-30)).toBe('0 min');
    expect(fraseAntelacion({ minutos: 1439, tarde: true })).toBe('Avisó con 23 h 59 min de antelación');
    expect(fraseAntelacion({ minutos: -30, tarde: true })).toBe('Avisó con la clase ya empezada');
  });
});

describe('el campo "¿Cuándo te avisó?"', () => {
  const AHORA = Date.parse('2026-10-20T10:15:00Z');   // 12:15 en España

  it('por defecto, ahora en hora de España', () => {
    expect(avisoAhoraEnEspana(AHORA)).toEqual({ fecha: '2026-10-20', hora: '12:15' });
  });
  it('ahora vale', () => {
    expect(problemaDelAviso({ fecha: '2026-10-20', hora: '12:15' }, AHORA)).toBeNull();
  });
  it('futuro no vale', () => {
    expect(problemaDelAviso({ fecha: '2026-10-20', hora: '12:30' }, AHORA)).toMatch(/futuro/);
  });
  it('incompleto no vale', () => {
    expect(problemaDelAviso({ fecha: '', hora: '12:00' }, AHORA)).toMatch(/Indica/);
    expect(problemaDelAviso({ fecha: '2026-10-20', hora: '' }, AHORA)).toMatch(/Indica/);
  });
});

describe('canceladoPorDelTipo', () => {
  it('las faltas y la cancelación sobre la hora son del alumno', () => {
    expect(canceladoPorDelTipo('falta_sin_aviso')).toBe('alumno');
    expect(canceladoPorDelTipo('falta_con_aviso')).toBe('alumno');
    expect(canceladoPorDelTipo('cancelacion_hora')).toBe('alumno');
  });
  it('las cancelaciones del profesor son del profesor', () => {
    expect(canceladoPorDelTipo('cancelada_por_profesor')).toBe('profesor');
    expect(canceladoPorDelTipo('cancelada_con_preaviso')).toBe('profesor');
  });
  it('la reprogramada y las clases dadas no se deducen', () => {
    expect(canceladoPorDelTipo('reprogramada')).toBeUndefined();
    expect(canceladoPorDelTipo('normal')).toBeUndefined();
    expect(canceladoPorDelTipo('recuperacion')).toBeUndefined();
  });
});
