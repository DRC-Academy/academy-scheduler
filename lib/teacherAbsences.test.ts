import { describe, expect, it } from 'vitest';
import {
  findDueAbsences, findLateJoins, absenceIdOf, normalizePhone, phoneLooksInternational, firstNameOf,
  buildAbsencePayload, slackTextOf, windowDates, inAbsenceWindow, sampleAbsencePayload,
  pickAbsenceOptions, joinedBeforeHalf, isAbsenceRecoveryTeacher, shouldEmailAbsenceRecovery, MAX_ABSENCE_OPTIONS,
  ABSENCE_RECOVERY_STUDENT_EMAIL,
  type TeacherScheduleInput, type JoinLogLite, type ClassRecordLite,
} from '@/lib/teacherAbsences';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { periodIndex } from '@/lib/studentPeriod';
import type { Assignment, Grid } from '@/types';

/** Instante de una hora de pared española (CEST, +2, en octubre hasta el 25). */
const madrid = (iso: string, hh: number, mm = 0) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), hh - 2, mm);

const MARTES = '2026-10-20';

function asg(name: string, slots: Array<{ day: string; hour: string }>, extra: Partial<Assignment> = {}): Assignment {
  return {
    id: `a_${name}`, teacherId: 't9', teacherName: 'Laura', teacherEmail: '', studentId: `s_${name}`,
    studentName: name, studentEmail: `${name.split(' ')[0].toLowerCase()}@x.com`, studentLevel: 'B1',
    slots, objetivo: '', plan: '', weeklyHours: slots.length, availability: '', notes: '',
    startDate: '2026-09-01', createdAt: '2026-09-01T10:00:00Z', status: 'active', ...extra,
  };
}

/** Un profesor armado como lo arma lib/teacherAbsenceStore (slots del grid). */
function profe(grid: Grid, assignments: Assignment[]): TeacherScheduleInput {
  const upcomingClasses = Object.entries(grid)
    .filter(([, c]) => c.state === 'ocupado' && c.student)
    .map(([k, c]) => { const i = k.lastIndexOf('_'); return { id: k, studentName: c.student!, day: k.slice(0, i), time: k.slice(i + 1), duration: 1, type: 'Clase' }; });
  return {
    teacherId: 't9', teacherName: 'Laura', assignments, grid,
    occupancy: gridOccupancyOfTeacher({ upcomingClasses }),
    periods: periodIndex(assignments, [], 't9'),
  };
}

const ANA_GRID: Grid = {
  'Martes_18:00': { state: 'ocupado', student: 'Ana Pérez' },
  'Martes_19:00': { state: 'ocupado', student: 'Ana Pérez' },
};
const ANA = asg('Ana Pérez', [{ day: 'Martes', hour: '18:00' }, { day: 'Martes', hour: '19:00' }]);

const run = (o: { now: number; grid?: Grid; assignments?: Assignment[]; logs?: JoinLogLite[]; records?: ClassRecordLite[]; known?: string[] }) =>
  findDueAbsences({
    teachers: [profe(o.grid ?? ANA_GRID, o.assignments ?? [ANA])],
    records: o.records ?? [], joinLogs: o.logs ?? [], nowMs: o.now, known: new Set(o.known ?? []),
  });

const log = (time: string, name = 'Ana Pérez', date = MARTES): JoinLogLite =>
  ({ teacherId: 't9', studentName: name, scheduledDate: date, scheduledTime: time, clickedAt: new Date(madrid(date, 18, 20)).toISOString() });
const rec = (classType: ClassRecordLite['classType'], extra: Partial<ClassRecordLite> = {}): ClassRecordLite =>
  ({ id: 'cr1', teacherId: 't9', studentName: 'Ana Pérez', classDate: MARTES, classTime: '18:00', classType, ...extra });

