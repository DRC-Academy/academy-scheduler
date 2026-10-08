import { describe, it, expect, vi } from 'vitest';
import { estadoAutoservicioWith, huecosAutoservicioWith } from '@/lib/cambioHorario/autoservicio';
import { cambiarHorarioCore, CambioHorarioError } from '@/lib/cambioHorario/core';
import { evaluarOrigen, finDeClase } from '@/lib/cambioHorario/origen';
import { autorizarLms, respuestaError, ESTADO_HTTP, MENSAJE } from '@/lib/cambioHorario/respuestas';
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
      'Lunes_12:00': { state: 'ocupado', student: 'Otro Alumno' },
    } }],
    students: [{ id: 's1', name: 'Lucía Pérez', email: 'lucia@x.com', product_name: 'Ingles General - 2h semanales', company_plan_months: null, is_oritalk: false }],
    assignments: [
      { id: 'asg1', teacher_id: 'tB', teacher_name: 'Berta', student_id: 's1', student_name: 'Lucía Pérez', student_email: 'lucia@x.com',
        status: 'active', slots: [{ day: 'Martes', hour: '15:00' }, { day: 'Martes', hour: '16:00' }] },
      { id: 'asg2', teacher_id: 'tB', teacher_name: 'Berta', student_id: 's2', student_name: 'Otro Alumno', student_email: 'o@x.com',
        status: 'active', slots: [{ day: 'Lunes', hour: '12:00' }] },
    ],
    notifications: [], calendar_changes: [], class_recoveries: [], class_records: [], scoring_events: [], schedule_change_requests: [],
  });
}

async function codigoDe(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) { return e instanceof CambioHorarioError ? e.codigo : `otro: ${String(e)}`; }
}

describe('GET estado', () => {
  it('elegible: sesiones con FIJO y las próximas clases de 6 semanas, sin escribir nada', async () => {
    const db = baseDb(); const antes = JSON.stringify(db.tables);
    const r = await estadoAutoservicioWith(db.client(), 's1', AHORA);
    expect(JSON.stringify(db.tables)).toBe(antes);
    expect(r).toMatchObject({ ok: true, elegible: true, motivo_no_elegible: null, detalle_no_elegible: null, profesor: { nombre: 'Berta' } });
    expect(r.sesiones).toHaveLength(1);
    const s = r.sesiones[0];
    expect(s).toMatchObject({ id: 'Martes_15:00', dia: 'Martes', hora: '15:00', duracion: 2,
      fijo: { movible: true, motivo_no_movible: null, disponible_desde: null } });
    // Del martes 13/10 al martes 17/11 (6 semanas desde el lunes 12 a las 10:00 → hasta el 23/11 10:00).
    expect(s.proximas_clases.map(c => c.fecha)).toEqual(['2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17']);
    expect(s.proximas_clases.every(c => c.movible && c.hora === '15:00' && c.duracion === 2)).toBe(true);
  });

  it('FIJO con la próxima clase a menos de 24 h: disponible_desde = final de esa clase', async () => {
    const db = baseDb();
    const lunes16h = Date.UTC(2026, 9, 12, 14, 0);   // el martes 15:00 está a 23 h
    const s = (await estadoAutoservicioWith(db.client(), 's1', lunes16h)).sesiones[0];
    expect(s.fijo).toEqual({ movible: false, motivo_no_movible: 'ANTELACION_INSUFICIENTE', disponible_desde: { fecha: '2026-10-13', hora: '17:00' } });
    // La clase del martes 13 tampoco se puede mover suelta (y no tiene fecha de desbloqueo).
    expect(s.proximas_clases[0]).toMatchObject({ fecha: '2026-10-13', movible: false, motivo_no_movible: 'ANTELACION_INSUFICIENTE', disponible_desde: null });
    expect(s.proximas_clases[1]).toMatchObject({ fecha: '2026-10-20', movible: true });
    // Coherencia con el POST: pasado ese momento, el FIJO ya no se rechaza por antelación.
    const fin = Date.UTC(2026, 9, 13, 15, 0);   // martes 13, 17:00 en España
    expect((await estadoAutoservicioWith(db.client(), 's1', fin)).sesiones[0].fijo.movible).toBe(true);
  });

  it('PUNTUAL con una marca vigente: todas sus clases bloqueadas hasta que acabe la semana de la marca', async () => {
    const db = baseDb();
    // Ya movió la clase del martes 27/10 (semana del 26/10).
    db.grid('tB')['Martes_15:00'] = { state: 'reprogramada', student: 'Lucía Pérez', weekDate: '2026-10-26', baseState: 'ocupado', baseStudent: 'Lucía Pérez' };
    const s = (await estadoAutoservicioWith(db.client(), 's1', AHORA)).sesiones[0];
    for (const c of s.proximas_clases) {
      expect(c).toMatchObject({ movible: false, motivo_no_movible: 'MARCA_PUNTUAL_EXISTENTE', disponible_desde: { fecha: '2026-11-02', hora: '00:00' } });
    }
    // El FIJO no lo bloquea la marca.
    expect(s.fijo.movible).toBe(true);
    // Coherencia con el POST: el núcleo rechaza con el mismo código antes de esa fecha…
    const p = {
      studentId: 's1', modo: 'puntual' as const, sesionOrigen: { dia: 'Martes', hora: '15:00', duracion: 2 }, fechaOrigen: '2026-11-03',
      destino: { dia: 'Jueves', hora: '10:00', duracion: 2, fecha: '2026-11-05' }, origen: 'lms' as const, actor: 't',
    };
    const deps = (ahora: number) => ({ enviarEmailProfesor: vi.fn(async () => true), enviarEmailAlumno: vi.fn(async () => true), ahora: () => ahora });
    expect(await codigoDe(cambiarHorarioCore(db.client(), p, deps(Date.UTC(2026, 10, 1, 22, 59))))).toBe('MARCA_PUNTUAL_EXISTENTE');
    // …y lo acepta a partir de ella (lunes 02/11 00:00 en España = 01/11 23:00 UTC).
    expect(await codigoDe(cambiarHorarioCore(db.client(), p, deps(Date.UTC(2026, 10, 1, 23, 0))))).toBe('OK');
  });

  it('no elegible: motivo y detalle, sin sesiones', async () => {
    const db = baseDb(); db.rows('students')[0].company_plan_months = 6;
    expect(await estadoAutoservicioWith(db.client(), 's1', AHORA)).toEqual({
      ok: true, elegible: false, motivo_no_elegible: 'NO_ELEGIBLE', detalle_no_elegible: 'EMPRESA', profesor: { nombre: 'Berta' }, sesiones: [],
    });
  });

  it('recuperación pendiente y calendario sin actualizar', async () => {
    const db = baseDb();
    db.rows('class_recoveries').push({ id: 'r1', group_id: 'g', assignment_id: 'asg1', student_id: 's1', teacher_id: 'tB', status: 'esperando_alumno', original_date: '2026-10-06', original_hour: '15:00' });
    expect((await estadoAutoservicioWith(db.client(), 's1', AHORA)).motivo_no_elegible).toBe('RECUPERACION_PENDIENTE');
    const db2 = baseDb(); db2.rows('teacher_calendars')[0].updated_at = hace(40);
    expect((await estadoAutoservicioWith(db2.client(), 's1', AHORA)).motivo_no_elegible).toBe('CALENDARIO_SIN_ACTUALIZAR');
  });

  it('alumno inexistente → ALUMNO_NO_ENCONTRADO', async () => {
    expect(await codigoDe(estadoAutoservicioWith(baseDb().client(), 'sX', AHORA))).toBe('ALUMNO_NO_ENCONTRADO');
  });
});

