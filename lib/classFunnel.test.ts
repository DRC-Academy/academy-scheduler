// El embudo no puede mentir: el total es SIEMPRE la suma de las ramas, y las
// pagables del embudo son SIEMPRE las mismas que las de finanzas.
//
// Estos tests cubren los casos límite que en producción aparecen de a uno y
// tarde: el profesor sin clases, el alumno sin fecha de inicio, la sesión de 2h,
// la falta sin aviso sobre una celda agendada (la que rompió la primera versión
// del embudo) y la baja a mitad de mes.
import { describe, it, expect } from 'vitest';
import { buildClassFunnel, funnelIsConsistent, funnelPayableTotal } from '@/lib/classFunnel';
import { calculateTeacherFinance } from '@/lib/finance';
import { EMPTY_GRID_OCCUPANCY, gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import type { Assignment, ClassJoinLog, ClassRecord, FinanceRate, Student } from '@/types';
import type { ClassTranscriptRef } from '@/lib/finance';
import type { StudentDropout } from '@/lib/studentPeriod';

const T = 't1';
const MES = '2026-08';
const HOY = '2026-08-31';
const NOW = 23 * 60;
const rates: FinanceRate[] = [
  { id: 'r1', planType: 'general', tier: 'antiguo', rate: 5 },
  { id: 'r2', planType: 'general', tier: 'nuevo', rate: 4 },
];

function alumno(name: string, slots: Array<{ day: string; hour: string }>, startDate?: string): Assignment {
  return {
    id: `a_${name}`, teacherId: T, teacherName: 'Prof', teacherEmail: 'p@x.com',
    studentId: `s_${name}`, studentName: name, studentEmail: `${name}@x.com`,
    studentLevel: 'B1', slots, objetivo: '', plan: 'Inglés general',
    weeklyHours: slots.length, availability: '', notes: '',
    startDate, createdAt: '2026-01-01T00:00:00Z',
  };
}
const student = (name: string): Student => ({
  id: `s_${name}`, name, email: `${name}@x.com`, level: 'B1',
  plan: 'Inglés general', createdAt: '2026-01-01T00:00:00Z',
});
const log = (name: string, date: string, time: string): ClassJoinLog => ({
  id: `l_${name}_${date}_${time}`, teacherId: T, teacherName: 'Prof', studentName: name,
  scheduledDate: date, scheduledTime: time, clickedAt: `${date}T${time}:00Z`, punctuality: 'on_time',
});
const rec = (name: string, date: string, classType: ClassRecord['classType'], time = '10:00'): ClassRecord => ({
  id: `r_${name}_${date}`, teacherId: T, teacherName: 'Prof', studentName: name,
  classDate: date, classTime: time, screenshotUrl: '', classType, createdAt: `${date}T20:00:00Z`,
});
const tx = (name: string, date: string): ClassTranscriptRef => ({
  id: `ca_${name}_${date}`, teacher_id: T, student_name: name, class_date: date,
  has_transcript: true, validation_status: 'auto_approved',
});

function armar(opts: {
  assignments: Assignment[];
  joinLogs?: ClassJoinLog[];
  classRecords?: ClassRecord[];
  analyses?: ClassTranscriptRef[];
  dropouts?: StudentDropout[];
  occupancy?: ReturnType<typeof gridOccupancyOfTeacher>;
}) {
  const joinLogs = opts.joinLogs ?? [];
  const classRecords = opts.classRecords ?? [];
  const analyses = opts.analyses ?? [];
  const gridOccupancy = opts.occupancy ?? EMPTY_GRID_OCCUPANCY;
  const finance = calculateTeacherFinance({
    teacherId: T, teacherName: 'Prof', monthYear: MES,
    assignments: opts.assignments, joinLogs, classRecords, classAnalyses: analyses,
    rates, scoringEvents: [], students: opts.assignments.map(a => student(a.studentName)),
    manualApprovals: [], payment: null, gridOccupancy,
  });
  const funnel = buildClassFunnel({
    monthYear: MES, teacherId: T, assignments: opts.assignments,
    joinLogs, classRecords, analyses, requests: [], dropouts: opts.dropouts ?? [],
    gridOccupancy, finance, todayIso: HOY, nowMinutes: NOW,
  });
  return { finance, funnel };
}

/** Las dos invariantes, en una sola aserción reutilizable. */
function invariantes(finance: ReturnType<typeof calculateTeacherFinance>, funnel: ReturnType<typeof buildClassFunnel>) {
  expect(funnelIsConsistent(funnel), 'la suma de las ramas debe dar el total').toBe(true);
  expect(funnelPayableTotal(funnel), 'pagables del embudo == pagables de finanzas').toBe(finance.totalPagable);
}

describe('el embudo cuadra', () => {
  it('profesor sin alumnos', () => {
    const { finance, funnel } = armar({ assignments: [] });
    invariantes(finance, funnel);
    expect(funnel.total).toBe(0);
  });

  it('alumno en el calendario, mes sin ningún dato', () => {
    // Martes de agosto de 2026: 4, 11, 18, 25.
    const { finance, funnel } = armar({ assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }], '2026-01-01')] });
    invariantes(finance, funnel);
    expect(funnel.total).toBe(4);
    expect(funnel.branches.find(b => b.key === 'sin_ingreso')!.count).toBe(4);
  });

  it('alumno SIN fecha de inicio: cae a createdAt y no proyecta antes', () => {
    const a = alumno('Ana', [{ day: 'Martes', hour: '10:00' }], undefined);
    const { finance, funnel } = armar({ assignments: [{ ...a, createdAt: '2026-08-12T00:00:00Z' }] });
    invariantes(finance, funnel);
    // Solo 18 y 25: el 4 y el 11 son anteriores al alta.
    expect(funnel.total).toBe(2);
  });

  it('alumno con fecha de inicio FUTURA: no genera nada', () => {
    const { finance, funnel } = armar({ assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }], '2026-09-15')] });
    invariantes(finance, funnel);
    expect(funnel.total).toBe(0);
  });

  it('alumno dado de baja a mitad de mes: solo hasta la baja', () => {
    const { finance, funnel } = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }], '2026-01-01')],
      dropouts: [{ teacherId: T, studentName: 'Ana', droppedAt: '2026-08-12T10:00:00Z' }],
    });
    invariantes(finance, funnel);
    // 4 y 11 sí; 18 y 25 no. El día de la baja se incluye.
    expect(funnel.total).toBe(2);
  });

  it('clase con ingreso y transcript: pagable', () => {
    const { finance, funnel } = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }], '2026-01-01')],
      joinLogs: [log('Ana', '2026-08-04', '10:00')],
      analyses: [tx('Ana', '2026-08-04')],
    });
    invariantes(finance, funnel);
    expect(finance.totalPagable).toBe(1);
    const con = funnel.branches.find(b => b.key === 'con_ingreso')!;
    expect(con.children!.find(c => c.key === 'pagables')!.count).toBe(1);
  });

  it('clase con ingreso SIN transcript: pendiente, no pagable', () => {
    const { finance, funnel } = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }], '2026-01-01')],
      joinLogs: [log('Ana', '2026-08-04', '10:00')],
    });
    invariantes(finance, funnel);
    expect(finance.totalPagable).toBe(0);
    const con = funnel.branches.find(b => b.key === 'con_ingreso')!;
    expect(con.children!.find(c => c.key === 'pendientes')!.count).toBe(1);
  });

  it('FALTA SIN AVISO sobre una celda agendada — el caso que rompió la v1', () => {
    // Tiene constancia y celda, pero NO tiene ingreso. Clasificando por el clic
    // caía fuera de las dos ramas y el embudo perdía una clase pagable.
    const { finance, funnel } = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }], '2026-01-01')],
      classRecords: [rec('Ana', '2026-08-04', 'falta_sin_aviso')],
    });
    invariantes(finance, funnel);
    expect(finance.totalPagable).toBe(1);
    // Cae en "con registro", no en "sin ingreso" ni en "fuera del calendario".
    const con = funnel.branches.find(b => b.key === 'con_ingreso')!;
    expect(con.count).toBe(1);
    expect(funnel.branches.find(b => b.key === 'fuera_calendario')!.count).toBe(0);
  });

  it('RECUPERACIÓN fuera del horario: rama "fuera del calendario"', () => {
    // Miércoles, cuando su horario es el martes.
    const { finance, funnel } = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }], '2026-01-01')],
      joinLogs: [log('Ana', '2026-08-05', '16:00')],
      analyses: [tx('Ana', '2026-08-05')],
    });
    invariantes(finance, funnel);
    expect(funnel.branches.find(b => b.key === 'fuera_calendario')!.count).toBe(1);
  });

  it('SESIÓN DE 2H: cuenta 2 en el embudo y 2 en finanzas', () => {
    const occ = gridOccupancyOfTeacher({
      upcomingClasses: [
        { studentName: 'Ana', day: 'Martes', time: '10:00' },
        { studentName: 'Ana', day: 'Martes', time: '11:00' },
      ],
    });
    const { finance, funnel } = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }, { day: 'Martes', hour: '11:00' }], '2026-01-01')],
      joinLogs: [log('Ana', '2026-08-04', '10:00')],
      analyses: [tx('Ana', '2026-08-04')],
      occupancy: occ,
    });
    invariantes(finance, funnel);
    expect(finance.totalPagable).toBe(2);
    const con = funnel.branches.find(b => b.key === 'con_ingreso')!;
    expect(con.children!.find(c => c.key === 'pagables')!.count).toBe(2);
  });

  it('mezcla completa: pagables, pendientes, sin ingreso y fuera del calendario', () => {
    const { finance, funnel } = armar({
      assignments: [
        alumno('Ana', [{ day: 'Martes', hour: '10:00' }], '2026-01-01'),
        alumno('Beto', [{ day: 'Jueves', hour: '12:00' }], '2026-01-01'),
      ],
      joinLogs: [
        log('Ana', '2026-08-04', '10:00'),   // pagable (con tx)
        log('Ana', '2026-08-11', '10:00'),   // pendiente (sin tx)
        log('Beto', '2026-08-19', '18:00'),  // fuera del calendario (miércoles)
      ],
      analyses: [tx('Ana', '2026-08-04'), tx('Beto', '2026-08-19')],
    });
    invariantes(finance, funnel);
    const b = Object.fromEntries(funnel.branches.map(x => [x.key, x]));
    expect(b.con_ingreso.count).toBe(2);
    expect(b.fuera_calendario.count).toBe(1);
    // Ana: 4 martes − 2 con ingreso = 2 · Beto: 4 jueves = 4
    expect(b.sin_ingreso.count).toBe(6);
    expect(funnel.total).toBe(9);
  });
});
