import { describe, it, expect } from 'vitest';
import { operacionDelMes } from '@/lib/dashboardMetrics';
import type { ClassRecord } from '@/types';

const rec = (p: Partial<ClassRecord>): ClassRecord =>
  ({ id: Math.random().toString(36), teacherId: 'tB', studentName: 'Lucía Pérez', classDate: '2026-10-20', classType: 'normal', ...p } as ClassRecord);

describe('operacionDelMes · clases movidas', () => {
  it('una reprogramada con destino no es "no dada" ni recuperación pendiente', () => {
    const op = operacionDelMes([
      rec({ classType: 'reprogramada', rescheduledTo: '2026-10-22' }),
      rec({ classDate: '2026-10-13' }),
    ], '2026-10');
    expect(op).toMatchObject({ dadas: 1, noDadas: 0, recuperacionesPendientes: 0 });
  });

  it('una reprogramada vieja sin destino y una cancelación siguen contando como antes', () => {
    const op = operacionDelMes([
      rec({ classType: 'reprogramada' }),
      rec({ classDate: '2026-10-06', classType: 'cancelada_con_preaviso' }),
    ], '2026-10');
    expect(op).toMatchObject({ noDadas: 2, recuperacionesPendientes: 2 });
  });
});
