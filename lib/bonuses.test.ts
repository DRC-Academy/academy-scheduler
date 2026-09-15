import { describe, it, expect } from 'vitest';
import type { Assignment, Teacher, TeacherBonus, FinancePayment } from '@/types';
import { buildBonusRows, bonusesForMonth, bonusCounters, accrualMonthFor, nextMonthYear } from './bonuses';
import { retentionDaysLeft, retentionDueIso, retentionStartIso, isRetentionBonusDue, hasRetentionBonus } from './retention';

// Hoy fijo: 14/09/2026 a las 12:00 en España (10:00 UTC).
const HOY = new Date('2026-09-14T10:00:00Z');

function teacher(id: string, archivedAt?: string): Teacher {
  return { id, name: id.toUpperCase(), archivedAt } as unknown as Teacher;
}

function asg(p: Partial<Assignment> & { id: string; teacherId: string; studentName: string }): Assignment {
  return {
    teacherName: p.teacherId, teacherEmail: '', studentId: `s_${p.id}`, studentEmail: '', studentLevel: 'B1',
    slots: [], objetivo: '', plan: '', weeklyHours: 1, availability: '', notes: '',
    createdAt: '2026-06-20T10:00:00Z',
    ...p,
  } as Assignment;
}

function bonus(p: Partial<TeacherBonus> & { id: string; teacherId: string; studentName: string; status: TeacherBonus['status'] }): TeacherBonus {
  return { bonusType: 'retencion_6m', euros: 30, createdAt: '2026-09-01T00:00:00Z', ...p };
}

const T = [teacher('t9'), teacher('t10'), teacher('t1'), teacher('t5', '2026-09-08')];

describe('retention.ts: el reloj corre desde teacher_since, en hora de España', () => {
  it('teacher_since manda sobre start_date y created_at', () => {
    const a = asg({ id: 'a', teacherId: 't9', studentName: 'Ana', teacherSince: '2026-03-18', startDate: '2025-01-01' });
    expect(retentionStartIso(a)).toBe('2026-03-18');
    expect(retentionDueIso(a)).toBe('2026-09-14');
    expect(retentionDaysLeft(a, HOY)).toBe(0);
  });

  it('sin teacher_since cae a start_date y después a created_at (fecha de España)', () => {
    expect(retentionStartIso(asg({ id: 'b', teacherId: 't9', studentName: 'B', startDate: '2026-01-15' }))).toBe('2026-01-15');
    // created_at a las 23:30 UTC del 19/06 es ya el 20/06 en Madrid (verano, UTC+2).
    expect(retentionStartIso(asg({ id: 'c', teacherId: 't9', studentName: 'C', createdAt: '2026-06-19T23:30:00Z' }))).toBe('2026-06-20');
  });

  it('180 días exactos: cumple el día 180, no antes', () => {
    const a = asg({ id: 'd', teacherId: 't9', studentName: 'D', teacherSince: '2026-03-19' });
    expect(retentionDaysLeft(a, HOY)).toBe(1);
    expect(isRetentionBonusDue(a, [], HOY)).toBe(false);
    const b = asg({ id: 'e', teacherId: 't9', studentName: 'E', teacherSince: '2026-03-18' });
    expect(isRetentionBonusDue(b, [], HOY)).toBe(true);
  });

  it('un bono no rechazado bloquea el par; uno rechazado no', () => {
    const a = asg({ id: 'f', teacherId: 't9', studentName: 'Álvaro  Pérez', teacherSince: '2026-01-01' });
    const externo = bonus({ id: 'x', teacherId: 't9', studentName: 'alvaro perez', status: 'pagado_externo' });
    expect(hasRetentionBonus([externo], 'Álvaro Pérez', 't9')).toBe(true);
    expect(isRetentionBonusDue(a, [externo], HOY)).toBe(false);
    const rechazado = bonus({ id: 'y', teacherId: 't9', studentName: 'Álvaro Pérez', status: 'rechazado' });
    expect(isRetentionBonusDue(a, [rechazado], HOY)).toBe(true);
    // El mismo alumno con OTRO profesor no está bloqueado por este bono.
    expect(hasRetentionBonus([externo], 'Álvaro Pérez', 't10')).toBe(false);
  });
});

