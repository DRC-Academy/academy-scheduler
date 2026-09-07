// Reprogramar una clase DENTRO DEL MISMO DÍA (mover solo la hora).
//
// El caso real: Sol mueve la clase de Alejandro del 03/09 de las 16:00 a las
// 17:00. El calendario lo pintaba bien (16:00 tachada, 17:00 nueva), pero en
// "Mis clases" salía UNA tarjeta falsa de "16:00 - 18:00", tachada como
// reprogramada, y la clase de las 17:00 desaparecía de la lista.
//
// Dos fallos independientes, y los dos se fijan acá:
//   1. La hora original y su destino se fundían en una sesión de 2 h, porque la
//      regla de contigüidad encadenaba cualquier recuperación pegada.
//   2. La constancia de reprogramación se cruzaba solo por alumno + fecha, así
//      que tachaba cualquier clase de ese alumno ese día.
//
// Lo que NO puede romperse: la sesión mixta de verdad (clase normal + una hora
// que recupera OTRO día) y las reprogramaciones antiguas, que no guardan hora.

import { describe, expect, it } from 'vitest';
import {
  groupContiguousClasses, gridOccupancyOfTeacher, rescheduledTargetFor,
  cancellationFor, fmtDateDMY, type TeacherClass,
} from './teacherClasses';
import type { Assignment, ClassRecord } from '@/types';

const DIA = '2026-09-03';        // jueves
const DAY = 'Jueves';
const OTRO_DIA = '2026-08-25';   // la clase perdida de la sesión mixta legítima
const T = 'teacher_sol';

const asgn = (studentName: string, hours: string[]): Assignment => ({
  id: `a_${studentName}`, teacherId: T, teacherName: 'Sol', studentName,
  studentEmail: `${studentName}@x.com`, studentLevel: 'B1', plan: 'Inglés general',
  weeklyHours: hours.length, slots: hours.map(h => ({ day: DAY, hour: h })),
  startDate: '2025-01-01', status: 'active',
} as unknown as Assignment);

const clase = (studentName: string, hour: string, extra: Partial<TeacherClass> = {}): TeacherClass => ({
  key: `${studentName}_${hour}`, date: DIA, assignment: asgn(studentName, [hour]),
  studentName, hour, level: 'B1', plan: 'Inglés general', ...extra,
});

const teacherWith = (
  recurrentes: Array<{ studentName: string; hour: string }>,
  recuperaciones: Array<{ studentName: string; hour: string; recoveryFor: string }> = [],
) => ({
  upcomingClasses: recurrentes.map(r => ({ studentName: r.studentName, day: DAY, time: r.hour })),
  recoveryCells: recuperaciones.map(r => ({
    studentName: r.studentName, day: DAY, hour: r.hour, date: DIA, recoveryFor: r.recoveryFor,
  })),
});

const record = (p: Partial<ClassRecord>): ClassRecord => ({
  id: `cr_${Math.random()}`, teacherId: T, teacherName: 'Sol', studentName: 'Alejandro',
  classDate: DIA, screenshotUrl: '', createdAt: '2026-09-01T10:00:00Z', ...p,
} as ClassRecord);

// ── CASO (a) · Alejandro: 16:00 movida a las 17:00 del mismo día ─────────────

describe('clase movida a otra hora del mismo día', () => {
  // El grid tras el movimiento: la 16:00 sigue siendo su horario recurrente
  // (queda marcada 'reprogramada', que no cambia la ocupación de fondo) y la
  // 17:00 es una celda de recuperación que repone la clase de ESE MISMO día.
  const occ = () => gridOccupancyOfTeacher(teacherWith(
    [{ studentName: 'Alejandro', hour: '16:00' }],
    [{ studentName: 'Alejandro', hour: '17:00', recoveryFor: DIA }],
  ));

  const clases = () => [
    clase('Alejandro', '16:00'),
    clase('Alejandro', '17:00', { isRecovery: true, recoveryFor: DIA }),
  ];

  it('NO las funde: son dos tarjetas, no un bloque de 16:00 a 18:00', () => {
    const s = groupContiguousClasses(clases(), T, occ());

    expect(s).toHaveLength(2);
    expect(s.map(x => x.durationHours)).toEqual([1, 1]);
    expect(s.some(x => x.mixedRecovery)).toBe(false);
  });

  it('la 17:00 queda como recuperación viva, con su propia tarjeta', () => {
    const destino = groupContiguousClasses(clases(), T, occ())
      .find(x => x.startHourNum === 17)!;

    expect(destino.isRecovery).toBe(true);
    expect(destino.recoveryFor).toBe(DIA);
    expect(destino.durationHours).toBe(1);
  });

  it('la constancia tacha la 16:00 y NO la 17:00', () => {
    const records = [record({ classTime: '16:00', rescheduledTo: DIA, classType: 'reprogramada' })];

    expect(rescheduledTargetFor(records, T, 'Alejandro', DIA, { start: 16, end: 17 })).toBe(DIA);
    expect(rescheduledTargetFor(records, T, 'Alejandro', DIA, { start: 17, end: 18 })).toBeNull();
  });
});

// ── Una sesión de 2 h movida ENTERA sigue siendo de 2 h ──────────────────────

