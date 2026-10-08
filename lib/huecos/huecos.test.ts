import { describe, it, expect } from 'vitest';
import { calcularBloques, estadoCalendarioWith, huecosLibres, HuecosError, tieneMarcaPuntualVigente, type OpcionesBloques } from '@/lib/huecos/huecos';
import { FakeDb } from '@/lib/transferencia/fakeDb.test-helper';
import type { Grid } from '@/types';

// Lunes 12/10/2026, 10:00 en España (UTC+2).
const AHORA = Date.UTC(2026, 9, 12, 8, 0);

const opts = (over: Partial<OpcionesBloques> = {}): OpcionesBloques =>
  ({ modo: 'fijo', duracionHoras: 1, horaInicio: 9, horaFin: 22, reservas: [], ahora: AHORA, ...over });

/** Bloques como 'Martes 15:00-16:00 (2026-10-13)' para comparar fácil. */
const ver = (grid: Grid, o: Partial<OpcionesBloques> = {}) =>
  calcularBloques(grid, opts(o)).map(b => `${b.dia} ${b.horaInicio}-${b.horaFin} (${b.fecha})`);

describe('calcularBloques · FIJO', () => {
  it('solo casillas pintadas libres, dentro del rango, nunca no_work ni sin pintar', () => {
    const grid: Grid = {
      'Martes_15:00': { state: 'libre' },
      'Martes_16:00': { state: 'no_work' },
      'Martes_17:00': { state: 'ocupado', student: 'Otro' },
      'Martes_23:00': { state: 'libre' },          // fuera de 9..22
      'Domingo_12:00': { state: 'libre' },         // domingo: nunca
    };
    expect(ver(grid)).toEqual(['Martes 15:00-16:00 (2026-10-13)']);
  });

  it('sesión de 2 h: dos casillas contiguas libres el mismo día', () => {
    const grid: Grid = {
      'Jueves_15:00': { state: 'libre' }, 'Jueves_16:00': { state: 'libre' }, 'Jueves_17:00': { state: 'no_work' },
      'Viernes_15:00': { state: 'libre' }, 'Viernes_17:00': { state: 'libre' },   // no contiguas
    };
    expect(ver(grid, { duracionHoras: 2 })).toEqual(['Jueves 15:00-17:00 (2026-10-15)']);
  });

  it('la próxima ocurrencia tiene que empezar a MÁS de 24 h', () => {
    const grid: Grid = {
      'Martes_09:00': { state: 'libre' },   // mañana a las 9: 23 h
      'Martes_10:00': { state: 'libre' },   // justo 24 h: no vale
      'Martes_11:00': { state: 'libre' },   // 25 h
      'Lunes_09:00': { state: 'libre' },    // hoy ya pasó → la próxima es el lunes 19
    };
    expect(ver(grid)).toEqual(['Martes 11:00-12:00 (2026-10-13)', 'Lunes 09:00-10:00 (2026-10-19)']);
  });

  it('marcas puntuales: una de semana pasada no cuenta; una de esta semana o posterior bloquea', () => {
    const grid: Grid = {
      'Martes_15:00': { state: 'bloqueado', student: 'X', weekDate: '2026-10-05', baseState: 'libre' },
      'Martes_16:00': { state: 'bloqueado', student: 'X', weekDate: '2026-10-26', baseState: 'libre' },
      'Martes_17:00': { state: 'reprogramada', student: 'Y', weekDate: '2026-10-12', baseState: 'libre' },
    };
    expect(ver(grid)).toEqual(['Martes 15:00-16:00 (2026-10-13)']);
  });

  it('una reserva viva tapa ese día y hora desde la fecha de la reserva', () => {
    const grid: Grid = { 'Jueves_15:00': { state: 'libre' }, 'Jueves_16:00': { state: 'libre' } };
    expect(ver(grid, { reservas: [{ date: '2026-10-15', hour: '15:00' }] })).toEqual(['Jueves 16:00-17:00 (2026-10-15)']);
  });

  it('excepción de sesión propia: se puede desplazar 14-16 a 15-17, pero no "mover" al mismo sitio', () => {
    const grid: Grid = {
      'Martes_14:00': { state: 'ocupado', student: 'Ana' },
      'Martes_15:00': { state: 'ocupado', student: 'Ana' },
      'Martes_16:00': { state: 'libre' },
    };
    const sesionPropia = { alumno: 'Ana', claves: ['Martes_14:00', 'Martes_15:00'] };
    expect(ver(grid, { duracionHoras: 2, sesionPropia })).toEqual(['Martes 15:00-17:00 (2026-10-13)']);
    expect(ver(grid, { duracionHoras: 2 })).toEqual([]);
    // La excepción es solo para ESE alumno.
    expect(ver(grid, { duracionHoras: 2, sesionPropia: { alumno: 'Otra', claves: sesionPropia.claves } })).toEqual([]);
  });
});

