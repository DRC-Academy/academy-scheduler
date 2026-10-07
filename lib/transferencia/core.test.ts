import { describe, it, expect, vi } from 'vitest';
import { transferirAlumnoCore, TransferenciaError, type TransferenciaDeps, type TransferenciaParams } from '@/lib/transferencia/core';
import { FakeDb } from '@/lib/transferencia/fakeDb.test-helper';

// Martes 13/10/2026, 10:00 en España.
const AHORA = Date.UTC(2026, 9, 13, 8, 0);

function baseDb() {
  return new FakeDb({
    teachers: [
      { id: 'tA', name: 'Ana', email: 'ana@x.com', archived_at: null, calendar_start_hour: 9, calendar_end_hour: 22 },
      { id: 'tB', name: 'Berta', email: 'berta@x.com', archived_at: null, calendar_start_hour: 9, calendar_end_hour: 22 },
      { id: 't1', name: 'Prueba', email: 'p@x.com', archived_at: null },
    ],
    teacher_calendars: [
      { teacher_id: 'tA', grid: {
        'Lunes_10:00': { state: 'ocupado', student: 'Lucía Pérez' },
        'Lunes_11:00': { state: 'ocupado', student: 'Lucía Pérez' },
        'Martes_10:00': { state: 'ocupado', student: 'Otro Alumno' },
      } },
      { teacher_id: 't1', grid: { 'Jueves_16:00': { state: 'libre' }, 'Jueves_17:00': { state: 'libre' } } },
      { teacher_id: 'tB', grid: {
        'Jueves_16:00': { state: 'libre' },
        'Jueves_17:00': { state: 'libre' },
        'Jueves_18:00': { state: 'no_work' },
        'Viernes_16:00': { state: 'ocupado', student: 'Pepe' },
      } },
    ],
    assignments: [{
      id: 'asg1', teacher_id: 'tA', teacher_name: 'Ana', teacher_email: 'ana@x.com',
      student_id: 's1', student_name: 'Lucía Pérez', student_email: 'lucia@x.com', student_level: 'B1',
      plan: 'Plan', start_date: '2026-06-01', weekly_hours: 2, status: 'active',
      slots: [{ day: 'Lunes', hour: '10:00' }, { day: 'Lunes', hour: '11:00' }],
      availability: 'Lunes 10:00, Lunes 11:00', created_at: '2026-06-01T00:00:00Z', meet_link: 'https://meet/a',
      meet_link_set_at: '2026-06-02T00:00:00Z', teacher_since: '2026-06-01', presentation_email_sent: true,
      presentation_email_sent_at: '2026-06-01T00:00:00Z', presentation_reminder_4h_sent: true,
      presentation_reminder_12h_sent: true, presentation_reminder_24h_sent: true,
    }],
    notifications: [], scoring_events: [], calendar_changes: [], class_recoveries: [], student_dropouts: [], student_pauses: [],
  });
}

const params = (over: Partial<TransferenciaParams> = {}): TransferenciaParams => ({
  assignmentId: 'asg1', toTeacherId: 'tB',
  slots: [{ day: 'Jueves', hour: '16:00' }, { day: 'Jueves', hour: '17:00' }],
  motivo: 'alumno', origen: 'admin', actor: 'Admin', ...over,
});

const deps = (over: Partial<TransferenciaDeps> = {}) => ({
  enviarEmailProfeNuevo: vi.fn(async () => true),
  enviarBienvenidaAlumno: vi.fn(async () => {}),
  ahora: () => AHORA,
  ...over,
});

const asg = (db: FakeDb) => db.rows('assignments')[0];
/** Todo menos la auditoría, que registra cada intento a propósito. */
const sinAuditoria = (db: FakeDb) => JSON.stringify({ ...db.tables, transfer_requests: undefined });
const tipos = (db: FakeDb) => db.rows('notifications').map(n => n.type);

async function codigoDe(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) { return e instanceof TransferenciaError ? e.codigo : `otro: ${String(e)}`; }
}

