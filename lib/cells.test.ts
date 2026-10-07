import { describe, it, expect } from 'vitest';
import { esHuecoLibreParaAlumno, isAssignableCell, type ContextoHuecoAlumno } from '@/lib/cells';
import type { Grid } from '@/types';

// 2026-10-13 es martes; su lunes es 2026-10-12.
const desde = (fecha = '2026-10-13', extra: Partial<ContextoHuecoAlumno> = {}): ContextoHuecoAlumno =>
  ({ alcance: { tipo: 'desde', fecha }, reservas: [], ...extra });
const puntual = (fecha = '2026-10-13', extra: Partial<ContextoHuecoAlumno> = {}): ContextoHuecoAlumno =>
  ({ alcance: { tipo: 'puntual', fecha }, reservas: [], ...extra });

const motivo = (grid: Grid, clave: string, ctx: ContextoHuecoAlumno) => {
  const r = esHuecoLibreParaAlumno(grid, clave, ctx);
  return r.libre ? 'libre' : r.motivo;
};

describe('esHuecoLibreParaAlumno', () => {
  it('solo una casilla pintada libre dentro del rango es libre', () => {
    const grid: Grid = {
      'Martes_15:00': { state: 'libre' },
      'Martes_16:00': { state: 'no_work' },
      'Martes_17:00': { state: 'ocupado', student: 'Ana' },
    };
    expect(motivo(grid, 'Martes_15:00', desde())).toBe('libre');
    expect(motivo(grid, 'Martes_16:00', desde())).toBe('no_work');
    expect(motivo(grid, 'Martes_17:00', desde())).toBe('ocupado');
    expect(motivo(grid, 'Martes_18:00', desde())).toBe('sin_pintar');
  });

  it('respeta el rango del profesor (por defecto 9..22, ambos incluidos)', () => {
    const grid: Grid = { 'Martes_08:00': { state: 'libre' }, 'Martes_09:00': { state: 'libre' }, 'Martes_22:00': { state: 'libre' }, 'Martes_23:00': { state: 'libre' } };
    expect(motivo(grid, 'Martes_08:00', desde())).toBe('fuera_de_rango');
    expect(motivo(grid, 'Martes_09:00', desde())).toBe('libre');
    expect(motivo(grid, 'Martes_22:00', desde())).toBe('libre');
    expect(motivo(grid, 'Martes_23:00', desde())).toBe('fuera_de_rango');
    expect(motivo(grid, 'Martes_08:00', desde(undefined, { horaInicio: 8 }))).toBe('libre');
  });

  it('rechaza claves inválidas (domingo, 24:00, puntual en otro día de la semana)', () => {
    const grid: Grid = { 'Miércoles_24:00': { state: 'libre' }, 'Domingo_10:00': { state: 'libre' }, 'Lunes_10:00': { state: 'libre' } };
    expect(motivo(grid, 'Miércoles_24:00', desde(undefined, { horaFin: 23 }))).toBe('clave_invalida');
    expect(motivo(grid, 'Domingo_10:00', desde())).toBe('clave_invalida');
    expect(motivo(grid, 'Lunes_10:00', puntual('2026-10-13'))).toBe('clave_invalida');
  });

  it('marca puntual: no vale su semana ni (en "desde") las siguientes; una pasada no cuenta', () => {
    const grid: Grid = {
      'Martes_15:00': { state: 'bloqueado', student: 'Bea', weekDate: '2026-10-12', baseState: 'libre' },
      'Martes_16:00': { state: 'reprogramada', student: 'Bea', weekDate: '2026-10-19', baseState: 'libre' },
      'Martes_17:00': { state: 'bloqueado', student: 'Bea', weekDate: '2026-09-28', baseState: 'libre' },
      'Martes_18:00': { state: 'bloqueado', student: 'Bea' }, // sin weekDate: permanente
    };
    expect(motivo(grid, 'Martes_15:00', puntual('2026-10-13'))).toBe('en_recuperacion');
    expect(motivo(grid, 'Martes_15:00', puntual('2026-10-20'))).toBe('libre');
    expect(motivo(grid, 'Martes_16:00', puntual('2026-10-13'))).toBe('libre');
    expect(motivo(grid, 'Martes_16:00', desde('2026-10-13'))).toBe('reprogramada');
    expect(motivo(grid, 'Martes_17:00', desde('2026-10-13'))).toBe('libre');
    expect(motivo(grid, 'Martes_18:00', desde('2026-10-13'))).toBe('en_recuperacion');
  });

  it('una reserva viva tapa la hora (en su fecha, o en adelante en "desde")', () => {
    const grid: Grid = { 'Martes_15:00': { state: 'libre' } };
    const reservas = [{ date: '2026-10-20', hour: '15:00' }];
    expect(motivo(grid, 'Martes_15:00', puntual('2026-10-13', { reservas }))).toBe('libre');
    expect(motivo(grid, 'Martes_15:00', puntual('2026-10-20', { reservas }))).toBe('reservado');
    expect(motivo(grid, 'Martes_15:00', desde('2026-10-13', { reservas }))).toBe('reservado');
    expect(motivo(grid, 'Martes_15:00', desde('2026-10-27', { reservas }))).toBe('libre');
  });

  it('excepción de la sesión propia: solo sus casillas y solo con su nombre', () => {
    // Sesión de Ana 14-16 → 15-17 con el mismo profesor.
    const grid: Grid = {
      'Martes_14:00': { state: 'ocupado', student: 'Ana' },
      'Martes_15:00': { state: 'ocupado', student: ' ana ' },
      'Martes_16:00': { state: 'libre' },
      'Martes_17:00': { state: 'ocupado', student: 'Ana' }, // otra clase suya, no se mueve
    };
    const sesionPropia = { alumno: 'Ana', claves: ['Martes_14:00', 'Martes_15:00'] };
    expect(motivo(grid, 'Martes_15:00', desde(undefined, { sesionPropia }))).toBe('libre');
    expect(motivo(grid, 'Martes_16:00', desde(undefined, { sesionPropia }))).toBe('libre');
    expect(motivo(grid, 'Martes_17:00', desde(undefined, { sesionPropia }))).toBe('ocupado');
    expect(motivo(grid, 'Martes_15:00', desde(undefined, { sesionPropia: { alumno: 'Beto', claves: ['Martes_15:00'] } }))).toBe('ocupado');
    expect(motivo(grid, 'Martes_15:00', desde())).toBe('ocupado');
  });

  it('difiere de isAssignableCell donde debe', () => {
    const marca = { state: 'bloqueado' as const, student: 'Bea', weekDate: '2026-10-12', baseState: 'libre' as const };
    expect(isAssignableCell(marca)).toBe(true);
    expect(motivo({ 'Martes_15:00': marca }, 'Martes_15:00', desde('2026-10-13'))).toBe('en_recuperacion');
    expect(isAssignableCell({ state: 'libre' })).toBe(true);
    expect(motivo({ 'Martes_06:00': { state: 'libre' } }, 'Martes_06:00', desde())).toBe('fuera_de_rango');
  });
});