it('dos horas movidas el mismo día siguen siendo UNA sesión de 2 h', () => {
  const occ = gridOccupancyOfTeacher(teacherWith([], [
    { studentName: 'Alejandro', hour: '18:00', recoveryFor: DIA },
    { studentName: 'Alejandro', hour: '19:00', recoveryFor: DIA },
  ]));
  const s = groupContiguousClasses([
    clase('Alejandro', '18:00', { isRecovery: true, recoveryFor: DIA }),
    clase('Alejandro', '19:00', { isRecovery: true, recoveryFor: DIA }),
  ], T, occ);

  expect(s).toHaveLength(1);
  expect(s[0].durationHours).toBe(2);
  expect(s[0].billingUnits).toBe(2);
});

// ── CASO (b) · Elena Pozo: la sesión mixta LEGÍTIMA no se toca ───────────────

describe('sesión mixta de verdad (recupera OTRO día)', () => {
  const occ = () => gridOccupancyOfTeacher(teacherWith(
    [{ studentName: 'Elena Pozo', hour: '14:00' }],
    [{ studentName: 'Elena Pozo', hour: '15:00', recoveryFor: OTRO_DIA }],
  ));

  it('sigue siendo UNA tarjeta de 2 h con "Normal + recuperación"', () => {
    const s = groupContiguousClasses([
      clase('Elena Pozo', '14:00'),
      clase('Elena Pozo', '15:00', { isRecovery: true, recoveryFor: OTRO_DIA }),
    ], T, occ());

    expect(s).toHaveLength(1);
    expect(s[0].durationHours).toBe(2);
    expect(s[0].billingUnits).toBe(2);
    expect(s[0].recoveryUnits).toBe(1);
    expect(s[0].mixedRecovery).toBe(true);
    expect(s[0].recoveryDates).toEqual([OTRO_DIA]);
  });

  it('y no la tacha ninguna constancia: no hay reprogramación', () => {
    expect(rescheduledTargetFor([], T, 'Elena Pozo', DIA, { start: 14, end: 16 })).toBeNull();
  });
});

// ── CASO (d) · las reprogramaciones antiguas NO se destachan ─────────────────

describe('compatibilidad hacia atrás', () => {
  it('una constancia SIN hora sigue tachando, como siempre', () => {
    const vieja = [record({ rescheduledTo: '2026-09-10', classType: 'reprogramada' })];

    expect(rescheduledTargetFor(vieja, T, 'Alejandro', DIA, { start: 16, end: 17 })).toBe('2026-09-10');
    expect(rescheduledTargetFor(vieja, T, 'Alejandro', DIA, { start: 19, end: 20 })).toBe('2026-09-10');
  });

  it('una constancia con hora vacía cuenta igual que sin hora', () => {
    const vieja = [record({ classTime: '', rescheduledTo: '2026-09-10', classType: 'reprogramada' })];
    expect(rescheduledTargetFor(vieja, T, 'Alejandro', DIA, { start: 16, end: 17 })).toBe('2026-09-10');
  });

  it('sin tramo se compara solo por fecha (los llamadores que no lo pasan)', () => {
    const r = [record({ classTime: '16:00', rescheduledTo: DIA, classType: 'reprogramada' })];
    expect(rescheduledTargetFor(r, T, 'Alejandro', DIA)).toBe(DIA);
  });
});

// ── La cancelación tenía el mismo fallo ──────────────────────────────────────

describe('cancellationFor', () => {
  const cancelada = [record({ classTime: '16:00', classType: 'falta_sin_aviso' })];

  it('marca la clase cancelada y no la otra del mismo día', () => {
    expect(cancellationFor(cancelada, T, 'Alejandro', DIA, { start: 16, end: 17 })).toBe('falta_sin_aviso');
    expect(cancellationFor(cancelada, T, 'Alejandro', DIA, { start: 18, end: 19 })).toBeNull();
  });

  it('una cancelación de 2 h cubre sus dos horas', () => {
    expect(cancellationFor(cancelada, T, 'Alejandro', DIA, { start: 16, end: 18 })).toBe('falta_sin_aviso');
  });

  it('sin hora en la constancia, sigue cubriendo el día entero', () => {
    const vieja = [record({ classType: 'falta_sin_aviso' })];
    expect(cancellationFor(vieja, T, 'Alejandro', DIA, { start: 18, end: 19 })).toBe('falta_sin_aviso');
  });
});

// ── CASO (c) · las fechas en pantalla son las de la base ─────────────────────

describe('fmtDateDMY', () => {
  it('una fecha de calendario no se corre un día (el fallo de Argentina)', () => {
    expect(fmtDateDMY('2026-09-03')).toBe('03/09/2026');
    expect(fmtDateDMY('2026-01-01')).toBe('01/01/2026');
    expect(fmtDateDMY('2026-12-31')).toBe('31/12/2026');
  });

  it('acepta lo vacío sin romperse', () => {
    expect(fmtDateDMY(null)).toBe('');
    expect(fmtDateDMY(undefined)).toBe('');
    expect(fmtDateDMY('')).toBe('');
    expect(fmtDateDMY('no es fecha')).toBe('');
  });

  it('una ISO completa se sigue formateando como antes', () => {
    const d = new Date('2026-09-03T15:30:00Z');
    const esperado = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    expect(fmtDateDMY('2026-09-03T15:30:00Z')).toBe(esperado);
  });
});
