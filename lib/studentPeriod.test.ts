// AUDITORÍA E — lo que no puede pasar.
//
// El período filtra clases PROYECTADAS y jamás hechos observados. Es la promesa
// que hace seguro aplicarlo a asistencias, la agenda y /revisiones sin mover un
// euro. Si algún día alguien la rompe, que lo diga un test y no un profesor.
import { describe, it, expect } from 'vitest';
import { periodOf, classExistsOn, periodIndex, existsForStudent, findStartDateMismatches } from '@/lib/studentPeriod';
import { buildAttendanceRows } from '@/lib/attendance';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import type { Assignment, ClassJoinLog } from '@/types';

const T = 't1';
const OTRO = 't2';

const asgn = (name: string, startDate?: string, createdAt = '2026-01-01T00:00:00Z', teacherId = T): Assignment => ({
  id: `a_${name}_${teacherId}`, teacherId, teacherName: 'Prof', teacherEmail: 'p@x.com',
  studentId: `s_${name}`, studentName: name, studentEmail: `${name}@x.com`,
  studentLevel: 'B1', slots: [{ day: 'Martes', hour: '10:00' }], objetivo: '',
  plan: 'Inglés general', weeklyHours: 1, availability: '', notes: '', startDate, createdAt,
});
const log = (name: string, date: string, time = '10:00', teacherId = T): ClassJoinLog => ({
  id: `l_${name}_${date}`, teacherId, teacherName: 'Prof', studentName: name,
  scheduledDate: date, scheduledTime: time, clickedAt: `${date}T${time}:00Z`, punctuality: 'on_time',
});

describe('periodOf', () => {
  it('usa startDate cuando está', () => {
    expect(periodOf({ startDate: '2026-05-10', createdAt: '2026-01-01T00:00:00Z' }).from).toBe('2026-05-10');
  });
  it('cae a createdAt cuando falta startDate', () => {
    expect(periodOf({ createdAt: '2026-03-04T12:00:00Z' }).from).toBe('2026-03-04');
  });
  it('nunca devuelve un período sin piso', () => {
    // Sin piso volveríamos al bug de origen: proyección infinita hacia atrás.
    expect(periodOf({}).from).toBeTruthy();
  });
  it('ignora una fecha con formato inválido y cae al siguiente candidato', () => {
    expect(periodOf({ startDate: '05/10/2026', createdAt: '2026-03-04T00:00:00Z' }).from).toBe('2026-03-04');
  });
  it('cierra el período con la baja', () => {
    const p = periodOf({ startDate: '2026-01-01' }, { droppedAt: '2026-08-12T09:00:00Z' });
    expect(p.to).toBe('2026-08-12');
  });
});

describe('classExistsOn — extremos incluidos', () => {
  const p = { from: '2026-08-10', to: '2026-08-20' };
  it('el día de inicio SÍ', () => expect(classExistsOn(p, '2026-08-10')).toBe(true));
  it('el día de la baja SÍ', () => expect(classExistsOn(p, '2026-08-20')).toBe(true));
  it('el día anterior al inicio NO', () => expect(classExistsOn(p, '2026-08-09')).toBe(false));
  it('el día siguiente a la baja NO', () => expect(classExistsOn(p, '2026-08-21')).toBe(false));
  it('sin baja, abierto por la derecha', () => {
    expect(classExistsOn({ from: '2026-08-10', to: null }, '2030-01-01')).toBe(true);
  });
});

describe('periodIndex — no mezcla profesores', () => {
  it('cada profesor tiene su propio período del mismo alumno', () => {
    // Una transferencia: Ana empezó en enero con t1 y en agosto con t2. Usar el
    // período del otro le borraría clases buenas.
    const asgs = [asgn('Ana', '2026-01-15', undefined, T), asgn('Ana', '2026-08-01', undefined, OTRO)];
    expect(periodIndex(asgs, [], T).get('ana')!.from).toBe('2026-01-15');
    expect(periodIndex(asgs, [], OTRO).get('ana')!.from).toBe('2026-08-01');
  });

  it('la baja de un profesor no cierra el período con el otro', () => {
    const asgs = [asgn('Ana', '2026-01-15', undefined, T), asgn('Ana', '2026-01-15', undefined, OTRO)];
    const bajas = [{ teacherId: T, studentName: 'Ana', droppedAt: '2026-06-01T00:00:00Z' }];
    expect(periodIndex(asgs, bajas, T).get('ana')!.to).toBe('2026-06-01');
    expect(periodIndex(asgs, bajas, OTRO).get('ana')!.to).toBeNull();
  });

  it('con dos asignaciones del mismo alumno gana la más antigua', () => {
    const asgs = [asgn('Ana', '2026-05-01'), { ...asgn('Ana', '2026-02-01'), id: 'a2' }];
    expect(periodIndex(asgs, [], T).get('ana')!.from).toBe('2026-02-01');
  });

  it('un alumno sin período NO se esconde', () => {
    // Una celda del grid sin assignment: no sabemos cuándo empezó, y esconder
    // una clase real le cuesta dinero al profesor.
    expect(existsForStudent(new Map(), 'Desconocida', '2020-01-01')).toBe(true);
  });
});

