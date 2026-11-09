import { describe, it, expect } from 'vitest';
import { calcularAgenda, calcularBloques, estadoCalendarioWith, evaluarBloque, huecosLibres, HuecosError, tieneMarcaPuntualVigente, type OpcionesBloques } from '@/lib/huecos/huecos';
import { addDaysIso, dayNameFromIso } from '@/lib/teacherClasses';
import type { Cell } from '@/types';
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

// ── Agenda del profesor ───────────────────────────────────────────────────────

describe('calcularAgenda', () => {
  const agenda = (grid: Grid, o: Partial<OpcionesBloques> = {}) => calcularAgenda(grid, opts(o));
  const estadoEn = (grid: Grid, fecha: string, hora: number, o: Partial<OpcionesBloques> = {}) =>
    agenda(grid, o).franjas.find(f => f.fecha === fecha && f.hora === hora)?.estado ?? 'fuera';

  it('ventana: del lunes de esta semana al último día de los huecos puntuales', () => {
    const a = agenda({});
    expect(a.desde).toBe('2026-10-12');
    expect(a.hasta).toBe('2026-11-23');   // lunes 12/10 10:00 + 42 días
  });

  it('libre, ocupado y fuera de horario (no_work, sin pintar, fuera de rango, domingo)', () => {
    const grid: Grid = {
      'Lunes_09:00': { state: 'libre' },
      'Martes_15:00': { state: 'ocupado', student: 'Lucía Pérez' },
      'Martes_16:00': { state: 'no_work' },
      'Martes_23:00': { state: 'libre' },
      'Domingo_12:00': { state: 'libre' },
    };
    expect(estadoEn(grid, '2026-10-12', 9)).toBe('libre');      // ya pasó: lo deshabilita el LMS
    expect(estadoEn(grid, '2026-10-13', 15)).toBe('ocupado');
    expect(estadoEn(grid, '2026-10-13', 16)).toBe('fuera');
    expect(estadoEn(grid, '2026-10-13', 17)).toBe('fuera');     // sin pintar
    expect(estadoEn(grid, '2026-10-13', 23)).toBe('fuera');     // fuera de 9..22
    expect(agenda(grid).franjas.some(f => dayNameFromIso(f.fecha) === 'Domingo')).toBe(false);
  });

  it('marcas puntuales solo en su semana; reservas solo en su fecha', () => {
    const grid: Grid = {
      'Miércoles_10:00': { state: 'bloqueado', student: 'X', weekDate: '2026-10-19', baseState: 'libre' },
      'Jueves_10:00': { state: 'libre' },
      'Viernes_10:00': { state: 'reprogramada', student: 'Y', weekDate: '2026-10-26', baseState: 'ocupado', baseStudent: 'Y' },
    };
    const reservas = [{ date: '2026-10-15', hour: '10:00' }];
    expect(estadoEn(grid, '2026-10-14', 10)).toBe('libre');
    expect(estadoEn(grid, '2026-10-21', 10)).toBe('ocupado');   // la recuperación de esa semana
    expect(estadoEn(grid, '2026-10-15', 10, { reservas })).toBe('ocupado');
    expect(estadoEn(grid, '2026-10-22', 10, { reservas })).toBe('libre');
    expect(estadoEn(grid, '2026-10-30', 10)).toBe('ocupado');   // reprogramada, su semana
    expect(estadoEn(grid, '2026-10-16', 10)).toBe('ocupado');   // las demás: su base, ocupado
  });

  it('nunca lleva nombres ni tipo de clase', () => {
    const grid: Grid = {
      'Lunes_12:00': { state: 'ocupado', student: 'Lucía Pérez' },
      'Martes_12:00': { state: 'bloqueado', student: 'Nayara Gil', weekDate: '2026-10-12', baseState: 'ocupado', baseStudent: 'Otra Alumna', recoveryFor: 'r1' },
    };
    const json = JSON.stringify(agenda(grid));
    for (const prohibido of ['Lucía', 'Nayara', 'Otra', 'r1', 'bloqueado', 'reprogramada', 'student']) expect(json).not.toContain(prohibido);
  });
});

