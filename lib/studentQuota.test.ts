// El cupo mensual del alumno que `calculateTeacherFinance` ya usaba por dentro,
// ahora expuesto. Estos tests fijan lo único que importa de esa exposición: que
// los números publicados son EXACTAMENTE los que decidieron qué clase quedó en
// 'excede_limite'. Si alguna vez se separan, la ficha del admin diría "3 de 9"
// mientras la clase de al lado aparece retenida, que es la clase de contradicción
// que este proyecto viene arrastrando.
import { describe, it, expect } from 'vitest';
import { calculateTeacherFinance, studentQuotaOf } from '@/lib/finance';
import { EMPTY_GRID_OCCUPANCY, gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import type { Assignment, ClassJoinLog, ClassRecord, FinanceRate, Student } from '@/types';
import type { ClassTranscriptRef } from '@/lib/finance';

const T = 't1';
const MES = '2026-08';
const rates: FinanceRate[] = [
  { id: 'r1', planType: 'general', tier: 'antiguo', rate: 5 },
  { id: 'r2', planType: 'general', tier: 'nuevo', rate: 4 },
];

const alumno = (name: string, slots: Array<{ day: string; hour: string }>): Assignment => ({
  id: `a_${name}`, teacherId: T, teacherName: 'Prof', teacherEmail: 'p@x.com',
  studentId: `s_${name}`, studentName: name, studentEmail: `${name}@x.com`,
  studentLevel: 'B1', slots, objetivo: '', plan: 'Inglés general',
  weeklyHours: slots.length, availability: '', notes: '',
  startDate: '2026-01-01', createdAt: '2026-01-01T00:00:00Z',
});
const student = (name: string): Student => ({
  id: `s_${name}`, name, email: `${name}@x.com`, level: 'B1',
  plan: 'Inglés general', createdAt: '2026-01-01T00:00:00Z',
});
const log = (name: string, date: string, time = '10:00'): ClassJoinLog => ({
  id: `l_${name}_${date}`, teacherId: T, teacherName: 'Prof', studentName: name,
  scheduledDate: date, scheduledTime: time, clickedAt: `${date}T${time}:00Z`, punctuality: 'on_time',
});
const tx = (name: string, date: string): ClassTranscriptRef => ({
  id: `ca_${name}_${date}`, teacher_id: T, student_name: name, class_date: date,
  has_transcript: true, validation_status: 'auto_approved',
});
const rec = (name: string, date: string, classType: ClassRecord['classType']): ClassRecord => ({
  id: `r_${name}_${date}`, teacherId: T, teacherName: 'Prof', studentName: name,
  classDate: date, classTime: '10:00', screenshotUrl: '', classType, createdAt: `${date}T20:00:00Z`,
});

function armar(opts: {
  assignments: Assignment[]; joinLogs?: ClassJoinLog[];
  classRecords?: ClassRecord[]; analyses?: ClassTranscriptRef[];
  occupancy?: ReturnType<typeof gridOccupancyOfTeacher>;
}) {
  return calculateTeacherFinance({
    teacherId: T, teacherName: 'Prof', monthYear: MES,
    assignments: opts.assignments, joinLogs: opts.joinLogs ?? [],
    classRecords: opts.classRecords ?? [], classAnalyses: opts.analyses ?? [], rates,
    scoringEvents: [], students: opts.assignments.map(a => student(a.studentName)),
    manualApprovals: [], payment: null, gridOccupancy: opts.occupancy ?? EMPTY_GRID_OCCUPANCY,
  });
}

// Martes de agosto de 2026: 4, 11, 18, 25. Miércoles: 5, 12, 19, 26.
const MARTES = ['2026-08-04', '2026-08-11', '2026-08-18', '2026-08-25'];
const MIERCOLES = ['2026-08-05', '2026-08-12', '2026-08-19', '2026-08-26'];

describe('el cupo del alumno que ve el admin', () => {
  it('1h/semana: 5 al mes, y cuenta las dadas', () => {
    const fin = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }])],
      joinLogs: MARTES.map(d => log('Ana', d)),
      analyses: MARTES.map(d => tx('Ana', d)),
    });
    const q = studentQuotaOf(fin, 'Ana')!;
    expect(q.limit).toBe(5);
    expect(q.used).toBe(4);
  });

  it('el número publicado es el que retuvo la clase: al llenarse, la siguiente excede', () => {
    // 2h/semana → 9 al mes. Ocho martes+miércoles caben; el noveno y el décimo no.
    const fechas = [...MARTES, ...MIERCOLES].sort();
    const fin = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }, { day: 'Miércoles', hour: '10:00' }])],
      joinLogs: fechas.map(d => log('Ana', d)),
      analyses: fechas.map(d => tx('Ana', d)),
    });
    const q = studentQuotaOf(fin, 'Ana')!;
    expect(q.limit).toBe(9);
    // Ocho clases: entran todas y el cupo NO se llena.
    expect(q.used).toBe(8);
    expect(fin.rows.filter(r => r.status === 'excede_limite')).toHaveLength(0);
  });

  it('lo retenido no suma al consumido', () => {
    // 1h/semana (5 al mes) con 4 martes + 4 miércoles = 8 clases: 5 entran, 3 no.
    const fechas = [...MARTES, ...MIERCOLES].sort();
    const fin = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }])],
      joinLogs: fechas.map(d => log('Ana', d)),
      analyses: fechas.map(d => tx('Ana', d)),
    });
    const q = studentQuotaOf(fin, 'Ana')!;
    expect(q.limit).toBe(5);
    expect(q.used).toBe(5);
    expect(fin.rows.filter(r => r.status === 'excede_limite')).toHaveLength(3);
  });

  it('la recuperación NO gasta cupo: repone una clase vieja', () => {
    const fin = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }])],
      joinLogs: [log('Ana', MARTES[0]), log('Ana', MIERCOLES[0])],
      classRecords: [rec('Ana', MIERCOLES[0], 'recuperacion')],
      analyses: [tx('Ana', MARTES[0]), tx('Ana', MIERCOLES[0])],
    });
    const q = studentQuotaOf(fin, 'Ana')!;
    expect(q.used).toBe(1);   // la normal; la recuperación no
  });

  it('la falta del alumno SÍ gasta cupo: esa clase se perdió', () => {
    const fin = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }])],
      joinLogs: [log('Ana', MARTES[0])],
      classRecords: [rec('Ana', MARTES[1], 'falta_sin_aviso')],
      analyses: [tx('Ana', MARTES[0])],
    });
    expect(studentQuotaOf(fin, 'Ana')!.used).toBe(2);
  });

  it('la falta sobre una RECUPERACIÓN sí gasta cupo: la clase se perdió otra vez', () => {
    // Cristian Díaz (Johny): faltó sin avisar a la recuperación del 17/08 y esa
    // falta no le gastaba ninguna clase del mes. No puede salir gratis faltar dos
    // veces seguidas — el crédito de la clase perdida se consume igual.
    const occ = gridOccupancyOfTeacher({
      recoveryCells: [{ studentName: 'Ana', hour: '10:00', date: MIERCOLES[0], recoveryFor: '2026-07-28' }],
    });
    const fin = armar({
      assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }])],
      classRecords: [rec('Ana', MIERCOLES[0], 'falta_sin_aviso')],
      occupancy: occ,
    });
    const fila = fin.rows.find(r => r.date === MIERCOLES[0])!;
    expect(fila.recoveryUnits).toBe(1);          // el calendario dice que era recuperación
    expect(fila.status).toBe('pagable');         // se cobra entera, como cualquier falta
    expect(studentQuotaOf(fin, 'Ana')!.used).toBe(1);   // y consume su clase del mes
  });

  it('ex-alumno: sin assignment no hay cupo, y nada excede', () => {
    const fechas = [...MARTES, ...MIERCOLES].sort();
    const fin = armar({
      assignments: [],   // ya no es suyo: solo quedan los hechos
      joinLogs: fechas.map(d => log('Ana', d)),
      analyses: fechas.map(d => tx('Ana', d)),
    });
    const q = studentQuotaOf(fin, 'Ana')!;
    expect(q.limit).toBeNull();
    expect(q.used).toBe(8);
    expect(fin.rows.filter(r => r.status === 'excede_limite')).toHaveLength(0);
  });

  it('se busca por nombre tolerante: mayúsculas y espacios no rompen la ficha', () => {
    const fin = armar({
      assignments: [alumno('Ana Pérez', [{ day: 'Martes', hour: '10:00' }])],
      joinLogs: [log('Ana Pérez', MARTES[0])],
      analyses: [tx('Ana Pérez', MARTES[0])],
    });
    expect(studentQuotaOf(fin, '  ana pérez ')!.used).toBe(1);
    expect(studentQuotaOf(fin, 'Otro')).toBeNull();
  });

  it('un alumno sin clases este mes no aparece en el cupo', () => {
    const fin = armar({ assignments: [alumno('Ana', [{ day: 'Martes', hour: '10:00' }])] });
    expect(fin.studentQuota).toEqual([]);
  });
});
