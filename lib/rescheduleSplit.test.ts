// Reprogramar una clase de 2 h en DOS días distintos.
//
// Lo que fijan estos tests: el modo partido crea DOS recuperaciones de 1 h que
// suman las 2 horas de la clase perdida, el profesor cobra lo mismo que en bloque,
// ninguna de las dos gasta cupo del mes, y el modo normal (checkbox destildado) no
// cambia en absolutamente nada.
//
// Y el que más importa a futuro: la regla 4 de `checkRecovery` sigue intacta. No
// se le abrió ninguna excepción porque no hizo falta — las dos horas son siempre
// posteriores a la clase original, así que la regla se cumple sola.

import { describe, expect, it } from 'vitest';
import {
  planRescheduleSplit, splitSummaryText, splitRescheduleComment, splitHourText, canSplitReschedule,
} from './rescheduleSplit';
import { checkRecovery } from './recovery';
import { recoveryLedgerOf } from './recoveryLedger';
import { calculateTeacherFinance } from './finance';
import { gridOccupancyOfTeacher } from './teacherClasses';
import type { Assignment, Cell, ClassJoinLog, ClassRecord, FinanceRate, Student } from '@/types';

const T = 'teacher_1';
// 2026-09-15 es MARTES. 16 miércoles, 17 jueves, 18 viernes, 22 el martes siguiente.
const ORIGINAL = '2026-09-15';
const HOY = '2026-09-09';
const ALUMNO = 'Ana';

/** Calendario del profe: Ana tiene 2 h seguidas los martes, 16:00 y 17:00. */
const ANA_2H: Record<string, Cell> = {
  'Martes_16:00': { state: 'ocupado', student: ALUMNO },
  'Martes_17:00': { state: 'ocupado', student: ALUMNO },
};

const cellAtOf = (grid: Record<string, Cell>) =>
  (day: string, hour: string): Cell | undefined => grid[`${day}_${hour}`];

const plan = (
  slots: Array<{ date: string; time: string }>,
  grid: Record<string, Cell> = ANA_2H,
  durationHours = 2,
) => planRescheduleSplit({
  studentName: ALUMNO,
  original: { date: ORIGINAL, hour: '16:00', durationHours },
  slots, todayIso: HOY, cellAt: cellAtOf(grid),
});

// ── El plan de escritura ─────────────────────────────────────────────────────

describe('planRescheduleSplit — dos horas válidas', () => {
  const r = plan([{ date: '2026-09-17', time: '11:00' }, { date: '2026-09-18', time: '12:00' }]);

  it('acepta las dos horas', () => {
    expect(r.ok).toBe(true);
  });

  it('tacha la clase original ENTERA: las dos celdas del bloque de 2 h', () => {
    if (!r.ok) throw new Error('debía ser válido');
    const tachadas = r.plan.cells.filter(c => c.cell.state === 'reprogramada');
    expect(tachadas.map(c => `${c.day} ${c.hour}`)).toEqual(['Martes 16:00', 'Martes 17:00']);
    // El fondo se conserva: la clase recurrente vuelve el resto de las semanas.
    for (const c of tachadas) {
      expect(c.cell.baseState).toBe('ocupado');
      expect(c.cell.baseStudent).toBe(ALUMNO);
      expect(c.cell.weekDate).toBe('2026-09-14');   // lunes de la semana del 15
    }
  });

  it('crea DOS celdas de recuperación, cada una en su semana y las dos a la misma clase', () => {
    if (!r.ok) throw new Error('debía ser válido');
    const recs = r.plan.cells.filter(c => c.cell.state === 'bloqueado');
    expect(recs.map(c => `${c.day} ${c.hour}`)).toEqual(['Jueves 11:00', 'Viernes 12:00']);
    for (const c of recs) {
      expect(c.cell.recoveryFor).toBe(ORIGINAL);
      expect(c.cell.student).toBe(ALUMNO);
      expect(c.cell.baseState).toBe('libre');
    }
  });

  it('sella lost_hours = 2 en la constancia de la clase original', () => {
    if (!r.ok) throw new Error('debía ser válido');
    expect(r.plan.reprogramada).toMatchObject({
      originalDate: ORIGINAL, originalTime: '16:00', lostHours: 2,
      newDate: '2026-09-17', newTime: '11:00',   // la primera: la del badge
    });
  });

  it('devuelve las dos constancias de recuperación con su hora', () => {
    if (!r.ok) throw new Error('debía ser válido');
    expect(r.plan.recuperaciones).toEqual([
      { date: '2026-09-17', hour: '11:00', recoveryFor: ORIGINAL },
      { date: '2026-09-18', hour: '12:00', recoveryFor: ORIGINAL },
    ]);
  });

  it('el resumen se lee como una frase', () => {
    if (!r.ok) throw new Error('debía ser válido');
    expect(r.plan.summary).toBe(
      'La clase del 15/09/2026 (2 h) se recupera el 17/09/2026 a las 11:00 y el 18/09/2026 a las 12:00.',
    );
  });
});