describe('GET huecos', () => {
  it('FIJO: bloques de la duración de la sesión, en el formato que acepta el POST', async () => {
    const db = baseDb();
    const r = await huecosAutoservicioWith(db.client(), 's1', { modo: 'fijo', sesion: 'Martes_15:00' }, AHORA);
    expect(r.sesion).toEqual({ id: 'Martes_15:00', dia: 'Martes', hora: '15:00', duracion: 2 });
    expect(r.huecos).toEqual([
      { dia: 'Martes', hora: '16:00', duracion: 2, fecha: '2026-10-13' },   // solapa consigo misma: vale en FIJO
      { dia: 'Jueves', hora: '10:00', duracion: 2, fecha: '2026-10-15' },
    ]);
    // Un hueco devuelto tal cual es un destino válido para el POST.
    const deps = { enviarEmailProfesor: vi.fn(async () => true), enviarEmailAlumno: vi.fn(async () => true), ahora: () => AHORA };
    await cambiarHorarioCore(db.client(), {
      studentId: 's1', modo: 'fijo', sesionOrigen: { dia: 'Martes', hora: '15:00', duracion: 2 }, destino: r.huecos[1], origen: 'lms', actor: 't',
    }, deps);
    expect(db.grid('tB')['Jueves_10:00']).toEqual({ state: 'ocupado', student: 'Lucía Pérez' });
  });

  it('PUNTUAL con fecha: sin el solape consigo misma ni la propia clase', async () => {
    const r = await huecosAutoservicioWith(baseDb().client(), 's1', { modo: 'puntual', sesion: 'Martes_15:00', fecha: '2026-10-20' }, AHORA);
    expect(r.fecha_origen).toBe('2026-10-20');
    expect(r.huecos.some(h => h.dia === 'Martes' && h.fecha === '2026-10-20')).toBe(false);
    expect(r.huecos.filter(h => h.dia === 'Jueves').map(h => h.fecha)).toEqual(['2026-10-15', '2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12', '2026-11-19']);
  });

  it('rechazos con el mismo código que el POST', async () => {
    const c = baseDb().client();
    expect(await codigoDe(huecosAutoservicioWith(c, 's1', { modo: 'otro', sesion: 'Martes_15:00' }, AHORA))).toBe('DATOS_INVALIDOS');
    expect(await codigoDe(huecosAutoservicioWith(c, 's1', { modo: 'fijo', sesion: 'Martes 15' }, AHORA))).toBe('DATOS_INVALIDOS');
    expect(await codigoDe(huecosAutoservicioWith(c, 's1', { modo: 'fijo', sesion: 'Martes_15:00', fecha: '2026-10-20' }, AHORA))).toBe('DATOS_INVALIDOS');
    expect(await codigoDe(huecosAutoservicioWith(c, 's1', { modo: 'fijo', sesion: 'Miércoles_15:00' }, AHORA))).toBe('SESION_NO_ENCONTRADA');
    expect(await codigoDe(huecosAutoservicioWith(c, 's1', { modo: 'fijo', sesion: 'Martes_15:00' }, Date.UTC(2026, 9, 12, 14, 0)))).toBe('ANTELACION_INSUFICIENTE');
    expect(await codigoDe(huecosAutoservicioWith(c, 's1', { modo: 'puntual', sesion: 'Martes_15:00', fecha: '2026-10-21' }, AHORA))).toBe('DATOS_INVALIDOS');
    const db = baseDb(); db.rows('students')[0].is_oritalk = true;
    const err = await huecosAutoservicioWith(db.client(), 's1', { modo: 'fijo', sesion: 'Martes_15:00' }, AHORA).catch(e => e);
    expect(err).toMatchObject({ codigo: 'NO_ELEGIBLE', detalleNoElegible: 'ORITALK' });
  });
});

