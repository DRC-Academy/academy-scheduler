import { describe, expect, it } from 'vitest';
import {
  textFeatures, linguisticBlock, isSpanish, extractSegments, choosePair, averageWpm, canBeA, canBeB,
  type ExtractInput,
} from '@/lib/testimonialScoring';
import type { Turn } from '@/lib/fluency';

const PROFE = 'Lily (lily@gmail.com)';
const T = (at: string, speaker: string, text: string): Turn => ({ at, speaker, text });

describe('textFeatures', () => {
  it('cuenta muletillas, y "ah"/"eh" pesan menos y nada si contestan ("ah, ok")', () => {
    expect(textFeatures('Um, I went, uh, there').fillers).toBe(2);
    expect(textFeatures('Eh, I went there').fillers).toBe(0.5);
    expect(textFeatures('Ah, ok, I see what you mean').fillers).toBe(0);
    expect(textFeatures('Ah, I see, that makes sense').fillers).toBe(0);
  });
  it('cuenta repeticiones seguidas pero no las naturales ("bye bye", "no no")', () => {
    expect(textFeatures('during during during the summer').repeats).toBe(2);
    expect(textFeatures('I, I, I think so').repeats).toBe(2);
    expect(textFeatures('No, no, bye bye').repeats).toBe(0);
  });
  it('detecta la búsqueda de palabra y las palabras en español', () => {
    const f = textFeatures("I'm a little, I don't know how to say, rencoroso, como...");
    expect(f.searches).toBe(1);
    expect(f.spanishWords).toBe(2);
    expect(linguisticBlock(f)).toBe(4);
  });
});

describe('isSpanish', () => {
  it('lo mayoritariamente en español, sí; el inglés con alguna palabra suelta, no', () => {
    expect(isSpanish('No, no, no, salió bien. Salió bien, tranquila.')).toBe(true);
    expect(isSpanish('Bueno, te voy a decir en español, porque si no aquí la gente se entera.')).toBe(true);
    expect(isSpanish('I used to think that the people have uno o dos niños in the school')).toBe(false);
  });
});

/** Una clase: el profe pregunta y el alumno contesta, con su minuto de Fathom. */
function clase(id: string, day: string, teacherId: string, alumno: Array<[string, string, string]>): ExtractInput {
  const turns: Turn[] = [];
  for (const [at, text, next] of alumno) {
    turns.push(T(at, PROFE, 'Tell me more about that, please.'));
    turns.push(T(at.replace(/:(\d\d)$/, (_, s) => `:${String(Number(s) + 2).padStart(2, '0')}`), 'Ana', text));
    turns.push(T(next, PROFE, 'Okay.'));
  }
  return { analysisId: id, studentGroup: 's1', teacherId, classDay: day, studentLabel: 'Ana', fathomUrl: 'https://fathom.video/share/x', turns };
}

const MALA: [string, string, string] = ['1:00', 'Um, I, I went to the, eh, the beach with my, uh, family.', '1:10'];
const BUENA: [string, string, string] = ['1:00', 'I went to the beach with my family and we had a lovely time, we swam every morning and ate fish every night.', '1:20'];

describe('extractSegments + choosePair', () => {
  it('saca el A de la clase mala y el B de la buena, con el mismo profe y 5 semanas', () => {
    const a = extractSegments(clase('c1', '2026-08-01', 't1', [MALA]));
    const b = extractSegments(clase('c2', '2026-09-05', 't1', [BUENA]));
    expect(a.segments.some(canBeA)).toBe(true);
    expect(b.segments.some(canBeB)).toBe(true);
    const r = choosePair([...a.segments, ...b.segments], averageWpm([a.stats, b.stats]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pair.a.analysisId).toBe('c1');
      expect(r.pair.b.analysisId).toBe('c2');
      expect(r.pair.gapDays).toBe(35);
      expect(r.pair.b.end - r.pair.b.start).toBeGreaterThan(r.pair.a.end - r.pair.a.start);
    }
  });
  it('sin las semanas mínimas, o con otro profe, no hay pareja y dice por qué', () => {
    const a = extractSegments(clase('c1', '2026-08-01', 't1', [MALA])).segments;
    const cerca = extractSegments(clase('c2', '2026-08-10', 't1', [BUENA])).segments;
    const otro = extractSegments(clase('c3', '2026-09-20', 't2', [BUENA])).segments;
    expect(choosePair([...a, ...cerca], null)).toMatchObject({ ok: false, reason: 'poca_distancia' });
    expect(choosePair([...a, ...otro], null)).toMatchObject({ ok: false, reason: 'distinto_profe' });
  });
  it('una frase limpia no es un A, aunque vaya lenta', () => {
    const lenta = extractSegments(clase('c1', '2026-08-01', 't1', [['1:00', 'Artificial intelligence should strictly be regulated.', '1:30']]));
    expect(lenta.segments.some(canBeA)).toBe(false);
  });
});
