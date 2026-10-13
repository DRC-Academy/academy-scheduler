import { describe, it, expect } from 'vitest';
import { huecosEntreProfesores, candidatosWith, franjaDeHora, chocan, type Horario, type HorarioDto } from '@/lib/cambioProfesor/huecos';
import { CambioHorarioError } from '@/lib/cambioHorario/errors';
import { TransferenciaError } from '@/lib/transferencia/errors';
import { AHORA, dbFase2, hace } from '@/lib/cambioProfesor/fixtures.test-helper';
import type { FakeDb } from '@/lib/transferencia/fakeDb.test-helper';

const etiq = (h: HorarioDto) => `${h.dia} ${h.hora} ${h.duracion}h ${h.fecha_primera_clase}`;
const h = (dia: string, hora: string, duracion: number): Horario => ({ dia, hora, duracion });

async function codigoDe(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) {
    return e instanceof CambioHorarioError || e instanceof TransferenciaError ? e.codigo : `otro: ${String(e)}`;
  }
}

const huecos = (db: FakeDb, extra: { elegidos?: Horario[]; dia?: string; franja?: string } = {}) =>
  huecosEntreProfesores({ client: db.client(), alumno: 's1', ahora: AHORA, ...extra });

/** Ningún dato de ningún profesor de la base (id, nombre, email) ni una clave "profesor". */
function sinDatosDeProfesores(db: FakeDb, r: unknown) {
  const json = JSON.stringify(r);
  expect(json).not.toMatch(/profesor|teacher/i);
  for (const t of db.rows('teachers')) {
    for (const v of [t.id, t.name, t.email]) expect(json, `aparece ${String(v)}`).not.toContain(`"${String(v)}"`);
    expect(json).not.toContain(String(t.name));
  }
}

describe('candidatos', () => {
  it('fuera: perfil de prueba, el actual, archivados y calendario sin actualizar (con el motivo)', async () => {
    const c = await candidatosWith(dbFase2().client(), { profesorActual: 'tA', ahora: AHORA });
    expect(c.profesores.map(p => p.id)).toEqual(['tB', 'tE']);
    expect(c.profesores.map(p => p.calendarioActualizadoEn)).toEqual([hace(3), hace(45)]);
    expect(Object.fromEntries(c.descartes)).toEqual({
      t1: 'PROFESOR_DE_PRUEBA', tA: 'MISMO_PROFESOR', tC: 'PROFESOR_ARCHIVADO', tD: 'CALENDARIO_SIN_ACTUALIZAR',
    });
  });
});

describe('chocan', () => {
  it('se solapan o van seguidos el mismo día; otro día o con una hora libre entre medias, no', () => {
    expect(chocan(h('Lunes', '10:00', 2), h('Lunes', '11:00', 1))).toBe(true);    // solapan
    expect(chocan(h('Lunes', '10:00', 2), h('Lunes', '12:00', 1))).toBe(true);    // seguidos: serían una sesión de 3 h
    expect(chocan(h('Lunes', '10:00', 2), h('Lunes', '09:00', 1))).toBe(true);    // seguidos por delante
    expect(chocan(h('Lunes', '10:00', 2), h('Lunes', '13:00', 1))).toBe(false);
    expect(chocan(h('Lunes', '10:00', 2), h('Martes', '10:00', 2))).toBe(false);
  });
});

