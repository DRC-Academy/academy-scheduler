import { describe, it, expect } from 'vitest';
import { marcasDeReprogramacion } from '@/lib/reprogramacion';
import type { Grid } from '@/types';

// Martes 13/10/2026 (semana del 12) → jueves 22/10/2026 (semana del 19).
const base = { studentName: 'Ana López', originalDate: '2026-10-13', originalHour: '15:00', newDate: '2026-10-22', newHour: '10:00' };

describe('marcasDeReprogramacion (mismo resultado que el "Reprogramar" de siempre)', () => {
  it('1 h: original tachada esa semana, destino como recuperación esa semana', () => {
    const grid: Grid = { 'Martes_15:00': { state: 'ocupado', student: 'Ana López' }, 'Jueves_10:00': { state: 'libre' } };
    const r = marcasDeReprogramacion(grid, { ...base, durationHours: 1 });
    expect(r['Martes_15:00']).toEqual({ state: 'reprogramada', student: 'Ana López', weekDate: '2026-10-12', baseState: 'ocupado', baseStudent: 'Ana López', rescheduledTo: '2026-10-22' });
    expect(r['Jueves_10:00']).toEqual({ state: 'bloqueado', student: 'Ana López', weekDate: '2026-10-19', baseState: 'libre', recoveryFor: '2026-10-13' });
    expect(grid['Martes_15:00']).toEqual({ state: 'ocupado', student: 'Ana López' }); // no muta la entrada
  });

  it('2 h: mueve las dos horas a los dos lados', () => {
    const grid: Grid = {
      'Martes_15:00': { state: 'ocupado', student: 'Ana López' }, 'Martes_16:00': { state: 'ocupado', student: 'Ana López' },
    };
    const r = marcasDeReprogramacion(grid, { ...base, durationHours: 2 });
    expect(r['Martes_16:00']?.state).toBe('reprogramada');
    expect(r['Jueves_10:00']?.state).toBe('bloqueado');
    expect(r['Jueves_11:00']).toEqual({ state: 'bloqueado', student: 'Ana López', weekDate: '2026-10-19', baseState: 'libre', recoveryFor: '2026-10-13' });
  });

  it('la segunda hora que ya no es del alumno no se tacha; el destino ocupado por otro no se pisa', () => {
    const grid: Grid = {
      'Martes_15:00': { state: 'ocupado', student: 'Ana López' },
      'Martes_16:00': { state: 'ocupado', student: 'Pepe' },
      'Jueves_11:00': { state: 'ocupado', student: 'Pepe' },
    };
    const r = marcasDeReprogramacion(grid, { ...base, durationHours: 2 });
    expect(r['Martes_16:00']).toEqual({ state: 'ocupado', student: 'Pepe' });
    expect(r['Jueves_11:00']).toEqual({ state: 'ocupado', student: 'Pepe' });
    expect(r['Jueves_10:00']?.state).toBe('bloqueado');
  });

  it('sobre una marca de otra semana, toma el fondo de la casilla', () => {
    const grid: Grid = {
      'Martes_15:00': { state: 'bloqueado', student: 'X', weekDate: '2026-10-05', baseState: 'ocupado', baseStudent: 'Ana López' },
      'Jueves_10:00': { state: 'reprogramada', student: 'Y', weekDate: '2026-10-05', baseState: 'libre' },
    };
    const r = marcasDeReprogramacion(grid, { ...base, durationHours: 1 });
    expect(r['Martes_15:00']).toMatchObject({ state: 'reprogramada', baseState: 'ocupado', baseStudent: 'Ana López' });
    expect(r['Jueves_10:00']).toMatchObject({ state: 'bloqueado', baseState: 'libre', weekDate: '2026-10-19' });
  });

  it('con una fecha no válida no marca nada', () => {
    const grid: Grid = { 'Martes_15:00': { state: 'ocupado', student: 'Ana López' } };
    expect(marcasDeReprogramacion(grid, { ...base, newDate: '', durationHours: 1 })).toBe(grid);
  });
});
