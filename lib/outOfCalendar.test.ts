// La rama "fuera del calendario" se divide por ORIGEN, y esa división tiene que
// cumplir dos cosas: no perder ninguna clase (las tres líneas suman la rama) y
// no mover un euro (las pagables del embudo siguen siendo las de finanzas).
//
// El caso que motivó estos tests: ninguna de las dos señales basta sola. En
// agosto de 2026, `class_type='recuperacion'` se perdía 16 de las 106
// recuperaciones y `recoveryUnits > 0` se perdía 2. Se usan en unión.
import { describe, it, expect } from 'vitest';
import { originOf, driftKindOf, scheduledIndex, buildDriftReport } from '@/lib/outOfCalendar';
import { buildClassFunnel, funnelIsConsistent, funnelPayableTotal } from '@/lib/classFunnel';
import { calculateTeacherFinance } from '@/lib/finance';
import { EMPTY_GRID_OCCUPANCY } from '@/lib/teacherClasses';
import type { Assignment, ClassJoinLog, ClassRecord, FinanceRate, Student } from '@/types';
import type { ClassFinanceRow, ClassTranscriptRef } from '@/lib/finance';
import type { StudentDropout } from '@/lib/studentPeriod';

const T = 't1';
const MES = '2026-08';

const fila = (p: Partial<ClassFinanceRow>): ClassFinanceRow => ({
  date: '2026-08-05', hour: '10:00', studentName: 'Ana', plan: 'Inglés general',
  planCategory: 'general', planLabel: 'Inglés general', weeklyHours: 1, antiquityDays: 100,
  rate: 4.5, durationHours: 1, billingUnits: 1, recoveryUnits: 0, recoveryForDates: [],
  status: 'pagable', classType: 'normal', hasJoinLog: true, hasTranscript: true,
  transcriptState: 'ok', hasMeetLink: true, manuallyApproved: false, ...p,
} as ClassFinanceRow);

describe('de dónde salió una clase fuera del calendario', () => {
  it('recuperación por celda bloqueada, aunque el tipo diga "normal"', () => {
    // Las 16 de agosto que `class_type` se perdía.
    expect(originOf(fila({ classType: 'normal', recoveryUnits: 1 }))).toBe('recuperacion');
  });

  it('recuperación por tipo, aunque no haya celda bloqueada', () => {
    // Las 2 de agosto que iban al revés: etiquetadas y sin recoveryUnits.
    expect(originOf(fila({ classType: 'recuperacion', recoveryUnits: 0 }))).toBe('recuperacion');
    expect(originOf(fila({ classType: 'recuperacion', recoveryUnits: 1 }))).toBe('recuperacion');
  });

  it('falta sin aviso y cancelación a la hora van juntas', () => {
    expect(originOf(fila({ classType: 'falta_sin_aviso' }))).toBe('falta');
    expect(originOf(fila({ classType: 'cancelacion_hora' }))).toBe('falta');
    expect(originOf(fila({ classType: 'falta_con_aviso' }))).toBe('falta');
  });

  it('la recuperación gana a la falta: repuso una clase, es lo que manda', () => {
    expect(originOf(fila({ classType: 'falta_sin_aviso', recoveryUnits: 1 }))).toBe('recuperacion');
  });

  it('el resto es "dada fuera de horario" — incluida la clase normal', () => {
    expect(originOf(fila({}))).toBe('fuera_horario');
    expect(originOf(fila({ classType: 'reprogramada' }))).toBe('fuera_horario');
  });
});

// ── El desglose no pierde clases ni mueve dinero ─────────────────────────────

const rates: FinanceRate[] = [
  { id: 'r1', planType: 'general', tier: 'antiguo', rate: 5 },
  { id: 'r2', planType: 'general', tier: 'nuevo', rate: 4 },
];
const alumno = (name: string, slots: Array<{ day: string; hour: string }>, startDate = '2026-01-01'): Assignment => ({
  id: `a_${name}`, teacherId: T, teacherName: 'Prof', teacherEmail: 'p@x.com',
  studentId: `s_${name}`, studentName: name, studentEmail: `${name}@x.com`,
  studentLevel: 'B1', slots, objetivo: '', plan: 'Inglés general',
  weeklyHours: slots.length, availability: '', notes: '', startDate,
  createdAt: '2026-01-01T00:00:00Z',
});
const student = (name: string): Student => ({
  id: `s_${name}`, name, email: `${name}@x.com`, level: 'B1',
  plan: 'Inglés general', createdAt: '2026-01-01T00:00:00Z',
});
const log = (name: string, date: string, time: string): ClassJoinLog => ({
  id: `l_${name}_${date}`, teacherId: T, teacherName: 'Prof', studentName: name,
  scheduledDate: date, scheduledTime: time, clickedAt: `${date}T${time}:00Z`, punctuality: 'on_time',
});
const tx = (name: string, date: string): ClassTranscriptRef => ({
  id: `ca_${name}_${date}`, teacher_id: T, student_name: name, class_date: date,
  has_transcript: true, validation_status: 'auto_approved',
});
const rec = (name: string, date: string, classType: ClassRecord['classType']): ClassRecord => ({
  id: `r_${name}_${date}`, teacherId: T, teacherName: 'Prof', studentName: name,
  classDate: date, classTime: '16:00', screenshotUrl: '', classType, createdAt: `${date}T20:00:00Z`,
});

