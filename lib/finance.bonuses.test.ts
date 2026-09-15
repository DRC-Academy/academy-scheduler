// Los bonos en la liquidación: un bono pagado con mes asignado suma a ese mes,
// venga de la app ('pagado') o de antes de ella ('pagado_externo', los históricos
// por email). Es la regla que el director fijó el 15/09/2026 —bonos son bonos—
// y lo que estos tests protegen es que las dos vías den exactamente el mismo
// número, y que un mes ya liquidado no se mueva.
import { describe, it, expect } from 'vitest';
import { calculateTeacherFinance } from '@/lib/finance';
import { EMPTY_GRID_OCCUPANCY } from '@/lib/teacherClasses';
import type { Assignment, ClassJoinLog, FinanceRate, Student, TeacherBonus, FinancePayment } from '@/types';
import type { ClassTranscriptRef } from '@/lib/finance';

const T = 't1';
const MES = '2026-08';
const rates: FinanceRate[] = [{ id: 'r1', planType: 'general', tier: 'antiguo', rate: 5 }];

const alumno = (name: string): Assignment => ({
  id: `a_${name}`, teacherId: T, teacherName: 'Prof', teacherEmail: 'p@x.com',
  studentId: `s_${name}`, studentName: name, studentEmail: `${name}@x.com`,
  studentLevel: 'B1', slots: [{ day: 'Martes', hour: '10:00' }], objetivo: '', plan: 'Inglés general',
  weeklyHours: 1, availability: '', notes: '',
  startDate: '2026-01-01', createdAt: '2026-01-01T00:00:00Z',
});
const student = (name: string): Student => ({
  id: `s_${name}`, name, email: `${name}@x.com`, level: 'B1',
  plan: 'Inglés general', createdAt: '2026-01-01T00:00:00Z',
});
const log = (name: string, date: string): ClassJoinLog => ({
  id: `l_${name}_${date}`, teacherId: T, teacherName: 'Prof', studentName: name,
  scheduledDate: date, scheduledTime: '10:00', clickedAt: `${date}T10:00:00Z`, punctuality: 'on_time',
});
const tx = (name: string, date: string): ClassTranscriptRef => ({
  id: `ca_${name}_${date}`, teacher_id: T, student_name: name, class_date: date,
  has_transcript: true, validation_status: 'auto_approved',
});
const bono = (p: Partial<TeacherBonus> & { id: string; status: TeacherBonus['status']; paidMonth?: string | null }): TeacherBonus => ({
  teacherId: T, studentName: `Alumno ${p.id}`, bonusType: 'retencion_6m', euros: 30,
  createdAt: '2026-09-14T00:00:00Z', ...p,
});

// Dos martes de agosto con ingreso y transcript: 2 clases pagables a 5 € = 10 €.
const MARTES = ['2026-08-04', '2026-08-11'];
function liquidar(teacherBonuses: TeacherBonus[], payment: FinancePayment | null = null) {
  return calculateTeacherFinance({
    teacherId: T, teacherName: 'Prof', monthYear: MES,
    assignments: [alumno('Ana')], joinLogs: MARTES.map(d => log('Ana', d)),
    classRecords: [], classAnalyses: MARTES.map(d => tx('Ana', d)), rates,
    scoringEvents: [], teacherBonuses, students: [student('Ana')],
    manualApprovals: [], payment, gridOccupancy: EMPTY_GRID_OCCUPANCY,
  });
}

const historicoAgo = bono({ id: 'h1', status: 'pagado_externo', paidMonth: '2026-08' });
const historicoJul = bono({ id: 'h2', status: 'pagado_externo', paidMonth: '2026-07' });
const historicoSinMes = bono({ id: 'h3', status: 'pagado_externo', paidMonth: null });
const appAgo = bono({ id: 'p1', status: 'pagado', paidMonth: '2026-08', approvedAt: '2026-08-20T10:00:00Z' });
const reclamado = bono({ id: 'r1', status: 'reclamado', claimedAt: '2026-08-20T10:00:00Z' });

describe('bonos en la liquidación: bonos son bonos', () => {
  it('un histórico pagado por email suma a su mes exactamente igual que uno pagado desde la app', () => {
    const porEmail = liquidar([historicoAgo]);
    const porApp = liquidar([appAgo]);
    expect(porEmail.bonusFromBonuses).toBe(30);
    expect(porEmail.totalAPagar).toBe(40);            // 10 de clases + 30 del bono
    expect(porEmail.bonusRows.map(b => b.id)).toEqual(['h1']);
    // Mismos números por las dos vías; solo cambia qué fila los compone.
    expect({ ...porApp, bonusRows: [] }).toEqual({ ...porEmail, bonusRows: [] });
  });

  it('solo cuentan los de ESTE mes con mes asignado; los reclamados y los de otro mes, no', () => {
    const r = liquidar([historicoAgo, historicoJul, historicoSinMes, appAgo, reclamado]);
    expect(r.bonusRows.map(b => b.id).sort()).toEqual(['h1', 'p1']);
    expect(r.bonusFromBonuses).toBe(60);
    expect(r.totalAPagar).toBe(70);
  });

  it('un mes ya liquidado no se mueve: el total congelado manda y el bono solo se ve en el desglose', () => {
    const pago: FinancePayment = {
      id: `fp_${T}_${MES}`, teacherId: T, teacherName: 'Prof', monthYear: MES,
      totalClassesPayable: 2, totalAmount: 10, bonusAmount: 0, status: 'paid', paidAt: '2026-09-01T10:00:00Z',
    };
    const r = liquidar([historicoAgo], pago);
    expect(r.paymentStatus).toBe('paid');
    expect(r.totalAPagar).toBe(10);
    expect(r.bonusFromBonuses).toBe(30);
    expect(r.bonusRows.map(b => b.id)).toEqual(['h1']);
  });
});
