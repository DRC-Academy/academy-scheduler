import { describe, it, expect } from 'vitest';
import { spainWallClockToEpoch } from '@/lib/spainTime';
import {
  mondayOf, buildWeeks, construirInformeUso, proyectarCalendario,
  type EntradaUso, type ClaseProgramada,
} from '@/lib/teacherUsage';
import type { ClassJoinLog, ClassRecord } from '@/types';

// Miércoles 30/09/2026 a las 12:00 en España.
const HOY = '2026-09-30';
const NOW = spainWallClockToEpoch(HOY, 12, 0);
const SEMANAS = buildWeeks(HOY, 2);   // 21-27/09 y 28/09-04/10

function log(p: Partial<ClassJoinLog> & { id: string; scheduledDate: string; scheduledTime: string }): ClassJoinLog {
  return { teacherId: 'tA', teacherName: 'Ana', studentName: 'Luis', clickedAt: '', punctuality: 'on_time', source: 'click', ...p } as ClassJoinLog;
}

function entrada(p: Partial<EntradaUso> = {}): EntradaUso {
  return {
    hoy: HOY, now: NOW, semanas: SEMANAS,
    profesores: [{ id: 'tA', name: 'Ana' }, { id: 'tB', name: 'Bea' }],
    ignorar: new Set(['t1']),
    profesorActualPorAlumno: new Map(), profesorActualPorNombre: new Map(),
    envios: [], validados: { ids: new Set(), nombres: new Set() },
    generaciones: [], joinLogs: [], records: [], analyses: [], primeraSubida: new Map(),
    programadas: [], fechasConFoto: new Set(), alertas: [], eventos: [],
    ...p,
  };
}

describe('semanas', () => {
  it('lunes de cualquier día, domingo incluido', () => {
    expect(mondayOf('2026-09-30')).toBe('2026-09-28');
    expect(mondayOf('2026-09-28')).toBe('2026-09-28');
    expect(mondayOf('2026-10-04')).toBe('2026-09-28');
  });
  it('buildWeeks termina en la semana de hoy, marcada en curso', () => {
    expect(SEMANAS).toEqual([
      { start: '2026-09-21', end: '2026-09-27', enCurso: false },
      { start: '2026-09-28', end: '2026-10-04', enCurso: true },
    ]);
  });
});

describe('prueba y validación', () => {
  it('cohorte por semana de envío; validación por semana en que se completó', () => {
    const r = construirInformeUso(entrada({
      envios: [
        { studentId: 's1', nombre: 'Uno', enviado: '2026-09-22T10:00:00Z', completada: '2026-09-29T10:00:00Z', teacherIdEnvio: 'tA' },
        { studentId: 's2', nombre: 'Dos', enviado: '2026-09-23T10:00:00Z', completada: null, teacherIdEnvio: 'tA' },
      ],
      validados: { ids: new Set(['s1']), nombres: new Set() },
      profesorActualPorAlumno: new Map([['s1', 'tB']]),
    }));
    expect(r.global.prueba[0]).toEqual({ num: 1, den: 2 });
    expect(r.global.validacion[1]).toEqual({ num: 1, den: 1 });
    // La validación le toca al profesor ACTUAL del alumno.
    expect(r.profesores.find(p => p.id === 'tB')!.celdas.validacion[1]).toEqual({ num: 1, den: 1 });
  });
});

describe('transcript en menos de 24 h', () => {
  const base = { id: 'ca1', teacher_id: 'tA', student_name: 'Luis', class_date: '2026-09-22', has_transcript: true, validation_status: 'ok' };

  it('la primera subida manda sobre analyzed_at reescrito al reemplazar', () => {
    const r = construirInformeUso(entrada({
      joinLogs: [log({ id: 'j1', scheduledDate: '2026-09-22', scheduledTime: '17:00' })],
      // Reemplazado 3 días después, pero la primera subida fue a las 2 h.
      analyses: [{ ...base, analyzed_at: '2026-09-25T10:00:00Z' }],
      primeraSubida: new Map([['ca1', '2026-09-22T18:00:00Z']]),
    }));
    expect(r.global.transcript[0]).toEqual({ num: 1, den: 1 });
    expect(r.transcriptProfes[0]).toEqual({ num: 1, den: 1 });
  });

  it('sin transcript y pasado el plazo cuenta como tarde; la falta del alumno no cuenta', () => {
    const falta = { id: 'r1', teacherId: 'tA', studentName: 'Eva', classDate: '2026-09-23', classType: 'falta_sin_aviso' } as ClassRecord;
    const r = construirInformeUso(entrada({
      joinLogs: [
        log({ id: 'j1', scheduledDate: '2026-09-22', scheduledTime: '17:00' }),
        log({ id: 'j2', scheduledDate: '2026-09-23', scheduledTime: '17:00', studentName: 'Eva' }),
      ],
      records: [falta],
    }));
    expect(r.global.transcript[0]).toEqual({ num: 0, den: 1 });
  });

  it('antes del 22/09/2026 la semana queda sin registrar (null), no en cero', () => {
    const r = construirInformeUso(entrada({ semanas: buildWeeks('2026-09-16', 1), hoy: '2026-09-16' }));
    expect(r.global.transcript[0]).toBeNull();
  });
});