// La garantía del contrato: lo que se ofrece y lo que se pinta salen del mismo
// criterio. Sobre calendarios variados (generados con semilla fija):
//   · bloque ofrecido             → todas sus casillas 'libre' en la agenda;
//   · SLOT_NO_DISPONIBLE          → alguna casilla NO 'libre' en la agenda;
//   · todas 'libre' y no ofrecido → solo por una regla de bloque.
describe('agenda y huecos: el mismo cálculo', () => {
  function azar(semilla: number) {
    let x = semilla;
    return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  }
  const DIAS_G = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const SEMANAS = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-11-02', '2026-11-16'];

  function calendario(r: () => number): { grid: Grid; reservas: { date: string; hour: string }[] } {
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    const grid: Grid = {};
    for (const dia of DIAS_G) {
      for (let h = 8; h <= 23; h++) {
        const k = `${dia}_${String(h).padStart(2, '0')}:00`;
        const p = r();
        let c: Cell | undefined;
        if (p < 0.40) c = { state: 'libre' };
        else if (p < 0.60) c = { state: 'ocupado', student: 'Alguien' };
        else if (p < 0.70) c = { state: 'no_work' };
        else if (p < 0.80) c = { state: 'bloqueado', student: 'Rec', weekDate: pick(SEMANAS), baseState: pick(['libre', 'ocupado', 'no_work'] as const) };
        else if (p < 0.87) c = { state: 'reprogramada', student: 'Rep', weekDate: pick(SEMANAS), baseState: 'ocupado', baseStudent: 'Rep' };
        else if (p < 0.90) c = { state: 'bloqueado', student: 'Viejo' };   // marca sin semana
        if (c) grid[k] = c;
      }
    }
    const reservas = Array.from({ length: 4 }, () => ({
      date: addDaysIso('2026-10-12', Math.floor(r() * 42)), hour: `${String(9 + Math.floor(r() * 13)).padStart(2, '0')}:00`,
    }));
    return { grid, reservas };
  }

  it('en 12 calendarios, duraciones de 1 a 3 h, con y sin la clase propia', () => {
    let ofrecidos = 0; let comprobados = 0;
    for (let semilla = 1; semilla <= 12; semilla++) {
      const r = azar(semilla);
      const { grid, reservas } = calendario(r);
      const rango = { horaInicio: 9, horaFin: semilla % 3 === 0 ? 20 : 22 };
      const libre = new Set(calcularAgenda(grid, { ...rango, reservas, ahora: AHORA }).franjas
        .filter(f => f.estado === 'libre').map(f => `${f.fecha}|${f.hora}`));

      for (const n of [1, 2, 3]) {
        const o: OpcionesBloques = {
          modo: 'puntual', duracionHoras: n, ...rango, reservas, ahora: AHORA,
          sesionPropia: semilla % 2 ? { alumno: 'Alguien', claves: ['Martes_15:00'], fecha: '2026-10-20' } : undefined,
        };
        const ofrecidosSet = new Set(calcularBloques(grid, o).map(b => `${b.fecha}|${b.horaInicio}`));
        for (let fecha = '2026-10-12'; fecha <= '2026-11-23'; fecha = addDaysIso(fecha, 1)) {
          const dia = dayNameFromIso(fecha);
          if (!DIAS_G.includes(dia)) continue;
          for (let h = rango.horaInicio; h <= rango.horaFin; h++) {
            const ev = evaluarBloque(grid, { dia, hora: h, fecha }, o);
            const todasLibres = Array.from({ length: n }, (_, i) => `${fecha}|${h + i}`).every(c => libre.has(c));
            comprobados++;
            if (ev.ok) {
              ofrecidos++;
              expect(todasLibres, `${fecha} ${h} (${n} h) se ofrece y no está libre en la agenda`).toBe(true);
              expect(ofrecidosSet.has(`${ev.bloque.fecha}|${ev.bloque.horaInicio}`)).toBe(true);
            } else if (ev.motivo === 'SLOT_NO_DISPONIBLE') {
              expect(todasLibres, `${fecha} ${h} (${n} h) no disponible pero la agenda lo da libre`).toBe(false);
            } else if (todasLibres) {
              expect(['ANTELACION_INSUFICIENTE', 'FUERA_DE_VENTANA', 'MARCA_PUNTUAL_EXISTENTE', 'MISMO_HORARIO', 'DATOS_INVALIDOS']).toContain(ev.motivo);
            }
          }
        }
      }
    }
    // Que el test no pase en vacío.
    expect(ofrecidos).toBeGreaterThan(100);
    expect(comprobados).toBeGreaterThan(4_000);
  }, 30_000);
});