describe('ventana de 30 a 90 minutos', () => {
  it('a los 30 minutos la sesión de 2 h sale como UNA sola clase', () => {
    const { due, inWindow } = run({ now: madrid(MARTES, 18, 30) });
    expect(inWindow).toBe(1);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ date: MARTES, hour: '18:00', durationHours: 2, studentName: 'Ana Pérez', teacherName: 'Laura' });
    expect(due[0].id).toBe(absenceIdOf('t9', 'Ana Pérez', MARTES, 18));
  });
  it('antes de los 30 minutos y pasados los 90, nada', () => {
    expect(run({ now: madrid(MARTES, 18, 29) }).due).toHaveLength(0);
    expect(run({ now: madrid(MARTES, 19, 30) }).due).toHaveLength(1);
    expect(run({ now: madrid(MARTES, 19, 31) }).due).toHaveLength(0);
  });
  it('otro día de la semana no tiene esa clase', () => {
    expect(run({ now: madrid('2026-10-21', 18, 35) }).due).toHaveLength(0);
  });
  it('inAbsenceWindow: bordes incluidos', () => {
    const start = madrid(MARTES, 18);
    expect(inAbsenceWindow(start, start + 30 * 60_000)).toBe(true);
    expect(inAbsenceWindow(start, start + 90 * 60_000)).toBe(true);
    expect(inAbsenceWindow(NaN, start)).toBe(false);
  });
});

describe('lo que apaga el aviso', () => {
  const now = madrid(MARTES, 18, 35);
  it('el ingreso, aunque figure en la segunda hora de la sesión', () => {
    expect(run({ now, logs: [log('18:00')] }).due).toHaveLength(0);
    expect(run({ now, logs: [log('19:00')] }).due).toHaveLength(0);
  });
  it('un ingreso de OTRO alumno u otro día no cuenta', () => {
    expect(run({ now, logs: [log('18:00', 'Otra Persona')] }).due).toHaveLength(1);
    expect(run({ now, logs: [log('18:00', 'Ana Pérez', '2026-10-19')] }).due).toHaveLength(1);
  });
  it('cancelada por el profesor, cancelada con preaviso, reprogramada o falta del alumno', () => {
    expect(run({ now, records: [rec('cancelada_por_profesor')] }).due).toHaveLength(0);
    expect(run({ now, records: [rec('cancelada_con_preaviso')] }).due).toHaveLength(0);
    expect(run({ now, records: [rec('falta_sin_aviso')] }).due).toHaveLength(0);
    expect(run({ now, records: [rec('cancelacion_hora')] }).due).toHaveLength(0);
    expect(run({ now, records: [rec('falta_con_aviso')] }).due).toHaveLength(0);
    expect(run({ now, records: [rec('reprogramada', { rescheduledTo: '2026-10-22' })] }).due).toHaveLength(0);
  });
  it('una constancia de OTRA hora del mismo día no la apaga', () => {
    expect(run({ now, records: [rec('cancelada_por_profesor', { classTime: '12:00' })] }).due).toHaveLength(1);
  });
  it('una recuperación de otra clase (record normal) no la apaga', () => {
    expect(run({ now, records: [rec('recuperacion', { classTime: '18:00' })] }).due).toHaveLength(1);
  });
  it('fuera del período del alumno (empieza después) no hay clase fantasma', () => {
    const tarde = asg('Ana Pérez', ANA.slots, { startDate: '2026-11-01' });
    expect(run({ now, assignments: [tarde] }).due).toHaveLength(0);
  });
  it('ya anotada: no se vuelve a avisar', () => {
    expect(run({ now, known: [absenceIdOf('t9', 'Ana Pérez', MARTES, 18)] }).due).toHaveLength(0);
  });
});

describe('recuperaciones confirmadas', () => {
  it('la celda de recuperación de esta semana cuenta como clase', () => {
    const grid: Grid = {
      ...ANA_GRID,
      'Miércoles_10:00': { state: 'bloqueado', student: 'Ana Pérez', weekDate: '2026-10-19', baseState: 'libre', recoveryFor: '2026-10-13' },
    };
    const { due } = run({ now: madrid('2026-10-21', 10, 31), grid });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ date: '2026-10-21', hour: '10:00', isRecovery: true });
  });
  it('la de otra semana no', () => {
    const grid: Grid = {
      ...ANA_GRID,
      'Miércoles_10:00': { state: 'bloqueado', student: 'Ana Pérez', weekDate: '2026-10-12', baseState: 'libre' },
    };
    expect(run({ now: madrid('2026-10-21', 10, 31), grid }).due).toHaveLength(0);
  });
});

