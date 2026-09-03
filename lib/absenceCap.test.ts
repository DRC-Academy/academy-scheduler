// El tope de 2 faltas sin aviso por alumno y mes cuenta CLASES, no filas.
//
// La auditoría de agosto de 2026 encontró 5 registros duplicados del mismo día
// (el profesor volvía a marcar la falta porque la fila seguía diciendo "pendiente
// de transcript"). Contándolos por separado, 3 alumnos quedaban falsamente en el
// tope y la siguiente falta REAL del mes no se pagaba. Los duplicados se
// conservan como constancia, así que el contador tiene que ser inmune a ellos.
import { describe, it, expect } from 'vitest';
import {
  studentAbsencesInMonth, studentAbsenceDatesInMonth, canMarkStudentAbsence,
  calculateTeacherFinance, ABSENCE_MONTHLY_CAP,
} from '@/lib/finance';
import { EMPTY_GRID_OCCUPANCY } from '@/lib/teacherClasses';
import type { ClassRecord, Assignment, FinanceRate, Student } from '@/types';

const T = 't1';

function falta(id: string, date: string, createdAt: string, time = '20:00'): ClassRecord {
  return {
    id, teacherId: T, teacherName: 'Jimena', studentName: 'Marc Caudevilla Reina',
    classDate: date, classTime: time, screenshotUrl: '',
    classType: 'falta_sin_aviso', createdAt,
  };
}

