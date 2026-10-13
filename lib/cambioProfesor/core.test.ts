import { describe, it, expect, vi } from 'vitest';
import { cambiarProfesorCore, puedeCambiarProfesorWith, MAX_INTENTOS, type CambioProfesorParams } from '@/lib/cambioProfesor/core';
import { transferirAlumnoCore, type TransferenciaDeps } from '@/lib/transferencia/core';
import { CambioHorarioError } from '@/lib/cambioHorario/errors';
import { TransferenciaError } from '@/lib/transferencia/errors';
import { respuestaError } from '@/lib/cambioHorario/respuestas';
import { FakeDb } from '@/lib/transferencia/fakeDb.test-helper';
import { AHORA, dbFase2, hace } from '@/lib/cambioProfesor/fixtures.test-helper';

const deps = (): TransferenciaDeps & { enviarEmailProfeNuevo: ReturnType<typeof vi.fn>; enviarBienvenidaAlumno: ReturnType<typeof vi.fn> } => ({
  enviarEmailProfeNuevo: vi.fn(async () => true),
  enviarBienvenidaAlumno: vi.fn(async () => {}),
  ahora: () => AHORA,
});

const DESTINOS = [{ dia: 'Lunes', hora: '10:00', duracion: 2 }, { dia: 'Miércoles', hora: '18:00', duracion: 1 }];

/** La transferencia de verdad (núcleo de la Fase 0) sobre el cliente falso. */
function correr(db: FakeDb, p: Partial<CambioProfesorParams> = {}, ahora = AHORA, d = deps()) {
  const params: CambioProfesorParams = { studentId: 's1', destinos: DESTINOS, ...p };
  return { d, r: cambiarProfesorCore(db.client(), params, tp => transferirAlumnoCore(db.client(), tp, d), ahora) };
}

async function codigoDe(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) {
    return e instanceof CambioHorarioError || e instanceof TransferenciaError ? e.codigo : `otro: ${String(e)}`;
  }
}

const sinAuditoria = (db: FakeDb) => JSON.stringify({ ...db.tables, transfer_requests: undefined });

/** Un profesor más con Lunes 10-12 y Miércoles 18 libres (cubre los DESTINOS) y `activas` alumnos. */
function conProfesor(db: FakeDb, id: string, activas: number, updatedAt = hace(1)) {
  db.rows('teachers').push({ id, name: `Profe ${id}`, email: `${id}@x.com`, calendar_start_hour: 9, calendar_end_hour: 22 });
  db.rows('teacher_calendars').push({ teacher_id: id, updated_at: updatedAt, grid: {
    'Lunes_10:00': { state: 'libre' }, 'Lunes_11:00': { state: 'libre' }, 'Miércoles_18:00': { state: 'libre' },
  } });
  for (let i = 0; i < activas; i++) {
    db.rows('assignments').push({ id: `asg_${id}_${i}`, teacher_id: id, student_name: `Alumno ${id} ${i}`, status: 'active', slots: [] });
  }
}

/** Antes de cada patch al calendario de un profesor de `ids`, otro alumno ocupa el Lunes 10:00. */
function alguienSeAdelanta(db: FakeDb, ids: string[]) {
  db.hooks.beforePatch = (_n, teacherId, d) => {
    if (ids.includes(teacherId)) d.grid(teacherId)['Lunes_10:00'] = { state: 'ocupado', student: 'Intruso' };
  };
}