describe('llegó tarde', () => {
  it('la posible ausencia abierta se cierra con el ingreso posterior', () => {
    const open = [{ id: 'aus1', teacherId: 't9', studentName: 'Ana Pérez', classDate: MARTES, classHour: '18:00', durationHours: 2 }];
    expect(findLateJoins(open, [])).toEqual([]);
    expect(findLateJoins(open, [log('19:00')])).toEqual([{ id: 'aus1', clickedAt: log('19:00').clickedAt }]);
    expect(findLateJoins(open, [log('20:00')])).toEqual([]);
  });
});

describe('cruce de medianoche', () => {
  it('pasada la medianoche se mira también el día anterior', () => {
    // 00:10 → la ventana (22:40–23:40) es entera del día anterior.
    expect(windowDates(madrid('2026-10-21', 0, 10))).toEqual(['2026-10-20']);
    // 00:50 → la ventana (23:20–00:20) cruza la medianoche.
    expect(windowDates(madrid('2026-10-21', 0, 50))).toEqual(['2026-10-20', '2026-10-21']);
    expect(windowDates(madrid('2026-10-21', 12, 0))).toEqual(['2026-10-21']);
  });
});

describe('id fijo', () => {
  it('estable, sin tildes ni espacios', () => {
    expect(absenceIdOf('t9', 'Ana Pérez', MARTES, '18:00')).toBe('aus_t9_2026-10-20_18_ana-perez');
    expect(absenceIdOf('t9', '  ana pérez ', MARTES, 18)).toBe('aus_t9_2026-10-20_18_ana-perez');
  });
});

describe('teléfono', () => {
  it('formato internacional', () => {
    expect(normalizePhone('600 111 222')).toBe('+34600111222');
    expect(normalizePhone('+34 600-111-222')).toBe('+34600111222');
    expect(normalizePhone('0034600111222')).toBe('+34600111222');
    expect(normalizePhone('34600111222')).toBe('+34600111222');
    expect(normalizePhone('+54 9 11 5555 6666')).toBe('+5491155556666');
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone('12345')).toBe('12345');
    expect(phoneLooksInternational('+34600111222')).toBe(true);
    expect(phoneLooksInternational('12345')).toBe(false);
  });
});

describe('lo que recibe Zapier', () => {
  it('todos los campos, fecha 15/10/2026 y hora 18:00', () => {
    const p = buildAbsencePayload({
      id: 'aus_x', date: '2026-10-15', hour: '18:00', teacherName: 'Laura',
      studentName: 'Ana Pérez', studentEmail: 'ana@x.com', phone: '+34600111222',
    });
    expect(p).toEqual({
      clase_id: 'aus_x', fecha: '15/10/2026', hora: '18:00', profe_nombre: 'Laura',
      alumno_nombre: 'Ana Pérez', alumno_nombre_pila: 'Ana', alumno_email: 'ana@x.com',
      alumno_telefono: '+34600111222',
      texto_slack: '⚠️ Posible falta: Laura no se ha conectado a la clase de las 18:00 con Ana Pérez. Teléfono del alumno: +34600111222',
      enlace_recuperacion: '',
    });
  });
  it('con recuperación: el enlace viaja en enlace_recuperacion', () => {
    const p = buildAbsencePayload({
      id: 'a', date: '2026-10-15', hour: '18:00', teacherName: 'Laura', studentName: 'Ana', studentEmail: '', phone: '',
      recoveryLink: 'https://lms.test/mis-clases?recuperacion=rec_1',
    });
    expect(p.enlace_recuperacion).toBe('https://lms.test/mis-clases?recuperacion=rec_1');
  });
  it('sin teléfono: campo vacío y lo dice el texto', () => {
    const p = buildAbsencePayload({ id: 'a', date: '2026-10-15', hour: '18:00', teacherName: 'Laura', studentName: 'Ana', studentEmail: '', phone: '' });
    expect(p.alumno_telefono).toBe('');
    expect(p.texto_slack).toContain('no tenemos su teléfono');
  });
  it('formato dudoso: se avisa en el texto', () => {
    expect(slackTextOf({ teacherName: 'L', hour: '18:00', studentName: 'A', phone: '12345' })).toContain('12345 (revisar el formato)');
  });
  it('el ejemplo de prueba va marcado', () => {
    const p = sampleAbsencePayload(madrid(MARTES, 18, 3));
    expect(p.alumno_nombre).toContain('[PRUEBA]');
    expect(p.alumno_nombre_pila).toBe('Alumna');
    expect(p.hora).toBe('18:00');
  });
  it('nombre de pila', () => {
    expect(firstNameOf('  María José Cabrera ')).toBe('María');
  });
});

