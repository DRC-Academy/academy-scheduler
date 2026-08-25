// Sesión de 2h "clase normal + clase de recuperación".
//
// El profesor da dos horas seguidas al mismo alumno: la primera es su clase
// normal, la segunda recupera una clase que el alumno había perdido. Es UNA
// sesión: un acceso, UN transcript, se paga doble — y del lado del alumno la hora
// de recuperación salda la clase perdida en vez de gastar una del cupo del mes.
//
// Estos tests fijan sobre todo lo que NO debe fundirse: alumnos distintos, horas
// no contiguas y días distintos. Es la parte peligrosa del cambio, porque fundir
// de más significa pagar de más.

import { describe, expect, it } from 'vitest';
import {
  groupContiguousClasses, gridOccupancyOfTeacher, recoveryPartOfSession,
  type TeacherClass,
} from './teacherClasses';
import { calculateTeacherFinance } from './finance';
import type { Assignment, ClassJoinLog, ClassRecord, FinanceRate, Student } from '@/types';

// 2026-07-15 es MIÉRCOLES. Todas las clases de abajo caen ese día.
const DATE = '2026-07-15';
const DAY = 'Miércoles';
const LOST = '2026-07-08';   // la clase que el alumno perdió y ahora recupera
const T = 'teacher_1';

const asgn = (studentName: string, hours: string[]): Assignment => ({
  id: `a_${studentName}`, teacherId: T, teacherName: 'Profe', studentName,
  studentEmail: `${studentName}@x.com`, studentLevel: 'B1', plan: 'Inglés general',
  weeklyHours: hours.length, slots: hours.map(h => ({ day: DAY, hour: h })),
  startDate: '2025-01-01', status: 'active',
} as unknown as Assignment);

const clase = (studentName: string, hour: string, extra: Partial<TeacherClass> = {}): TeacherClass => ({
  key: `${studentName}_${hour}`, date: DATE, assignment: asgn(studentName, [hour]),
  studentName, hour, level: 'B1', plan: 'Inglés general', ...extra,
});

/** Profesor con su calendario: horas recurrentes + celdas de recuperación. */
const teacherWith = (
  recurrentes: Array<{ studentName: string; hour: string }>,
  recuperaciones: Array<{ studentName: string; hour: string; date?: string; recoveryFor?: string }> = [],
) => ({
  upcomingClasses: recurrentes.map(r => ({ studentName: r.studentName, day: DAY, time: r.hour })),
  recoveryCells: recuperaciones.map(r => ({
    studentName: r.studentName, day: DAY, hour: r.hour,
    date: r.date ?? DATE, recoveryFor: r.recoveryFor ?? LOST,
  })),
});

// ── Agrupación: qué se funde y qué NO ────────────────────────────────────────