function armar(assignments: Assignment[], joinLogs: ClassJoinLog[], classRecords: ClassRecord[], analyses: ClassTranscriptRef[]) {
  const finance = calculateTeacherFinance({
    teacherId: T, teacherName: 'Prof', monthYear: MES,
    assignments, joinLogs, classRecords, classAnalyses: analyses, rates,
    scoringEvents: [], students: assignments.map(a => student(a.studentName)),
    manualApprovals: [], payment: null, gridOccupancy: EMPTY_GRID_OCCUPANCY,
  });
  const funnel = buildClassFunnel({
    monthYear: MES, teacherId: T, assignments, joinLogs, classRecords, analyses,
    requests: [], dropouts: [], gridOccupancy: EMPTY_GRID_OCCUPANCY, finance,
    todayIso: '2026-08-31', nowMinutes: 23 * 60,
  });
  return { finance, funnel };
}

describe('la rama sigue cuadrando con el desglose por origen', () => {
  it('las tres líneas suman la rama y las pagables no se mueven', () => {
    const { finance, funnel } = armar(
      [alumno('Ana', [{ day: 'Martes', hour: '10:00' }])],
      // Miércoles y viernes: días que no son suyos.
      [log('Ana', '2026-08-05', '16:00'), log('Ana', '2026-08-07', '16:00')],
      [rec('Ana', '2026-08-12', 'falta_sin_aviso')],
      [tx('Ana', '2026-08-05')],
    );
    expect(funnelIsConsistent(funnel)).toBe(true);
    expect(funnelPayableTotal(funnel)).toBe(finance.totalPagable);

    const fuera = funnel.branches.find(b => b.key === 'fuera_calendario')!;
    expect(fuera.children!.map(c => c.key)).toEqual(
      ['fuera_recuperacion', 'fuera_falta', 'fuera_horario']);
    expect(fuera.children!.reduce((s, c) => s + c.count, 0)).toBe(fuera.count);
  });

  it('cada línea reparte sus clases entre pagables y pendientes', () => {
    const { funnel } = armar(
      [alumno('Ana', [{ day: 'Martes', hour: '10:00' }])],
      [log('Ana', '2026-08-05', '16:00'), log('Ana', '2026-08-07', '16:00')],
      [],
      [tx('Ana', '2026-08-05')],   // una con transcript, la otra sin él
    );
    const linea = funnel.branches
      .find(b => b.key === 'fuera_calendario')!.children!
      .find(c => c.key === 'fuera_horario')!;
    expect(linea.count).toBe(2);
    expect(linea.payStatus).toEqual({ pagables: 1, pendientes: 1 });
  });

  it('sin nada fuera del calendario, las tres líneas quedan en cero', () => {
    const { finance, funnel } = armar(
      [alumno('Ana', [{ day: 'Martes', hour: '10:00' }])],
      [log('Ana', '2026-08-04', '10:00')], [], [tx('Ana', '2026-08-04')],
    );
    expect(funnelPayableTotal(funnel)).toBe(finance.totalPagable);
    const fuera = funnel.branches.find(b => b.key === 'fuera_calendario')!;
    expect(fuera.count).toBe(0);
    expect(fuera.children!.every(c => c.count === 0)).toBe(true);
  });
});

// ── Lo que ve el admin ───────────────────────────────────────────────────────

describe('por qué quedó fuera de horario (vista del admin)', () => {
  const sched = (asg: Assignment[], dropouts: StudentDropout[] = []) =>
    scheduledIndex({ assignments: asg, dropouts, teacherId: T, monthYear: MES });

  it('sin ninguna celda y sin baja: calendario desincronizado', () => {
    const s = sched([alumno('Ana', [])]);
    expect(driftKindOf({ studentName: 'Ana', date: '2026-08-05', sched: s, bajas: new Set() }))
      .toBe('sin_celda_activo');
  });

  it('sin celdas pero con baja registrada: operación normal', () => {
    const s = sched([alumno('Ana', [])]);
    expect(driftKindOf({ studentName: 'Ana', date: '2026-08-05', sched: s, bajas: new Set(['ana']) }))
      .toBe('baja');
  });

  it('tiene celdas, pero la clase se dio otro día', () => {
    const s = sched([alumno('Ana', [{ day: 'Martes', hour: '10:00' }])]);
    // 2026-08-05 es miércoles.
    expect(driftKindOf({ studentName: 'Ana', date: '2026-08-05', sched: s, bajas: new Set() }))
      .toBe('dia_ajeno');
  });

  it('el informe agrupa por alumno y ordena lo roto primero', () => {
    const conCeldas = alumno('Ana', [{ day: 'Martes', hour: '10:00' }]);
    const sinCeldas = alumno('Beto', []);
    const report = buildDriftReport({
      monthYear: MES,
      dropouts: [],
      teachers: [{
        teacherId: T, teacherName: 'Prof',
        assignments: [conCeldas, sinCeldas],
        rows: [
          fila({ studentName: 'Ana', date: '2026-08-05' }),                     // miércoles
          fila({ studentName: 'Beto', date: '2026-08-04' }),
          fila({ studentName: 'Beto', date: '2026-08-06' }),
          fila({ studentName: 'Ana', date: '2026-08-04', recoveryUnits: 1 }),   // recuperación: fuera
          fila({ studentName: 'Ana', date: '2026-08-11' }),                     // martes: agendada
        ],
      }],
    });
    expect(report.map(g => [g.studentName, g.kind, g.units])).toEqual([
      ['Beto', 'sin_celda_activo', 2],
      ['Ana', 'dia_ajeno', 1],
    ]);
    expect(report[1].scheduledDays).toEqual(['Martes']);
  });
});
