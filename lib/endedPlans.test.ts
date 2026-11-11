import { describe, expect, it } from 'vitest';
import {
  findEndedPlans, endedWindow, addDays, pendingChannels, mergeChannels, cycleDone, isRenewalInProgress,
  ENDED_NOTICE_SINCE, type EndedStudentRow, type EndedAssignmentRow, type EndedTeacherRow,
} from '@/lib/endedPlans';

const TEACHERS: EndedTeacherRow[] = [
  { id: 't9', name: 'Laura', email: 'laura@x.com', notificationEmail: 'avisos-laura@x.com' },
  { id: 't8', name: 'Marta', email: 'marta@x.com' },
  { id: 't1', name: 'Sebastian (test)', email: 's@x.com', isTest: true },
  { id: 't7', name: 'Archivada', email: 'a@x.com', archivedAt: '2026-10-01' },
];

const alumno = (o: Partial<EndedStudentRow> = {}): EndedStudentRow => ({
  id: 's1', name: 'Ana Pérez', email: 'ana@x.com', phone: '+34600111222', productType: 'one_time',
  productName: 'Intensivo FCE — 12:00-13:00 · Lunes a jueves', wooProductId: 30782, manualActiveUntil: '2026-11-16', ...o,
});
const asg = (o: Partial<EndedAssignmentRow> = {}): EndedAssignmentRow => ({
  teacherId: 't9', studentId: 's1', studentEmail: 'ana@x.com', studentName: 'Ana Pérez', status: 'active', createdAt: '2026-08-01', ...o,
});
const run = (students: EndedStudentRow[], today = '2026-11-17', assignments = [asg()]) =>
  findEndedPlans({ students, assignments, teachers: TEACHERS, today });

