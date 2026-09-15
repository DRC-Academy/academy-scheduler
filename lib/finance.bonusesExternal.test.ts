// Los bonos pagados FUERA del sistema (pagado_externo, los históricos por email)
// se exponen en la liquidación para poder verlos, pero no son dinero que la app
// deba: estos tests fijan que su presencia no mueve ni un céntimo de ningún
// total, que es lo único que podría salir mal al añadirlos al resultado.
import { describe, it, expect } from 'vitest';
import { calculateTeacherFinance } from '@/lib/finance';
import { EMPTY_GRID_OCCUPANCY } from '@/lib/teacherClasses';
import type { Assignment, ClassJoinLog, FinanceRate, Student, TeacherBonus, FinancePayment } from '@/types';
import type { ClassTranscriptRef } from '@/lib/finance';

const T = 't1';
const MES = '2026-06';
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
const bono = (p: Partial<TeacherBonus> & { id: string; status: TeacherBonus['status']; paidMonth: string }): TeacherBonus => ({
  teacherId: T, studentName: `Alumno ${p.id}`, bonusType: 'retencion_6m', euros: 30,
  createdAt: '2026-09-14T00:00:00Z', ...p,
});

// Dos martes de junio con ingreso y transcript: 2 clases pagables a 5 € = 10 €.
const MARTES = ['2026-06-02', '2026-06-09'];
function liquidar(teacherBonuses: TeacherBonus[], payment: FinancePayment | null = null) {
  return calculateTeacherFinance({
    teacherId: T, teacherName: 'Prof', monthYear: MES,
    assignments: [alumno('Ana')], joinLogs: MARTES.map(d => log('Ana', d)),
    classRecords: [], classAnalyses: MARTES.map(d => tx('Ana', d)), rates,
    scoringEvents: [], teacherBonuses, students: [student('Ana')],
    manualApprovals: [], payment, gridOccupancy: EMPTY_GRID_OCCUPANCY,
  });
}

const externosJunio = [
  bono({ id: 'e1', status: 'pagado_externo', paidMonth: '2026-06' }),
  bono({ id: 'e2', status: 'pagado_externo', paidMonth: '2026-06', bonusType: 'upsell', euros: 20 }),
];
const externoJulio = bono({ id: 'e3', status: 'pagado_externo', paidMonth: '2026-07' });
const pagadoApp = bono({ id: 'p1', status: 'pagado', paidMonth: '2026-06', approvedAt: '2026-06-20T10:00:00Z' });

describe('bonos pagados fuera del sistema en la liquidación', () => {
  it('se listan y se suman aparte, solo los del mes pedido', () => {
    const r = liquidar([...externosJunio, externoJulio]);
    expect(r.bonusRowsExternal.map(b => b.id)).toEqual(['e1', 'e2']);
    expect(r.bonusExternalEuros).toBe(50);
  });

  it('no mueven ningún total: el resultado es idéntico al de un mes sin ellos', () => {
    const sin = liquidar([]);
    const con = liquidar([...externosJunio, externoJulio]);
    expect(sin.bonusRowsExternal).toEqual([]);
    expect(sin.bonusExternalEuros).toBe(0);
    // Todo igual salvo los dos campos informativos.
    expect(con).toEqual({ ...sin, bonusRowsExternal: externosJunio, bonusExternalEuros: 50 });
    // Y los totales son los de las clases, nada más.
    expect(con.montoPagable).toBe(10);
    expect(con.bonusFromBonuses).toBe(0);
    expect(con.bonusRows).toEqual([]);
    expect(con.totalAPagar).toBe(10);
  });

  it('conviven con un bono pagado desde la app sin mezclarse', () => {
    const r = liquidar([...externosJunio, pagadoApp]);
    expect(r.bonusRows.map(b => b.id)).toEqual(['p1']);
    expect(r.bonusFromBonuses).toBe(30);
    expect(r.totalAPagar).toBe(40);            // 10 de clases + 30 del bono de la app
    expect(r.bonusRowsExternal.map(b => b.id)).toEqual(['e1', 'e2']);
    expect(r.bonusExternalEuros).toBe(50);     // fuera del total
  });

  it('con el mes ya liquidado, el total congelado tampoco los incluye', () => {
    const pago: FinancePayment = {
      id: `fp_${T}_${MES}`, teacherId: T, teacherName: 'Prof', monthYear: MES,
      totalClassesPayable: 2, totalAmount: 10, bonusAmount: 0, status: 'paid', paidAt: '2026-07-01T10:00:00Z',
    };
    const r = liquidar(externosJunio, pago);
    expect(r.paymentStatus).toBe('paid');
    expect(r.totalAPagar).toBe(10);
    expect(r.bonusExternalEuros).toBe(50);
  });
});