describe('huecosEntreProfesores (contrato v3: horarios sin profesor)', () => {
  it('sin elegidos: horarios para la PRIMERA sesión (2 h) de cualquier candidato, por día y hora, con la fecha de la primera clase', async () => {
    const db = dbFase2();
    const r = await huecos(db);
    expect(r.sesiones).toEqual([h('Martes', '15:00', 2), h('Jueves', '10:00', 1)]);
    expect(r.siguiente).toEqual({ indice: 0, duracion: 2 });
    expect(r.elegidos_disponibles).toBe(true);
    expect(r.horarios.map(etiq)).toEqual([
      'Lunes 10:00 2h 2026-10-12',          // tB (Lunes 11-13 no: 12:00 ocupado)
      'Martes 19:00 2h 2026-10-13',         // tB
      'Viernes 09:00 2h 2026-10-16',        // tE: al día por el cambio humano reciente
    ]);
    sinDatosDeProfesores(db, r);
  });

  it('con elegidos: solo horarios de un profesor que también tiene libres TODOS los elegidos, sin solaparse con ellos', async () => {
    const db = dbFase2();
    // Lunes 10-12 solo lo tiene tB: los horarios de 1 h salen solo de tB (nada del Jueves 21:00 de tE).
    const conLunes = await huecos(db, { elegidos: [h('Lunes', '10:00', 2)] });
    expect(conLunes.siguiente).toEqual({ indice: 1, duracion: 1 });
    expect(conLunes.horarios.map(etiq)).toEqual(['Martes 19:00 1h 2026-10-13', 'Martes 20:00 1h 2026-10-13', 'Miércoles 18:00 1h 2026-10-14']);
    // Viernes 9-11 solo lo tiene tE: solo el Jueves 21:00 (los Viernes 9 y 10 se solapan con el elegido).
    const conViernes = await huecos(db, { elegidos: [h('Viernes', '09:00', 2)] });
    expect(conViernes.horarios.map(etiq)).toEqual(['Jueves 21:00 1h 2026-10-15']);
    sinDatosDeProfesores(db, conLunes);
    sinDatosDeProfesores(db, conViernes);
  });

  it('con elegidos: tampoco horarios seguidos a un elegido (serían una sola clase más larga)', async () => {
    const db = dbFase2();
    const g = db.grid('tB');
    g['Martes_18:00'] = { state: 'libre' };
    g['Martes_21:00'] = { state: 'libre' };
    const r = await huecos(db, { elegidos: [h('Martes', '19:00', 2)] });
    expect(r.horarios.map(etiq)).toEqual(['Lunes 10:00 1h 2026-10-12', 'Lunes 11:00 1h 2026-10-12', 'Miércoles 18:00 1h 2026-10-14']);
  });

  it('sin duplicados: el mismo horario libre con dos profesores sale una vez', async () => {
    const db = dbFase2();
    db.rows('teachers').push({ id: 'tF', name: 'Gala', email: 'gala@x.com', calendar_start_hour: 9, calendar_end_hour: 22 });
    db.rows('teacher_calendars').push({ teacher_id: 'tF', updated_at: hace(1), grid: { 'Lunes_10:00': { state: 'libre' }, 'Lunes_11:00': { state: 'libre' } } });
    const r = await huecos(db);
    expect(r.horarios.map(etiq)).toEqual(['Lunes 10:00 2h 2026-10-12', 'Martes 19:00 2h 2026-10-13', 'Viernes 09:00 2h 2026-10-16']);
    sinDatosDeProfesores(db, r);
  });

  it('elegidos que ya no cubre nadie: 200 con lista vacía y elegidos_disponibles: false', async () => {
    const r = await huecos(dbFase2(), { elegidos: [h('Sábado', '10:00', 2)] });
    expect(r).toMatchObject({ siguiente: { indice: 1, duracion: 1 }, elegidos_disponibles: false, horarios: [] });
  });

  it('todas las sesiones elegidas: siguiente null y sin horarios', async () => {
    const r = await huecos(dbFase2(), { elegidos: [h('Lunes', '10:00', 2), h('Miércoles', '18:00', 1)] });
    expect(r).toMatchObject({ siguiente: null, elegidos_disponibles: true, horarios: [] });
  });

  it('elegidos que no casan con sus sesiones o mal formados', async () => {
    const db = dbFase2();
    expect(await codigoDe(huecos(db, { elegidos: [h('Lunes', '10:00', 1)] }))).toBe('SESIONES_NO_COINCIDEN');   // su sesión 1 dura 2 h
    expect(await codigoDe(huecos(db, { elegidos: [h('Lunes', '10:00', 2), h('Miércoles', '18:00', 1), h('Sábado', '20:00', 1)] }))).toBe('SESIONES_NO_COINCIDEN');
    expect(await codigoDe(huecos(db, { elegidos: [h('Lunes', '10:30', 2)] }))).toBe('DATOS_INVALIDOS');
    expect(await codigoDe(huecos(db, { elegidos: [h('Domingo', '10:00', 2)] }))).toBe('DATOS_INVALIDOS');
    expect(await codigoDe(huecos(db, { elegidos: [h('Lunes', '10:00', 2), h('Lunes', '12:00', 1)] }))).toBe('DATOS_INVALIDOS');   // seguidos
  });

  it('franjas del LMS por hora de inicio (la madrugada es noche)', () => {
    const por = (hs: number[]) => hs.map(x => `${x}:${franjaDeHora(x)}`);
    expect(por([0, 5, 6, 11, 12, 14, 15, 19, 20, 23])).toEqual([
      '0:noche', '5:noche', '6:manana', '11:manana', '12:mediodia', '14:mediodia', '15:tarde', '19:tarde', '20:noche', '23:noche',
    ]);
  });

  it('filtros por día y franja', async () => {
    const db = dbFase2();
    expect((await huecos(db, { dia: 'Lunes' })).horarios.map(etiq)).toEqual(['Lunes 10:00 2h 2026-10-12']);
    expect((await huecos(db, { franja: 'tarde' })).horarios.map(etiq)).toEqual(['Martes 19:00 2h 2026-10-13']);
    expect((await huecos(db, { franja: 'manana' })).horarios.map(etiq)).toEqual(['Lunes 10:00 2h 2026-10-12', 'Viernes 09:00 2h 2026-10-16']);
    expect((await huecos(db, { elegidos: [h('Lunes', '10:00', 2)], franja: 'noche' })).horarios.map(etiq)).toEqual(['Martes 20:00 1h 2026-10-13']);
    expect((await huecos(db, { elegidos: [h('Lunes', '10:00', 2)], franja: 'mediodia' })).horarios).toEqual([]);   // 12:00 ocupado
    expect(await codigoDe(huecos(db, { franja: 'madrugada' }))).toBe('DATOS_INVALIDOS');
  });

  it('elegibilidad y recuperaciones de la Fase 1', async () => {
    const db = dbFase2(); db.rows('students')[0].is_oritalk = true;
    const err = await huecos(db).catch(e => e);
    expect(err).toMatchObject({ codigo: 'NO_ELEGIBLE', detalleNoElegible: 'ORITALK' });
    const db2 = dbFase2();
    db2.rows('class_recoveries').push({ id: 'r1', assignment_id: 'asg1', student_id: 's1', teacher_id: 'tA', status: 'esperando_alumno', original_date: '2026-10-06', original_hour: '15:00' });
    expect(await codigoDe(huecos(db2))).toBe('RECUPERACION_PENDIENTE');
    expect(await codigoDe(huecosEntreProfesores({ client: dbFase2().client(), alumno: 'sX', ahora: AHORA }))).toBe('ALUMNO_NO_ENCONTRADO');
  });

  it('el calendario sin actualizar del profesor ACTUAL no frena (se va de él)', async () => {
    const db = dbFase2(); db.rows('teacher_calendars').find(c => c.teacher_id === 'tA')!.updated_at = hace(60);
    expect(await codigoDe(huecos(db))).toBe('OK');
  });

  it('reservas vivas de otro profesor ocupan sus huecos', async () => {
    const db = dbFase2();
    db.rows('class_recoveries').push({ id: 'r9', group_id: 'g9', teacher_id: 'tB', student_id: 'sZ', student_name: 'Zoe', status: 'esperando_alumno',
      teacher_proposals: [{ date: '2026-10-19', hour: '10:00', hours: 1 }] });
    // Lunes 10:00 en FIJO se comprueba 'desde' su primera clase: una reserva el 19/10 a las 10 lo ocupa.
    expect((await huecos(db)).horarios.some(x => x.dia === 'Lunes')).toBe(false);
  });
});
