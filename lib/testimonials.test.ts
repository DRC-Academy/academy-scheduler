import { describe, expect, it } from 'vitest';
import { findBestPair, pairKey, daysBetween, isBetterPair, type FluencyClass } from '@/lib/testimonials';
import { TESTIMONIAL_RULES } from '@/lib/testimonialRules';

let n = 0;
function clase(day: string, score: number, extra: Partial<FluencyClass> = {}): FluencyClass {
  n++;
  return {
    analysisId: `ca_${n}`, classNumber: n, classDay: day, teacherId: 't1', score,
    bestExcerpt: 'I went to the market and bought some fruit', bestAt: '10:00', bestFound: true,
    worstExcerpt: 'I, I... eh... yesterday I... no sé', worstAt: '3:15', worstFound: true,
    fathomUrl: 'https://fathom.video/share/x',
    ...extra,
  };
}

describe('daysBetween', () => {
  it('cuenta días de calendario', () => {
    expect(daysBetween('2026-07-01', '2026-08-12')).toBe(42);
  });
});

describe('findBestPair', () => {
  it('pareja válida: antes ≤ 4, después ≥ 7, mejora ≥ 3, 6 semanas', () => {
    const a = clase('2026-07-14', 3);
    const b = clase('2026-09-01', 8);
    const p = findBestPair([a, b]);
    expect(p?.before.analysisId).toBe(a.analysisId);
    expect(p?.after.analysisId).toBe(b.analysisId);
    expect(p?.improvement).toBe(5);
    expect(p?.daysApart).toBe(49);
  });

  it('menos de 6 semanas entre las clases: no hay pareja', () => {
    expect(findBestPair([clase('2026-07-14', 2), clase('2026-08-20', 9)])).toBeNull();
  });

  it('justo 6 semanas sí vale', () => {
    expect(findBestPair([clase('2026-07-01', 4), clase('2026-08-12', 7)])).not.toBeNull();
  });

  it('notas fuera de rango: no hay pareja', () => {
    expect(findBestPair([clase('2026-07-01', 5), clase('2026-09-01', 9)])).toBeNull();   // antes 5 > 4
    expect(findBestPair([clase('2026-07-01', 2), clase('2026-09-01', 6)])).toBeNull();   // después 6 < 7
  });

  it('la mejora exige que la buena sea POSTERIOR', () => {
    expect(findBestPair([clase('2026-07-01', 8), clase('2026-09-01', 3)])).toBeNull();
  });

  it('se queda con la de mayor mejora', () => {
    const a1 = clase('2026-07-01', 4);
    const a2 = clase('2026-07-03', 2);
    const b = clase('2026-09-01', 8);
    expect(findBestPair([a1, a2, b])?.before.analysisId).toBe(a2.analysisId);
  });

  it('a igual mejora, la del "después" más reciente', () => {
    const a = clase('2026-07-01', 3);
    const b1 = clase('2026-08-20', 7);
    const b2 = clase('2026-09-10', 7);
    expect(findBestPair([a, b1, b2])?.after.analysisId).toBe(b2.analysisId);
  });

  it('una cita no comprobada no vale si CITAS_COMPROBADAS', () => {
    const a = clase('2026-07-01', 3, { worstFound: false });
    const b = clase('2026-09-01', 8);
    expect(findBestPair([a, b])).toBeNull();
    expect(findBestPair([a, b], { ...TESTIMONIAL_RULES, CITAS_COMPROBADAS: false })).not.toBeNull();
  });

  it('no repite una pareja descartada, pero puede proponer otra', () => {
    const a1 = clase('2026-07-01', 2);
    const a2 = clase('2026-07-02', 3);
    const b = clase('2026-09-01', 8);
    const p = findBestPair([a1, a2, b], TESTIMONIAL_RULES, new Set([pairKey(a1.analysisId, b.analysisId)]));
    expect(p?.before.analysisId).toBe(a2.analysisId);
  });
});

describe('isBetterPair', () => {
  it('mejora manda sobre fecha', () => {
    expect(isBetterPair({ improvement: 5, daysApart: 50, afterDay: '2026-08-01' },
                        { improvement: 4, daysApart: 90, afterDay: '2026-09-30' })).toBe(true);
  });
  it('una pareja igual no es mejor', () => {
    const x = { improvement: 4, daysApart: 50, afterDay: '2026-09-01' };
    expect(isBetterPair(x, x)).toBe(false);
  });
});