describe('calcularBloques · PUNTUAL', () => {
  const p = (o: Partial<OpcionesBloques> = {}) => ({ modo: 'puntual' as const, ...o });

  it('un bloque por fecha, desde ahora + 24 h hasta 6 semanas', () => {
    const grid: Grid = { 'Martes_10:00': { state: 'libre' }, 'Martes_11:00': { state: 'libre' } };
    const r = ver(grid, p());
    expect(r[0]).toBe('Martes 11:00-12:00 (2026-10-13)');          // el martes 13 a las 10 está a 24 h justas
    expect(r).toContain('Martes 10:00-11:00 (2026-10-20)');
    expect(r).toContain('Martes 11:00-12:00 (2026-11-17)');
    expect(r.some(x => x.includes('2026-11-24'))).toBe(false);     // más de 6 semanas
    expect(r).toHaveLength(11);                                     // 13/10: 1 + 5 martes × 2
  });

  it('marcas: la de otra semana no impide ese día por el criterio, pero una marca vigente no admite otra encima', () => {
    const grid: Grid = {
      'Martes_15:00': { state: 'bloqueado', student: 'X', weekDate: '2026-10-19', baseState: 'libre' },  // 20/10
      'Martes_16:00': { state: 'bloqueado', student: 'X', weekDate: '2026-10-05', baseState: 'libre' },  // pasada
    };
    const r = ver(grid, p({ hasta: AHORA + 15 * 86_400_000 }));
    // 15:00: ni el 20/10 (su semana) ni el 13/10 (la casilla ya tiene una marca vigente).
    expect(r.filter(x => x.includes('15:00-'))).toEqual([]);
    // 16:00: la marca es de una semana pasada → libre todos los martes.
    expect(r.filter(x => x.includes('16:00-'))).toEqual(['Martes 16:00-17:00 (2026-10-13)', 'Martes 16:00-17:00 (2026-10-20)']);
  });

  it('una reserva tapa solo su fecha', () => {
    const grid: Grid = { 'Jueves_15:00': { state: 'libre' } };
    const r = ver(grid, p({ hasta: AHORA + 15 * 86_400_000, reservas: [{ date: '2026-10-15', hour: '15:00' }] }));
    expect(r).toEqual(['Jueves 15:00-16:00 (2026-10-22)']);
  });

  it('sin excepción de solape: un bloque que pisa la clase que se mueve no se ofrece (una marca por casilla)', () => {
    const grid: Grid = {
      'Martes_14:00': { state: 'ocupado', student: 'Ana' },
      'Martes_15:00': { state: 'ocupado', student: 'Ana' },
      'Martes_16:00': { state: 'libre' }, 'Martes_17:00': { state: 'libre' },
    };
    const r = ver(grid, p({ duracionHoras: 2, hasta: AHORA + 15 * 86_400_000,
      sesionPropia: { alumno: 'Ana', claves: ['Martes_14:00', 'Martes_15:00'], fecha: '2026-10-13' } }));
    // 15-17 solaparía con 14-16: no. 16-18 sí, y en las dos fechas.
    expect(r).toEqual(['Martes 16:00-18:00 (2026-10-13)', 'Martes 16:00-18:00 (2026-10-20)']);
  });
});

