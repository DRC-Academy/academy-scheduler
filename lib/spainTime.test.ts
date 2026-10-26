import { describe, expect, it } from 'vitest';
import { spainHourToArgentinaHour } from '@/lib/spainTime';

describe('spainHourToArgentinaHour', () => {
  it('en el verano español son 5 h de diferencia', () => {
    expect(spainHourToArgentinaHour('2026-10-19', 15)).toBe(10);
    expect(spainHourToArgentinaHour('2026-10-24', 9)).toBe(4);
  });

  it('desde el cambio de hora del 25/10/2026 son 4 h', () => {
    expect(spainHourToArgentinaHour('2026-10-26', 15)).toBe(11);
    expect(spainHourToArgentinaHour('2026-10-26', 9)).toBe(5);
    expect(spainHourToArgentinaHour('2027-01-11', 22)).toBe(18);
  });

  it('la medianoche española cae el día anterior en Argentina', () => {
    expect(spainHourToArgentinaHour('2026-10-20', 0)).toBe(19);
    expect(spainHourToArgentinaHour('2026-10-27', 0)).toBe(20);
    expect(spainHourToArgentinaHour('2026-10-27', 2)).toBe(22);
  });

  it('vuelve a 5 h con el horario de verano de 2027 (28/03)', () => {
    expect(spainHourToArgentinaHour('2027-03-26', 15)).toBe(11);
    expect(spainHourToArgentinaHour('2027-03-29', 15)).toBe(10);
  });

  it('fecha inválida → NaN', () => {
    expect(spainHourToArgentinaHour('', 15)).toBeNaN();
  });
});
