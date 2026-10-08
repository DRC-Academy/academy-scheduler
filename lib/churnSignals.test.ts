import { describe, it, expect } from 'vitest';
import { computeChurnSignals } from '@/lib/churnSignals';

const rec = (class_date: string, class_type: string, rescheduled_to?: string) =>
  ({ student_name: 'Lucía Pérez', class_date, class_type, rescheduled_to: rescheduled_to ?? null });

describe('computeChurnSignals · clases movidas', () => {
  it('una reprogramada con destino (profesor o alumno) no cuenta como cancelación', () => {
    const s = computeChurnSignals({
      studentName: 'Lucía Pérez', logs: [], analyses: [], nowIso: '2026-10-21T10:00:00Z',
      records: [rec('2026-10-20', 'reprogramada', '2026-10-22'), rec('2026-10-13', 'normal')],
    });
    expect(s.cancellations).toBe(0);
  });

  it('las ausencias de verdad y la reprogramada vieja sin destino siguen contando', () => {
    const s = computeChurnSignals({
      studentName: 'Lucía Pérez', logs: [], analyses: [], nowIso: '2026-10-21T10:00:00Z',
      records: [rec('2026-10-20', 'reprogramada'), rec('2026-10-13', 'falta_sin_aviso'), rec('2026-10-06', 'reprogramada', '2026-10-08')],
    });
    expect(s.cancellations).toBe(2);
    expect(s.deterministicRisk).toBe(24);
  });
});
