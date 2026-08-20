import { describe, it, expect } from 'vitest';
import {
  assessReading, readingWithinLevel, roundHalfDown, calculateOverall,
  calculateWritingScore, READING_WINDOW, WITHIN_HIGH_MIN, WITHIN_MID_MIN,
} from './scoring';
import { cefrToScore } from './constants';
import type { LTAnswerLite } from './types';

// Construye respuestas de lectura en orden cronológico. `dif` y `ok` van en
// paralelo: dif[i] es la dificultad servida y ok[i] si la acertó.
function lectura(dif: number[], ok: boolean[]): LTAnswerLite[] {
  return dif.map((d, i) => ({
    section: 'reading_completion' as const,
    difficulty: d,
    is_correct: ok[i] ?? false,
    ai_score: null,
  }));
}
const alternando = (a: number, b: number) => [a, b, a, b, a, b, a, b];

describe('roundHalfDown — el empate baja', () => {
  it('3,5 → 3, no 4', () => expect(roundHalfDown(3.5)).toBe(3));
  it('respeta el redondeo normal fuera del empate', () => {
    expect(roundHalfDown(3.4)).toBe(3);
    expect(roundHalfDown(3.6)).toBe(4);
    expect(roundHalfDown(3.51)).toBe(4);
  });
  it('empates en todos los bordes de banda', () => {
    expect(roundHalfDown(1.5)).toBe(1);
    expect(roundHalfDown(2.5)).toBe(2);
    expect(roundHalfDown(4.5)).toBe(4);
    expect(roundHalfDown(5.5)).toBe(5);
  });
  it('los enteros no se mueven', () => {
    expect(roundHalfDown(6)).toBe(6);
    expect(roundHalfDown(1)).toBe(1);
  });
});

describe('readingWithinLevel — fronteras explícitas', () => {
  it('los 9 valores alcanzables con 8 ítems', () => {
    expect(readingWithinLevel(0)).toBe('low');
    expect(readingWithinLevel(12.5)).toBe('low');
    expect(readingWithinLevel(25)).toBe('low');
    expect(readingWithinLevel(37.5)).toBe('low');
    expect(readingWithinLevel(50)).toBe('mid');
    expect(readingWithinLevel(62.5)).toBe('mid');   // 62,5 < 65 → mid
    expect(readingWithinLevel(75)).toBe('high');
    expect(readingWithinLevel(87.5)).toBe('high');
    expect(readingWithinLevel(100)).toBe('high');
  });

  // El 65 no es alcanzable con 8 ítems, pero la frontera está escrita y no debe
  // depender del tamaño de la ventana.
  it('las fronteras son las declaradas, alcanzables o no', () => {
    expect(readingWithinLevel(WITHIN_HIGH_MIN)).toBe('high');
    expect(readingWithinLevel(WITHIN_HIGH_MIN - 0.01)).toBe('mid');
    expect(readingWithinLevel(WITHIN_MID_MIN)).toBe('mid');
    expect(readingWithinLevel(WITHIN_MID_MIN - 0.01)).toBe('low');
  });
});

describe('assessReading — casos de borde', () => {
  it('media 3,5 exacta → B1, no B2', () => {
    // Oscilación 3↔4: acierta en 3, falla en 4. Es el equilibrio de un B1.
    const r = assessReading(lectura(alternando(3, 4), [true, false, true, false, true, false, true, false]))!;
    expect(r.meanDifficulty).toBe(3.5);
    expect(r.band).toBe(3);
    expect(r.cefr_level).toBe('B1');
    expect(r.accuracy).toBe(50);
    expect(r.within_level).toBe('mid');
  });

  it('alumno que llega al techo 6 y se queda ahí', () => {
    const r = assessReading(lectura([6, 6, 6, 6, 6, 6, 6, 6], Array(8).fill(true)))!;
    expect(r.band).toBe(6);
    expect(r.cefr_level).toBe('C2');
    expect(r.accuracy).toBe(100);
    expect(r.within_level).toBe('high');
  });

  it('alumno que baja al suelo 1 y se queda ahí', () => {
    const r = assessReading(lectura([1, 1, 1, 1, 1, 1, 1, 1], Array(8).fill(false)))!;
    expect(r.band).toBe(1);
    expect(r.cefr_level).toBe('A1');
    expect(r.accuracy).toBe(0);
    expect(r.within_level).toBe('low');
  });

  it('precisión 62,5% → mid (queda por debajo del 65)', () => {
    const ok = [true, true, true, true, true, false, false, false];   // 5/8
    const r = assessReading(lectura([4, 4, 4, 4, 4, 4, 4, 4], ok))!;
    expect(r.accuracy).toBe(62.5);
    expect(r.within_level).toBe('mid');
    expect(r.score).toBe(cefrToScore('B2', 'mid'));
  });

  it('precisión 75% → high', () => {
    const ok = [true, true, true, true, true, true, false, false];    // 6/8
    const r = assessReading(lectura([4, 4, 4, 4, 4, 4, 4, 4], ok))!;
    expect(r.accuracy).toBe(75);
    expect(r.within_level).toBe('high');
    expect(r.score).toBe(cefrToScore('B2', 'high'));
  });
});