describe('planRescheduleSplit — lo que rechaza', () => {
  const problemas = (r: ReturnType<typeof plan>) => (r.ok ? [] : r.problems);

  it('falta una hora → lo dice y no arma nada', () => {
    const r = plan([{ date: '2026-09-17', time: '11:00' }, { date: '', time: '' }]);
    expect(r.ok).toBe(false);
    expect(problemas(r)[0]).toContain('Falta la fecha o la hora de la segunda');
  });

  it('una hora ANTERIOR a la clase original se rechaza (van siempre después)', () => {
    const r = plan([{ date: '2026-09-10', time: '11:00' }, { date: '2026-09-18', time: '12:00' }]);
    expect(problemas(r).some(p => p.includes('posterior a la clase original'))).toBe(true);
  });

  it('la misma hora de la clase original tampoco vale', () => {
    const r = plan([{ date: ORIGINAL, time: '16:00' }, { date: '2026-09-18', time: '12:00' }]);
    expect(problemas(r).some(p => p.includes('posterior a la clase original'))).toBe(true);
  });

  it('una fecha ya pasada se rechaza', () => {
    const r = plan([{ date: '2026-09-01', time: '11:00' }, { date: '2026-09-18', time: '12:00' }]);
    expect(problemas(r).some(p => p.includes('ya pasó'))).toBe(true);
  });

  it('el año mal tipeado se rechaza aunque tenga formato de fecha', () => {
    const r = plan([{ date: '0266-09-17', time: '11:00' }, { date: '2026-09-18', time: '12:00' }]);
    expect(problemas(r).some(p => p.includes('Revisá el año'))).toBe(true);
  });

  it('las dos en el mismo hueco exacto se rechazan', () => {
    const r = plan([{ date: '2026-09-17', time: '11:00' }, { date: '2026-09-17', time: '11:00' }]);
    expect(problemas(r).some(p => p.includes('dos huecos distintos'))).toBe(true);
  });

  it('la segunda antes que la primera se rechaza, sin reordenar en silencio', () => {
    const r = plan([{ date: '2026-09-18', time: '12:00' }, { date: '2026-09-17', time: '11:00' }]);
    expect(problemas(r).some(p => p.includes('posterior a la primera'))).toBe(true);
  });

  it('un hueco ocupado se rechaza nombrando el día y la hora', () => {
    const grid = { ...ANA_2H, 'Jueves_11:00': { state: 'ocupado' as const, student: 'Otro' } };
    const r = plan([{ date: '2026-09-17', time: '11:00' }, { date: '2026-09-18', time: '12:00' }], grid);
    expect(problemas(r).some(p => p.includes('Jueves') && p.includes('ya está ocupado'))).toBe(true);
  });

  it('una recuperación de OTRO alumno también ocupa, aunque el fondo esté libre', () => {
    const grid = {
      ...ANA_2H,
      'Jueves_11:00': { state: 'bloqueado' as const, student: 'Otro', weekDate: '2026-09-14', baseState: 'libre' as const },
    };
    const r = plan([{ date: '2026-09-17', time: '11:00' }, { date: '2026-09-18', time: '12:00' }], grid);
    expect(problemas(r).some(p => p.includes('ya está ocupado'))).toBe(true);
  });

  it('MISMO día de la semana y misma hora en semanas distintas: una borraría a la otra', () => {
    // Martes 22 y martes 29 a las 11:00 son la MISMA casilla del grid.
    const r = plan([{ date: '2026-09-22', time: '11:00' }, { date: '2026-09-29', time: '11:00' }]);
    expect(problemas(r).some(p => p.includes('mismo hueco del calendario'))).toBe(true);
  });

  it('el domingo se rechaza: el calendario va de lunes a sábado', () => {
    // 2026-09-20 es domingo. Una celda 'Domingo_11:00' no la pinta nadie y
    // `puntualDateOf` no le puede resolver la fecha: la clase quedaría invisible.
    const r = plan([{ date: '2026-09-20', time: '11:00' }, { date: '2026-09-21', time: '12:00' }]);
    expect(problemas(r).some(p => p.includes('domingo') && p.includes('lunes a sábado'))).toBe(true);
  });

  it('la casilla de la PROPIA clase que se mueve se rechaza', () => {
    // El martes 22 a las 16:00 es la misma casilla del grid que el martes 15 a las
    // 16:00, que es la clase que se está moviendo: la recuperación pisaría el tachado.
    // Sin la clase en el calendario, el control de "hueco ocupado" no lo ve venir.
    const r = plan([{ date: '2026-09-22', time: '16:00' }, { date: '2026-09-23', time: '12:00' }], {});
    expect(problemas(r).some(p => p.includes('misma casilla del calendario'))).toBe(true);
  });

  it("'no work' no ocupa: el profe puede dar una hora que normalmente no trabaja", () => {
    const grid = { ...ANA_2H, 'Jueves_11:00': { state: 'no_work' as const } };
    const r = plan([{ date: '2026-09-17', time: '11:00' }, { date: '2026-09-18', time: '12:00' }], grid);
    expect(r.ok).toBe(true);
  });
});

