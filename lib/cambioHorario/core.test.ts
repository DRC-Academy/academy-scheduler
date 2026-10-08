import { describe, it, expect, vi } from 'vitest';
import { cambiarHorarioCore, CambioHorarioError, type CambioHorarioDeps, type CambioHorarioParams } from '@/lib/cambioHorario/core';
import { FakeDb } from '@/lib/transferencia/fakeDb.test-helper';

// Lunes 12/10/2026, 10:00 en España (UTC+2).
const AHORA = Date.UTC(2026, 9, 12, 8, 0);
const hace = (dias: number) => new Date(AHORA - dias * 86_400_000).toISOString();

function baseDb() {
  return new FakeDb({
    teachers: [{ id: 'tB', name: 'Berta', email: 'berta@x.com', calendar_start_hour: 9, calendar_end_hour: 22 }],
    teacher_calendars: [{ teacher_id: 'tB', updated_at: hace(2), grid: {
      'Martes_15:00': { state: 'ocupado', student: 'Lucía Pérez' },
      'Martes_16:00': { state: 'ocupado', student: 'Lucía Pérez' },
      'Martes_17:00': { state: 'libre' },
      'Jueves_10:00': { state: 'libre' },
      'Jueves_11:00': { state: 'libre' },
      'Viernes_10:00': { state: 'no_work' },
      'Viernes_11:00': { state: 'no_work' },
      'Lunes_12:00': { state: 'ocupado', student: 'Otro Alumno' },
    } }],
    students: [{ id: 's1', name: 'Lucía Pérez', email: 'lucia@x.com', product_name: 'Ingles General - 2h semanales', company_plan_months: null, is_oritalk: false }],
    assignments: [
      { id: 'asg1', teacher_id: 'tB', teacher_name: 'Berta', student_id: 's1', student_name: 'Lucía Pérez', student_email: 'mama@x.com',
        status: 'active', slots: [{ day: 'Martes', hour: '15:00' }, { day: 'Martes', hour: '16:00' }], weekly_hours: 2,
        meet_link: 'https://meet/l', created_at: '2026-06-01T00:00:00Z', teacher_since: '2026-06-01', presentation_email_sent: true },
      { id: 'asg2', teacher_id: 'tB', teacher_name: 'Berta', student_id: 's2', student_name: 'Otro Alumno', student_email: 'o@x.com',
        status: 'active', slots: [{ day: 'Lunes', hour: '12:00' }], weekly_hours: 1 },
    ],
    notifications: [], calendar_changes: [], class_recoveries: [], class_records: [], scoring_events: [], schedule_change_requests: [],
  });
}

const fijo = (over: Partial<CambioHorarioParams> = {}): CambioHorarioParams => ({
  studentId: 's1', modo: 'fijo',
  sesionOrigen: { dia: 'Martes', hora: '15:00', duracion: 2 },
  destino: { dia: 'Jueves', hora: '10:00', duracion: 2, fecha: '2026-10-15' },
  origen: 'lms', actor: 'lucia@x.com', ...over,
});
const puntual = (over: Partial<CambioHorarioParams> = {}): CambioHorarioParams => fijo({
  modo: 'puntual', fechaOrigen: '2026-10-13', destino: { dia: 'Jueves', hora: '10:00', duracion: 2, fecha: '2026-10-22' }, ...over,
});

const deps = (over: Partial<CambioHorarioDeps> = {}) => ({
  enviarEmailProfesor: vi.fn(async () => true),
  enviarEmailAlumno: vi.fn(async () => true),
  ahora: () => AHORA,
  ...over,
});

const asg = (db: FakeDb) => db.rows('assignments').find(a => a.id === 'asg1')!;
const tipos = (db: FakeDb) => db.rows('notifications').map(n => n.type);
/** Todo menos la auditoría, que registra cada intento a propósito. */
const sinAuditoria = (db: FakeDb) => JSON.stringify({ ...db.tables, schedule_change_requests: undefined });

async function codigoDe(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) { return e instanceof CambioHorarioError ? e.codigo : `otro: ${String(e)}`; }
}

