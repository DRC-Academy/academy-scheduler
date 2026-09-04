// Recuperar una clase de 2 horas: junta (un bloque) o partida (1 h + 1 h en días
// distintos).
//
// Lo que fijan estos tests es la regla nueva: una clase perdida se repone hasta
// completar SUS horas. La de 1 h sigue admitiendo una sola recuperación —que es
// lo que evitó que se cobrara dos veces la misma clase (Paula Tatiana, agosto de
// 2026)— y la de 2 h admite dos horas, con la libertad de darlas juntas o en dos
// días. En los dos casos el profesor cobra 2 horas y el alumno salda su clase.

import { describe, expect, it } from 'vitest';
import { lostClassHours, recoveryLedgerOf } from './recoveryLedger';
import { checkRecovery, existingRecoveriesOf } from './recovery';
import { gridOccupancyOfTeacher } from './teacherClasses';
import { calculateTeacherFinance } from './finance';
import type { Assignment, ClassJoinLog, ClassRecord, FinanceRate, Student } from '@/types';

const T = 'teacher_1';
// 2026-07-08 es MIÉRCOLES; el 15 también. 16 jueves, 17 viernes.
const PERDIDA = '2026-07-08';

const rec = (
  studentName: string, classDate: string, classType: ClassRecord['classType'],
  extra: Partial<ClassRecord> = {},
): ClassRecord => ({
  id: `cr_${studentName}_${classDate}_${classType}`, teacherId: T, teacherName: 'Profe',
  studentName, classDate, classTime: '17:00', screenshotUrl: '', classType,
  createdAt: `${classDate}T20:00:00Z`, ...extra,
});

/** Calendario del profesor: horas recurrentes + celdas de recuperación. */
const teacherWith = (
  recurrentes: Array<{ studentName: string; day: string; hour: string }>,
  recuperaciones: Array<{ studentName: string; day: string; hour: string; date: string; recoveryFor: string }> = [],
) => ({
  upcomingClasses: recurrentes.map(r => ({ studentName: r.studentName, day: r.day, time: r.hour })),
  recoveryCells: recuperaciones,
});

// Ana da dos horas seguidas los miércoles: su clase es de 2 h.
const ANA_2H = [
  { studentName: 'Ana', day: 'Miércoles', hour: '17:00' },
  { studentName: 'Ana', day: 'Miércoles', hour: '18:00' },
];
const ANA_1H = [{ studentName: 'Ana', day: 'Miércoles', hour: '17:00' }];

describe('lostClassHours — cuántas horas valía la clase perdida', () => {
  it('una clase de 1 h vale 1', () => {
    expect(lostClassHours({
      studentName: 'Ana', lostDate: PERDIDA,
      classRecords: [rec('Ana', PERDIDA, 'falta_con_aviso')],
      occupancy: gridOccupancyOfTeacher(teacherWith(ANA_1H)),
    })).toBe(1);
  });

  it('una sesión de 2 h vale 2 — sale del CALENDARIO, igual que en finanzas', () => {
    expect(lostClassHours({
      studentName: 'Ana', lostDate: PERDIDA,
      classRecords: [rec('Ana', PERDIDA, 'falta_con_aviso')],
      occupancy: gridOccupancyOfTeacher(teacherWith(ANA_2H)),
    })).toBe(2);
  });

  it('sin calendario que lo respalde asume 1 h (lo prudente: no abre horas de más)', () => {
    expect(lostClassHours({
      studentName: 'Ana', lostDate: PERDIDA,
      classRecords: [rec('Ana', PERDIDA, 'falta_con_aviso')],
    })).toBe(1);
  });

  it('con dos bloques sueltos ese día y sin hora en la constancia, asume 1 h', () => {
    expect(lostClassHours({
      studentName: 'Ana', lostDate: PERDIDA,
      classRecords: [rec('Ana', PERDIDA, 'falta_con_aviso', { classTime: undefined })],
      occupancy: gridOccupancyOfTeacher(teacherWith([
        { studentName: 'Ana', day: 'Miércoles', hour: '11:00' },
        { studentName: 'Ana', day: 'Miércoles', hour: '17:00' },
      ])),
    })).toBe(1);
  });
});

