import { describe, it, expect } from 'vitest';
import { huecosEntreProfesores, ordenEstable, candidatosWith, franjaDeHora } from '@/lib/cambioProfesor/huecos';
import { CambioHorarioError } from '@/lib/cambioHorario/errors';
import { TransferenciaError } from '@/lib/transferencia/errors';
import { AHORA, dbFase2, hace } from '@/lib/cambioProfesor/fixtures.test-helper';

const etiq = (h: { profesor: { id: string }; dia: string; hora: string; duracion: number; fecha_primera_clase: string }) =>
  `${h.profesor.id} ${h.dia} ${h.hora} ${h.duracion}h ${h.fecha_primera_clase}`;

async function codigoDe(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) {
    return e instanceof CambioHorarioError || e instanceof TransferenciaError ? e.codigo : `otro: ${String(e)}`;
  }
}

describe('candidatos', () => {
  it('fuera: perfil de prueba, el actual, archivados y calendario sin actualizar (con el motivo)', async () => {
    const c = await candidatosWith(dbFase2().client(), { profesorActual: 'tA', ahora: AHORA });
    expect(c.profesores.map(p => p.id).sort()).toEqual(['tB', 'tE']);
    expect(Object.fromEntries(c.descartes)).toEqual({
      t1: 'PROFESOR_DE_PRUEBA', tA: 'MISMO_PROFESOR', tC: 'PROFESOR_ARCHIVADO', tD: 'CALENDARIO_SIN_ACTUALIZAR',
    });
  });
});

describe('orden estable', () => {
  const ps = ['tB', 'tE', 'tF', 'tG', 'tH', 'tI'].map(id => ({ id }));
  it('mismo alumno y día → mismo orden, aunque la base devuelva las filas en otro orden', () => {
    expect(ordenEstable(ps, 's1', '2026-10-10')).toEqual(ordenEstable([...ps].reverse(), 's1', '2026-10-10'));
  });
  it('otro día u otro alumno → (en general) otro orden; nunca pierde ni repite profesores', () => {
    const base = ordenEstable(ps, 's1', '2026-10-10').map(p => p.id).join();
    const otros = ['2026-10-11', '2026-10-12', '2026-10-13'].map(f => ordenEstable(ps, 's1', f).map(p => p.id).join());
    expect(otros.some(o => o !== base)).toBe(true);
    expect(ordenEstable(ps, 's2', '2026-10-10').map(p => p.id).sort()).toEqual(ps.map(p => p.id).sort());
  });
});