describe('ventana', () => {
  it('ayer, con 3 días de margen', () => {
    expect(endedWindow('2026-11-20')).toEqual({ desde: '2026-11-17', hasta: '2026-11-19' });
  });
  it('nunca antes de la publicación', () => {
    expect(endedWindow('2026-11-12')).toEqual({ desde: ENDED_NOTICE_SINCE, hasta: '2026-11-11' });
    const w = endedWindow(ENDED_NOTICE_SINCE);
    expect(w.desde > w.hasta).toBe(true);          // el día de la publicación no mira nada
  });
  it('addDays cruza meses y años', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('quién entra', () => {
  it('venció ayer: entra, con plan del catálogo y su profe', () => {
    const { candidatos } = run([alumno()]);
    expect(candidatos).toHaveLength(1);
    expect(candidatos[0]).toMatchObject({
      endDate: '2026-11-16', planName: 'Intensivo FCE', pendientes: ['alumno', 'profe', 'equipo'],
      teacher: { id: 't9', name: 'Laura', email: 'avisos-laura@x.com' },
    });
  });

  it('vence hoy o en el futuro: no', () => {
    expect(run([alumno({ manualActiveUntil: '2026-11-17' })]).candidatos).toHaveLength(0);
    expect(run([alumno({ manualActiveUntil: '2026-12-01' })]).candidatos).toHaveLength(0);
  });

  it('dentro del margen sí; fuera del margen no', () => {
    expect(run([alumno({ manualActiveUntil: '2026-11-14' })]).candidatos).toHaveLength(1);
    expect(run([alumno({ manualActiveUntil: '2026-11-13' })]).candidatos).toHaveLength(0);
  });

  it('vencido antes de la publicación: nunca', () => {
    expect(run([alumno({ manualActiveUntil: '2026-11-10' })], '2026-11-12').candidatos).toHaveLength(0);
    expect(run([alumno({ manualActiveUntil: '2026-11-11' })], '2026-11-12').candidatos).toHaveLength(1);
  });

  it.each([
    ['cuenta de prueba', { isTest: true }],
    ['Oritalk', { isOritalk: true }],
    ['empresa', { companyPlanMonths: 6 }],
    ['empresa', { productName: 'Empresas Intensivos — 5h semanales', wooProductId: null }],
    ['programa fraccionado', { wooProductId: 35654 }],
    ['suscripción mensual', { wooProductId: 26744 }],
    ['sin email', { email: '' }],
  ])('fuera: %s', (motivo, o) => {
    const r = run([alumno(o as Partial<EndedStudentRow>)]);
    expect(r.candidatos).toHaveLength(0);
    expect(r.excluidos[0].motivo).toBe(motivo);
  });

  it('solo con profes de prueba: fuera', () => {
    const r = run([alumno()], '2026-11-17', [asg({ teacherId: 't1' })]);
    expect(r.excluidos[0].motivo).toBe('solo con profesores de prueba');
  });

  it('suscripción con activación manual: entra (Woo lo decide el job)', () => {
    const r = run([alumno({ productType: 'subscription', wooProductId: null, productName: 'Ingles General - 1h semanal' })]);
    expect(r.candidatos[0].planName).toBe('Ingles General - 1h semanal');
  });

  it('profe: la activa más reciente; nunca de prueba ni archivada; si no hay, null', () => {
    const asgs = [
      asg({ teacherId: 't8', status: 'inactive', createdAt: '2026-10-01' }),
      asg({ teacherId: 't7', status: 'active', createdAt: '2026-10-05' }),
      asg({ teacherId: 't9', status: 'active', createdAt: '2026-09-01' }),
    ];
    expect(run([alumno()], '2026-11-17', asgs).candidatos[0].teacher?.id).toBe('t9');
    expect(run([alumno()], '2026-11-17', [asg({ teacherId: 't8', status: 'inactive' })]).candidatos[0].teacher?.id).toBe('t8');
    expect(run([alumno()], '2026-11-17', []).candidatos[0].teacher).toBeNull();
  });

  it('aviso de 7 días del mismo ciclo: lo informa', () => {
    expect(run([alumno({ endingNoticeForDate: '2026-11-16' })]).candidatos[0].sevenDayNotice).toBe(true);
    expect(run([alumno({ endingNoticeForDate: '2026-08-16' })]).candidatos[0].sevenDayNotice).toBe(false);
  });
});

describe('no repetir', () => {
  it('ciclo completo: no vuelve a salir', () => {
    const s = alumno({ endedNoticeForDate: '2026-11-16', endedNoticeSentAt: '2026-11-17T12:00:00Z',
      endedNoticeCanales: { alumno: { estado: 'enviado' }, profe: { estado: 'enviado' }, equipo: { estado: 'enviado' } } });
    expect(run([s]).candidatos).toHaveLength(0);
  });

  it('solo se reintenta el que falló', () => {
    const s = alumno({ endedNoticeForDate: '2026-11-16', endedNoticeSentAt: null,
      endedNoticeCanales: { alumno: { estado: 'enviado' }, profe: { estado: 'error', error: 'x' }, equipo: { estado: 'enviado' } } });
    expect(pendingChannels(s, '2026-11-16')).toEqual(['profe']);
    expect(run([s], '2026-11-18').candidatos[0].pendientes).toEqual(['profe']);
  });

  it('ciclo nuevo (renovó y volvió a vencer): todos otra vez', () => {
    const s = alumno({ endedNoticeForDate: '2026-08-16', endedNoticeSentAt: '2026-08-17T12:00:00Z',
      endedNoticeCanales: { alumno: { estado: 'enviado' }, profe: { estado: 'enviado' }, equipo: { estado: 'enviado' } } });
    expect(pendingChannels(s, '2026-11-16')).toEqual(['alumno', 'profe', 'equipo']);
  });

  it('mezclar nunca pisa lo enviado; ciclo completo solo sin errores', () => {
    const m = mergeChannels({ alumno: { estado: 'enviado', at: 'a' } }, { alumno: { estado: 'error' }, profe: { estado: 'omitido' }, equipo: { estado: 'error' } });
    expect(m.alumno).toEqual({ estado: 'enviado', at: 'a' });
    expect(cycleDone(m)).toBe(false);
    expect(cycleDone({ ...m, equipo: { estado: 'enviado' } })).toBe(true);
  });

  it('pago pendiente o pausa: no es "no renovó"', () => {
    expect(isRenewalInProgress('on-hold')).toBe(true);
    expect(isRenewalInProgress('paused')).toBe(true);
    expect(isRenewalInProgress('cancelled')).toBe(false);
  });
});