describe('origen', () => {
  it('finDeClase pasa de medianoche', () => {
    expect(finDeClase({ hora: '23:00', duracion: 1 }, '2026-10-13')).toEqual({ fecha: '2026-10-14', hora: '00:00' });
    expect(finDeClase({ hora: '15:00', duracion: 2 }, '2026-10-13')).toEqual({ fecha: '2026-10-13', hora: '17:00' });
  });

  it('marca sin semana (antigua): bloquea sin fecha de desbloqueo', () => {
    const s = { dia: 'Martes', hora: '15:00', duracion: 1, claves: ['Martes_15:00'] };
    const ev = evaluarOrigen({ 'Martes_15:00': { state: 'bloqueado', student: 'X', baseState: 'ocupado', baseStudent: 'Ana' } }, s, 'puntual', AHORA, '2026-10-20');
    expect(ev).toMatchObject({ ok: false, codigo: 'MARCA_PUNTUAL_EXISTENTE', disponibleDesde: null });
  });
});

describe('respuestas HTTP', () => {
  it('todo código tiene estado y mensaje; el error lleva ok:false y el detalle de no elegible', async () => {
    for (const k of Object.keys(ESTADO_HTTP)) expect(MENSAJE[k as keyof typeof MENSAJE]).toBeTruthy();
    const r = respuestaError(new CambioHorarioError({ codigo: 'NO_ELEGIBLE', paso: 'x', mensaje: 'y', detalleNoElegible: 'EMPRESA' }), 't');
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, codigo: 'NO_ELEGIBLE', mensaje: MENSAJE.NO_ELEGIBLE, detalle_no_elegible: 'EMPRESA' });
  });

  it('cambio a medias: a_medias: true y mensaje propio para no reintentar', async () => {
    const r = respuestaError(new CambioHorarioError({ codigo: 'HUECO_YA_OCUPADO', paso: 'x', mensaje: 'y', compensada: false }), 't');
    expect(r.status).toBe(409);
    const cuerpo = await r.json();
    expect(cuerpo).toMatchObject({ ok: false, codigo: 'HUECO_YA_OCUPADO', a_medias: true });
    expect(cuerpo.mensaje).toContain('No lo intentes de nuevo');
  });

  it('sin quedar a medias (compensada null o true) no lleva a_medias', async () => {
    for (const compensada of [null, true]) {
      const r = respuestaError(new CambioHorarioError({ codigo: 'HUECO_YA_OCUPADO', paso: 'x', mensaje: 'y', compensada }), 't');
      const cuerpo = await r.json();
      expect('a_medias' in cuerpo).toBe(false);
      expect(cuerpo.mensaje).toBe(MENSAJE.HUECO_YA_OCUPADO);
    }
  });

  it('error inesperado → ERROR_INTERNO 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = respuestaError(new Error('boom'), 't');
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ ok: false, codigo: 'ERROR_INTERNO' });
    spy.mockRestore();
  });

  it('x-lms-secret: sin configurar 503, mal 401, bien null', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = (h?: string) => new Request('http://x/api', { headers: h ? { 'x-lms-secret': h } : {} });
    vi.stubEnv('LMS_GESTION_SECRET', '');
    expect(autorizarLms(req('a'))?.status).toBe(503);
    vi.stubEnv('LMS_GESTION_SECRET', 'secreto');
    const mal = autorizarLms(req('otro'))!;
    expect(mal.status).toBe(401);
    expect(await mal.json()).toMatchObject({ ok: false, codigo: 'NO_AUTORIZADO' });
    expect(autorizarLms(req('secreto'))).toBeNull();
    vi.unstubAllEnvs(); spy.mockRestore();
  });
});
