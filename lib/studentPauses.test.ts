import { describe, expect, it } from 'vitest';
import { pauseCovers, pauseIndex, isPausedOn, openPauseOf, type StudentPause } from '@/lib/studentPauses';

const pausa = (o: Partial<StudentPause>): StudentPause => ({
  studentId: 's_1', studentName: 'Ana López', studentEmail: 'ana@x.com', from: '2026-10-01', to: null, ...o,
});

describe('pauseCovers: [from, to)', () => {
  it('incluye el primer día y excluye el de la reactivación', () => {
    const p = { from: '2026-10-01', to: '2026-10-15' };
    expect(pauseCovers(p, '2026-09-30')).toBe(false);
    expect(pauseCovers(p, '2026-10-01')).toBe(true);
    expect(pauseCovers(p, '2026-10-14')).toBe(true);
    expect(pauseCovers(p, '2026-10-15')).toBe(false);
  });

  it('abierta: cubre todo desde el inicio', () => {
    expect(pauseCovers({ from: '2026-10-01', to: null }, '2030-01-01')).toBe(true);
  });
});

describe('isPausedOn', () => {
  const idx = pauseIndex([pausa({ to: '2026-10-15' })]);

  it('por nombre, sin mayúsculas ni espacios', () => {
    expect(isPausedOn(idx, { name: '  ana lópez ' }, '2026-10-05')).toBe(true);
    expect(isPausedOn(idx, { name: 'Ana López' }, '2026-10-20')).toBe(false);
  });

  it('por id, aunque el nombre de la asignación sea otro', () => {
    expect(isPausedOn(idx, { name: 'Ana', id: 's_1' }, '2026-10-05')).toBe(true);
    expect(isPausedOn(idx, { name: 'Otra', id: 's_2' }, '2026-10-05')).toBe(false);
  });
});

describe('openPauseOf', () => {
  it('devuelve la abierta, no las cerradas', () => {
    const idx = pauseIndex([
      pausa({ from: '2026-06-01', to: '2026-07-01' }),
      pausa({ from: '2026-10-01', to: null }),
    ]);
    expect(openPauseOf(idx, { id: 's_1' })?.from).toBe('2026-10-01');
    expect(openPauseOf(pauseIndex([pausa({ to: '2026-10-15' })]), { name: 'Ana López' })).toBeNull();
  });
});