describe('recoveryLedgerOf — el saldo de la clase perdida', () => {
  const ledger = (recuperaciones: Array<{ date: string; hour: string }>, recurrentes = ANA_2H) =>
    recoveryLedgerOf({
      studentName: 'Ana', lostDate: PERDIDA,
      classRecords: [rec('Ana', PERDIDA, 'falta_con_aviso')],
      existing: recuperaciones.map(r => ({ studentName: 'Ana', date: r.date, hour: r.hour, recoveryFor: PERDIDA })),
      occupancy: gridOccupancyOfTeacher(teacherWith(recurrentes)),
    });

  it('una clase de 2 h sin recuperar debe 2 horas', () => {
    expect(ledger([])).toMatchObject({ lostHours: 2, recoveredHours: 0, pendingHours: 2, settled: false });
  });

  it('con 1 h repuesta queda 1 h pendiente', () => {
    expect(ledger([{ date: '2026-07-16', hour: '11:00' }]))
      .toMatchObject({ recoveredHours: 1, pendingHours: 1, settled: false });
  });

  it('partida en dos días: las dos horas la saldan', () => {
    expect(ledger([{ date: '2026-07-16', hour: '11:00' }, { date: '2026-07-17', hour: '11:00' }]))
      .toMatchObject({ recoveredHours: 2, pendingHours: 0, settled: true });
  });

  it('junta en un bloque: dos horas seguidas el mismo día también la saldan', () => {
    expect(ledger([{ date: '2026-07-16', hour: '11:00' }, { date: '2026-07-16', hour: '12:00' }]))
      .toMatchObject({ recoveredHours: 2, pendingHours: 0, settled: true });
  });

  it('la celda y su constancia son LA MISMA hora: no cuentan dos veces', () => {
    // Es el caso real: marcar la recuperación crea la celda en el calendario y
    // además un class_record. Contar los dos daría por saldada media clase.
    const l = recoveryLedgerOf({
      studentName: 'Ana', lostDate: PERDIDA,
      classRecords: [
        rec('Ana', PERDIDA, 'falta_con_aviso'),
        rec('Ana', '2026-07-16', 'recuperacion', { classTime: '11:00', recoveryForDate: PERDIDA }),
      ],
      existing: existingRecoveriesOf({
        studentName: 'Ana',
        classRecords: [
          rec('Ana', PERDIDA, 'falta_con_aviso'),
          rec('Ana', '2026-07-16', 'recuperacion', { classTime: '11:00', recoveryForDate: PERDIDA }),
        ],
        recoveryCells: [{ studentName: 'Ana', date: '2026-07-16', hour: '11:00', recoveryFor: PERDIDA }],
      }),
      occupancy: gridOccupancyOfTeacher(teacherWith(ANA_2H)),
    });
    expect(l).toMatchObject({ lostHours: 2, recoveredHours: 1, pendingHours: 1 });
  });

  it('la celda que se está marcando ahora no cuenta como ya hecha', () => {
    const l = recoveryLedgerOf({
      studentName: 'Ana', lostDate: PERDIDA,
      classRecords: [rec('Ana', PERDIDA, 'falta_con_aviso')],
      existing: [{ studentName: 'Ana', date: '2026-07-16', hour: '11:00', recoveryFor: PERDIDA }],
      occupancy: gridOccupancyOfTeacher(teacherWith(ANA_2H)),
      exclude: { date: '2026-07-16', hour: '11:00' },
    });
    expect(l.recoveredHours).toBe(0);
  });
});

describe('checkRecovery — cuántas horas admite cada clase perdida', () => {
  const check = (o: Partial<Parameters<typeof checkRecovery>[0]>) => checkRecovery({
    studentName: 'Ana', recoveryDate: '2026-07-17', recoveryHour: '11:00', lostDate: PERDIDA,
    classRecords: [rec('Ana', PERDIDA, 'falta_con_aviso')], joinLogs: [], existing: [], ...o,
  });

  it('clase de 1 h: la segunda recuperación en otro día se sigue bloqueando', () => {
    const v = check({
      lostHours: 1,
      existing: [{ studentName: 'Ana', date: '2026-07-16', hour: '11:00', recoveryFor: PERDIDA }],
    });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe('ya_recuperada');
  });

  it('clase de 2 h: la segunda hora en OTRO día ya se puede (lo nuevo)', () => {
    const v = check({
      lostHours: 2,
      existing: [{ studentName: 'Ana', date: '2026-07-16', hour: '11:00', recoveryFor: PERDIDA }],
    });
    expect(v.ok).toBe(true);
  });

  it('clase de 2 h: la segunda hora PEGADA el mismo día también', () => {
    const v = check({
      lostHours: 2, recoveryDate: '2026-07-16', recoveryHour: '12:00',
      existing: [{ studentName: 'Ana', date: '2026-07-16', hour: '11:00', recoveryFor: PERDIDA }],
    });
    expect(v.ok).toBe(true);
  });

  it('clase de 2 h: la TERCERA hora se bloquea y dice por qué', () => {
    const v = check({
      lostHours: 2,
      existing: [
        { studentName: 'Ana', date: '2026-07-16', hour: '11:00', recoveryFor: PERDIDA },
        { studentName: 'Ana', date: '2026-07-16', hour: '12:00', recoveryFor: PERDIDA },
      ],
    });
    expect(v.kind).toBe('ya_recuperada');
    expect(v.detail).toContain('2 horas');
  });

  it('revisar la MISMA celda no cuenta como duplicado', () => {
    const v = check({
      lostHours: 1,
      recoveryDate: '2026-07-16', recoveryHour: '11:00',
      existing: [{ studentName: 'Ana', date: '2026-07-16', hour: '11:00', recoveryFor: PERDIDA }],
    });
    expect(v.ok).toBe(true);
  });
});

// ── Finanzas: el pago sale igual junta que partida ───────────────────────────

