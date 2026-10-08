import { describe, it, expect } from 'vitest';
import { buildAttendanceRows, markMovedClasses } from '@/lib/attendance';
import { buildMissingJoinClasses } from '@/lib/reviewRequests';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { slotsOnDate, changesOfStudent } from '@/lib/slotHistory';
import type { Assignment, ClassJoinLog, ClassRecord, SlotChange } from '@/types';

// Lucía Pérez con Berta (tB). Hoy: miércoles 21/10/2026, 12:00 en España.
const HOY = '2026-10-21';
const AHORA_MIN = 12 * 60;

const asg = (slots: Array<[string, string]>): Assignment => ({
  id: 'asg1', teacherId: 'tB', teacherName: 'Berta', studentName: 'Lucía Pérez', meetLink: 'https://meet/l',
  slots: slots.map(([day, hour]) => ({ day, hour })),
} as unknown as Assignment);

const log = (date: string, time: string): ClassJoinLog => ({
  id: `log_${date}_${time}`, teacherId: 'tB', teacherName: 'Berta', studentName: 'Lucía Pérez',
  scheduledDate: date, scheduledTime: time, clickedAt: `${date}T13:00:00Z`, punctuality: 'on_time',
} as ClassJoinLog);

const reprogramada = (from: string, to: string, time = '15:00'): ClassRecord => ({
  id: `cr_${from}`, teacherId: 'tB', teacherName: 'Berta', studentName: 'Lucía Pérez',
  classDate: from, classTime: time, classType: 'reprogramada', originalDate: from, rescheduledTo: to,
  screenshotUrl: '', comment: '', createdAt: '2026-10-12T08:00:00Z',
} as ClassRecord);

const occ = (slotChanges?: SlotChange[]) => gridOccupancyOfTeacher({
  upcomingClasses: [
    { studentName: 'Lucía Pérez', day: 'Martes', time: '15:00' },
    { studentName: 'Lucía Pérez', day: 'Martes', time: '16:00' },
  ],
  slotChanges,
});

const etiquetas = (rows: ReturnType<typeof buildAttendanceRows>) =>
  rows.map(r => `${r.date} ${r.hoursLabel} ${r.status}${r.rescheduledTo ? `→${r.rescheduledTo}` : ''}${r.rescheduledFrom ? `←${r.rescheduledFrom}` : ''}`).sort();

describe('PUNCTUAL: clase movida (profesor o alumno)', () => {
  it('la fecha original sale "Reprogramada al …" y el ingreso de la nueva queda asociado', () => {
    // Martes 20/10 15-17 movida al lunes 19/10 10-12 (ya pasó, con ingreso).
    const rows = buildAttendanceRows({
      assignments: [asg([['Martes', '15:00'], ['Martes', '16:00']])],
      joinLogs: [log('2026-10-13', '15:00'), log('2026-10-19', '10:00'), log('2026-10-19', '11:00')],
      fromDate: '2026-10-12', toDate: HOY, todayIso: HOY, nowMinutes: AHORA_MIN,
      gridOccupancyByTeacher: { tB: occ() },
    });
    // Sin las constancias: la del 20/10 es "No ingresó" (lo que pasaba antes).
    expect(etiquetas(rows)).toContain('2026-10-20 15:00 - 17:00 missed');
    markMovedClasses(rows, [reprogramada('2026-10-20', '2026-10-19')]);
    expect(etiquetas(rows)).toEqual([
      '2026-10-13 15:00 - 17:00 on_time',
      '2026-10-19 10:00 - 12:00 on_time←2026-10-20',
      '2026-10-20 15:00 - 17:00 rescheduled→2026-10-19',
    ]);
  });

  it('una próxima clase movida tampoco sale como pendiente', () => {
    const rows = buildAttendanceRows({
      assignments: [asg([['Martes', '15:00'], ['Martes', '16:00']])],
      joinLogs: [], fromDate: '2026-10-26', toDate: '2026-11-01', todayIso: HOY, nowMinutes: AHORA_MIN,
      includeFuture: true, gridOccupancyByTeacher: { tB: occ() },
    });
    markMovedClasses(rows, [reprogramada('2026-10-27', '2026-10-29')]);
    expect(etiquetas(rows)).toEqual(['2026-10-27 15:00 - 17:00 rescheduled→2026-10-29']);
  });

  it('si en la fecha original hubo ingreso, manda el ingreso; una reprogramada sin destino no cambia nada', () => {
    const rows = buildAttendanceRows({
      assignments: [asg([['Martes', '15:00'], ['Martes', '16:00']])],
      joinLogs: [log('2026-10-20', '15:00')],
      fromDate: '2026-10-12', toDate: HOY, todayIso: HOY, nowMinutes: AHORA_MIN, gridOccupancyByTeacher: { tB: occ() },
    });
    markMovedClasses(rows, [reprogramada('2026-10-20', '2026-10-22'), { ...reprogramada('2026-10-13', ''), rescheduledTo: undefined }]);
    expect(etiquetas(rows)).toEqual(['2026-10-13 15:00 - 17:00 missed', '2026-10-20 15:00 - 17:00 on_time']);
  });

  it('solo la sesión de esa hora: otra clase del mismo día sigue igual', () => {
    const rows = buildAttendanceRows({
      assignments: [asg([['Martes', '10:00'], ['Martes', '15:00']])],
      joinLogs: [], fromDate: '2026-10-20', toDate: '2026-10-20', todayIso: HOY, nowMinutes: AHORA_MIN,
    });
    markMovedClasses(rows, [reprogramada('2026-10-20', '2026-10-22', '15:00')]);
    expect(etiquetas(rows)).toEqual(['2026-10-20 10:00 missed', '2026-10-20 15:00 rescheduled→2026-10-22']);
  });
});

