import { describe, expect, it } from 'vitest';
import {
  planCandidate, ownClasses, speakerMatchesName, speakerKey, pickPair, daysBetween,
  clipLabel, clipsOverlap,
  type FluencyClass, type TestimonialClip,
} from '@/lib/testimonials';

let n = 0;
function clase(day: string, speaker: string | null = 'Ana García'): FluencyClass {
  n++;
  return { analysisId: `ca_${String(n).padStart(3, '0')}`, classNumber: n, classDay: day, teacherId: 't1', score: 6, fathomUrl: null, studentSpeaker: speaker };
}

/** Clases semanales desde el 1 de julio, con estas etiquetas de hablante. */
function semanal(speakers: Array<string | null>, desde = '2026-07-01'): FluencyClass[] {
  const t0 = Date.parse(`${desde}T00:00:00Z`);
  return speakers.map((s, i) => clase(new Date(t0 + i * 7 * 86_400_000).toISOString().slice(0, 10), s));
}
const ANA = (k: number) => Array<string>(k).fill('Ana García');

describe('daysBetween', () => {
  it('cuenta días de calendario', () => {
    expect(daysBetween('2026-07-01', '2026-08-12')).toBe(42);
  });
});

describe('¿es el mismo alumno?', () => {
  it('speakerKey quita el email y deja la parte local de un email suelto', () => {
    expect(speakerKey('Lily DRC Academy (drcacademylily@gmail.com)')).toBe('lily drc academy');
    expect(speakerKey('jvizcaino12@yahoo.es')).toBe('jvizcaino12');
  });

  it('speakerMatchesName: basta un nombre o apellido en común', () => {
    expect(speakerMatchesName('Juan Francisco Zamorano Fernández', 'Juan Fran Zamorano Fernández')).toBe(true);
    expect(speakerMatchesName('Maximiliano Bilotti', 'Max Bilotti')).toBe(true);
    expect(speakerMatchesName('Bruna', 'BRUNA TORRES')).toBe(true);
    expect(speakerMatchesName('Zule', 'Zulena Rosero')).toBe(true);
    expect(speakerMatchesName('Cris (Guest)', 'Cristina Ferre Espinosa')).toBe(true);
    expect(speakerMatchesName('jvizcaino12@yahoo.es', 'Jose Vizcaíno')).toBe(true);
    expect(speakerMatchesName('Elena', 'Ana Aparicio')).toBe(false);
    expect(speakerMatchesName('Dani Sanz Rubí', 'Juan Fran Zamorano Fernández')).toBe(false);
    expect(speakerMatchesName('re ms', 'Remigio Martinez Gonzalez')).toBe(false);
  });

  it('ownClasses: fuera las clases de otra persona', () => {
    const cs = semanal(['Ana Aparicio', 'Ana Aparicio', 'Ana Aparicio', 'Elena', 'Elena']);
    expect(ownClasses(cs, 'Ana Aparicio').map(c => c.studentSpeaker)).toEqual(['Ana Aparicio', 'Ana Aparicio', 'Ana Aparicio']);
  });

  it('ownClasses: vale el alias que usa en más de la mitad de sus clases', () => {
    expect(ownClasses(semanal(['re ms', 're ms', 're ms', 'Otro']), 'Remigio Martinez')).toHaveLength(3);
    expect(ownClasses(semanal(['re ms', 're ms', 'Otro', 'Otro']), 'Remigio Martinez')).toHaveLength(0);
    expect(ownClasses(semanal(['BLNNDNN', 'BLNNDNN', 'BLNNDNN', 'felipe blandon']), 'felipe blandon')).toHaveLength(4);
  });

  it('ownClasses: el nombre completo de otra persona nunca, aunque sea la mayoría', () => {
    expect(ownClasses(semanal(['Luis Méndez', 'Luis Méndez', 'Luis Méndez', 'Victoria Robledo']), 'Victoria Robledo')).toHaveLength(1);
  });

  it('ownClasses: una clase sin hablante del alumno no cuenta', () => {
    expect(ownClasses(semanal(['Ana García', null]), 'Ana García')).toHaveLength(1);
  });
});

describe('planCandidate (V4: sin nota, mismo alumno)', () => {
  it('entra con 4 clases suyas separadas lo suficiente, sin mirar la nota', () => {
    const p = planCandidate(semanal(ANA(6)), 'Ana García')!;
    expect(p.own).toHaveLength(6);
    expect(p.badOptions.map(c => c.classDay)).toEqual(['2026-07-01', '2026-07-08', '2026-07-15']);
    expect(p.goodOptions.map(c => c.classDay)).toEqual(['2026-07-22', '2026-07-29', '2026-08-05']);
    expect(p.before.classDay).toBe('2026-07-01');
    expect(p.after.classDay).toBe('2026-08-05');
  });

  it('con 4 o 5 clases las ventanas no se solapan', () => {
    const p = planCandidate(semanal(ANA(5)), 'Ana García')!;
    expect(p.badOptions).toHaveLength(2);
    expect(p.goodOptions).toHaveLength(2);
    expect(p.badOptions.some(b => p.goodOptions.includes(b))).toBe(false);
  });

  it('no entra con menos de 4 clases suyas: las de otra persona no cuentan', () => {
    expect(planCandidate(semanal(ANA(3)), 'Ana García')).toBeNull();
    expect(planCandidate(semanal([...ANA(3), 'Elena', 'Elena']), 'Ana García')).toBeNull();
  });

  it('no entra si entre las primeras y las últimas no hay 21 días', () => {
    const cs = ['2026-07-01', '2026-07-03', '2026-07-08', '2026-07-10'].map(d => clase(d));
    expect(planCandidate(cs, 'Ana García')).toBeNull();
  });
});

describe('pickPair', () => {
  const k = (classDate: string, start = 10): TestimonialClip =>
    ({ analysisId: `a_${classDate}`, classDate, teacherId: null, start, end: start + 8, excerpt: '', why: '', fathomUrl: null });

  it('el primer malo y el primer bueno con mejora y a los días mínimos', () => {
    const p = pickPair(
      [{ clip: k('2026-07-01'), nivel: 2 }, { clip: k('2026-07-08'), nivel: 1 }],
      [{ clip: k('2026-08-20'), nivel: 4 }],
    )!;
    expect(p.malo.clip.classDate).toBe('2026-07-01');
    expect(p.bueno.nivel).toBe(4);
  });

  it('salta el bueno que no supera al malo', () => {
    const p = pickPair(
      [{ clip: k('2026-07-01'), nivel: 3 }],
      [{ clip: k('2026-08-20'), nivel: 3 }, { clip: k('2026-08-27'), nivel: 4 }],
    )!;
    expect(p.bueno.clip.classDate).toBe('2026-08-27');
  });

  it('null si no hay mejora o están demasiado cerca', () => {
    expect(pickPair([{ clip: k('2026-07-01'), nivel: 3 }], [{ clip: k('2026-08-20'), nivel: 3 }])).toBeNull();
    expect(pickPair([{ clip: k('2026-07-01'), nivel: 1 }], [{ clip: k('2026-07-15'), nivel: 5 }])).toBeNull();
    expect(pickPair([], [{ clip: k('2026-08-20'), nivel: 5 }])).toBeNull();
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