describe('groupContiguousClasses — normal + recuperación', () => {
  const occ = () => gridOccupancyOfTeacher(teacherWith(
    [{ studentName: 'Ana', hour: '17:00' }],
    [{ studentName: 'Ana', hour: '18:00' }],
  ));

  it('funde la clase normal con la recuperación pegada del MISMO alumno', () => {
    const s = groupContiguousClasses([
      clase('Ana', '17:00'),
      clase('Ana', '18:00', { isRecovery: true, recoveryFor: LOST }),
    ], T, occ());

    expect(s).toHaveLength(1);
    expect(s[0].durationHours).toBe(2);
    expect(s[0].billingUnits).toBe(2);      // paga doble
    expect(s[0].recoveryUnits).toBe(1);     // solo una de las dos horas recupera
    expect(s[0].mixedRecovery).toBe(true);
  });

  it('NO pierde el vínculo con la clase que se recupera', () => {
    const s = groupContiguousClasses([
      clase('Ana', '17:00'),
      clase('Ana', '18:00', { isRecovery: true, recoveryFor: LOST }),
    ], T, occ());

    expect(s[0].recoveryDates).toEqual([LOST]);
    expect(s[0].recoveryFor).toBe(LOST);
  });

  it('la sesión mixta NO se etiqueta como "Recuperación" a secas', () => {
    // Ni siquiera cuando la hora de recuperación va PRIMERA: `isRecovery`
    // describe la sesión entera, no su primera hora.
    const s = groupContiguousClasses([
      clase('Ana', '17:00', { isRecovery: true, recoveryFor: LOST }),
      clase('Ana', '18:00'),
    ], T, gridOccupancyOfTeacher(teacherWith(
      [{ studentName: 'Ana', hour: '18:00' }],
      [{ studentName: 'Ana', hour: '17:00' }],
    )));

    expect(s).toHaveLength(1);
    expect(s[0].isRecovery).toBe(false);
    expect(s[0].mixedRecovery).toBe(true);
    expect(s[0].recoveryDates).toEqual([LOST]);
  });

  it('una recuperación SOLA sigue siendo una sesión de 1h de pura recuperación', () => {
    const s = groupContiguousClasses(
      [clase('Ana', '18:00', { isRecovery: true, recoveryFor: LOST })],
      T,
      gridOccupancyOfTeacher(teacherWith([], [{ studentName: 'Ana', hour: '18:00' }])),
    );
    expect(s).toHaveLength(1);
    expect(s[0].billingUnits).toBe(1);
    expect(s[0].recoveryUnits).toBe(1);
    expect(s[0].isRecovery).toBe(true);
    expect(s[0].mixedRecovery).toBe(false);
  });
});

describe('groupContiguousClasses — lo que NO se debe fundir', () => {
  it('alumnos DISTINTOS en horas contiguas nunca son la misma sesión', () => {
    const occ = gridOccupancyOfTeacher(teacherWith(
      [{ studentName: 'Ana', hour: '17:00' }],
      [{ studentName: 'Beto', hour: '18:00' }],
    ));
    const s = groupContiguousClasses([
      clase('Ana', '17:00'),
      clase('Beto', '18:00', { isRecovery: true, recoveryFor: LOST }),
    ], T, occ);

    expect(s).toHaveLength(2);
    expect(s.every(x => x.durationHours === 1)).toBe(true);
  });

  it('el mismo alumno con horas NO contiguas siguen siendo dos clases', () => {
    const occ = gridOccupancyOfTeacher(teacherWith(
      [{ studentName: 'Ana', hour: '14:00' }],
      [{ studentName: 'Ana', hour: '18:00' }],
    ));
    const s = groupContiguousClasses([
      clase('Ana', '14:00'),
      clase('Ana', '18:00', { isRecovery: true, recoveryFor: LOST }),
    ], T, occ);

    expect(s).toHaveLength(2);
    expect(s.every(x => x.billingUnits === 1)).toBe(true);
  });

  it('clases de días distintos nunca se funden', () => {
    const occ = gridOccupancyOfTeacher(teacherWith(
      [{ studentName: 'Ana', hour: '17:00' }],
      [{ studentName: 'Ana', hour: '18:00', date: '2026-07-16' }],
    ));
    const s = groupContiguousClasses([
      clase('Ana', '17:00'),
      { ...clase('Ana', '18:00', { isRecovery: true, recoveryFor: LOST }), date: '2026-07-16' },
    ], T, occ);

    expect(s).toHaveLength(2);
  });

  it('dos clases normales contiguas del mismo alumno siguen siendo UNA sesión de 2h', () => {
    // Comportamiento de siempre: no cambia. La sesión de 2h normal ya existía.
    const occ = gridOccupancyOfTeacher(teacherWith([
      { studentName: 'Ana', hour: '17:00' }, { studentName: 'Ana', hour: '18:00' },
    ]));
    const s = groupContiguousClasses([clase('Ana', '17:00'), clase('Ana', '18:00')], T, occ);

    expect(s).toHaveLength(1);
    expect(s[0].billingUnits).toBe(2);
    expect(s[0].recoveryUnits).toBe(0);
    expect(s[0].mixedRecovery).toBe(false);
  });
});