describe('buildBonusRows: una fila por par con su estado', () => {
  const assignments = [
    asg({ id: 'disp', teacherId: 't9', studentName: 'Disponible', teacherSince: '2026-02-01' }),
    asg({ id: 'prox', teacherId: 't9', studentName: 'Proximo', teacherSince: '2026-03-25' }),     // cumple el 21/09: faltan 7
    asg({ id: 'lejos', teacherId: 't9', studentName: 'Lejos', teacherSince: '2026-08-01' }),      // faltan meses
    asg({ id: 'recl', teacherId: 't10', studentName: 'Reclamada', teacherSince: '2026-01-01' }),
    asg({ id: 'inac', teacherId: 't9', studentName: 'Inactiva', teacherSince: '2026-01-01', status: 'inactive' }),
    asg({ id: 'test', teacherId: 't1', studentName: 'De prueba', teacherSince: '2026-01-01' }),
    asg({ id: 'arch', teacherId: 't5', studentName: 'Del archivado', teacherSince: '2026-01-01' }),
  ];
  const bonuses = [
    bonus({ id: 'b1', teacherId: 't10', studentName: 'Reclamada', assignmentId: 'recl', status: 'reclamado', claimedAt: '2026-09-10T10:00:00Z' }),
    bonus({ id: 'b2', teacherId: 't9', studentName: 'Historico Sin Asignacion', status: 'pagado_externo', paidMonth: '2026-06' }),
    bonus({ id: 'b3', teacherId: 't9', studentName: 'Disponible', status: 'rechazado', approvedAt: '2026-09-01T10:00:00Z', note: 'error' }),
    bonus({ id: 'b4', teacherId: 't10', studentName: 'Reclamada', bonusType: 'upsell', euros: 20, status: 'aprobado', approvedAt: '2026-09-02T10:00:00Z' }),
  ];

  it('clasifica disponible / próximo / en curso / reclamado', () => {
    const rows = buildBonusRows({ assignments, bonuses, teachers: T, now: HOY });
    const estadoDe = (name: string) => rows.filter(r => r.studentName === name).map(r => r.estado);
    expect(estadoDe('Disponible')).toEqual(['disponible', 'rechazado']);   // el rechazo queda como historial
    expect(estadoDe('Proximo')).toEqual(['proximo']);
    expect(estadoDe('Lejos')).toEqual(['en_curso']);   // visible para el admin, sin ser un bono todavía
    expect(estadoDe('Reclamada').sort()).toEqual(['aprobado', 'reclamado']); // retención reclamada + upsell aprobado
    expect(estadoDe('Historico Sin Asignacion')).toEqual(['pagado_externo']);
    expect(rows.find(r => r.studentName === 'Proximo')?.daysLeft).toBe(7);
    expect(rows.find(r => r.studentName === 'Proximo')?.dueDate).toBe('2026-09-21');
  });

  it('en la lista global no entran inactivas, ni lo calculado de cuentas de prueba o archivados', () => {
    const rows = buildBonusRows({ assignments, bonuses, teachers: T, now: HOY });
    expect(rows.some(r => r.studentName === 'Inactiva')).toBe(false);
    expect(rows.some(r => r.teacherId === 't1')).toBe(false);
    expect(rows.some(r => r.studentName === 'Del archivado')).toBe(false);
    // Pero una fila REAL de una cuenta de prueba (reclamada) sí se ve: es un registro.
    const reclamadoDePrueba = bonus({ id: 'bt', teacherId: 't1', studentName: 'De prueba', assignmentId: 'test', status: 'reclamado', claimedAt: '2026-09-14T10:00:00Z' });
    const conPrueba = buildBonusRows({ assignments, bonuses: [...bonuses, reclamadoDePrueba], teachers: T, now: HOY });
    expect(conPrueba.filter(r => r.teacherId === 't1').map(r => r.estado)).toEqual(['reclamado']);
  });

  it('pidiendo UN profesor sí se ve la cuenta de prueba (para probar el circuito)', () => {
    const rows = buildBonusRows({ assignments, bonuses, teachers: T, teacherId: 't1', now: HOY });
    expect(rows.map(r => r.studentName)).toEqual(['De prueba']);
    expect(rows[0].estado).toBe('disponible');
  });

  it('orden: reclamados, disponibles, historial, y al final lo que aún no cumplió', () => {
    const estados = buildBonusRows({ assignments, bonuses, teachers: T, now: HOY }).map(r => r.estado);
    expect(estados.slice(0, 2)).toEqual(['reclamado', 'disponible']);
    expect(estados.slice(-2)).toEqual(['proximo', 'en_curso']);
  });

  it('las cifras cuentan reclamados, próximos y disponibles', () => {
    const rows = buildBonusRows({ assignments, bonuses, teachers: T, now: HOY });
    expect(bonusCounters(rows)).toEqual({ reclamados: 1, proximos: 1, disponibles: 1 });
  });
});