describe('cambiarProfesorCore · caso feliz', () => {
  it('Gestión elige el único profesor que cubre TODO y pasa sus sesiones (2 h + 1 h) con el núcleo de siempre, sin scoring', async () => {
    const db = dbFase2();
    const { d, r } = correr(db);
    const res = await r;

    expect(res).toMatchObject({ de: { id: 'tA' }, a: { id: 'tB', name: 'Carla' } });
    expect(res.slotsDespues).toEqual([{ day: 'Lunes', hour: '10:00' }, { day: 'Lunes', hour: '11:00' }, { day: 'Miércoles', hour: '18:00' }]);
    expect(db.rows('assignments')[0]).toMatchObject({ teacher_id: 'tB', weekly_hours: 3, meet_link: null });

    const nuevo = db.grid('tB');
    for (const k of ['Lunes_10:00', 'Lunes_11:00', 'Miércoles_18:00']) expect(nuevo[k]).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
    const viejo = db.grid('tA');
    for (const k of ['Martes_15:00', 'Martes_16:00', 'Jueves_10:00']) expect(viejo[k]).toEqual({ state: 'libre' });

    // Sin scoring ('autoservicio') y con los efectos del núcleo.
    expect(db.rows('scoring_events')).toEqual([]);
    const tipos = db.rows('notifications').map(n => `${n.type}:${n.target_user ?? n.target_role}`);
    expect(tipos).toEqual(expect.arrayContaining(['student_transferred_admin:admin', 'new_assignment:tB', 'student_transferred:tA']));
    expect(d.enviarEmailProfeNuevo).toHaveBeenCalledWith(expect.objectContaining({ teacherId: 'tB', studentName: 'Lucía Pérez' }));
    expect(d.enviarBienvenidaAlumno).toHaveBeenCalledWith('asg1');
    expect(db.rows('transfer_requests')).toMatchObject([{ estado: 'ok', motivo: 'autoservicio', origen: 'lms', actor: 'alumno:s1', to_teacher_id: 'tB' }]);
  });

  it('un profesor_id en el cuerpo se ignora', async () => {
    const db = dbFase2();
    const res = await correr(db, { profesorId: 'tE' } as Partial<CambioProfesorParams>).r;
    expect(res.a.id).toBe('tB');
  });

  it('elige con elegirProfesor: menos asignaciones activas, luego calendario más reciente, luego id menor', async () => {
    const db = dbFase2();                       // tB tiene 0 activas, calendario de hace 3 días
    conProfesor(db, 'tF', 0, hace(1));          // 0 activas, calendario más reciente → gana
    conProfesor(db, 'tG', 0, hace(1));          // empata con tF: id mayor
    expect((await correr(db).r).a.id).toBe('tF');

    const db2 = dbFase2();
    conProfesor(db2, 'tF', 2, hace(1));
    db2.rows('assignments').push({ id: 'x1', teacher_id: 'tB', student_name: 'Otro', status: 'active', slots: [] });
    db2.rows('assignments').push({ id: 'x2', teacher_id: 'tB', student_name: 'Otro 2', status: 'cancelled', slots: [] });   // no cuenta
    expect((await correr(db2).r).a.id).toBe('tB');   // 1 activa contra 2
  });

  it('si alguien ocupa un hueco al transferir, prueba con el siguiente candidato que cubra todo', async () => {
    const db = dbFase2();
    conProfesor(db, 'tF', 0, hace(1));          // el elegido primero
    alguienSeAdelanta(db, ['tF']);
    const { r } = correr(db, { idempotencyKey: 'k1' });
    const res = await r;
    expect(res.a.id).toBe('tB');
    expect(db.grid('tF')['Lunes_11:00']).toEqual({ state: 'libre' });   // el intento fallido no dejó nada
    expect(db.rows('assignments')[0]).toMatchObject({ teacher_id: 'tB' });
    expect(db.rows('transfer_requests').map(t => `${t.idempotency_key}:${t.estado}`)).toEqual(['k1|tF:error', 'k1|tB:ok']);

    // Repetir la misma clave devuelve lo guardado sin repetir nada.
    const antes = JSON.stringify(db.tables);
    const otra = correr(db, { idempotencyKey: 'k1' });
    expect(await otra.r).toEqual(res);
    expect(JSON.stringify(db.tables)).toBe(antes);
    expect(otra.d.enviarEmailProfeNuevo).not.toHaveBeenCalled();
  });

  it(`hasta ${MAX_INTENTOS} intentos; si en todos alguien se adelanta, HUECO_YA_OCUPADO sin dejar nada hecho`, async () => {
    const db = dbFase2();
    for (const id of ['tF', 'tG', 'tH']) conProfesor(db, id, 0, hace(1));
    alguienSeAdelanta(db, ['tB', 'tF', 'tG', 'tH']);
    const err = await correr(db, { idempotencyKey: 'k2' }).r.catch(e => e);
    expect(err).toMatchObject({ codigo: 'HUECO_YA_OCUPADO' });
    expect(db.rows('transfer_requests')).toHaveLength(MAX_INTENTOS);
    expect(db.rows('assignments')[0]).toMatchObject({ teacher_id: 'tA' });
    expect(respuestaError(err, 't').status).toBe(409);
  });

  it('idempotencia: la clave de otro alumno no devuelve su cambio', async () => {
    const db = dbFase2();
    await correr(db, { idempotencyKey: 'k3' }).r;
    db.rows('students').push({ id: 's2', name: 'Otra', email: 'o@x.com', product_name: 'Ingles General - 3h semanales', company_plan_months: null, is_oritalk: false });
    expect(await codigoDe(correr(db, { idempotencyKey: 'k3', studentId: 's2' }).r)).toBe('DATOS_INVALIDOS');
  });
});