describe('EL CONTRATO: el período no esconde hechos observados', () => {
  const occ = gridOccupancyOfTeacher({ upcomingClasses: [{ studentName: 'Ana', day: 'Martes', time: '10:00' }] });

  it('un ingreso ANTERIOR al inicio sigue apareciendo (leftovers)', () => {
    // Ana empieza el 18/08 pero hay un ingreso del 04/08. La proyección de ese
    // martes queda tapada, pero el HECHO se reemite igual.
    const rows = buildAttendanceRows({
      assignments: [asgn('Ana', '2026-08-18')],
      joinLogs: [log('Ana', '2026-08-04')],
      teacherId: T, fromDate: '2026-08-01', toDate: '2026-08-31',
      todayIso: '2026-08-31', nowMinutes: 1380,
      gridOccupancyByTeacher: { [T]: occ },
      periodsByTeacher: { [T]: periodIndex([asgn('Ana', '2026-08-18')], [], T) },
    });
    const delCuatro = rows.filter(r => r.date === '2026-08-04');
    expect(delCuatro).toHaveLength(1);
    expect(delCuatro[0].joinedAt, 'el ingreso del 4 tiene que seguir viéndose').toBeTruthy();
  });

  it('un ingreso POSTERIOR a la baja sigue apareciendo', () => {
    const asgs = [asgn('Ana', '2026-01-01')];
    const bajas = [{ teacherId: T, studentName: 'Ana', droppedAt: '2026-08-05T00:00:00Z' }];
    const rows = buildAttendanceRows({
      assignments: asgs, joinLogs: [log('Ana', '2026-08-25')],
      teacherId: T, fromDate: '2026-08-01', toDate: '2026-08-31',
      todayIso: '2026-08-31', nowMinutes: 1380,
      gridOccupancyByTeacher: { [T]: occ },
      periodsByTeacher: { [T]: periodIndex(asgs, bajas, T) },
    });
    expect(rows.filter(r => r.date === '2026-08-25' && r.joinedAt)).toHaveLength(1);
  });

  it('sí tapa las PROYECCIONES sin hecho', () => {
    const rows = buildAttendanceRows({
      assignments: [asgn('Ana', '2026-08-18')], joinLogs: [],
      teacherId: T, fromDate: '2026-08-01', toDate: '2026-08-31',
      todayIso: '2026-08-31', nowMinutes: 1380,
      gridOccupancyByTeacher: { [T]: occ },
      periodsByTeacher: { [T]: periodIndex([asgn('Ana', '2026-08-18')], [], T) },
    });
    // Martes de agosto: 4, 11, 18, 25. Solo quedan 18 y 25.
    expect(rows.map(r => r.date).sort()).toEqual(['2026-08-18', '2026-08-25']);
  });

  it('sin el índice de períodos NO filtra nada (compatibilidad)', () => {
    const rows = buildAttendanceRows({
      assignments: [asgn('Ana', '2026-08-18')], joinLogs: [],
      teacherId: T, fromDate: '2026-08-01', toDate: '2026-08-31',
      todayIso: '2026-08-31', nowMinutes: 1380,
      gridOccupancyByTeacher: { [T]: occ },
    });
    expect(rows).toHaveLength(4);
  });
});

describe('un profesor no ve las clases de otro', () => {
  const occ = gridOccupancyOfTeacher({ upcomingClasses: [{ studentName: 'Ana', day: 'Martes', time: '10:00' }] });
  it('las filas se filtran por teacherId', () => {
    const rows = buildAttendanceRows({
      assignments: [asgn('Ana', '2026-01-01', undefined, T), asgn('Bea', '2026-01-01', undefined, OTRO)],
      joinLogs: [log('Ana', '2026-08-04', '10:00', T), log('Bea', '2026-08-04', '10:00', OTRO)],
      teacherId: T, fromDate: '2026-08-01', toDate: '2026-08-31',
      todayIso: '2026-08-31', nowMinutes: 1380,
      gridOccupancyByTeacher: { [T]: occ },
    });
    expect(rows.every(r => r.teacherId === T)).toBe(true);
    expect(rows.some(r => r.studentName === 'Bea')).toBe(false);
  });
});

describe('findStartDateMismatches', () => {
  it('detecta el hecho anterior al inicio declarado', () => {
    const out = findStartDateMismatches({
      assignments: [{ teacherId: T, teacherName: 'Florencia', studentName: 'Samantha', startDate: '2026-08-17' }],
      joinLogs: [], classRecords: [],
      analyses: [{ teacher_id: T, student_name: 'Samantha', class_date: '2026-08-13' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ declared: '2026-08-17', firstFact: '2026-08-13', source: 'transcript', daysBefore: 4 });
  });

  it('no marca nada cuando el primer hecho es posterior', () => {
    const out = findStartDateMismatches({
      assignments: [{ teacherId: T, teacherName: 'P', studentName: 'Ana', startDate: '2026-08-01' }],
      joinLogs: [{ teacherId: T, studentName: 'Ana', scheduledDate: '2026-08-05' }],
      classRecords: [], analyses: [],
    });
    expect(out).toHaveLength(0);
  });

  it('no confunde alumnos de profesores distintos', () => {
    const out = findStartDateMismatches({
      assignments: [{ teacherId: T, teacherName: 'P', studentName: 'Ana', startDate: '2026-08-17' }],
      joinLogs: [{ teacherId: OTRO, studentName: 'Ana', scheduledDate: '2026-08-01' }],
      classRecords: [], analyses: [],
    });
    expect(out).toHaveLength(0);
  });
});
