import { describe, it, expect } from 'vitest';
import type { Grid } from '@/types';
import { diffGrids, applyChanges, cellsEqual, studentEvents, normLoose } from './gridPatch';

describe('diffGrids', () => {
  it('solo devuelve las casillas que cambiaron, con lo que la pantalla vio', () => {
    const prev: Grid = { 'Lunes_10:00': { state: 'libre' }, 'Lunes_11:00': { state: 'ocupado', student: 'Ana' } };
    const next: Grid = { 'Lunes_10:00': { state: 'ocupado', student: 'Bea' }, 'Lunes_11:00': { state: 'ocupado', student: 'Ana' } };
    expect(diffGrids(prev, next)).toEqual({
      'Lunes_10:00': { expected: { state: 'libre' }, next: { state: 'ocupado', student: 'Bea' } },
    });
  });

  it('ignora campos undefined y el orden de las claves', () => {
    expect(cellsEqual({ state: 'libre', student: undefined }, { state: 'libre' })).toBe(true);
    expect(diffGrids({ a_1: { student: 'X', state: 'ocupado' } }, { a_1: { state: 'ocupado', student: 'X' } })).toEqual({});
  });

  it('una casilla que desaparece va con next null', () => {
    expect(diffGrids({ 'Lunes_22:00': { state: 'libre' } }, {})).toEqual({
      'Lunes_22:00': { expected: { state: 'libre' }, next: null },
    });
  });
});

describe('applyChanges: dos pestañas del mismo calendario', () => {
  // Base: lo que ambas pestañas cargaron.
  const base: Grid = {
    'Martes_18:00': { state: 'libre' },
    'Martes_19:00': { state: 'ocupado', student: 'Zulena Rosero' },
  };

  it('la pestaña vieja NO borra al alumno que la otra agregó', () => {
    // Pestaña A (setter) agrega a Bea a las 18.
    const a = applyChanges(base, diffGrids(base, { ...base, 'Martes_18:00': { state: 'ocupado', student: 'Bea' } }));
    // Pestaña B (profesor, copia vieja) marca "no trabajo" el miércoles.
    const b = applyChanges(a.grid, diffGrids(base, { ...base, 'Miércoles_10:00': { state: 'no_work' } }));
    expect(b.conflicts).toEqual([]);
    expect(b.grid['Martes_18:00']).toEqual({ state: 'ocupado', student: 'Bea' });
    expect(b.grid['Miércoles_10:00']).toEqual({ state: 'no_work' });
  });

  it('la pestaña vieja NO revive a un alumno que la otra quitó', () => {
    const quitado = applyChanges(base, diffGrids(base, { ...base, 'Martes_19:00': { state: 'libre' } }));
    const vieja = applyChanges(quitado.grid, diffGrids(base, { ...base, 'Martes_18:00': { state: 'no_work' } }));
    expect(vieja.grid['Martes_19:00']).toEqual({ state: 'libre' });
  });

  it('si las dos tocan la MISMA casilla, la segunda no pisa: conflicto', () => {
    const a = applyChanges(base, diffGrids(base, { ...base, 'Martes_18:00': { state: 'ocupado', student: 'Bea' } }));
    const b = applyChanges(a.grid, diffGrids(base, { ...base, 'Martes_18:00': { state: 'no_work' } }));
    expect(b.conflicts).toEqual(['Martes_18:00']);
    expect(b.applied).toEqual([]);
    expect(b.grid['Martes_18:00']).toEqual({ state: 'ocupado', student: 'Bea' });
  });
});

describe('studentEvents', () => {
  it('detecta agregado, quitado y renombrado del alumno recurrente', () => {
    const before: Grid = {
      'Lunes_10:00': { state: 'ocupado', student: 'Ana' },
      'Lunes_11:00': { state: 'libre' },
      'Lunes_12:00': { state: 'ocupado', student: 'Maria do Mar' },
    };
    const after: Grid = {
      'Lunes_10:00': { state: 'libre' },
      'Lunes_11:00': { state: 'ocupado', student: 'Bea' },
      'Lunes_12:00': { state: 'ocupado', student: 'María do Mar' },
    };
    expect(studentEvents(before, after, Object.keys(after))).toEqual([
      { key: 'Lunes_10:00', day: 'Lunes', hour: '10:00', action: 'quitado', studentName: 'Ana' },
      { key: 'Lunes_11:00', day: 'Lunes', hour: '11:00', action: 'agregado', studentName: 'Bea' },
      { key: 'Lunes_12:00', day: 'Lunes', hour: '12:00', action: 'renombrado', studentName: 'María do Mar', previousName: 'Maria do Mar' },
    ]);
  });

  it('una recuperación puntual encima NO es alta ni baja del alumno fijo', () => {
    const before: Grid = { 'Martes_20:00': { state: 'ocupado', student: 'Lourdes' } };
    const after: Grid = {
      'Martes_20:00': { state: 'bloqueado', student: 'Otro', weekDate: '2026-09-14', baseState: 'ocupado', baseStudent: 'Lourdes' },
    };
    expect(studentEvents(before, after, ['Martes_20:00'])).toEqual([]);
  });
});

describe('normLoose', () => {
  it('iguala tildes, mayúsculas y espacios', () => {
    expect(normLoose('  María   do Mar ')).toBe(normLoose('maria do mar'));
  });
});