describe('recuperación automática por ausencia', () => {
  it('beta solo para t1', () => {
    expect(isAbsenceRecoveryTeacher('t1')).toBe(true);
    expect(isAbsenceRecoveryTeacher('t2')).toBe(false);
    expect(isAbsenceRecoveryTeacher(null)).toBe(false);
  });

  it('una opción por día, la hora más cercana a la original, como mucho 4', () => {
    const days = [
      { date: '2026-10-21', hours: ['09:00', '17:00', '20:00'] },
      { date: '2026-10-22', hours: [] },
      { date: '2026-10-23', hours: ['19:00', '17:00'] },   // 17 y 19 a la misma distancia de 18: la más temprana
      { date: '2026-10-24', hours: ['10:00'] },
      { date: '2026-10-26', hours: ['18:00'] },
      { date: '2026-10-27', hours: ['18:00'] },
    ];
    expect(pickAbsenceOptions(days, '18:00', 1)).toEqual([
      { date: '2026-10-21', hour: '17:00', hours: 1 },
      { date: '2026-10-23', hour: '17:00', hours: 1 },
      { date: '2026-10-24', hour: '10:00', hours: 1 },
      { date: '2026-10-26', hour: '18:00', hours: 1 },
    ]);
    expect(MAX_ABSENCE_OPTIONS).toBe(4);
  });

  it('sin horas libres: ninguna opción; las de 2 h llevan hours 2', () => {
    expect(pickAbsenceOptions([{ date: '2026-10-21', hours: [] }], '18:00', 1)).toEqual([]);
    expect(pickAbsenceOptions([{ date: '2026-10-21', hours: ['9'] }], '18:00', 2)).toEqual([{ date: '2026-10-21', hour: '09:00', hours: 2 }]);
  });

  it('llegó tarde: antes o después de la mitad (hora de España)', () => {
    const clase = { classDate: MARTES, classHour: '18:00', durationHours: 1 };
    expect(joinedBeforeHalf(clase, new Date(madrid(MARTES, 18, 29)).toISOString())).toBe(true);
    expect(joinedBeforeHalf(clase, new Date(madrid(MARTES, 18, 30)).toISOString())).toBe(false);
    expect(joinedBeforeHalf(clase, new Date(madrid(MARTES, 18, 40)).toISOString())).toBe(false);
    // Sesión de 2 h: la mitad es a la hora.
    const larga = { ...clase, durationHours: 2 };
    expect(joinedBeforeHalf(larga, new Date(madrid(MARTES, 18, 45)).toISOString())).toBe(true);
    expect(joinedBeforeHalf(larga, new Date(madrid(MARTES, 19, 5)).toISOString())).toBe(false);
    // Sin hora legible: cuenta como antes (hubo ingreso).
    expect(joinedBeforeHalf(clase, '')).toBe(true);
  });

  it('email al alumno: siempre por ahora; con "sin_telefono" solo a quien no lo tiene', () => {
    if (ABSENCE_RECOVERY_STUDENT_EMAIL === 'siempre') {
      expect(shouldEmailAbsenceRecovery('+34600111222')).toBe(true);
    } else {
      expect(shouldEmailAbsenceRecovery('+34600111222')).toBe(false);
    }
    expect(shouldEmailAbsenceRecovery('')).toBe(true);
  });
});
