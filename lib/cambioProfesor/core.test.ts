import { describe, it, expect, vi } from 'vitest';
import { cambiarProfesorCore, puedeCambiarProfesorWith, type CambioProfesorParams } from '@/lib/cambioProfesor/core';
import { transferirAlumnoCore, type TransferenciaDeps } from '@/lib/transferencia/core';
import { CambioHorarioError } from '@/lib/cambioHorario/errors';
import { TransferenciaError } from '@/lib/transferencia/errors';
import { respuestaError } from '@/lib/cambioHorario/respuestas';
import { FakeDb } from '@/lib/transferencia/fakeDb.test-helper';
import { AHORA, dbFase2 } from '@/lib/cambioProfesor/fixtures.test-helper';

const deps = (): TransferenciaDeps & { enviarEmailProfeNuevo: ReturnType<typeof vi.fn>; enviarBienvenidaAlumno: ReturnType<typeof vi.fn> } => ({
  enviarEmailProfeNuevo: vi.fn(async () => true),
  enviarBienvenidaAlumno: vi.fn(async () => {}),
  ahora: () => AHORA,
});

/** La transferencia de verdad (núcleo de la Fase 0) sobre el cliente falso. */
function correr(db: FakeDb, p: Partial<CambioProfesorParams> = {}, ahora = AHORA, d = deps()) {
  const params: CambioProfesorParams = {
    studentId: 's1', profesorId: 'tB',
    destinos: [{ dia: 'Lunes', hora: '10:00', duracion: 2 }, { dia: 'Miércoles', hora: '18:00', duracion: 1 }],
    ...p,
  };
  return { d, r: cambiarProfesorCore(db.client(), params, tp => transferirAlumnoCore(db.client(), tp, d), ahora) };
}

async function codigoDe(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) {
    return e instanceof CambioHorarioError || e instanceof TransferenciaError ? e.codigo : `otro: ${String(e)}`;
  }
}

const sinAuditoria = (db: FakeDb) => JSON.stringify({ ...db.tables, transfer_requests: undefined });

describe('cambiarProfesorCore · caso feliz', () => {
  it('pasa TODAS sus sesiones (2 h + 1 h) al profesor nuevo con el núcleo de siempre, sin scoring', async () => {
    const db = dbFase2();
    const { d, r } = correr(db);
    const res = await r;

    expect(res).toMatchObject({ de: { id: 'tA' }, a: { id: 'tB' } });
    expect(res.slotsDespues).toEqual([{ day: 'Lunes', hour: '10:00' }, { day: 'Lunes', hour: '11:00' }, { day: 'Miércoles', hour: '18:00' }]);
    const asg = db.rows('assignments')[0];
    expect(asg).toMatchObject({ teacher_id: 'tB', weekly_hours: 3, meet_link: null });

    const nuevo = db.grid('tB');
    for (const k of ['Lunes_10:00', 'Lunes_11:00', 'Miércoles_18:00']) expect(nuevo[k]).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
    const viejo = db.grid('tA');
    for (const k of ['Martes_15:00', 'Martes_16:00', 'Jueves_10:00']) expect(viejo[k]).toEqual({ state: 'libre' });

    // Sin scoring ('autoservicio') y con los efectos del núcleo.
    expect(db.rows('scoring_events')).toEqual([]);
    const tipos = db.rows('notifications').map(n => `${n.type}:${n.target_user ?? n.target_role}`);
    expect(tipos).toEqual(expect.arrayContaining(['student_transferred_admin:admin']));
    expect(tipos.some(t => t.endsWith(':tB'))).toBe(true);   // aviso al profesor nuevo
    expect(tipos.some(t => t.endsWith(':tA'))).toBe(true);   // aviso al profesor anterior
    expect(d.enviarEmailProfeNuevo).toHaveBeenCalledWith(expect.objectContaining({ teacherId: 'tB', studentName: 'Lucía Pérez' }));
    expect(d.enviarBienvenidaAlumno).toHaveBeenCalledWith('asg1');
    expect(db.rows('transfer_requests')).toMatchObject([{ estado: 'ok', motivo: 'autoservicio', origen: 'lms', actor: 'alumno:s1' }]);
  });

  it('idempotencia: la misma clave tras un cambio hecho devuelve lo guardado sin repetir nada', async () => {
    const db = dbFase2();
    const primero = await correr(db, { idempotencyKey: 'k1' }).r;
    const antes = JSON.stringify(db.tables);
    const { d, r } = correr(db, { idempotencyKey: 'k1' });
    expect(await r).toEqual(primero);
    expect(JSON.stringify(db.tables)).toBe(antes);
    expect(d.enviarEmailProfeNuevo).not.toHaveBeenCalled();
    // La misma clave para OTRO profesor: no.
    expect(await codigoDe(correr(db, { idempotencyKey: 'k1', profesorId: 'tE', destinos: [{ dia: 'Viernes', hora: '09:00', duracion: 2 }, { dia: 'Jueves', hora: '21:00', duracion: 1 }] }).r)).toBe('DATOS_INVALIDOS');
  });
});

