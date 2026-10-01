import { describe, expect, it } from 'vitest';
import {
  parseFathomTurns, parseCaptionTurns, parseTurns, extractFathomUrl, identifyTeacher, prepareFluency,
  formatTurnsForAi, excerptFound, MIN_WORDS,
} from '@/lib/fluency';

const HEADER = `Impromptu Google Meet Meeting - August 25
VIEW RECORDING - 55 mins (No highlights): https://fathom.video/share/abcDEF_123-x

---

`;

/** Transcript de Fathom con `n` turnos alternos alumno/profe de `words` palabras. */
function fathom(n: number, words: number, speakers = ['Sonia Becerra', 'Wanda Muñoz (wanda@gmail.com)']): string {
  const body = Array.from({ length: n }, (_, i) => {
    const sp = speakers[i % speakers.length];
    const text = Array.from({ length: words }, (_, w) => `word${w}`).join(' ');
    return `${Math.floor(i / 2)}:${String((i * 7) % 60).padStart(2, '0')} - ${sp}\n  ${text}\n`;
  }).join('\n');
  return HEADER + body;
}

describe('parseFathomTurns', () => {
  it('lee minuto, hablante y texto, e ignora la cabecera', () => {
    const t = parseFathomTurns(`${HEADER}0:01 - Sonia Becerra
  So, is there anything
  to check today?

0:06 - Wanda Muñoz (wanda@gmail.com)
  No.

1:02:15 - Sonia Becerra
  Okay.
`);
    expect(t).toEqual([
      { at: '0:01', speaker: 'Sonia Becerra', text: 'So, is there anything to check today?' },
      { at: '0:06', speaker: 'Wanda Muñoz (wanda@gmail.com)', text: 'No.' },
      { at: '1:02:15', speaker: 'Sonia Becerra', text: 'Okay.' },
    ]);
  });

  it('un texto sin formato de Fathom no da turnos', () => {
    expect(parseFathomTurns('Teacher: hello\nStudent: hi')).toEqual([]);
  });
});

describe('parseCaptionTurns (subtítulos de Meet/Zoom)', () => {
  const SRT = `06:03:51 --> 06:03:53
Nury Barreto: Michael Jast?
06:03:53 --> 06:03:55
Jimena Pastore: Hello. How are you?
06:03:55.120 --> 06:03:57.000
Nury Barreto: I'll find you.`;

  it('lee minuto, hablante y texto', () => {
    expect(parseCaptionTurns(SRT)).toEqual([
      { at: '6:03:51', speaker: 'Nury Barreto', text: 'Michael Jast?' },
      { at: '6:03:53', speaker: 'Jimena Pastore', text: 'Hello. How are you?' },
      { at: '6:03:55', speaker: 'Nury Barreto', text: "I'll find you." },
    ]);
  });

  it('parseTurns usa Fathom si lo hay y subtítulos si no', () => {
    expect(parseTurns(SRT)).toHaveLength(3);
    expect(parseTurns(fathom(6, 5))[0].speaker).toBe('Sonia Becerra');
  });

  it('el resumen de Fathom no tiene turnos', () => {
    expect(parseTurns('Meeting Purpose\nPractice tenses.\nKey Takeaways\nPresent Perfect: Use for...')).toEqual([]);
  });
});

describe('extractFathomUrl', () => {
  it('saca el enlace de la grabación', () => {
    expect(extractFathomUrl(HEADER)).toBe('https://fathom.video/share/abcDEF_123-x');
  });
  it('null si no hay enlace', () => {
    expect(extractFathomUrl('0:01 - A\n  hola')).toBeNull();
  });
});

describe('identifyTeacher', () => {
  it('el único con email es el profe', () => {
    expect(identifyTeacher(['Sonia Becerra', 'Wanda (w@x.com)'], {})).toBe('Wanda (w@x.com)');
  });
  it('sin email, por el nombre del profe (sin acentos ni mayúsculas)', () => {
    expect(identifyTeacher(['Sonia Becerra', 'Wanda Muñoz'], { teacherName: 'wanda munoz' })).toBe('Wanda Muñoz');
  });
  it('sin email ni nombre del profe, el que no es el alumno', () => {
    expect(identifyTeacher(['Sonia Becerra', 'Profe X'], { studentName: 'Sonia' })).toBe('Profe X');
  });
  it('dos con email y sin más pistas: no se adivina', () => {
    expect(identifyTeacher(['A (a@x.com)', 'B (b@x.com)'], {})).toBeNull();
  });
});

describe('prepareFluency', () => {
  it('transcript normal: pasa a la IA con roles y reparto de palabras', () => {
    const p = prepareFluency(fathom(20, 50));
    expect(p.skip).toBeNull();
    expect(p.wordCount).toBe(1000);
    expect(p.teacherSpeaker).toBe('Wanda Muñoz (wanda@gmail.com)');
    expect(p.studentSpeaker).toBe('Sonia Becerra');
    expect(p.labelShare).toBe(50);
    expect(p.fathomUrl).toBe('https://fathom.video/share/abcDEF_123-x');
  });

  it(`menos de ${MIN_WORDS} palabras: descartado`, () => {
    expect(prepareFluency(fathom(20, 30)).skip).toBe('pocas_palabras');
  });

  it('más de 2 personas: descartado', () => {
    expect(prepareFluency(fathom(30, 50, ['A', 'B (b@x.com)', 'C'])).skip).toBe('mas_de_dos_hablantes');
  });

  it('una sola persona: descartado', () => {
    expect(prepareFluency(fathom(20, 50, ['A'])).skip).toBe('un_solo_hablante');
  });

  it('sin formato de Fathom: descartado', () => {
    expect(prepareFluency('Profe: hola '.repeat(500)).skip).toBe('sin_formato_hablantes');
  });
});

describe('formatTurnsForAi', () => {
  it('marca PROFE / ALUMNO y quita el email', () => {
    const p = prepareFluency(fathom(20, 50));
    const lines = formatTurnsForAi(p).split('\n');
    expect(lines[0]).toMatch(/^\[0:00\] ALUMNO \(Sonia Becerra\): word0/);
    expect(lines[1]).toMatch(/^\[0:07\] PROFE \(Wanda Muñoz\): word0/);
    expect(formatTurnsForAi(p)).not.toContain('@');
  });
});

describe('excerptFound', () => {
  const turns = parseFathomTurns(`0:01 - A
  In my opinion, the people who are afraid of the dark
  usually have kids.
0:05 - B
  They are afraid, decimos.`);

  it('encuentra la cita aunque cambien puntuación, mayúsculas y saltos de línea', () => {
    expect(excerptFound(turns, 'in my opinion the people who are afraid of the dark usually have kids')).toBe(true);
  });
  it('una cita inventada no se encuentra', () => {
    expect(excerptFound(turns, 'I really love speaking English every day')).toBe(false);
  });
  it('una cita de menos de 3 palabras no vale como prueba', () => {
    expect(excerptFound(turns, 'afraid')).toBe(false);
  });
});