describe('cambiarHorarioCore · FIJO', () => {
  it('mueve la sesión de 2 h, deriva slots del calendario y no toca nada más de la ficha', async () => {
    const db = baseDb(); const d = deps();
    const r = await cambiarHorarioCore(db.client(), fijo(), d);

    const g = db.grid('tB');
    expect(g['Martes_15:00']).toEqual({ state: 'libre' });
    expect(g['Martes_16:00']).toEqual({ state: 'libre' });
    expect(g['Jueves_10:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
    expect(g['Jueves_11:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });

    // slots los escribe syncSlotsFromGrid; lo demás de la ficha no se toca.
    expect(asg(db)).toMatchObject({
      slots: [{ day: 'Jueves', hour: '10:00' }, { day: 'Jueves', hour: '11:00' }], weekly_hours: 2,
      meet_link: 'https://meet/l', created_at: '2026-06-01T00:00:00Z', teacher_since: '2026-06-01', presentation_email_sent: true, teacher_id: 'tB',
    });
    expect(db.rows('calendar_changes')).toHaveLength(4);
    expect(db.rows('calendar_changes').every(c => c.assignment_id === 'asg1' && c.origin === 'sistema' && c.actor_role === 'lms')).toBe(true);
    expect(db.rows('scoring_events')).toEqual([]);
    expect(db.rows('class_records')).toEqual([]);

    expect(tipos(db)).toEqual(['student_schedule_changed']);
    expect(db.rows('notifications')[0]).toMatchObject({ target_user: 'tB' });
    expect(String(db.rows('notifications')[0].body)).toContain('los martes de 15:00 a 17:00 a los jueves de 10:00 a 12:00');
    expect(d.enviarEmailAlumno).toHaveBeenCalledWith(expect.objectContaining({ studentEmail: 'lucia@x.com', ccEmail: 'mama@x.com', modo: 'fijo' }));
    expect(r).toMatchObject({ sesionAntes: { dia: 'Martes', hora: '15:00', duracion: 2 }, sesionDespues: { dia: 'Jueves', hora: '10:00', duracion: 2 }, fechaNueva: '2026-10-15', efectosFallidos: [] });
    expect(db.rows('schedule_change_requests')).toMatchObject([{ estado: 'ok', modo: 'fijo', assignment_id: 'asg1', teacher_id: 'tB' }]);
  });

  it('desplazamiento que solapa consigo mismo (15-17 → 16-18)', async () => {
    const db = baseDb();
    await cambiarHorarioCore(db.client(), fijo({ destino: { dia: 'Martes', hora: '16:00', duracion: 2 } }), deps());
    const g = db.grid('tB');
    expect(g['Martes_15:00']).toEqual({ state: 'libre' });
    expect(g['Martes_16:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
    expect(g['Martes_17:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
    expect(asg(db).slots).toEqual([{ day: 'Martes', hour: '16:00' }, { day: 'Martes', hour: '17:00' }]);
  });
});

describe('cambiarHorarioCore · PUNTUAL', () => {
  it('constancia reprogramada + marcas, igual que el "Reprogramar" del profesor; el horario fijo no cambia', async () => {
    const db = baseDb(); const d = deps();
    const r = await cambiarHorarioCore(db.client(), puntual(), d);

    expect(db.rows('class_records')).toMatchObject([{ class_type: 'reprogramada', class_date: '2026-10-13', class_time: '15:00',
      original_date: '2026-10-13', rescheduled_to: '2026-10-22', lost_hours: 2, student_name: 'Lucía Pérez', teacher_id: 'tB' }]);
    const g = db.grid('tB');
    expect(g['Martes_15:00']).toEqual({ state: 'reprogramada', student: 'Lucía Pérez', weekDate: '2026-10-12', baseState: 'ocupado', baseStudent: 'Lucía Pérez', rescheduledTo: '2026-10-22' });
    expect(g['Martes_16:00']?.state).toBe('reprogramada');
    expect(g['Jueves_10:00']).toEqual({ state: 'bloqueado', student: 'Lucía Pérez', weekDate: '2026-10-19', baseState: 'libre', recoveryFor: '2026-10-13' });
    expect(g['Jueves_11:00']?.state).toBe('bloqueado');
    expect(asg(db).slots).toEqual([{ day: 'Martes', hour: '15:00' }, { day: 'Martes', hour: '16:00' }]);
    expect(db.rows('calendar_changes')).toEqual([]);   // las marcas puntuales no van al historial
    expect(tipos(db)).toEqual(['student_schedule_changed']);
    expect(r).toMatchObject({ modo: 'puntual', fechaOriginal: '2026-10-13', fechaNueva: '2026-10-22' });
    expect(d.enviarEmailProfesor).toHaveBeenCalledTimes(1);
  });
});

describe('rechazos: cada código, sin escribir nada', () => {
  const casos: Array<[string, (db: FakeDb) => void, CambioHorarioParams, number?]> = [
    ['DATOS_INVALIDOS', () => {}, fijo({ destino: { dia: 'Jueves', hora: '10:30', duracion: 2 } })],
    ['DATOS_INVALIDOS', () => {}, fijo({ destino: { dia: 'Jueves', hora: '10:00', duracion: 1 } })],
    ['DATOS_INVALIDOS', () => {}, puntual({ fechaOrigen: undefined })],
    ['ALUMNO_NO_ENCONTRADO', () => {}, fijo({ studentId: 'sX' })],
    ['NO_ELEGIBLE', db => { db.rows('students')[0].is_oritalk = true; }, fijo()],
    ['SESION_NO_ENCONTRADA', () => {}, fijo({ sesionOrigen: { dia: 'Martes', hora: '15:00', duracion: 1 }, destino: { dia: 'Jueves', hora: '10:00', duracion: 1 } })],
    ['MISMO_HORARIO', () => {}, fijo({ destino: { dia: 'Martes', hora: '15:00', duracion: 2 } })],
    // Lunes a las 16:00: el martes a las 15:00 está a 23 h.
    ['ANTELACION_INSUFICIENTE', () => {}, fijo(), Date.UTC(2026, 9, 12, 14, 0)],
    // El destino el martes 13 a las 10:00: justo a 24 h.
    ['ANTELACION_INSUFICIENTE', db => { db.grid('tB')['Martes_10:00'] = { state: 'libre' }; db.grid('tB')['Martes_11:00'] = { state: 'libre' }; },
      puntual({ fechaOrigen: '2026-10-20', destino: { dia: 'Martes', hora: '10:00', duracion: 2, fecha: '2026-10-13' } })],
    ['FUERA_DE_VENTANA', () => {}, puntual({ destino: { dia: 'Jueves', hora: '10:00', duracion: 2, fecha: '2026-12-10' } })],
    ['MARCA_PUNTUAL_EXISTENTE', db => {
      db.grid('tB')['Martes_16:00'] = { state: 'bloqueado', student: 'X', weekDate: '2026-11-02', baseState: 'ocupado', baseStudent: 'Lucía Pérez' };
    }, puntual()],
    ['MARCA_PUNTUAL_EXISTENTE', db => {
      db.grid('tB')['Jueves_11:00'] = { state: 'reprogramada', student: 'Y', weekDate: '2026-10-26', baseState: 'libre' };
    }, puntual()],
    ['SLOT_NO_DISPONIBLE', () => {}, fijo({ destino: { dia: 'Viernes', hora: '10:00', duracion: 2 } })],
    ['SLOT_NO_DISPONIBLE', () => {}, fijo({ destino: { dia: 'Sábado', hora: '10:00', duracion: 2 } })],   // sin pintar
    ['RECUPERACION_PENDIENTE', db => { db.rows('class_recoveries').push({ id: 'r1', group_id: 'g', assignment_id: 'asg1', student_id: 's1', teacher_id: 'tB', status: 'esperando_alumno', original_date: '2026-10-06', original_hour: '15:00' }); }, fijo()],
    ['CALENDARIO_SIN_ACTUALIZAR', db => { db.rows('teacher_calendars')[0].updated_at = hace(40); }, fijo()],
  ];
  for (const [codigo, prep, p, ahora] of casos) {
    it(`${codigo}${p.modo === 'puntual' ? ' (puntual)' : ''}`, async () => {
      const db = baseDb(); prep(db);
      const antes = sinAuditoria(db);
      const d = deps(ahora ? { ahora: () => ahora } : {});
      expect(await codigoDe(cambiarHorarioCore(db.client(), p, d))).toBe(codigo);
      expect(sinAuditoria(db)).toBe(antes);
      expect(d.enviarEmailAlumno).not.toHaveBeenCalled();
    });
  }

  it('NO_ELEGIBLE lleva el detalle estable', async () => {
    const db = baseDb(); db.rows('students')[0].company_plan_months = 3;
    const err = await cambiarHorarioCore(db.client(), fijo(), deps()).catch(e => e);
    expect(err.detalleNoElegible).toBe('EMPRESA');
  });
});

describe('conflictos: todo o nada', () => {
  it('FIJO: otro ocupa una casilla destino a la vez → se deshace y HUECO_YA_OCUPADO', async () => {
    const db = baseDb();
    db.hooks.beforePatch = (n, _t, fake) => { if (n === 1) fake.grid('tB')['Jueves_11:00'] = { state: 'ocupado', student: 'Intruso' }; };
    const err = await cambiarHorarioCore(db.client(), fijo(), deps()).catch(e => e);
    expect(err.codigo).toBe('HUECO_YA_OCUPADO');
    expect(err.compensada).toBeNull();
    const g = db.grid('tB');
    expect(g['Martes_15:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
    expect(g['Jueves_10:00']).toEqual({ state: 'libre' });
    expect(asg(db).slots).toEqual([{ day: 'Martes', hour: '15:00' }, { day: 'Martes', hour: '16:00' }]);
    expect(db.rows('calendar_changes')).toEqual([]);
    expect(db.rows('schedule_change_requests')).toMatchObject([{ estado: 'error' }]);
  });

  it('PUNTUAL: si el calendario choca, se borra la constancia (compensada)', async () => {
    const db = baseDb();
    db.hooks.beforePatch = (n, _t, fake) => { if (n === 1) fake.grid('tB')['Jueves_11:00'] = { state: 'ocupado', student: 'Intruso' }; };
    const err = await cambiarHorarioCore(db.client(), puntual(), deps()).catch(e => e);
    expect(err.codigo).toBe('HUECO_YA_OCUPADO');
    expect(err.compensada).toBe(true);
    expect(db.rows('class_records')).toEqual([]);
    expect(db.grid('tB')['Martes_15:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
    expect(db.rows('schedule_change_requests')).toMatchObject([{ estado: 'compensada' }]);
  });

  it('PUNTUAL: si tampoco se puede borrar la constancia, queda a medias y se avisa al admin', async () => {
    const db = baseDb();
    db.hooks.beforePatch = (n, _t, fake) => { if (n === 1) fake.grid('tB')['Jueves_11:00'] = { state: 'ocupado', student: 'Intruso' }; };
    db.hooks.failWrite = (t, op) => (t === 'class_records' && op === 'delete' ? { message: 'boom' } : null);
    const err = await cambiarHorarioCore(db.client(), puntual(), deps()).catch(e => e);
    expect(err.compensada).toBe(false);
    expect(tipos(db)).toEqual(['schedule_change_compensation_failed']);
  });
});

describe('idempotencia y efectos', () => {
  it('misma clave ya resuelta: devuelve lo guardado sin repetir nada', async () => {
    const db = baseDb(); const d = deps();
    const r1 = await cambiarHorarioCore(db.client(), fijo({ idempotencyKey: 'k1' }), d);
    const foto = sinAuditoria(db);
    const r2 = await cambiarHorarioCore(db.client(), fijo({ idempotencyKey: 'k1' }), d);
    expect(r2).toEqual(r1);
    expect(sinAuditoria(db)).toBe(foto);
    expect(d.enviarEmailAlumno).toHaveBeenCalledTimes(1);
  });

  it("misma clave 'en_curso': EN_CURSO", async () => {
    const db = baseDb();
    db.rows('schedule_change_requests').push({ id: 'x', idempotency_key: 'k1', assignment_id: 'asg1', modo: 'fijo', estado: 'en_curso' });
    expect(await codigoDe(cambiarHorarioCore(db.client(), fijo({ idempotencyKey: 'k1' }), deps()))).toBe('EN_CURSO');
    expect(db.grid('tB')['Martes_15:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
  });

  it('un correo que falla no frena lo demás y avisa al admin', async () => {
    const db = baseDb();
    const r = await cambiarHorarioCore(db.client(), fijo(), deps({ enviarEmailAlumno: vi.fn(async () => false) }));
    expect(r.efectosFallidos).toEqual(['correo al alumno']);
    expect(tipos(db)).toEqual(['student_schedule_changed', 'schedule_change_side_effect_failed']);
  });

  it('sin la tabla de auditoría el cambio se hace igual', async () => {
    const db = baseDb();
    db.hooks.failRead = t => (t === 'schedule_change_requests' ? { message: 'no', code: 'PGRST205' } : null);
    db.hooks.failWrite = t => (t === 'schedule_change_requests' ? { message: 'no', code: 'PGRST205' } : null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cambiarHorarioCore(db.client(), fijo({ idempotencyKey: 'k1' }), deps());
    warn.mockRestore();
    expect(db.grid('tB')['Jueves_10:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
  });
});