describe('tope de faltas sin aviso', () => {
  // El caso real: Jimena · Marc Caudevilla, 2026-08-05 marcada TRES veces.
  const triplicada = [
    falta('a', '2026-08-05', '2026-08-05T19:12:00Z'),
    falta('b', '2026-08-05', '2026-08-25T15:16:00Z'),
    falta('c', '2026-08-05', '2026-08-25T17:05:00Z'),
  ];

  it('cuenta una sola clase aunque haya tres registros del mismo día', () => {
    expect(studentAbsencesInMonth(triplicada, T, 'Marc Caudevilla Reina', '2026-08')).toHaveLength(1);
    expect(studentAbsenceDatesInMonth(triplicada, T, 'Marc Caudevilla Reina', '2026-08')).toHaveLength(1);
  });

  it('deja marcar otra falta: el alumno tiene 1 clase perdida, no 3', () => {
    const cap = canMarkStudentAbsence(triplicada, T, 'Marc Caudevilla Reina', '2026-08');
    expect(cap.count).toBe(1);
    expect(cap.allowed).toBe(true);
    expect(cap.remaining).toBe(ABSENCE_MONTHLY_CAP - 1);
  });

  it('agrupa conservando TODOS los registros de cada fecha', () => {
    const grupos = studentAbsenceDatesInMonth(triplicada, T, 'Marc Caudevilla Reina', '2026-08');
    expect(grupos[0].date).toBe('2026-08-05');
    expect(grupos[0].records.map(r => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('el duplicado con hora distinta tampoco cuenta dos veces', () => {
    // Silvia · Paula Tatiana: la misma clase marcada a las 21:00 y a las 12:00.
    const mismaFechaOtraHora = [
      falta('x', '2026-08-18', '2026-08-18T22:50:00Z', '21:00'),
      falta('y', '2026-08-18', '2026-08-19T10:15:00Z', '12:00'),
    ];
    expect(canMarkStudentAbsence(mismaFechaOtraHora, T, 'Marc Caudevilla Reina', '2026-08').count).toBe(1);
  });

  it('dos faltas de días distintos sí llegan al tope', () => {
    const dosClases = [
      falta('a', '2026-08-05', '2026-08-05T19:12:00Z'),
      falta('b', '2026-08-12', '2026-08-12T19:12:00Z'),
    ];
    const cap = canMarkStudentAbsence(dosClases, T, 'Marc Caudevilla Reina', '2026-08');
    expect(cap.count).toBe(2);
    expect(cap.allowed).toBe(false);
  });

  it('las faltas revertidas por el admin no cuentan', () => {
    const conRevertida: ClassRecord[] = [
      falta('a', '2026-08-05', '2026-08-05T19:12:00Z'),
      { ...falta('b', '2026-08-12', '2026-08-12T19:12:00Z'), classType: 'falta_sin_aviso_revertida' },
    ];
    expect(canMarkStudentAbsence(conRevertida, T, 'Marc Caudevilla Reina', '2026-08').count).toBe(1);
  });
});

describe('el duplicado ya no quema cupo en el pago', () => {
  const asgn: Assignment = {
    id: 'a1', teacherId: T, teacherName: 'Jimena', teacherEmail: 'j@x.com',
    studentId: 's1', studentName: 'Marc Caudevilla Reina', studentEmail: 'm@x.com',
    studentLevel: 'B1', slots: [{ day: 'Miércoles', hour: '20:00' }],
    objetivo: '', plan: 'Inglés general', weeklyHours: 1,
    availability: 'Miércoles 20:00', notes: '', startDate: '2026-01-01',
    createdAt: '2026-01-01T00:00:00Z',
  };
  const rates: FinanceRate[] = [{ id: 'r1', planType: 'general', tier: 'antiguo', rate: 5 }];
  const students: Student[] = [{
    id: 's1', name: 'Marc Caudevilla Reina', email: 'm@x.com',
    level: 'B1', plan: 'Inglés general', createdAt: '2026-01-01T00:00:00Z',
  }];

  const calc = (classRecords: ClassRecord[], monthYear = '2026-08') => calculateTeacherFinance({
    teacherId: T, teacherName: 'Jimena', monthYear,
    assignments: [asgn], joinLogs: [], classRecords, classAnalyses: [],
    rates, scoringEvents: [], students, manualApprovals: [], payment: null,
    gridOccupancy: EMPTY_GRID_OCCUPANCY,
  });

  it('la tercera falta REAL del mes se paga aunque haya duplicados antes', () => {
    // Una clase marcada dos veces + otras dos clases distintas. Antes, los dos
    // registros del día 5 gastaban el cupo entero y el día 19 caía en
    // 'excede_limite_tipo': el profesor perdía una clase que sí dio.
    const rows = calc([
      falta('dup1', '2026-08-05', '2026-08-05T19:12:00Z'),
      falta('dup2', '2026-08-05', '2026-08-25T15:16:00Z'),
      falta('otra', '2026-08-12', '2026-08-12T19:12:00Z'),
    ]).rows;

    const dia5  = rows.find(r => r.date === '2026-08-05');
    const dia12 = rows.find(r => r.date === '2026-08-12');
    expect(dia5?.status).toBe('pagable');
    expect(dia12?.status).toBe('pagable');
  });

  it('el tope sigue aplicándose a la TERCERA clase distinta', () => {
    const rows = calc([
      falta('a', '2026-08-05', '2026-08-05T19:12:00Z'),
      falta('b', '2026-08-12', '2026-08-12T19:12:00Z'),
      falta('c', '2026-08-19', '2026-08-19T19:12:00Z'),
    ]).rows;
    expect(rows.find(r => r.date === '2026-08-19')?.status).toBe('excede_limite_tipo');
  });

  it('una clase marcada dos veces produce UNA sola fila', () => {
    const rows = calc([
      falta('dup1', '2026-08-05', '2026-08-05T19:12:00Z'),
      falta('dup2', '2026-08-05', '2026-08-25T15:16:00Z'),
    ]).rows;
    expect(rows.filter(r => r.date === '2026-08-05')).toHaveLength(1);
  });

  // El tope es MENSUAL, no de por vida: 2 en agosto, otras 2 en septiembre. Un
  // tope por historial dejaría a un alumno de dos años sin poder faltar nunca
  // más, y con los datos de producción de septiembre de 2026 habría bloqueado a
  // 22 alumnos que sí tenían su cupo del mes intacto.
  describe('el tope se reinicia con el mes', () => {
    const agostoLleno = [
      falta('ago1', '2026-08-05', '2026-08-05T19:12:00Z'),
      falta('ago2', '2026-08-12', '2026-08-12T19:12:00Z'),
    ];
    const septiembre = [
      falta('sep1', '2026-09-02', '2026-09-02T19:12:00Z'),
      falta('sep2', '2026-09-09', '2026-09-09T19:12:00Z'),
    ];
    const A = 'Marc Caudevilla Reina';

    it('agosto al tope no gasta el cupo de septiembre', () => {
      const cap = canMarkStudentAbsence(agostoLleno, T, A, '2026-09');
      expect(cap.count).toBe(0);
      expect(cap.allowed).toBe(true);
      expect(cap.remaining).toBe(ABSENCE_MONTHLY_CAP);
    });

    it('las dos de septiembre se pagan aunque agosto llegara al tope', () => {
      const rows = calc([...agostoLleno, ...septiembre], '2026-09').rows;
      expect(rows.find(r => r.date === '2026-09-02')?.status).toBe('pagable');
      expect(rows.find(r => r.date === '2026-09-09')?.status).toBe('pagable');
    });

    it('el alumno al tope queda bloqueado SOLO en su mes', () => {
      const todo = [...agostoLleno, ...septiembre];
      expect(canMarkStudentAbsence(todo, T, A, '2026-08').allowed).toBe(false);
      expect(canMarkStudentAbsence(todo, T, A, '2026-09').allowed).toBe(false);
      expect(canMarkStudentAbsence(todo, T, A, '2026-10').allowed).toBe(true);
    });

    it('una revertida devuelve el cupo de ese mes, no del historial', () => {
      const conRevertida: ClassRecord[] = [
        ...agostoLleno,
        { ...falta('sep1', '2026-09-02', '2026-09-02T19:12:00Z'), classType: 'falta_sin_aviso_revertida' },
        falta('sep2', '2026-09-09', '2026-09-09T19:12:00Z'),
      ];
      expect(canMarkStudentAbsence(conRevertida, T, A, '2026-09').count).toBe(1);
      expect(canMarkStudentAbsence(conRevertida, T, A, '2026-09').allowed).toBe(true);
    });
  });
});
