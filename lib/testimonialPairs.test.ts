import { describe, expect, it } from 'vitest';
import { validateMoment, keepBest, bestPairs, type Moment, type MomentClassContext } from '@/lib/testimonialPairs';
import { studentInterventions } from '@/lib/testimonialSpeaker';
import type { Turn } from '@/lib/fluency';

const PROFE = 'Lily (lily@gmail.com)';
const T = (at: string, speaker: string, text: string): Turn => ({ at, speaker, text });

function ctx(turns: Turn[]): MomentClassContext {
  return {
    analysisId: 'ca_1', studentGroup: 's1', teacherId: 't1', classDay: '2026-08-01', studentLabel: 'Ana',
    fathomUrl: 'https://fathom.video/share/abc', turns, interventions: studentInterventions(turns, 'Ana'),
  };
}

describe('validateMoment', () => {
  const turns = [
    T('8:00', PROFE, 'What did you do at the weekend? Tell me everything.'),
    T('8:20', 'Ana', 'I went to the beach with my family and we ate a lot of paella in a small restaurant.'),
    T('8:31', PROFE, 'Nice! Now listen to this audio, please.'),
    T('8:35', 'Ana', 'Welcome to the podcast where we talk about how our brains change when we fall in love.'),
    T('9:00', PROFE, 'I went to the beach with my family and we ate a lot of paella.'),
  ];
  const ai = (cita: string, tipo: 'malo' | 'bueno' = 'bueno', intervencion = 1) =>
    ({ tipo, intervencion, cita, puntuacion: 8, porque: 'Habla con soltura.' });

  it('acepta una cita dentro de una intervención del alumno y calcula sus segundos (5-15 s)', () => {
    const r = validateMoment(ctx(turns), ai('I went to the beach with my family and we ate a lot of paella'));
    expect('moment' in r && r.moment).toMatchObject({ kind: 'bueno', start: 500, score: 8, fathomUrl: 'https://fathom.video/share/abc?timestamp=500' });
    if ('moment' in r) expect(r.moment.end - r.moment.start).toBeGreaterThanOrEqual(5);
  });

  it('busca en las otras intervenciones del alumno si la IA se equivoca de número', () => {
    const r = validateMoment(ctx(turns), ai('I went to the beach with my family and we ate a lot of paella', 'bueno', 7));
    expect('moment' in r).toBe(true);
  });

  it('rechaza una cita que solo dice el profe', () => {
    const t2 = turns.map((t, i) => (i === 1 ? { ...t, text: 'Yes, I agree with you about that one for sure.' } : t));
    const r = validateMoment(ctx(t2), ai('I went to the beach with my family and we ate a lot of paella'));
    expect(r).toMatchObject({ error: expect.stringMatching(/ninguna intervención del alumno/) });
  });

  it('rechaza audios y lecturas', () => {
    const r = validateMoment(ctx(turns), ai('how our brains change when we fall in love', 'bueno', 2));
    expect(r).toMatchObject({ error: expect.stringMatching(/suena a audio/) });
  });

  it('rechaza un momento bueno que no contesta al profe', () => {
    const t2 = [turns[0], turns[1], T('8:31', 'Ana', 'And then we walked along the beach for two hours with the dog.')];
    const r = validateMoment(ctx(t2), ai('And then we walked along the beach for two hours with the dog', 'bueno', 2));
    expect(r).toMatchObject({ error: expect.stringMatching(/no contesta al profe/) });
  });

  it('rechaza citas demasiado cortas', () => {
    expect(validateMoment(ctx(turns), ai('I went to the'))).toMatchObject({ error: expect.stringMatching(/corta/) });
  });
});

let seq = 0;
function m(kind: 'malo' | 'bueno', classDay: string, score: number, extra: Partial<Moment> = {}): Moment {
  seq++;
  return {
    id: `m${String(seq).padStart(3, '0')}`, analysisId: `ca_${classDay}`, studentGroup: 's1', teacherId: 't1',
    classDay, studentLabel: 'Ana', kind, start: seq * 100, end: seq * 100 + 10, excerpt: '', score, why: '', fathomUrl: null, ...extra,
  };
}

describe('keepBest', () => {
  it('hasta N de cada tipo, los de más puntuación y sin pisarse', () => {
    const list = [m('malo', '2026-08-01', 5), m('malo', '2026-08-01', 9), m('malo', '2026-08-01', 7), m('bueno', '2026-08-01', 6)];
    list[2].start = list[1].start; list[2].end = list[1].end;   // se pisa con el de 9
    expect(keepBest(list, 2).map(x => `${x.kind}${x.score}`)).toEqual(['malo9', 'malo5', 'bueno6']);
  });
});

describe('bestPairs', () => {
  it('mismo alumno + mismo profe, clases distintas, la combinación más fuerte en orden', () => {
    const p = bestPairs([
      m('malo', '2026-07-01', 6), m('malo', '2026-07-08', 9),
      m('bueno', '2026-08-01', 7), m('bueno', '2026-09-01', 8),
    ]);
    expect(p).toHaveLength(1);
    expect([p[0].malo.score, p[0].bueno.score, p[0].reverse]).toEqual([9, 8, false]);
  });

  it('prefiere el orden normal aunque una pareja al revés sume más', () => {
    // Al revés: bueno 01/07 (10) + malo 01/08 (10) = 20. En orden: malo 01/06 (3) + bueno 15/08 (4) = 7.
    const p = bestPairs([m('bueno', '2026-07-01', 10), m('malo', '2026-08-01', 10), m('malo', '2026-06-01', 3), m('bueno', '2026-08-02', 4)]);
    expect([p[0].malo.classDay, p[0].bueno.classDay, p[0].reverse]).toEqual(['2026-08-01', '2026-08-02', false]);
  });

  it('si solo hay al revés, sale marcada como orden inverso', () => {
    const p = bestPairs([m('bueno', '2026-07-01', 8), m('malo', '2026-08-01', 7)]);
    expect(p[0].reverse).toBe(true);
  });

  it('nunca junta profes distintos ni dos momentos de la misma clase', () => {
    expect(bestPairs([m('malo', '2026-07-01', 8), m('bueno', '2026-08-01', 8, { teacherId: 't2' })])).toEqual([]);
    expect(bestPairs([m('malo', '2026-07-01', 8), m('bueno', '2026-07-01', 8)])).toEqual([]);
  });

  it('una pareja por alumno y profe', () => {
    const p = bestPairs([
      m('malo', '2026-07-01', 8), m('bueno', '2026-08-01', 8),
      m('malo', '2026-07-02', 8, { teacherId: 't2' }), m('bueno', '2026-08-02', 8, { teacherId: 't2' }),
    ]);
    expect(p.map(x => x.teacherId).sort()).toEqual(['t1', 't2']);
  });
});