describe('assessReading — la ventana', () => {
  it('solo cuentan las últimas 8: el arranque en dificultad 3 no contamina', () => {
    // 8 primeras en dificultad 1, 8 últimas en dificultad 5.
    const dif = [...Array(8).fill(1), ...Array(8).fill(5)];
    const r = assessReading(lectura(dif, Array(16).fill(true)))!;
    expect(r.sampleSize).toBe(READING_WINDOW);
    expect(r.band).toBe(5);
    expect(r.cefr_level).toBe('C1');
  });

  it('ignora la escritura', () => {
    const answers: LTAnswerLite[] = [
      ...lectura(alternando(3, 4), Array(8).fill(true)),
      { section: 'writing', difficulty: 6, is_correct: null, ai_score: 85 },
    ];
    const r = assessReading(answers)!;
    expect(r.sampleSize).toBe(8);
    expect(r.meanDifficulty).toBe(3.5);
  });

  it('con menos de 8 respuestas usa las que haya', () => {
    const r = assessReading(lectura([2, 2, 2], [true, true, false]))!;
    expect(r.sampleSize).toBe(3);
    expect(r.band).toBe(2);
  });

  it('sin respuestas de lectura devuelve null, no cero', () => {
    expect(assessReading([])).toBeNull();
    expect(assessReading([{ section: 'writing', difficulty: 3, is_correct: null, ai_score: 45 }])).toBeNull();
  });

  it('el score es exactamente cefrToScore(banda, posición)', () => {
    const r = assessReading(lectura(alternando(5, 6), [true, false, true, false, true, false, true, false]))!;
    expect(r.cefr_level).toBe('C1');
    expect(r.score).toBe(cefrToScore(r.cefr_level, r.within_level));
  });
});

// El motivo de todo el cambio: antes B2 y C1 daban los dos exactamente 50,00.
describe('assessReading — separa los niveles que la fórmula vieja confundía', () => {
  const equilibrio = (techo: number) => {
    // Oscila entre su techo y techo+1: acierta abajo, falla arriba.
    const dif = alternando(techo + 1, techo);
    const ok = dif.map(d => d <= techo);
    return assessReading(lectura(dif, ok))!;
  };

  it('B2 y C1 ya no coinciden', () => {
    const b2 = equilibrio(4);
    const c1 = equilibrio(5);
    expect(b2.cefr_level).toBe('B2');
    expect(c1.cefr_level).toBe('C1');
    expect(b2.score).not.toBe(c1.score);
  });

  it('los seis niveles salen distintos y en orden', () => {
    const scores = [1, 2, 3, 4, 5].map(t => equilibrio(t).score);
    expect(new Set(scores).size).toBe(5);
    expect([...scores]).toEqual([...scores].sort((a, b) => a - b));
  });
});

describe('calculateOverall — huecos', () => {
  it('sin escritura manda la lectura sola', () => {
    expect(calculateOverall(55, null)).toBe(55);
  });
  it('sin lectura manda la escritura sola', () => {
    expect(calculateOverall(null, 45)).toBe(45);
  });
  it('con las dos, 60/40', () => {
    expect(calculateOverall(50, 100)).toBe(70);
  });
  it('sin ninguna de las dos, 0', () => {
    expect(calculateOverall(null, null)).toBe(0);
  });
});

describe('calculateWritingScore', () => {
  it('sin ai_score devuelve null, no 0', () => {
    expect(calculateWritingScore([{ section: 'writing', difficulty: 3, is_correct: null, ai_score: null }])).toBeNull();
  });
});