describe('bonusesForMonth y accrualMonthFor: en qué liquidación entra un bono', () => {
  const pago = (monthYear: string, paid: boolean): FinancePayment => ({
    id: `fp_t9_${monthYear}`, teacherId: 't9', teacherName: 'T9', monthYear,
    totalClassesPayable: 0, totalAmount: 0, bonusAmount: 0,
    status: paid ? 'paid' : 'pending', paidAt: paid ? '2026-09-05T10:00:00Z' : undefined,
  });
  const pagadoSep   = bonus({ id: 'a', teacherId: 't9', studentName: 'A', status: 'pagado', approvedAt: '2026-09-10T10:00:00Z', paidMonth: '2026-09' });
  const pagadoOct   = bonus({ id: 'b', teacherId: 't9', studentName: 'B', status: 'pagado', approvedAt: '2026-09-28T10:00:00Z', paidMonth: '2026-10' });
  const externo     = bonus({ id: 'c', teacherId: 't9', studentName: 'C', status: 'pagado_externo', paidMonth: '2026-09' });
  const reclamado   = bonus({ id: 'e', teacherId: 't9', studentName: 'E', status: 'reclamado', claimedAt: '2026-09-10T10:00:00Z' });
  const otroProfe   = bonus({ id: 'f', teacherId: 't10', studentName: 'F', status: 'pagado', approvedAt: '2026-09-10T10:00:00Z', paidMonth: '2026-09' });

  it('suma los pagados con ese paid_month, desde la app o por email antes de ella; nunca los reclamados ni los de otro profesor', () => {
    const todos = [pagadoSep, pagadoOct, externo, reclamado, otroProfe];
    expect(bonusesForMonth(todos, 't9', '2026-09').map(b => b.id)).toEqual(['a', 'c']);
    expect(bonusesForMonth(todos, 't9', '2026-10').map(b => b.id)).toEqual(['b']);
    // Un histórico sin mes asignado no puede caer en ninguna liquidación.
    const sinMes = bonus({ id: 'g', teacherId: 't9', studentName: 'G', status: 'pagado_externo' });
    expect(bonusesForMonth([sinMes], 't9', '2026-09')).toEqual([]);
  });

  it('marcado en un mes abierto: entra en ese mes', () => {
    expect(accrualMonthFor(null, HOY)).toBe('2026-09');
    expect(accrualMonthFor(pago('2026-09', false), HOY)).toBe('2026-09');
  });

  it('marcado cuando Finanzas ya cerró el mes: pasa al siguiente', () => {
    expect(accrualMonthFor(pago('2026-09', true), HOY)).toBe('2026-10');
    // Un pago cerrado de OTRO mes no cuenta.
    expect(accrualMonthFor(pago('2026-08', true), HOY)).toBe('2026-09');
  });

  it('el mes en curso se corta en hora de España', () => {
    // 30/09 a las 22:30 UTC = 1/10 00:30 en Madrid → octubre.
    expect(accrualMonthFor(null, new Date('2026-09-30T22:30:00Z'))).toBe('2026-10');
    expect(nextMonthYear('2026-12')).toBe('2027-01');
  });
});
