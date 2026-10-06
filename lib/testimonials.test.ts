import { describe, expect, it } from 'vitest';
import {
  planCandidate, studentTrend, goodOptionsAfter, daysBetween, improvementLine, evidenceImproves, blindConfirms,
  clipLabel, clipsOverlap,
  type FluencyClass,
} from '@/lib/testimonials';

let n = 0;
function clase(day: string, score: number): FluencyClass {
  n++;
  return { analysisId: `ca_${String(n).padStart(3, '0')}`, classNumber: n, classDay: day, teacherId: 't1', score, fathomUrl: null };
}

/** Seis clases semanales desde el 1 de julio con estas notas. */
function semanal(scores: number[], desde = '2026-07-01'): FluencyClass[] {
  const t0 = Date.parse(`${desde}T00:00:00Z`);
  return scores.map((s, i) => clase(new Date(t0 + i * 7 * 86_400_000).toISOString().slice(0, 10), s));
}

describe('daysBetween', () => {
  it('cuenta días de calendario', () => {
    expect(daysBetween('2026-07-01', '2026-08-12')).toBe(42);
  });
});

describe('studentTrend', () => {
  it('media de las 3 primeras y las 3 últimas, en orden de fecha aunque lleguen desordenadas', () => {
    const cs = semanal([5, 5, 6, 6, 7, 8]);
    const t = studentTrend([...cs].reverse())!;
    expect(t.firstMean).toBeCloseTo(16 / 3);
    expect(t.lastMean).toBe(7);
    expect(t.first.map(c => c.analysisId)).toEqual(cs.slice(0, 3).map(c => c.analysisId));
  });

  it('menos de 5 clases: sin tendencia', () => {
    expect(studentTrend(semanal([4, 5, 6, 7]))).toBeNull();
    expect(studentTrend(semanal([4, 5, 6, 7, 8]))).not.toBeNull();
  });
});

describe('planCandidate (regla V3: tendencia de la nota, primer filtro)', () => {
  it('entra si la media sube 1 punto, sin mínimos ni máximos de nota', () => {
    const p = planCandidate(semanal([6, 6, 7, 7, 7, 8]))!;
    expect(p).not.toBeNull();
    expect(p.trend.improvement).toBeCloseTo(1);
  });

  it('justo 1 punto con decimales también entra', () => {
    // (5+5+6)/3 = 5,33 → (6+6+7)/3 = 6,33
    expect(planCandidate(semanal([5, 5, 6, 6, 6, 7]))).not.toBeNull();
  });

  it('2 puntos entre 3 clases (+0,67 de media) entran; 1 punto no', () => {
    expect(planCandidate(semanal([5, 5, 6, 6, 6, 7]))).not.toBeNull();
    expect(planCandidate(semanal([5, 6, 6, 6, 6, 6]))).toBeNull();
  });

  it('notas planas o que bajan: no entra', () => {
    expect(planCandidate(semanal([7, 7, 7, 7, 7, 7]))).toBeNull();
    expect(planCandidate(semanal([8, 7, 7, 6, 6, 6]))).toBeNull();
  });

  it('pareja provisional: peor nota de las primeras, mejor de las últimas a 28 días o más', () => {
    const cs = semanal([6, 4, 5, 6, 8, 7]);
    const p = planCandidate(cs)!;
    expect(p.before.analysisId).toBe(cs[1].analysisId);
    // El 8 está a solo 21 días del 4: la buena es el 7, a 28.
    expect(p.after.analysisId).toBe(cs[5].analysisId);
  });

  it('sin 4 semanas entre alguna primera y alguna última: no entra', () => {
    // 6 clases en 12 días.
    const cs = ['2026-07-01', '2026-07-03', '2026-07-05', '2026-07-08', '2026-07-10', '2026-07-12']
      .map((d, i) => clase(d, [4, 4, 4, 7, 7, 7][i]));
    expect(planCandidate(cs)).toBeNull();
  });

  it('solo ofrece a la IA clases a 28 días o más entre sí', () => {
    const cs = ['2026-07-01', '2026-07-20', '2026-07-25', '2026-08-10', '2026-08-20', '2026-08-28']
      .map((d, i) => clase(d, [4, 4, 4, 6, 6, 6][i]));
    const p = planCandidate(cs)!;
    // 20/07 → 20/08 son 31 días; 25/07 → 28/08 son 34; 25/07 → 20/08 son 26 (no).
    expect(p.badOptions.map(c => c.classDay)).toEqual(['2026-07-01', '2026-07-20', '2026-07-25']);
    expect(p.goodOptions.map(c => c.classDay)).toEqual(['2026-08-10', '2026-08-20', '2026-08-28']);
    expect(goodOptionsAfter(cs[2], p.goodOptions).map(c => c.classDay)).toEqual(['2026-08-28']);
    expect(daysBetween(p.before.classDay, p.after.classDay)).toBeGreaterThanOrEqual(28);
  });
});