describe('recoveryPartOfSession — solo las horas DENTRO del bloque', () => {
  it('ignora una recuperación del mismo día que cae fuera de la sesión', () => {
    const occ = gridOccupancyOfTeacher(teacherWith([], [
      { studentName: 'Ana', hour: '18:00', recoveryFor: LOST },
      { studentName: 'Ana', hour: '21:00', recoveryFor: '2026-06-10' },
    ]));
    // Sesión 17:00–19:00 → solo entra la de las 18:00.
    expect(recoveryPartOfSession(occ, 'Ana', DATE, 17, 19)).toEqual({ units: 1, dates: [LOST] });
  });
});

// ── Finanzas: la única fuente del pago ───────────────────────────────────────

const RATES: FinanceRate[] = [
  { id: 'r1', planType: 'general', tier: 'antiguo', rate: 10 },
  { id: 'r2', planType: 'general', tier: 'nuevo', rate: 10 },
  { id: 'r3', planType: 'examenes', tier: 'antiguo', rate: 12 },
  { id: 'r4', planType: 'examenes', tier: 'nuevo', rate: 12 },
];

const log = (studentName: string, date: string, time: string): ClassJoinLog => ({
  id: `l_${studentName}_${date}_${time}`, teacherId: T, teacherName: 'Profe', studentName,
  scheduledDate: date, scheduledTime: time, joinedAt: `${date}T15:00:00Z`,
  punctuality: 'on_time', subscriptionStatus: 'active',
} as unknown as ClassJoinLog);

const record = (studentName: string, date: string, time: string, extra: Partial<ClassRecord> = {}): ClassRecord => ({
  id: `cr_${studentName}_${date}_${time}`, teacherId: T, teacherName: 'Profe', studentName,
  classDate: date, classTime: time, screenshotUrl: '', classType: 'normal',
  createdAt: `${date}T16:00:00Z`, ...extra,
} as ClassRecord);

const transcript = (studentName: string, date: string, joinLogId: string) => ({
  teacher_id: T, student_name: studentName, class_date: date,
  has_transcript: true, join_log_id: joinLogId, validation_status: 'ok',
});

function calc(opts: {
  assignments: Assignment[]; logs: ClassJoinLog[]; records: ClassRecord[];
  analyses?: ReturnType<typeof transcript>[];
  teacher: ReturnType<typeof teacherWith>;
}) {
  return calculateTeacherFinance({
    teacherId: T, teacherName: 'Profe', monthYear: '2026-07',
    assignments: opts.assignments, joinLogs: opts.logs, classRecords: opts.records,
    classAnalyses: opts.analyses ?? [], rates: RATES, scoringEvents: [],
    students: [] as Student[], manualApprovals: [], payment: null,
    gridOccupancy: gridOccupancyOfTeacher(opts.teacher),
  });
}