const RATES: FinanceRate[] = [
  { id: 'r1', planType: 'general', tier: 'antiguo', rate: 10 },
  { id: 'r2', planType: 'general', tier: 'nuevo', rate: 10 },
  { id: 'r3', planType: 'examenes', tier: 'antiguo', rate: 12 },
  { id: 'r4', planType: 'examenes', tier: 'nuevo', rate: 12 },
];

const ana: Assignment = {
  id: 'a_ana', teacherId: T, teacherName: 'Profe', studentName: 'Ana',
  studentEmail: 'ana@x.com', studentLevel: 'B1', plan: 'Inglés general',
  weeklyHours: 2, slots: [{ day: 'Miércoles', hour: '17:00' }, { day: 'Miércoles', hour: '18:00' }],
  startDate: '2025-01-01', status: 'active',
} as unknown as Assignment;

const log = (date: string, time: string): ClassJoinLog => ({
  id: `l_${date}_${time}`, teacherId: T, teacherName: 'Profe', studentName: 'Ana',
  scheduledDate: date, scheduledTime: time, joinedAt: `${date}T15:00:00Z`,
  punctuality: 'on_time', subscriptionStatus: 'active',
} as unknown as ClassJoinLog);

const transcript = (date: string, joinLogId: string) => ({
  teacher_id: T, student_name: 'Ana', class_date: date,
  has_transcript: true, join_log_id: joinLogId, validation_status: 'ok',
});

function calc(opts: {
  logs: ClassJoinLog[]; records: ClassRecord[];
  analyses?: ReturnType<typeof transcript>[];
  teacher: ReturnType<typeof teacherWith>;
}) {
  return calculateTeacherFinance({
    teacherId: T, teacherName: 'Profe', monthYear: '2026-07',
    assignments: [ana], joinLogs: opts.logs, classRecords: opts.records,
    classAnalyses: opts.analyses ?? [], rates: RATES, scoringEvents: [],
    students: [] as Student[], manualApprovals: [], payment: null,
    gridOccupancy: gridOccupancyOfTeacher(opts.teacher),
  });
}

describe('recuperación de 2 h partida en dos bloques de 1 h', () => {
  // Jueves 16 y viernes 17 a las 11:00: dos clases de 1 h que reponen la sesión
  // de 2 h del miércoles 8.
  const partida = teacherWith(ANA_2H, [
    { studentName: 'Ana', day: 'Jueves',  hour: '11:00', date: '2026-07-16', recoveryFor: PERDIDA },
    { studentName: 'Ana', day: 'Viernes', hour: '11:00', date: '2026-07-17', recoveryFor: PERDIDA },
  ]);
  const logs = [log('2026-07-16', '11:00'), log('2026-07-17', '11:00')];
  const analyses = logs.map(l => transcript(l.scheduledDate, l.id));

  it('son DOS clases de 1 h, cada una con su transcript y su hora de pago', () => {
    const r = calc({ logs, records: [], analyses, teacher: partida });
    const filas = r.rows.filter(f => f.date === '2026-07-16' || f.date === '2026-07-17');

    expect(filas).toHaveLength(2);
    for (const f of filas) {
      expect(f.billingUnits).toBe(1);
      expect(f.recoveryUnits).toBe(1);        // la hora entera es recuperación
      expect(f.recoveryForDates).toEqual([PERDIDA]);
      expect(f.status).toBe('pagable');
      expect(f.hasTranscript).toBe(true);
    }
    expect(r.montoPagable).toBe(20);          // 2 horas × 10 €
  });

  it('el profesor cobra lo MISMO que si la hubiera dado junta', () => {
    const junta = teacherWith(ANA_2H, [
      { studentName: 'Ana', day: 'Jueves', hour: '11:00', date: '2026-07-16', recoveryFor: PERDIDA },
      { studentName: 'Ana', day: 'Jueves', hour: '12:00', date: '2026-07-16', recoveryFor: PERDIDA },
    ]);
    const logsJuntos = [log('2026-07-16', '11:00')];
    const r = calc({
      logs: logsJuntos, records: [], teacher: junta,
      analyses: [transcript('2026-07-16', logsJuntos[0].id)],
    });

    expect(r.rows).toHaveLength(1);           // un bloque, un transcript
    expect(r.rows[0].billingUnits).toBe(2);
    expect(r.rows[0].recoveryUnits).toBe(2);
    expect(r.montoPagable).toBe(20);          // el mismo dinero que partida
  });

  it('ninguna de las dos horas gasta cupo del mes: reponen una clase ya perdida', () => {
    // Mes lleno: 9 clases (el tope de un alumno de 2 h/semana) y ADEMÁS la
    // recuperación partida. Si consumiera cupo, caería en 'excede_limite'.
    const llenos = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07'];
    const logsLlenos = llenos.map(d => log(d, '17:00'));   // 5 sesiones… de 1 h cada una
    const todos = [...logsLlenos, ...logs];
    const r = calc({
      logs: todos, records: [], teacher: partida,
      analyses: todos.map(l => transcript(l.scheduledDate, l.id)),
    });

    const recuperaciones = r.rows.filter(f => f.date === '2026-07-16' || f.date === '2026-07-17');
    expect(recuperaciones.every(f => f.status === 'pagable')).toBe(true);
  });
});