describe('improvementLine', () => {
  it('formato con coma y puntos', () => {
    expect(improvementLine(5, 7)).toBe('Media de 5,0 → 7,0 (+2 puntos)');
    expect(improvementLine(16 / 3, 19 / 3)).toBe('Media de 5,3 → 6,3 (+1 punto)');
    expect(improvementLine(5, 6.67)).toBe('Media de 5,0 → 6,7 (+1,7 puntos)');
  });
});

describe('evidenceImproves (V3: el transcript respalda la mejora)', () => {
  const st = (topTurnsMean: number, longTurns: number) => ({ topTurnsMean, longTurns });

  it('entra si las intervenciones en inglés más largas suben 5 palabras', () => {
    expect(evidenceImproves([st(30, 1), st(32, 1)], [st(36, 1), st(38, 1)]).ok).toBe(true);
  });

  it('o si hace 2 intervenciones largas más por clase', () => {
    expect(evidenceImproves([st(40, 1), st(40, 2)], [st(40, 4), st(40, 3)]).ok).toBe(true);
  });

  it('sin ninguna de las dos subidas, no', () => {
    const r = evidenceImproves([st(40, 2), st(40, 2)], [st(43, 3), st(42, 3)]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no muestra/);
  });

  it('con menos de 2 clases legibles a un lado no se puede juzgar: no entra', () => {
    const r = evidenceImproves([st(10, 0)], [st(80, 9), st(80, 9)]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/legibles/);
  });
});

describe('blindConfirms (V3: comparación a ciegas)', () => {
  it('confirma si elige la reciente con confianza alta o media', () => {
    expect(blindConfirms('A', 'alta', true)).toBe(true);
    expect(blindConfirms('B', 'media', false)).toBe(true);
  });

  it('no confirma si elige la antigua', () => {
    expect(blindConfirms('B', 'alta', true)).toBe(false);
    expect(blindConfirms('A', 'alta', false)).toBe(false);
  });

  it('un empate o una confianza baja no confirman', () => {
    expect(blindConfirms('igual', 'alta', true)).toBe(false);
    expect(blindConfirms('A', 'baja', true)).toBe(false);
  });
});

describe('clips', () => {
  it('clipLabel: "16 jul · 8:20 – 8:27"', () => {
    expect(clipLabel({ classDate: '2026-07-16', start: 500, end: 507 })).toBe('16 jul · 8:20 – 8:27');
    expect(clipLabel({ classDate: '2026-09-03', start: 3725, end: 3734 })).toBe('3 sep · 1:02:05 – 1:02:14');
  });

  it('clipsOverlap: solo si son de la misma clase y se pisan', () => {
    const k = (analysisId: string, start: number, end: number) =>
      ({ analysisId, classDate: '2026-07-16', teacherId: null, start, end, excerpt: '', why: '', fathomUrl: null });
    expect(clipsOverlap(k('a', 10, 20), k('a', 15, 25))).toBe(true);
    expect(clipsOverlap(k('a', 10, 20), k('a', 20, 30))).toBe(false);
    expect(clipsOverlap(k('a', 10, 20), k('b', 10, 20))).toBe(false);
  });
});