describe('calculateTeacherFinance — sesión 2h normal + recuperación', () => {
  // Alumno de 1h/semana: cupo mensual de 5 clases.
  const ana = asgn('Ana', ['17:00']);
  const teacher = teacherWith(
    [{ studentName: 'Ana', hour: '17:00' }],
    [{ studentName: 'Ana', hour: '18:00', recoveryFor: LOST }],
  );

  it('paga las DOS horas con UN solo transcript', () => {
    const l = log('Ana', DATE, '17:00');
    const r = calc({
      assignments: [ana], logs: [l], records: [record('Ana', DATE, '17:00')],
      analyses: [transcript('Ana', DATE, l.id)], teacher,
    });

    expect(r.rows).toHaveLength(1);                 // una sesión, no dos clases
    const row = r.rows[0];
    expect(row.billingUnits).toBe(2);
    expect(row.recoveryUnits).toBe(1);
    expect(row.recoveryForDates).toEqual([LOST]);
    expect(row.status).toBe('pagable');
    expect(row.hasTranscript).toBe(true);
    expect(r.montoPagable).toBe(20);                // 2 × 10 €
    expect(r.totalPagable).toBe(2);
  });

  it('con el cupo del mes al tope, la sesión mixta consume UNA sola clase', () => {
    // 4 normales (4 unidades) + la mixta (1 unidad de cupo, 2 de pago) = 5 = tope.
    const normales = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06'];
    const logs = [...normales.map(d => log('Ana', d, '17:00')), log('Ana', DATE, '17:00')];
    const r = calc({
      assignments: [ana], logs,
      records: [...normales.map(d => record('Ana', d, '17:00')), record('Ana', DATE, '17:00')],
      analyses: logs.map(l => transcript('Ana', l.scheduledDate, l.id)), teacher,
    });

    expect(r.rows.every(x => x.status === 'pagable')).toBe(true);
    // Al profesor se le pagan 6 horas: 4 + 2.
    expect(r.totalPagable).toBe(6);
    expect(r.montoPagable).toBe(60);
  });

  it('sin la regla la mixta habría excedido: consume 1 y no 2', () => {
    // 5 normales (cupo lleno) + la mixta. La parte normal ya no cabe, así que la
    // sesión queda 'excede_limite'; lo que se comprueba es que las 5 anteriores
    // siguen pagables (la mixta no se comió dos huecos de golpe).
    const normales = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07'];
    const logs = [...normales.map(d => log('Ana', d, '17:00')), log('Ana', DATE, '17:00')];
    const r = calc({
      assignments: [ana], logs,
      records: [...normales.map(d => record('Ana', d, '17:00')), record('Ana', DATE, '17:00')],
      analyses: logs.map(l => transcript('Ana', l.scheduledDate, l.id)), teacher,
    });

    expect(r.rows.filter(x => x.status === 'excede_limite')).toHaveLength(1);
    expect(r.rows.filter(x => x.status === 'pagable')).toHaveLength(5);
  });

  it('una recuperación PURA no consume cupo aunque el mes esté lleno', () => {
    const normales = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07'];
    const soloRecuperacion = teacherWith([], [{ studentName: 'Ana', hour: '18:00', recoveryFor: LOST }]);
    const logs = [...normales.map(d => log('Ana', d, '17:00')), log('Ana', DATE, '18:00')];
    const r = calc({
      assignments: [ana], logs,
      records: [
        ...normales.map(d => record('Ana', d, '17:00')),
        record('Ana', DATE, '18:00', { classType: 'recuperacion', recoveryForDate: LOST }),
      ],
      analyses: logs.map(l => transcript('Ana', l.scheduledDate, l.id)),
      teacher: soloRecuperacion,
    });

    const rec = r.rows.find(x => x.date === DATE)!;
    expect(rec.recoveryUnits).toBe(1);
    expect(rec.recoveryForDates).toEqual([LOST]);
    expect(rec.status).toBe('pagable');            // el mes lleno no la bloquea
  });

  it('una clase normal de 1h no cambia en nada', () => {
    const sinRecuperacion = teacherWith([{ studentName: 'Ana', hour: '17:00' }]);
    const l = log('Ana', DATE, '17:00');
    const r = calc({
      assignments: [ana], logs: [l], records: [record('Ana', DATE, '17:00')],
      analyses: [transcript('Ana', DATE, l.id)], teacher: sinRecuperacion,
    });

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].billingUnits).toBe(1);
    expect(r.rows[0].recoveryUnits).toBe(0);
    expect(r.rows[0].recoveryForDates).toEqual([]);
    expect(r.montoPagable).toBe(10);
  });

  it('una REPROGRAMACIÓN normal (sin fundir) se sigue ignorando para el pago', () => {
    // El profesor mueve la clase del 15/07 al 16/07: constancia 'reprogramada' en
    // la fecha original. No crea fila ni consume cupo — igual que antes.
    const sinRecuperacion = teacherWith([{ studentName: 'Ana', hour: '17:00' }]);
    const r = calc({
      assignments: [ana], logs: [],
      records: [record('Ana', DATE, '17:00', {
        classType: 'reprogramada', originalDate: DATE, rescheduledTo: '2026-07-16',
      })],
      teacher: sinRecuperacion,
    });

    expect(r.rows).toHaveLength(0);
    expect(r.montoPagable).toBe(0);
  });
});