describe('planRescheduleSplit — el aviso suave de las horas seguidas', () => {
  it('dos horas seguidas el mismo día se PERMITEN, con aviso', () => {
    const r = plan([{ date: '2026-09-17', time: '11:00' }, { date: '2026-09-17', time: '12:00' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.warning).toContain('dos horas seguidas');
  });

  it('dos horas separadas no avisan nada', () => {
    const r = plan([{ date: '2026-09-17', time: '11:00' }, { date: '2026-09-18', time: '12:00' }]);
    if (!r.ok) throw new Error('debía ser válido');
    expect(r.plan.warning).toBeUndefined();
  });
});

describe('planRescheduleSplit — una clase de 1 h', () => {
  it('tacha una sola celda (el checkbox no se ofrece, pero el módulo no inventa horas)', () => {
    const grid = { 'Martes_16:00': { state: 'ocupado' as const, student: ALUMNO } };
    const r = plan([{ date: '2026-09-17', time: '11:00' }, { date: '2026-09-18', time: '12:00' }], grid, 1);
    if (!r.ok) throw new Error('debía ser válido');
    expect(r.plan.cells.filter(c => c.cell.state === 'reprogramada')).toHaveLength(1);
    expect(r.plan.reprogramada.lostHours).toBe(1);
  });
});

describe('canSplitReschedule — cuándo aparece el checkbox', () => {
  it('solo con una clase de 2 h', () => {
    expect(canSplitReschedule(2)).toBe(true);
  });

  it('una clase de 1 h no se parte: no hay nada que repartir', () => {
    expect(canSplitReschedule(1)).toBe(false);
  });

  it('una de 3 h tampoco: no cabe en dos mitades de una hora', () => {
    expect(canSplitReschedule(3)).toBe(false);
  });
});

describe('helpers', () => {
  it('splitHourText normaliza a HH:00 y descarta lo que no es hora', () => {
    expect(splitHourText('9:30')).toBe('09:00');
    expect(splitHourText('17')).toBe('17:00');
    expect(splitHourText('')).toBe('');
    expect(splitHourText('nope')).toBe('');
  });

  it('splitSummaryText no dice nada a medias', () => {
    expect(splitSummaryText({ originalDate: ORIGINAL, durationHours: 2, slots: [{ date: '2026-09-17', time: '11:00' }] })).toBe('');
  });

  it('el comentario de la constancia nombra las DOS horas', () => {
    const c = splitRescheduleComment({
      recuperaciones: [
        { date: '2026-09-17', hour: '11:00', recoveryFor: ORIGINAL },
        { date: '2026-09-18', hour: '12:00', recoveryFor: ORIGINAL },
      ],
      reasonLabel: 'El alumno avisó con anticipación',
    });
    expect(c).toBe('Reprogramada en dos horas: 2026-09-17 11:00 y 2026-09-18 12:00 — Motivo: El alumno avisó con anticipación');
  });
});

// ── La regla 4 de checkRecovery sigue intacta ────────────────────────────────

describe('checkRecovery — no se le abrió ninguna excepción', () => {
  const records: ClassRecord[] = [{
    id: 'cr1', teacherId: T, teacherName: 'Profe', studentName: ALUMNO,
    classDate: ORIGINAL, classTime: '16:00', screenshotUrl: '',
    classType: 'reprogramada', createdAt: `${ORIGINAL}T20:00:00Z`,
  }];

  it('el modal de recuperación sigue bloqueando una clase perdida POSTERIOR', () => {
    const v = checkRecovery({
      studentName: ALUMNO, recoveryDate: '2026-09-10', recoveryHour: '11:00',
      lostDate: ORIGINAL, classRecords: records, joinLogs: [], existing: [], lostHours: 2,
    });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe('futura');
  });

  it('y sigue bloqueando la del MISMO día', () => {
    const v = checkRecovery({
      studentName: ALUMNO, recoveryDate: ORIGINAL, recoveryHour: '20:00',
      lostDate: ORIGINAL, classRecords: records, joinLogs: [], existing: [], lostHours: 2,
    });
    expect(v.kind).toBe('futura');
  });

  it('las dos horas que crea Reprogramar pasan la regla 4 por sí solas', () => {
    // Es la razón por la que no hizo falta ninguna excepción.
    const r = plan([{ date: '2026-09-17', time: '11:00' }, { date: '2026-09-18', time: '12:00' }]);
    if (!r.ok) throw new Error('debía ser válido');
    for (const rec of r.plan.recuperaciones) {
      const v = checkRecovery({
        studentName: ALUMNO, recoveryDate: rec.date, recoveryHour: rec.hour,
        lostDate: rec.recoveryFor, classRecords: records, joinLogs: [], existing: [], lostHours: 2,
      });
      expect(v.ok).toBe(true);
    }
  });
});

// ── El saldo del alumno y el pago del profesor ───────────────────────────────

const RATES: FinanceRate[] = [
  { id: 'r1', planType: 'general', tier: 'antiguo', rate: 10 },
  { id: 'r2', planType: 'general', tier: 'nuevo', rate: 10 },
  { id: 'r3', planType: 'examenes', tier: 'antiguo', rate: 12 },
  { id: 'r4', planType: 'examenes', tier: 'nuevo', rate: 12 },
];

const ana: Assignment = {
  id: 'a_ana', teacherId: T, teacherName: 'Profe', studentName: ALUMNO,
  studentEmail: 'ana@x.com', studentLevel: 'B1', plan: 'Inglés general',
  weeklyHours: 2, slots: [{ day: 'Martes', hour: '16:00' }, { day: 'Martes', hour: '17:00' }],
  startDate: '2025-01-01', status: 'active',
} as unknown as Assignment;

const log = (date: string, time: string): ClassJoinLog => ({
  id: `l_${date}_${time}`, teacherId: T, teacherName: 'Profe', studentName: ALUMNO,
  scheduledDate: date, scheduledTime: time, joinedAt: `${date}T09:00:00Z`,
  punctuality: 'on_time', subscriptionStatus: 'active',
} as unknown as ClassJoinLog);

const transcript = (date: string, joinLogId: string) => ({
  teacher_id: T, student_name: ALUMNO, class_date: date,
  has_transcript: true, join_log_id: joinLogId, validation_status: 'ok',
});

/** El calendario tal como queda DESPUÉS de aplicar el plan. */
function teacherAfterPlan(r: ReturnType<typeof plan>) {
  if (!r.ok) throw new Error('el plan debía ser válido');
  const recoveryCells = r.plan.cells
    .filter(c => c.cell.state === 'bloqueado')
    .map((c, i) => ({
      studentName: ALUMNO, day: c.day, hour: c.hour,
      date: r.plan.recuperaciones[i].date, recoveryFor: r.plan.recuperaciones[i].recoveryFor,
    }));
  return {
    // El horario recurrente sigue existiendo: el tachado conserva el fondo.
    upcomingClasses: [
      { studentName: ALUMNO, day: 'Martes', time: '16:00' },
      { studentName: ALUMNO, day: 'Martes', time: '17:00' },
    ],
    recoveryCells,
  };
}

describe('reprogramar 2 h en dos días — finanzas y cupo salen solos', () => {
  const r = plan([{ date: '2026-09-17', time: '11:00' }, { date: '2026-09-18', time: '12:00' }]);
  const teacher = teacherAfterPlan(r);
  // Las constancias que escribe el flujo, tal cual.
  const records: ClassRecord[] = [
    {
      id: 'cr_orig', teacherId: T, teacherName: 'Profe', studentName: ALUMNO,
      classDate: ORIGINAL, classTime: '16:00', screenshotUrl: '',
      classType: 'reprogramada', rescheduledTo: '2026-09-17', createdAt: `${HOY}T10:00:00Z`,
    },
    ...(r.ok ? r.plan.recuperaciones : []).map((rec, i) => ({
      id: `cr_rec_${i}`, teacherId: T, teacherName: 'Profe', studentName: ALUMNO,
      classDate: rec.date, classTime: rec.hour, screenshotUrl: '',
      classType: 'recuperacion' as const, recoveryForDate: rec.recoveryFor,
      createdAt: `${HOY}T10:00:00Z`,
    })),
  ];
  const logs = [log('2026-09-17', '11:00'), log('2026-09-18', '12:00')];

  const finanzas = calculateTeacherFinance({
    teacherId: T, teacherName: 'Profe', monthYear: '2026-09',
    assignments: [ana], joinLogs: logs, classRecords: records,
    classAnalyses: logs.map(l => transcript(l.scheduledDate, l.id)),
    rates: RATES, scoringEvents: [], students: [] as Student[],
    manualApprovals: [], payment: null,
    gridOccupancy: gridOccupancyOfTeacher(teacher),
  });

  it('son DOS filas de 1 unidad, con un transcript cada una', () => {
    const filas = finanzas.rows.filter(f => f.date === '2026-09-17' || f.date === '2026-09-18');
    expect(filas).toHaveLength(2);
    for (const f of filas) {
      expect(f.billingUnits).toBe(1);
      expect(f.recoveryUnits).toBe(1);
      expect(f.recoveryForDates).toEqual([ORIGINAL]);
      expect(f.hasTranscript).toBe(true);
      expect(f.status).toBe('pagable');
    }
  });

  it('el profesor cobra lo mismo que si la hubiera dado en bloque: 2 horas', () => {
    expect(finanzas.montoPagable).toBe(20);
  });

  it('ninguna de las dos gasta cupo del mes (cupoUnits 0)', () => {
    const cupo = finanzas.studentQuota.find(q => q.studentName === ALUMNO);
    // 9 es el tope de un alumno de 2 h/semana; las dos recuperaciones no lo tocan.
    expect(cupo?.used).toBe(0);
  });

  it('la clase original NO genera fila pagable: está reprogramada', () => {
    expect(finanzas.rows.some(f => f.date === ORIGINAL && f.status === 'pagable')).toBe(false);
  });

  it('el crédito del alumno queda saldado: 2 h que valía, 2 repuestas, 0 pendientes', () => {
    const ledger = recoveryLedgerOf({
      studentName: ALUMNO, lostDate: ORIGINAL, classRecords: records,
      existing: (r.ok ? r.plan.recuperaciones : []).map(rec => ({
        studentName: ALUMNO, date: rec.date, hour: rec.hour, recoveryFor: rec.recoveryFor,
      })),
      occupancy: gridOccupancyOfTeacher(teacher),
    });
    expect(ledger).toMatchObject({ lostHours: 2, recoveredHours: 2, pendingHours: 0, settled: true });
  });

  it('una falta SIN aviso en la segunda recuperación cierra solo esa hora', () => {
    const conFalta: ClassRecord[] = records.map(rec =>
      rec.classDate === '2026-09-18'
        ? { ...rec, classType: 'falta_sin_aviso' as const }
        : rec);
    const f = calculateTeacherFinance({
      teacherId: T, teacherName: 'Profe', monthYear: '2026-09',
      assignments: [ana], joinLogs: logs, classRecords: conFalta,
      classAnalyses: [transcript('2026-09-17', logs[0].id)],
      rates: RATES, scoringEvents: [], students: [] as Student[],
      manualApprovals: [], payment: null,
      gridOccupancy: gridOccupancyOfTeacher(teacher),
    });
    const falta = f.rows.find(x => x.date === '2026-09-18');
    // La clase perdida por el alumno se cobra igual y consume su cupo entero.
    expect(falta?.classType).toBe('falta_sin_aviso');
    const cupo = f.studentQuota.find(q => q.studentName === ALUMNO);
    expect(cupo?.used).toBe(1);
    // La primera hora sigue siendo una recuperación pagable que no gasta cupo.
    expect(f.rows.find(x => x.date === '2026-09-17')?.recoveryUnits).toBe(1);
  });
});
