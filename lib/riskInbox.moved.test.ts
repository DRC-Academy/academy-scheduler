import { describe, it, expect } from 'vitest';
import { attendance30d } from '@/lib/riskInbox';
import type { ClassRecord } from '@/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const rec = (classDate: string, classType: string, rescheduledTo?: string) =>
  ({ id: classDate + classType, teacherId: 'tB', studentName: 'Lucía Pérez', classDate, classType, rescheduledTo } as ClassRecord);

describe('attendance30d · clases movidas', () => {
  it('una reprogramada con destino no cuenta como clase no dada', () => {
    expect(attendance30d([rec('2026-10-13', 'normal'), rec('2026-10-20', 'reprogramada', '2026-10-22')], 'Lucía Pérez', NOW))
      .toBe('1 de 1 clases');
  });
  it('solo con una movida no hay nada que medir (null, no "0 de 0")', () => {
    expect(attendance30d([rec('2026-10-20', 'reprogramada', '2026-10-22')], 'Lucía Pérez', NOW)).toBeNull();
  });
  it('una falta sigue contando', () => {
    expect(attendance30d([rec('2026-10-13', 'normal'), rec('2026-10-20', 'falta_sin_aviso')], 'Lucía Pérez', NOW)).toBe('1 de 2 clases');
  });
});
