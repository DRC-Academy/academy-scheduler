import { describe, expect, it } from 'vitest';
import type { Segment } from '@/lib/testimonialScoring';
import {
  planStudentPairs, nextPlanItem, spanishShare, recordingKey, momentKey, momentKeyFromId, toPlanItem,
  type PlanOptions, type PlanItem,
} from '@/lib/testimonialPairPlan';

const O: PlanOptions = { max: 10, perMoment: 2, spanishMax: 0.15, minWeeks: 4 };

let n = 0;
const url = (day: string) => `https://fathom.video/share/${day.replace(/-/g, '')}abcdefghijklmnopqrstuvw`;
const A = (day: string, over: Partial<Segment> = {}): Segment => ({
  id: `ca_${day}:${++n}:A:0`, kind: 'A', analysisId: `ca_${day}`, studentGroup: 's1', teacherId: 't7', classDay: day, studentLabel: 'Ana',
  fathomUrl: url(day), turnIndex: n, start: 100, end: 110,
  text: 'I, um, I went to the, uh, beach with my family', turnWpm: 70, teacherBefore: true,
  words: 10, fillers: 2, repeats: 1, searches: 0, spanishWords: 0, ...over,
});
const B = (day: string, over: Partial<Segment> = {}): Segment => ({
  id: `ca_${day}:${++n}:B:0`, kind: 'B', analysisId: `ca_${day}`, studentGroup: 's1', teacherId: 't7', classDay: day, studentLabel: 'Ana',
  fathomUrl: url(day), turnIndex: n, start: 200, end: 225,
  text: 'Last weekend I went to the mountains with my friends and we cooked dinner together', turnWpm: 140, teacherBefore: true,
  words: 15, fillers: 0, repeats: 0, searches: 0, spanishWords: 0, ...over,
});

describe('momentos por grabación', () => {
  it('la grabación sin timestamp ni mayúsculas; el momento es grabación + intervención', () => {
    expect(recordingKey('https://www.Fathom.video/share/AbC?timestamp=12')).toBe('fathom.video/share/abc');
    expect(momentKey({ fathomUrl: 'https://fathom.video/share/abc/', turnIndex: 7 })).toBe('fathom.video/share/abc#7');
    expect(momentKeyFromId('ca_1_x:7:B:37', 'https://fathom.video/share/abc?timestamp=90')).toBe('fathom.video/share/abc#7');
    expect(momentKeyFromId('raro', 'https://fathom.video/share/abc')).toBeNull();
  });
});

describe('planStudentPairs', () => {
  it('mismas reglas que el buscador: mismo profe, 4+ semanas y el B más largo', () => {
    const a = A('2026-07-01');
    const r = planStudentPairs([a, B('2026-08-10'), B('2026-07-15'), B('2026-08-10', { teacherId: 'otro' }), B('2026-08-10', { end: 205 })], null, O);
    expect(r.map(p => [p.a.id, p.b.classDay])).toEqual([[a.id, '2026-08-10']]);
  });

  it('un momento sale como mucho 2 veces y hay como mucho 10 parejas', () => {
    const as = Array.from({ length: 6 }, () => A('2026-07-01'));
    const bs = Array.from({ length: 6 }, () => B('2026-09-01'));
    const r = planStudentPairs([...as, ...bs], null, O);
    expect(r).toHaveLength(10);
    const usos = new Map<string, number>();
    for (const p of r) for (const k of [momentKey(p.a), momentKey(p.b)]) usos.set(k, (usos.get(k) ?? 0) + 1);
    expect(Math.max(...usos.values())).toBe(2);
  });

  it('ventanas de la misma intervención y copias del transcript cuentan como el mismo momento', () => {
    const a = A('2026-07-01');
    const ventana = { ...a, id: `${a.analysisId}:${a.turnIndex}:A:5`, start: 103, end: 113 };
    const copia = { ...a, id: `ca_copia:${a.turnIndex}:A:0`, analysisId: 'ca_copia', classDay: '2026-07-02' };
    const r = planStudentPairs([a, ventana, copia, B('2026-09-01')], null, O);
    expect(r).toHaveLength(1);
  });

  it('nunca un A y un B de la misma grabación (transcript copiado en otra fecha)', () => {
    const a = A('2026-07-01');
    const r = planStudentPairs([a, B('2026-09-01', { fathomUrl: a.fathomUrl })], null, O);
    expect(r).toEqual([]);
  });

  it('español: más del 15 % no se usa; con algo de español va al final', () => {
    const mucho = A('2026-07-01', { spanishWords: 2, words: 10 });
    const poco = A('2026-07-01', { spanishWords: 1, words: 10 });
    const limpio = A('2026-07-20');
    const r = planStudentPairs([mucho, poco, limpio, B('2026-09-01')], null, O);
    expect(spanishShare(mucho)).toBeGreaterThan(0.15);
    expect(r.map(p => p.a.id)).toEqual([limpio.id, poco.id]);
    expect(r[1].conEspanol).toBe(true);
  });

  it('a igualdad de español, más semanas va antes', () => {
    const cerca = A('2026-08-01'), lejos = A('2026-06-01');
    const r = planStudentPairs([cerca, lejos, B('2026-09-15')], null, O);
    expect(r.map(p => p.a.id)).toEqual([lejos.id, cerca.id]);
  });

  it('respeta vetos, combinaciones ya verificadas y enlaces que faltan', () => {
    const a1 = A('2026-07-01'), a2 = A('2026-07-01'), a3 = A('2026-07-01', { fathomUrl: null }), b = B('2026-09-01');
    const r = planStudentPairs([a1, a2, a3, b], null, { ...O, blocked: s => s.id === a1.id, skipPair: (a) => a.id === a2.id });
    expect(r).toEqual([]);
  });
});

describe('nextPlanItem', () => {
  const it_ = (g: string, i: number, ra = `g${i}`, rb = `h${i}`): PlanItem => ({ g, a: `a${i}`, b: `b${i}`, ma: `${ra}#1`, mb: `${rb}#1`, ra, rb });
  const plan: PlanItem[] = [it_('x', 1, 'r1'), it_('x', 2, 'r1', 'r3'), it_('y', 3, 'r4', 'r5'), it_('y', 4, 'r6', 'r5')];
  const sin = { momentos: new Set<string>(), grabaciones: new Set<string>() };
  it('va en orden desde el cursor', () => {
    expect(nextPlanItem(plan, 0, new Set(), sin)?.index).toBe(0);
    expect(nextPlanItem(plan, 2, new Set(), sin)?.index).toBe(2);
  });
  it('con una aprobada, salta al siguiente alumno', () => {
    expect(nextPlanItem(plan, 1, new Set(['x']), sin)?.item.g).toBe('y');
  });
  it('salta momentos y grabaciones vetados', () => {
    expect(nextPlanItem(plan, 0, new Set(), { momentos: new Set(['r1#1']), grabaciones: new Set() })?.index).toBe(2);
    expect(nextPlanItem(plan, 2, new Set(), { momentos: new Set(), grabaciones: new Set(['r5']) })).toBeNull();
  });
  it('toPlanItem guarda momentos y grabaciones', () => {
    const p = toPlanItem('s1', { a: A('2026-07-01'), b: B('2026-09-01') });
    expect(p.ra).toBe(recordingKey(url('2026-07-01')));
    expect(p.mb.startsWith(recordingKey(url('2026-09-01')))).toBe(true);
  });
});