describe('huecosEntreProfesores', () => {
  it('lista: bloques FIJOS para la duración de la primera sesión (2 h), solo de candidatos', async () => {
    const r = await huecosEntreProfesores({ client: dbFase2().client(), alumno: 's1', ahora: AHORA });
    if (r.tipo !== 'lista') throw new Error('esperaba lista');
    expect(r.sesiones).toEqual([{ dia: 'Martes', hora: '15:00', duracion: 2 }, { dia: 'Jueves', hora: '10:00', duracion: 1 }]);
    expect(r.huecos.map(etiq).sort()).toEqual([
      'tB Lunes 10:00 2h 2026-10-12',          // Lunes 11-13 no: 12:00 ocupado
      'tB Martes 19:00 2h 2026-10-13',
      'tE Viernes 09:00 2h 2026-10-16',        // al día por el cambio humano reciente
    ]);
    // Agrupados por profesor en el orden estable.
    const orden = [...new Set(r.huecos.map(h => h.profesor.id))];
    const r2 = await huecosEntreProfesores({ client: dbFase2().client(), alumno: 's1', ahora: AHORA + 3_600_000 });
    expect([...new Set((r2 as typeof r).huecos.map(h => h.profesor.id))]).toEqual(orden);
  });

  it('franjas del LMS por hora de inicio (la madrugada es noche)', () => {
    const por = (hs: number[]) => hs.map(h => `${h}:${franjaDeHora(h)}`);
    expect(por([0, 5, 6, 11, 12, 14, 15, 19, 20, 23])).toEqual([
      '0:noche', '5:noche', '6:manana', '11:manana', '12:mediodia', '14:mediodia', '15:tarde', '19:tarde', '20:noche', '23:noche',
    ]);
  });

  it('filtros por día y franja', async () => {
    const dia = await huecosEntreProfesores({ client: dbFase2().client(), alumno: 's1', dia: 'Lunes', ahora: AHORA });
    expect((dia as { huecos: unknown[] }).huecos.map(etiq as never)).toEqual(['tB Lunes 10:00 2h 2026-10-12']);
    const tarde = await huecosEntreProfesores({ client: dbFase2().client(), alumno: 's1', franja: 'tarde', ahora: AHORA });
    expect((tarde as { huecos: unknown[] }).huecos.map(etiq as never)).toEqual(['tB Martes 19:00 2h 2026-10-13']);
    const manana = await huecosEntreProfesores({ client: dbFase2().client(), alumno: 's1', franja: 'manana', ahora: AHORA });
    expect((manana as { huecos: unknown[] }).huecos.map(etiq as never).sort()).toEqual(['tB Lunes 10:00 2h 2026-10-12', 'tE Viernes 09:00 2h 2026-10-16']);
    // Con profesor fijado: la sesión de 1 h en mediodía (12–14:59) y en noche (20:00).
    const fij = await huecosEntreProfesores({ client: dbFase2().client(), alumno: 's1', profesorFijado: 'tB', franja: 'noche', ahora: AHORA });
    expect((fij as { sesiones: Array<{ huecos: unknown[] }> }).sesiones[1].huecos.map(etiq as never)).toEqual(['tB Martes 20:00 1h 2026-10-13']);
    const mediodia = await huecosEntreProfesores({ client: dbFase2().client(), alumno: 's1', profesorFijado: 'tB', franja: 'mediodia', ahora: AHORA });
    expect((mediodia as { sesiones: Array<{ huecos: unknown[] }> }).sesiones[1].huecos).toEqual([]);   // 12:00 ocupado
    expect(await codigoDe(huecosEntreProfesores({ client: dbFase2().client(), alumno: 's1', franja: 'madrugada', ahora: AHORA }))).toBe('DATOS_INVALIDOS');
  });

  it('profesor fijado: sus bloques para CADA sesión (2 h y 1 h)', async () => {
    const r = await huecosEntreProfesores({ client: dbFase2().client(), alumno: 's1', profesorFijado: 'tB', ahora: AHORA });
    if (r.tipo !== 'profesor') throw new Error('esperaba profesor');
    expect(r.profesor).toEqual({ id: 'tB', nombre: 'Carla' });
    expect(r.sesiones.map(s => `${s.indice} ${s.dia} ${s.hora} ${s.duracion}h`)).toEqual(['0 Martes 15:00 2h', '1 Jueves 10:00 1h']);
    expect(r.sesiones[1].huecos.map(etiq)).toEqual([
      'tB Lunes 10:00 1h 2026-10-12', 'tB Lunes 11:00 1h 2026-10-12', 'tB Martes 19:00 1h 2026-10-13',
      'tB Martes 20:00 1h 2026-10-13', 'tB Miércoles 18:00 1h 2026-10-14',
    ]);
  });

  it('profesor fijado que no vale: el motivo exacto', async () => {
    const cod = (id: string) => codigoDe(huecosEntreProfesores({ client: dbFase2().client(), alumno: 's1', profesorFijado: id, ahora: AHORA }));
    expect(await cod('t1')).toBe('PROFESOR_DE_PRUEBA');
    expect(await cod('tA')).toBe('MISMO_PROFESOR');
    expect(await cod('tC')).toBe('PROFESOR_ARCHIVADO');
    expect(await cod('tD')).toBe('CALENDARIO_SIN_ACTUALIZAR');
    expect(await cod('tX')).toBe('PROFESOR_NO_EXISTE');
  });

  it('elegibilidad y recuperaciones de la Fase 1', async () => {
    const db = dbFase2(); db.rows('students')[0].is_oritalk = true;
    const err = await huecosEntreProfesores({ client: db.client(), alumno: 's1', ahora: AHORA }).catch(e => e);
    expect(err).toMatchObject({ codigo: 'NO_ELEGIBLE', detalleNoElegible: 'ORITALK' });
    const db2 = dbFase2();
    db2.rows('class_recoveries').push({ id: 'r1', assignment_id: 'asg1', student_id: 's1', teacher_id: 'tA', status: 'esperando_alumno', original_date: '2026-10-06', original_hour: '15:00' });
    expect(await codigoDe(huecosEntreProfesores({ client: db2.client(), alumno: 's1', ahora: AHORA }))).toBe('RECUPERACION_PENDIENTE');
    expect(await codigoDe(huecosEntreProfesores({ client: dbFase2().client(), alumno: 'sX', ahora: AHORA }))).toBe('ALUMNO_NO_ENCONTRADO');
  });

  it('el calendario sin actualizar del profesor ACTUAL no frena (se va de él)', async () => {
    const db = dbFase2(); db.rows('teacher_calendars').find(c => c.teacher_id === 'tA')!.updated_at = hace(60);
    expect(await codigoDe(huecosEntreProfesores({ client: db.client(), alumno: 's1', ahora: AHORA }))).toBe('OK');
  });

  it('reservas vivas de otro profesor ocupan sus huecos', async () => {
    const db = dbFase2();
    db.rows('class_recoveries').push({ id: 'r9', group_id: 'g9', teacher_id: 'tB', student_id: 'sZ', student_name: 'Zoe', status: 'esperando_alumno',
      teacher_proposals: [{ date: '2026-10-19', hour: '10:00', hours: 1 }] });
    const r = await huecosEntreProfesores({ client: db.client(), alumno: 's1', ahora: AHORA });
    // Lunes 10:00 en FIJO se comprueba 'desde' su primera clase: una reserva el 19/10 a las 10 lo ocupa.
    expect((r as { huecos: Array<{ profesor: { id: string }; dia: string }> }).huecos.some(h => h.profesor.id === 'tB' && h.dia === 'Lunes')).toBe(false);
  });
});
