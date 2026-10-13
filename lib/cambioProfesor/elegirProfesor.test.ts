import { describe, it, expect } from 'vitest';
import { elegirProfesor, type CandidatoAElegir } from '@/lib/cambioProfesor/elegirProfesor';

const c = (id: string, asignacionesActivas: number, calendarioActualizadoEn: string | null): CandidatoAElegir =>
  ({ id, asignacionesActivas, calendarioActualizadoEn });

describe('elegirProfesor', () => {
  it('sin candidatos: null', () => {
    expect(elegirProfesor([])).toBeNull();
  });

  it('1. el que tiene menos asignaciones activas, aunque su calendario sea más viejo', () => {
    expect(elegirProfesor([
      c('tA', 5, '2026-10-12T00:00:00Z'),
      c('tB', 2, '2026-09-20T00:00:00Z'),
      c('tC', 3, '2026-10-13T00:00:00Z'),
    ])?.id).toBe('tB');
  });

  it('2. empate de asignaciones: el calendario actualizado más recientemente (sin fecha, el último)', () => {
    expect(elegirProfesor([
      c('tA', 2, '2026-10-01T00:00:00Z'),
      c('tB', 2, null),
      c('tC', 2, '2026-10-11T08:00:00Z'),
      c('tD', 4, '2026-10-12T00:00:00Z'),
    ])?.id).toBe('tC');
    expect(elegirProfesor([c('tA', 1, null), c('tB', 1, '2026-01-01T00:00:00Z')])?.id).toBe('tB');
  });

  it('3. empate total: el id menor', () => {
    expect(elegirProfesor([c('t9', 1, '2026-10-01T00:00:00Z'), c('t10', 1, '2026-10-01T00:00:00Z'), c('t2', 1, '2026-10-01T00:00:00Z')])?.id).toBe('t10');
    expect(elegirProfesor([c('tB', 0, null), c('tA', 0, null)])?.id).toBe('tA');
  });

  it('determinista: el orden de entrada no cambia el resultado', () => {
    const xs = [c('tA', 2, '2026-10-01T00:00:00Z'), c('tB', 2, '2026-10-01T00:00:00Z'), c('tC', 3, null), c('tD', 2, '2026-09-01T00:00:00Z')];
    const ids = new Set([xs, [...xs].reverse(), [xs[2], xs[0], xs[3], xs[1]]].map(l => elegirProfesor(l)?.id));
    expect([...ids]).toEqual(['tA']);
  });
});