describe('transferirAlumnoCore', () => {
  it('transfiere: calendarios, asignación, historial, scoring, avisos y correos', async () => {
    const db = baseDb(); const d = deps();
    const r = await transferirAlumnoCore(db.client(), params(), d);

    expect(db.grid('tB')['Jueves_16:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
    expect(db.grid('tB')['Jueves_17:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
    expect(db.grid('tA')['Lunes_10:00']).toEqual({ state: 'libre' });
    expect(db.grid('tA')['Martes_10:00']).toEqual({ state: 'ocupado', student: 'Otro Alumno' });

    const a = asg(db);
    expect(a).toMatchObject({ teacher_id: 'tB', teacher_name: 'Berta', weekly_hours: 2, meet_link: null, status: 'active', start_date: '2026-06-01', teacher_since: '2026-10-13' });
    expect(a.slots).toEqual([{ day: 'Jueves', hour: '16:00' }, { day: 'Jueves', hour: '17:00' }]);
    expect(db.rows('assignments')).toHaveLength(1); // misma fila, nunca una nueva

    const cc = db.rows('calendar_changes');
    expect(cc).toHaveLength(4);
    expect(cc.every(c => c.assignment_id === 'asg1' && c.origin === 'sistema' && c.actor_role === 'admin')).toBe(true);

    expect(db.rows('scoring_events')).toMatchObject([{ teacher_id: 'tA', event_type: 'cambio_por_alumno', points: -10 }]);
    expect(tipos(db)).toEqual(['new_assignment', 'student_transferred', 'student_transferred_admin']);
    expect(db.rows('notifications')[2]).toMatchObject({ target_role: 'admin', title: 'Cambio de profesor', body: 'Lucía Pérez ha pasado de Ana a Berta (origen: admin)' });
    expect(d.enviarEmailProfeNuevo).toHaveBeenCalledWith(expect.objectContaining({ teacherId: 'tB', studentName: 'Lucía Pérez', startDate: '2026-06-01' }));
    expect(d.enviarBienvenidaAlumno).toHaveBeenCalledWith('asg1');
    expect(r.efectosFallidos).toEqual([]);
  });

  it("'autoservicio' no toca el scoring de ninguna forma", async () => {
    const db = baseDb();
    const update = vi.fn();
    db.hooks.failWrite = (t, op) => { if (t === 'teachers') update(op); return null; };
    await transferirAlumnoCore(db.client(), params({ motivo: 'autoservicio', origen: 'lms' }), deps());
    expect(db.rows('scoring_events')).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it("'reorg' no penaliza pero recalcula, como antes", async () => {
    const db = baseDb();
    const update = vi.fn();
    db.hooks.failWrite = (t, op) => { if (t === 'teachers') update(op); return null; };
    await transferirAlumnoCore(db.client(), params({ motivo: 'reorg' }), deps());
    expect(db.rows('scoring_events')).toEqual([]);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('valida sin escribir nada', async () => {
    const casos: Array<[string, (db: FakeDb) => void, Partial<TransferenciaParams>]> = [
      ['ASIGNACION_INACTIVA', db => { asg(db).status = 'inactive'; }, {}],
      ['MISMO_PROFESOR', () => {}, { toTeacherId: 'tA' }],
      ['PROFESOR_NO_EXISTE', () => {}, { toTeacherId: 'tZ' }],
      ['HORAS_NO_COINCIDEN', () => {}, { slots: [{ day: 'Jueves', hour: '16:00' }], origen: 'lms', motivo: 'autoservicio' }],
      ['DATOS_INVALIDOS', () => {}, { slots: [{ day: 'Jueves', hour: '16:00' }, { day: 'Jueves', hour: '16:00' }] }],
      ['SLOT_NO_DISPONIBLE', () => {}, { slots: [{ day: 'Jueves', hour: '16:00' }, { day: 'Viernes', hour: '16:00' }] }],
      ['PROFESOR_DE_PRUEBA', () => {}, { toTeacherId: 't1', origen: 'setter' }],
      ['PROFESOR_ARCHIVADO', db => { db.rows('teachers')[1].archived_at = '2026-09-01'; }, { origen: 'lms', motivo: 'autoservicio' }],
    ];
    for (const [codigo, prep, over] of casos) {
      const db = baseDb(); prep(db);
      const antes = sinAuditoria(db);
      expect(await codigoDe(transferirAlumnoCore(db.client(), params(over), deps())), codigo).toBe(codigo);
      expect(sinAuditoria(db), codigo).toBe(antes);
      expect(db.rows('transfer_requests'), codigo).toMatchObject([{ estado: 'error' }]);
      expect(String(db.rows('transfer_requests')[0].error), codigo).toMatch(new RegExp(`^${codigo}`));
    }
  });

  it('admin, setter y script pueden cambiar las horas: weekly_hours pasa a ser la cantidad nueva', async () => {
    const db = baseDb();
    await transferirAlumnoCore(db.client(), params({ origen: 'setter', slots: [{ day: 'Jueves', hour: '16:00' }] }), deps());
    expect(asg(db)).toMatchObject({ teacher_id: 'tB', weekly_hours: 1, availability: 'Jueves 16:00' });
  });

  it('solo t1 es perfil de prueba: t2 (profesor real) se acepta con origen setter y lms', async () => {
    for (const origen of ['setter', 'lms'] as const) {
      const db = baseDb();
      db.rows('teachers').push({ id: 't2', name: 'Mauricio', email: 'm@x.com', archived_at: null, calendar_start_hour: 9, calendar_end_hour: 23 });
      db.rows('teacher_calendars').push({ teacher_id: 't2', grid: { 'Jueves_16:00': { state: 'libre' }, 'Jueves_17:00': { state: 'libre' } } });
      expect(await codigoDe(transferirAlumnoCore(db.client(), params({ toTeacherId: 't2', origen, motivo: 'autoservicio' }), deps())), origen).toBe('OK');
    }
  });

  it('no hay control de profesor bloqueado (retención baja no frena)', async () => {
    const db = baseDb();
    for (let i = 0; i < 5; i++) db.rows('student_dropouts').push({ id: `d${i}`, teacher_id: 'tB', dropped_at: new Date().toISOString() });
    db.rows('assignments').push({ id: 'otra', teacher_id: 'tB', student_name: 'Pepe', status: 'active' });
    expect(await codigoDe(transferirAlumnoCore(db.client(), params({ origen: 'lms', motivo: 'autoservicio' }), deps()))).toBe('OK');
  });

  it('libera solo las casillas con el nombre EXACTO: "Ana López" no toca a "Ana María"', async () => {
    const db = baseDb();
    const a = asg(db);
    a.student_name = 'Ana López';
    a.slots = [{ day: 'Lunes', hour: '10:00' }, { day: 'Lunes', hour: '11:00' }];
    db.rows('teacher_calendars')[0].grid = {
      'Lunes_10:00': { state: 'ocupado', student: ' Ana López ' },
      'Lunes_11:00': { state: 'ocupado', student: 'Ana' },          // de su ficha, pero sin el nombre exacto
      'Martes_10:00': { state: 'ocupado', student: 'Ana María' },   // otra alumna con el mismo nombre de pila
    };
    await transferirAlumnoCore(db.client(), params(), deps());

    expect(db.grid('tA')['Lunes_10:00']).toEqual({ state: 'libre' });
    expect(db.grid('tA')['Lunes_11:00']).toEqual({ state: 'ocupado', student: 'Ana' });
    expect(db.grid('tA')['Martes_10:00']).toEqual({ state: 'ocupado', student: 'Ana María' });
    const aviso = db.rows('notifications').find(n => n.type === 'transfer_casillas_pendientes');
    expect(aviso).toMatchObject({ target_role: 'admin' });
    expect(aviso?.body).toMatch(/Ana López.*Ana.*Berta/);
    expect(aviso?.body).toContain('Lunes_11:00 (Ana)');
    expect(aviso?.body).toContain('Martes_10:00 (Ana María)');
  });

  it("con origen 'lms' usa el criterio estricto (no_work, fuera de rango, reservas)", async () => {
    const lms = { origen: 'lms' as const, motivo: 'autoservicio' as const };
    let db = baseDb();
    expect(await codigoDe(transferirAlumnoCore(db.client(), params({ ...lms, slots: [{ day: 'Jueves', hour: '16:00' }, { day: 'Jueves', hour: '18:00' }] }), deps()))).toBe('SLOT_NO_DISPONIBLE');

    // Con admin, una marca puntual sobre fondo libre de esta semana vale; con lms, no.
    const marca = { state: 'bloqueado', student: 'X', weekDate: '2026-10-12', baseState: 'libre' };
    db = baseDb(); (db.grid('tB') as Record<string, unknown>)['Jueves_17:00'] = marca;
    expect(await codigoDe(transferirAlumnoCore(db.client(), params(lms), deps()))).toBe('SLOT_NO_DISPONIBLE');
    db = baseDb(); (db.grid('tB') as Record<string, unknown>)['Jueves_17:00'] = marca;
    expect(await codigoDe(transferirAlumnoCore(db.client(), params(), deps()))).toBe('OK');

    db = baseDb();
    db.rows('class_recoveries').push({ teacher_id: 'tB', status: 'esperando_alumno', group_id: 'g', student_name: 'Y',
      teacher_proposals: [{ date: '2026-10-15', hour: '16:00', hours: 1 }] });
    expect(await codigoDe(transferirAlumnoCore(db.client(), params(lms), deps()))).toBe('SLOT_NO_DISPONIBLE');
  });

  it("recuperación abierta: con 'lms' frena, con admin solo avisa", async () => {
    const rec = { id: 'r1', group_id: 'g1', assignment_id: 'asg1', student_id: 's1', teacher_id: 'tA', status: 'confirmada', original_date: '2026-10-05', original_hour: '10:00' };
    let db = baseDb(); db.rows('class_recoveries').push(rec);
    expect(await codigoDe(transferirAlumnoCore(db.client(), params({ origen: 'lms', motivo: 'autoservicio' }), deps()))).toBe('RECUPERACION_PENDIENTE');
    db = baseDb(); db.rows('class_recoveries').push(rec);
    const r = await transferirAlumnoCore(db.client(), params(), deps());
    expect(r.avisos[0]).toMatch(/recuperación/);
  });

  it('conflicto en el patch del profesor nuevo: deshace lo aplicado y lanza HUECO_YA_OCUPADO', async () => {
    const db = baseDb();
    db.hooks.beforePatch = (n, t, fake) => {
      if (n === 1 && t === 'tB') fake.grid('tB')['Jueves_17:00'] = { state: 'ocupado', student: 'Intruso' };
    };
    const err = await transferirAlumnoCore(db.client(), params(), deps()).catch(e => e);
    expect(err).toBeInstanceOf(TransferenciaError);
    expect(err.codigo).toBe('HUECO_YA_OCUPADO');
    expect(err.compensada).toBeNull();
    expect(db.grid('tB')['Jueves_16:00']).toEqual({ state: 'libre' });            // la que sí entró, devuelta
    expect(db.grid('tB')['Jueves_17:00']).toEqual({ state: 'ocupado', student: 'Intruso' });
    expect(asg(db).teacher_id).toBe('tA');
    expect(db.rows('calendar_changes')).toEqual([]);
  });

  it('falla el UPDATE de la asignación: devuelve el calendario nuevo', async () => {
    const db = baseDb();
    db.hooks.failWrite = (t, op) => (t === 'assignments' && op === 'update' ? { message: 'boom' } : null);
    const err = await transferirAlumnoCore(db.client(), params(), deps()).catch(e => e);
    expect(err.codigo).toBe('ERROR_ESCRITURA');
    expect(err.compensada).toBe(true);
    expect(db.grid('tB')['Jueves_16:00']).toEqual({ state: 'libre' });
    expect(db.grid('tB')['Jueves_17:00']).toEqual({ state: 'libre' });
    expect(tipos(db)).toEqual([]);
  });

  it('la asignación cambió entre medias: ASIGNACION_CAMBIADA y se deshace', async () => {
    const db = baseDb();
    db.hooks.beforePatch = (n, _t, fake) => { if (n === 1) fake.rows('assignments')[0].teacher_id = 'tOtro'; };
    const err = await transferirAlumnoCore(db.client(), params(), deps()).catch(e => e);
    expect(err.codigo).toBe('ASIGNACION_CAMBIADA');
    expect(db.grid('tB')['Jueves_16:00']).toEqual({ state: 'libre' });
  });

  it('conflicto al liberar el calendario viejo: deshace asignación y calendario nuevo', async () => {
    const db = baseDb();
    db.hooks.beforePatch = (n, t, fake) => {
      if (n === 2 && t === 'tA') fake.grid('tA')['Lunes_11:00'] = { state: 'no_work' };
    };
    const err = await transferirAlumnoCore(db.client(), params(), deps()).catch(e => e);
    expect(err.codigo).toBe('HUECO_YA_OCUPADO');
    expect(err.compensada).toBe(true);
    expect(asg(db)).toMatchObject({ teacher_id: 'tA', meet_link: 'https://meet/a', created_at: '2026-06-01T00:00:00Z', weekly_hours: 2 });
    expect(db.grid('tB')['Jueves_16:00']).toEqual({ state: 'libre' });
    expect(db.grid('tA')['Lunes_10:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
  });

  it('si la compensación choca, avisa al admin y marca compensada=false', async () => {
    const db = baseDb();
    db.hooks.failWrite = (t, op) => (t === 'assignments' && op === 'update' ? { message: 'boom' } : null);
    db.hooks.beforePatch = (n, t, fake) => { if (n === 2 && t === 'tB') fake.grid('tB')['Jueves_16:00'] = { state: 'no_work' }; };
    const err = await transferirAlumnoCore(db.client(), params(), deps()).catch(e => e);
    expect(err.compensada).toBe(false);
    expect(tipos(db)).toEqual(['transfer_compensation_failed']);
    expect(db.grid('tB')['Jueves_17:00']).toEqual({ state: 'libre' });
  });

  it('un efecto que falla no frena a los demás y avisa al admin', async () => {
    const db = baseDb();
    const r = await transferirAlumnoCore(db.client(), params(), deps({ enviarEmailProfeNuevo: vi.fn(async () => false) }));
    expect(r.efectosFallidos).toEqual(['correo a Berta']);
    expect(tipos(db)).toEqual(['new_assignment', 'transfer_side_effect_failed', 'student_transferred', 'student_transferred_admin']);

    const db2 = baseDb();
    db2.hooks.failWrite = t => (t === 'calendar_changes' ? { message: 'sin permiso' } : null);
    const r2 = await transferirAlumnoCore(db2.client(), params(), deps());
    expect(r2.efectosFallidos).toEqual(['historial del calendario de Berta', 'historial del calendario de Ana']);
    expect(asg(db2).teacher_id).toBe('tB'); // el historial no revierte el cambio
  });

  describe('idempotencia y auditoría (transfer_requests)', () => {
    it('registra el intento correcto con antes/después y el resultado', async () => {
      const db = baseDb();
      const r = await transferirAlumnoCore(db.client(), params({ idempotencyKey: 'k1' }), deps());
      expect(db.rows('transfer_requests')).toMatchObject([{
        idempotency_key: 'k1', assignment_id: 'asg1', from_teacher_id: 'tA', to_teacher_id: 'tB',
        motivo: 'alumno', origen: 'admin', actor: 'Admin', estado: 'ok', error: null,
        slots_antes: [{ day: 'Lunes', hour: '10:00' }, { day: 'Lunes', hour: '11:00' }],
      }]);
      expect(db.rows('transfer_requests')[0].resultado).toEqual(r);
      expect(db.rows('transfer_requests')[0].finished_at).toBeTruthy();
    });

    it('misma clave ya resuelta: devuelve lo guardado sin repetir nada', async () => {
      const db = baseDb(); const d = deps();
      const r1 = await transferirAlumnoCore(db.client(), params({ idempotencyKey: 'k1' }), d);
      const foto = sinAuditoria(db);
      const r2 = await transferirAlumnoCore(db.client(), params({ idempotencyKey: 'k1' }), d);
      expect(r2).toEqual(r1);
      expect(sinAuditoria(db)).toBe(foto);
      expect(d.enviarEmailProfeNuevo).toHaveBeenCalledTimes(1);
      expect(db.rows('transfer_requests')).toHaveLength(1);
    });

    it("misma clave 'en_curso': EN_CURSO sin tocar nada", async () => {
      const db = baseDb();
      db.rows('transfer_requests').push({ id: 'x', idempotency_key: 'k1', assignment_id: 'asg1', to_teacher_id: 'tB', estado: 'en_curso' });
      const foto = sinAuditoria(db);
      expect(await codigoDe(transferirAlumnoCore(db.client(), params({ idempotencyKey: 'k1' }), deps()))).toBe('EN_CURSO');
      expect(sinAuditoria(db)).toBe(foto);
    });

    it('misma clave para otra petición: DATOS_INVALIDOS', async () => {
      const db = baseDb();
      db.rows('transfer_requests').push({ id: 'x', idempotency_key: 'k1', assignment_id: 'otra', to_teacher_id: 'tB', estado: 'ok', resultado: {} });
      expect(await codigoDe(transferirAlumnoCore(db.client(), params({ idempotencyKey: 'k1' }), deps()))).toBe('DATOS_INVALIDOS');
    });

    it("tras un 'error' o 'compensada', la misma clave se puede reintentar", async () => {
      const db = baseDb();
      db.hooks.failWrite = (t, op) => (t === 'assignments' && op === 'update' ? { message: 'boom' } : null);
      await transferirAlumnoCore(db.client(), params({ idempotencyKey: 'k1' }), deps()).catch(() => {});
      expect(db.rows('transfer_requests')).toMatchObject([{ estado: 'compensada' }]);
      db.hooks.failWrite = undefined;
      await transferirAlumnoCore(db.client(), params({ idempotencyKey: 'k1' }), deps());
      expect(db.rows('transfer_requests')).toMatchObject([{ estado: 'ok', error: null }]);
      expect(asg(db).teacher_id).toBe('tB');
    });

    it('sin tabla o sin permiso (anon con RLS) transfiere igual, sin registro', async () => {
      for (const code of ['42P01', '42501']) {
        const db = baseDb();
        db.hooks.failRead = t => (t === 'transfer_requests' ? { message: 'no', code } : null);
        db.hooks.failWrite = t => (t === 'transfer_requests' ? { message: 'no', code } : null);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await transferirAlumnoCore(db.client(), params({ idempotencyKey: 'k1' }), deps());
        warn.mockRestore();
        expect(asg(db).teacher_id, code).toBe('tB');
        expect(db.rows('transfer_requests'), code).toEqual([]);
      }
    });
  });
});