describe('cambiarProfesorCore · rechazos, sin escribir nada', () => {
  const casos: Array<[string, (db: FakeDb) => void, Partial<CambioProfesorParams>, number?]> = [
    ['SESIONES_NO_COINCIDEN', () => {}, { destinos: [] }],
    ['DATOS_INVALIDOS', () => {}, { destinos: [{ dia: 'Lunes', hora: '10:30', duracion: 2 }, DESTINOS[1]] }],
    ['DATOS_INVALIDOS', () => {}, { idempotencyKey: 'a%b' }],
    // No cubre todas sus sesiones / duraciones distintas.
    ['SESIONES_NO_COINCIDEN', () => {}, { destinos: [DESTINOS[0]] }],
    ['SESIONES_NO_COINCIDEN', () => {}, { destinos: [{ dia: 'Lunes', hora: '10:00', duracion: 1 }, { dia: 'Martes', hora: '19:00', duracion: 1 }, DESTINOS[1]] }],
    // Dos destinos que se solapan, o que van seguidos (serían una sola clase).
    ['DATOS_INVALIDOS', () => {}, { destinos: [DESTINOS[0], { dia: 'Lunes', hora: '11:00', duracion: 1 }] }],
    ['DATOS_INVALIDOS', () => {}, { destinos: [DESTINOS[0], { dia: 'Lunes', hora: '12:00', duracion: 1 }] }],
    ['NO_ELEGIBLE', db => { db.rows('students')[0].company_plan_months = 3; }, {}],
    ['RECUPERACION_PENDIENTE', db => { db.rows('class_recoveries').push({ id: 'r1', assignment_id: 'asg1', student_id: 's1', teacher_id: 'tA', status: 'confirmada', original_date: '2026-10-06', original_hour: '15:00' }); }, {}],
    // Ningún candidato tiene libres a la vez todos los destinos (cada uno sí lo tiene alguien).
    ['SLOT_NO_DISPONIBLE', () => {}, { destinos: [DESTINOS[0], { dia: 'Jueves', hora: '21:00', duracion: 1 }] }],
    ['SLOT_NO_DISPONIBLE', () => {}, { destinos: [{ dia: 'Lunes', hora: '11:00', duracion: 2 }, DESTINOS[1]] }],   // 12:00 ocupado
    ['SLOT_NO_DISPONIBLE', () => {}, { destinos: [DESTINOS[0], { dia: 'Viernes', hora: '18:00', duracion: 1 }] }],     // sin pintar
    // Lo único que lo tiene es el perfil de prueba, un archivado o un calendario sin actualizar.
    ['SLOT_NO_DISPONIBLE', db => { db.grid('tB')['Lunes_10:00'] = { state: 'ocupado', student: 'Otro' }; }, {}],
    // Antelación de la clase ACTUAL: lunes 12/10 a las 16:00 → el martes 15:00 está a 23 h.
    ['ANTELACION_INSUFICIENTE', () => {}, {}, Date.UTC(2026, 9, 12, 14, 0)],
    // Antelación de la clase NUEVA: el viernes 16/10 a las 09:00 cuando son las 10:00 del jueves 15/10.
    ['ANTELACION_INSUFICIENTE', () => {}, { destinos: [{ dia: 'Viernes', hora: '09:00', duracion: 2 }, { dia: 'Jueves', hora: '21:00', duracion: 1 }] }, Date.UTC(2026, 9, 15, 8, 0)],
    // El núcleo de transferencia: el plan dice 4 h y llegan 3 (no se reintenta con otro profesor).
    ['HORAS_NO_COINCIDEN', db => { db.rows('assignments')[0].weekly_hours = 4; }, {}],
  ];
  for (const [codigo, prep, p, ahora] of casos) {
    it(`${codigo}${p.destinos ? ` ${JSON.stringify(p.destinos.map(d => `${d.dia} ${d.hora} ${d.duracion}`))}` : ''}`, async () => {
      const db = dbFase2(); prep(db);
      const antes = sinAuditoria(db);
      expect(await codigoDe(correr(db, p, ahora).r)).toBe(codigo);
      expect(sinAuditoria(db)).toBe(antes);
    });
  }

  it('ANTELACION_INSUFICIENTE de la clase actual lleva disponible_desde = final de esa clase, también en la respuesta HTTP', async () => {
    const err = await correr(dbFase2(), {}, Date.UTC(2026, 9, 12, 14, 0)).r.catch(e => e);
    expect(err).toMatchObject({ codigo: 'ANTELACION_INSUFICIENTE', disponibleDesde: { fecha: '2026-10-13', hora: '17:00' } });
    const http = respuestaError(err, 't');
    expect(http.status).toBe(409);
    expect(await http.json()).toMatchObject({ ok: false, codigo: 'ANTELACION_INSUFICIENTE', disponible_desde: { fecha: '2026-10-13', hora: '17:00' } });
  });

  it('cambio a medias en el núcleo de transferencia → a_medias: true (y no se reintenta con otro profesor)', async () => {
    const http = respuestaError(new TransferenciaError({ codigo: 'HUECO_YA_OCUPADO', paso: 'x', mensaje: 'y', compensada: false }), 't');
    expect(await http.json()).toMatchObject({ ok: false, codigo: 'HUECO_YA_OCUPADO', a_medias: true });

    const db = dbFase2(); conProfesor(db, 'tF', 0, hace(1));
    const transferir = vi.fn(async () => { throw new TransferenciaError({ codigo: 'HUECO_YA_OCUPADO', paso: 'x', mensaje: 'y', compensada: false }); });
    const err = await cambiarProfesorCore(db.client(), { studentId: 's1', destinos: DESTINOS }, transferir, AHORA).catch(e => e);
    expect(err).toMatchObject({ codigo: 'HUECO_YA_OCUPADO', compensada: false });
    expect(transferir).toHaveBeenCalledTimes(1);
  });
});

describe('puede_cambiar_profesor (GET estado)', () => {
  it('puede, o el motivo con disponible_desde', async () => {
    expect(await puedeCambiarProfesorWith(dbFase2().client(), 's1', AHORA)).toEqual({ puede: true, motivo: null, detalle_no_elegible: null, disponible_desde: null });
    expect(await puedeCambiarProfesorWith(dbFase2().client(), 's1', Date.UTC(2026, 9, 12, 14, 0)))
      .toEqual({ puede: false, motivo: 'ANTELACION_INSUFICIENTE', detalle_no_elegible: null, disponible_desde: { fecha: '2026-10-13', hora: '17:00' } });
    const db = dbFase2(); db.rows('students')[0].is_oritalk = true;
    expect(await puedeCambiarProfesorWith(db.client(), 's1', AHORA)).toMatchObject({ puede: false, motivo: 'NO_ELEGIBLE', detalle_no_elegible: 'ORITALK' });
  });
});