describe('FIJO: el horario nuevo no se proyecta hacia atrás', () => {
  // El lunes 12/10 a las 10:00 pasó de los martes 15-17 a los jueves 10-12.
  const cambio: SlotChange[] = [
    { studentName: 'Lucía Pérez', day: 'Martes', hour: '15:00', action: 'quitado', createdAt: '2026-10-12T08:00:00.123456+00:00' },
    { studentName: 'Lucía Pérez', day: 'Martes', hour: '16:00', action: 'quitado', createdAt: '2026-10-12T08:00:00.123456+00:00' },
    { studentName: 'Lucía Pérez', day: 'Jueves', hour: '10:00', action: 'agregado', createdAt: '2026-10-12T08:00:00.123456+00:00' },
    { studentName: 'Lucía Pérez', day: 'Jueves', hour: '11:00', action: 'agregado', createdAt: '2026-10-12T08:00:00.123456+00:00' },
  ];
  const nuevo = asg([['Jueves', '10:00'], ['Jueves', '11:00']]);
  const occNuevo = gridOccupancyOfTeacher({
    upcomingClasses: [{ studentName: 'Lucía Pérez', day: 'Jueves', time: '10:00' }, { studentName: 'Lucía Pérez', day: 'Jueves', time: '11:00' }],
    slotChanges: cambio,
  });

  it('slotsOnDate: antes del cambio, el horario viejo; después, null (el de hoy)', () => {
    const c = changesOfStudent(cambio, ' lucía pérez ');
    expect(slotsOnDate(nuevo.slots, c, '2026-10-06')).toEqual([{ day: 'Martes', hour: '15:00' }, { day: 'Martes', hour: '16:00' }]);
    expect(slotsOnDate(nuevo.slots, c, '2026-10-13')).toBeNull();
    expect(changesOfStudent(cambio, 'Otro Alumno')).toEqual([]);
  });

  it('Registro: los jueves anteriores no son "No ingresó" y los martes dados son su clase, no filas sueltas', () => {
    const rows = buildAttendanceRows({
      assignments: [nuevo],
      joinLogs: [log('2026-10-06', '15:00'), log('2026-10-15', '10:00')],
      fromDate: '2026-10-01', toDate: '2026-10-16', todayIso: HOY, nowMinutes: AHORA_MIN,
      gridOccupancyByTeacher: { tB: occNuevo },
    });
    expect(etiquetas(rows)).toEqual([
      '2026-10-06 15:00 - 17:00 on_time',   // martes viejo, con su ingreso: una sesión de 2 h
      '2026-10-15 10:00 - 12:00 on_time',   // primer jueves nuevo
    ]);
    // Sin el historial (lo de antes): el jueves 01/10 y el 08/10 salían "No ingresó".
    const sin = buildAttendanceRows({
      assignments: [nuevo], joinLogs: [log('2026-10-06', '15:00'), log('2026-10-15', '10:00')],
      fromDate: '2026-10-01', toDate: '2026-10-16', todayIso: HOY, nowMinutes: AHORA_MIN,
      gridOccupancyByTeacher: { tB: { ...occNuevo, slotChanges: undefined } },
    });
    expect(etiquetas(sin)).toContain('2026-10-01 10:00 - 12:00 missed');
    expect(etiquetas(sin)).toContain('2026-10-08 10:00 - 12:00 missed');
  });

  it('un martes viejo SIN ingreso sí es "No ingresó" (tocaba clase ese día)', () => {
    const rows = buildAttendanceRows({
      assignments: [nuevo], joinLogs: [],
      fromDate: '2026-10-06', toDate: '2026-10-06', todayIso: HOY, nowMinutes: AHORA_MIN,
      gridOccupancyByTeacher: { tB: occNuevo },
    });
    expect(etiquetas(rows)).toEqual(['2026-10-06 15:00 - 17:00 missed']);
  });

  it('clases sin ingreso (revisiones y embudo): tampoco aparecen los jueves anteriores', () => {
    const lista = buildMissingJoinClasses({
      assignments: [nuevo], joinLogs: [log('2026-10-06', '15:00')], classRecords: [], requests: [],
      teacherId: 'tB', fromDate: '2026-10-01', toDate: '2026-10-16', todayIso: HOY, nowMinutes: AHORA_MIN,
      gridOccupancy: occNuevo, onlyWithSignal: false,
    });
    // Solo el primer jueves con el horario nuevo (15/10), que no tiene ingreso; ni el 01/10 ni el 08/10.
    expect(lista.map(c => c.date)).toEqual(['2026-10-15']);
  });
});