describe('cambiarProfesorCore · rechazos, sin escribir nada', () => {
  const casos: Array<[string, (db: FakeDb) => void, Partial<CambioProfesorParams>, number?]> = [
    ['DATOS_INVALIDOS', () => {}, { destinos: [] }],
    ['DATOS_INVALIDOS', () => {}, { destinos: [{ dia: 'Lunes', hora: '10:30', duracion: 2 }, { dia: 'Miércoles', hora: '18:00', duracion: 1 }] }],
    // No cubre todas sus sesiones / duraciones distintas.
    ['DATOS_INVALIDOS', () => {}, { destinos: [{ dia: 'Lunes', hora: '10:00', duracion: 2 }] }],
    ['DATOS_INVALIDOS', () => {}, { destinos: [{ dia: 'Lunes', hora: '10:00', duracion: 1 }, { dia: 'Lunes', hora: '11:00', duracion: 1 }, { dia: 'Miércoles', hora: '18:00', duracion: 1 }] }],
    // Dos destinos que se solapan.
    ['DATOS_INVALIDOS', () => {}, { destinos: [{ dia: 'Lunes', hora: '10:00', duracion: 2 }, { dia: 'Lunes', hora: '11:00', duracion: 1 }] }],
    ['NO_ELEGIBLE', db => { db.rows('students')[0].company_plan_months = 3; }, {}],
    ['RECUPERACION_PENDIENTE', db => { db.rows('class_recoveries').push({ id: 'r1', assignment_id: 'asg1', student_id: 's1', teacher_id: 'tA', status: 'confirmada', original_date: '2026-10-06', original_hour: '15:00' }); }, {}],
    ['MISMO_PROFESOR', () => {}, { profesorId: 'tA' }],
    ['PROFESOR_DE_PRUEBA', () => {}, { profesorId: 't1', destinos: [{ dia: 'Lunes', hora: '10:00', duracion: 2 }, { dia: 'Miércoles', hora: '18:00', duracion: 1 }] }],
    ['PROFESOR_ARCHIVADO', () => {}, { profesorId: 'tC' }],
    ['PROFESOR_NO_EXISTE', () => {}, { profesorId: 'tX' }],
    ['CALENDARIO_SIN_ACTUALIZAR', () => {}, { profesorId: 'tD' }],
    ['SLOT_NO_DISPONIBLE', () => {}, { destinos: [{ dia: 'Lunes', hora: '11:00', duracion: 2 }, { dia: 'Miércoles', hora: '18:00', duracion: 1 }] }],   // 12:00 ocupado
    ['SLOT_NO_DISPONIBLE', () => {}, { destinos: [{ dia: 'Lunes', hora: '10:00', duracion: 2 }, { dia: 'Viernes', hora: '18:00', duracion: 1 }] }],     // sin pintar
    // Antelación de la clase ACTUAL: lunes 12/10 a las 16:00 → el martes 15:00 está a 23 h.
    ['ANTELACION_INSUFICIENTE', () => {}, {}, Date.UTC(2026, 9, 12, 14, 0)],
    // Antelación de la clase NUEVA: el viernes 16/10 a las 09:00 cuando son las 10:00 del jueves 15/10.
    ['ANTELACION_INSUFICIENTE', () => {}, { profesorId: 'tE', destinos: [{ dia: 'Viernes', hora: '09:00', duracion: 2 }, { dia: 'Jueves', hora: '21:00', duracion: 1 }] }, Date.UTC(2026, 9, 15, 8, 0)],
    // El núcleo de transferencia: el plan dice 4 h y llegan 3.
    ['HORAS_NO_COINCIDEN', db => { db.rows('assignments')[0].weekly_hours = 4; }, {}],
  ];
  for (const [codigo, prep, p, ahora] of casos) {
    it(`${codigo}${p.profesorId ? ` (${p.profesorId})` : ''}`, async () => {
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

  it('cambio a medias en el núcleo de transferencia → a_medias: true', async () => {
    const http = respuestaError(new TransferenciaError({ codigo: 'HUECO_YA_OCUPADO', paso: 'x', mensaje: 'y', compensada: false }), 't');
    expect(await http.json()).toMatchObject({ ok: false, codigo: 'HUECO_YA_OCUPADO', a_medias: true });
    const sin = respuestaError(new TransferenciaError({ codigo: 'PROFESOR_DE_PRUEBA', paso: 'x', mensaje: 'y' }), 't');
    expect(sin.status).toBe(422);
    expect('a_medias' in await sin.json()).toBe(false);
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