describe('entró con el link', () => {
  const prog = (p: Partial<ClaseProgramada>): ClaseProgramada => ({
    teacherId: 'tA', teacherName: 'Ana', studentName: 'Luis', date: '2026-09-22',
    startHour: 17, durationHours: 1, isRecovery: false, ...p,
  });

  it('el ingreso manual del admin no cuenta; la cancelada no suma al total', () => {
    const r = construirInformeUso(entrada({
      programadas: [
        prog({}),                                  // clic → sí
        prog({ date: '2026-09-23' }),              // solo ingreso manual → no
        prog({ date: '2026-09-24' }),              // cancelada → fuera
      ],
      joinLogs: [
        log({ id: 'j1', scheduledDate: '2026-09-22', scheduledTime: '17:00' }),
        log({ id: 'j2', scheduledDate: '2026-09-23', scheduledTime: '17:00', source: 'manual' }),
      ],
      records: [{ id: 'r1', teacherId: 'tA', studentName: 'Luis', classDate: '2026-09-24', classTime: '17:00', classType: 'cancelada_con_preaviso' } as ClassRecord],
    }));
    expect(r.global.ingreso[0]).toEqual({ num: 1, den: 2 });
  });

  it('un clic a otra hora el mismo día cubre la clase (no cuenta dos)', () => {
    const r = construirInformeUso(entrada({
      programadas: [prog({})],
      joinLogs: [log({ id: 'j1', scheduledDate: '2026-09-22', scheduledTime: '19:00' })],
    }));
    expect(r.global.ingreso[0]).toEqual({ num: 1, den: 1 });
  });

  it('la clase de hoy que todavía no terminó no se cuenta', () => {
    const r = construirInformeUso(entrada({ programadas: [prog({ date: HOY, startHour: 18 })] }));
    expect(r.global.ingreso[1]).toEqual({ num: 0, den: 0 });
  });

  it('las cuentas de prueba no cuentan', () => {
    const r = construirInformeUso(entrada({ programadas: [prog({ teacherId: 't1' })] }));
    expect(r.global.ingreso[0]).toEqual({ num: 0, den: 0 });
  });
});

describe('proyección del calendario', () => {
  it('dos horas seguidas del mismo alumno son una sesión de 2 h', () => {
    const out = proyectarCalendario([{
      id: 'tA', name: 'Ana',
      upcomingClasses: [{ studentName: 'Luis', day: 'Martes', time: '17' }, { studentName: 'Luis', day: 'Martes', time: '18' }],
    }], ['2026-09-22'], new Map());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startHour: 17, durationHours: 2 });
  });
});

describe('ia y riesgo', () => {
  it('ia: profes que generaron sobre profes activos esa semana', () => {
    const r = construirInformeUso(entrada({
      joinLogs: [
        log({ id: 'j1', scheduledDate: '2026-09-22', scheduledTime: '17:00' }),
        log({ id: 'j2', scheduledDate: '2026-09-22', scheduledTime: '17:00', teacherId: 'tB' }),
      ],
      generaciones: [{ teacher_id: 'tA', teacher_name: 'Ana', origin: 'directa', created_at: '2026-09-22T12:00:00Z' }],
    }));
    expect(r.global.ia[0]).toEqual({ num: 1, den: 2 });
    expect(r.iaOrigen[0]).toEqual({ transcript: 0, directa: 1 });
  });

  it('riesgo: sin ningún evento registrado todavía, todo queda sin registrar', () => {
    const r = construirInformeUso(entrada({ alertas: [{ target_user: 'tA', created_at: '2026-09-22T10:00:00Z' }] }));
    expect(r.global.riesgo).toEqual([null, null]);
  });

  it('riesgo: abrir la alerta dentro de la semana siguiente cuenta', () => {
    const r = construirInformeUso(entrada({
      alertas: [{ target_user: 'tA', created_at: '2026-09-27T20:00:00Z' }, { target_user: 'tB', created_at: '2026-09-22T10:00:00Z' }],
      eventos: [
        // El registro ya existía esa semana (cualquier evento marca el arranque).
        { event: 'transcript_first_upload', teacher_id: 'tB', ref_id: 'x', created_at: '2026-09-21T08:00:00Z' },
        { event: 'risk_alert_opened', teacher_id: 'tA', ref_id: null, created_at: '2026-09-28T08:00:00Z' },
      ],
    }));
    expect(r.global.riesgo[0]).toEqual({ num: 1, den: 2 });
  });
});