describe('tieneMarcaPuntualVigente', () => {
  it('de esta semana o posterior, o sin semana', () => {
    expect(tieneMarcaPuntualVigente({ state: 'bloqueado', weekDate: '2026-10-12' }, '2026-10-14')).toBe(true);
    expect(tieneMarcaPuntualVigente({ state: 'reprogramada', weekDate: '2026-11-02' }, '2026-10-14')).toBe(true);
    expect(tieneMarcaPuntualVigente({ state: 'bloqueado', weekDate: '2026-10-05' }, '2026-10-14')).toBe(false);
    expect(tieneMarcaPuntualVigente({ state: 'bloqueado' }, '2026-10-14')).toBe(true);
    expect(tieneMarcaPuntualVigente({ state: 'libre' }, '2026-10-14')).toBe(false);
  });
});

describe('estadoCalendarioWith / huecosLibres', () => {
  const hace = (dias: number) => new Date(AHORA - dias * 86_400_000).toISOString();
  const db = (updated: string, cambios: Array<{ origin: string; dias: number }>) => new FakeDb({
    teachers: [{ id: 'tB', calendar_start_hour: 9, calendar_end_hour: 22 }],
    teacher_calendars: [{ teacher_id: 'tB', updated_at: updated, grid: { 'Jueves_15:00': { state: 'libre' } } }],
    calendar_changes: cambios.map(c => ({ teacher_id: 'tB', origin: c.origin, created_at: hace(c.dias) })),
    class_recoveries: [],
  });

  it('sin actualizar = sin cambios humanos en 30 días Y updated_at de más de 30 días', async () => {
    const casos: Array<[string, FakeDb, boolean]> = [
      ['viejo y sin cambios', db(hace(40), []), false],
      ['viejo, solo cambios del sistema', db(hace(40), [{ origin: 'sistema', dias: 2 }]), false],
      ['viejo pero el profesor lo tocó hace 10 días', db(hace(40), [{ origin: 'profesor', dias: 10 }]), true],
      ['viejo y el cambio humano es de hace 35 días', db(hace(40), [{ origin: 'profesor', dias: 35 }]), false],
      ['updated_at reciente', db(hace(5), []), true],
    ];
    for (const [nombre, fake, esperado] of casos) {
      expect((await estadoCalendarioWith(fake.client(), 'tB', AHORA)).actualizado, nombre).toBe(esperado);
    }
  });

  it('huecosLibres: CALENDARIO_SIN_ACTUALIZAR, o los bloques con las reservas de la base', async () => {
    const viejo = db(hace(40), []);
    const err = await huecosLibres({ client: viejo.client(), teacherId: 'tB', duracionHoras: 1, modo: 'fijo', ahora: AHORA }).catch(e => e);
    expect(err).toBeInstanceOf(HuecosError);
    expect(err.codigo).toBe('CALENDARIO_SIN_ACTUALIZAR');

    const ok = db(hace(1), []);
    ok.rows('class_recoveries').push({ teacher_id: 'tB', status: 'esperando_alumno', group_id: 'g', student_name: 'Y',
      teacher_proposals: [{ date: '2026-10-22', hour: '15:00', hours: 1 }] });
    const r = await huecosLibres({ client: ok.client(), teacherId: 'tB', duracionHoras: 1, modo: 'puntual', ahora: AHORA, hasta: AHORA + 15 * 86_400_000 });
    expect(r.map(b => b.fecha)).toEqual(['2026-10-15']);   // el 22 está reservado
    expect(await huecosLibres({ client: ok.client(), teacherId: 'tZ', duracionHoras: 1, modo: 'fijo', ahora: AHORA }).catch(e => e.codigo)).toBe('PROFESOR_NO_EXISTE');
  });
});
