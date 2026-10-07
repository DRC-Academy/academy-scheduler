import { describe, expect, it } from 'vitest';
import {
  parseFathomTurns, parseCaptionTurns, parseTurns, extractFathomUrl, identifyTeacher, prepareFluency,
  formatTurnsForAi, excerptFound, MIN_WORDS,
  toSeconds, formatSeconds, locateExcerpt, excerptStartSeconds, excerptEndSeconds, excerptWordCount, withFathomTimestamp,
  readingCue, type Turn,
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

describe('segundo exacto de una cita', () => {
  const turns = [
    { at: '0:05', speaker: 'Profe', text: 'Tell me about your weekend.' },
    { at: '0:10', speaker: 'Alumno', text: 'I went to the beach with my family and we ate paella, it was very nice and sunny' },
    { at: '0:20', speaker: 'Profe', text: 'Great!' },
    { at: '1:02:15', speaker: 'Alumno', text: 'Last one here' },
  ];

  it('toSeconds y formatSeconds van y vuelven', () => {
    expect(toSeconds('12:40')).toBe(760);
    expect(toSeconds('1:02:15')).toBe(3735);
    expect(toSeconds('hola')).toBeNull();
    expect(formatSeconds(760)).toBe('12:40');
    expect(formatSeconds(3735)).toBe('1:02:15');
    expect(formatSeconds(7)).toBe('0:07');
  });

  it('al inicio de la intervención: la hora de Fathom tal cual', () => {
    const loc = locateExcerpt(turns, 'I went to the beach')!;
    expect(loc).toEqual({ turnIndex: 1, wordsBefore: 0, turnWords: 18 });
    expect(excerptStartSeconds(turns, loc)).toBe(10);
  });

  it('en mitad: reparte el tiempo por palabras y adelanta 1 s', () => {
    // 11 de 18 palabras antes, en una intervención de 10 s → ⌊10 + 6,1⌋ − 1.
    const loc = locateExcerpt(turns, 'paella, it was very nice')!;
    expect(loc.wordsBefore).toBe(11);
    expect(excerptStartSeconds(turns, loc)).toBe(15);
  });

  it('tolera mayúsculas y puntuación, pero solo palabras enteras', () => {
    expect(locateExcerpt(turns, 'i WENT to the beach!')).not.toBeNull();
    expect(locateExcerpt(turns, 'went to the bea')).toBeNull();
  });

  it('una cita que cruza dos intervenciones no vale', () => {
    expect(locateExcerpt(turns, 'very nice and sunny Great')).toBeNull();
  });

  it('añade ?timestamp al enlace de Fathom', () => {
    expect(withFathomTimestamp('https://fathom.video/share/abc', 95)).toBe('https://fathom.video/share/abc?timestamp=95');
    expect(withFathomTimestamp('https://fathom.video/share/abc?timestamp=3', 95)).toBe('https://fathom.video/share/abc?timestamp=95');
    expect(withFathomTimestamp('https://fathom.video/share/abc', null)).toBe('https://fathom.video/share/abc');
    expect(withFathomTimestamp(null, 95)).toBeNull();
  });
});

describe('readingCue (lectura, audio o repetición)', () => {
  const T = (speaker: string, text: string): Turn => ({ at: '0:01', speaker, text });

  it('tira el clip si justo antes se anuncia un audio o una lectura', () => {
    const turns = [
      T('Profe', 'Okay. So now we are going to listen to Petra telling Dave about her vision board.'),
      T('Ana', "I'm going to buy some really good running shoes. Then I'm going to get up at 5am every day."),
    ];
    expect(readingCue(turns, 1)).toMatch(/listen/);
    expect(readingCue([T('Profe', 'Mientras, puedes ir leyendo el diálogo.'), turns[1]], 1)).toMatch(/leyendo/);
    expect(readingCue([T('Profe', 'Ahora cerremos el ensayo con el Párrafo 4.'), turns[1]], 1)).toMatch(/ensayo/);
  });

  it('tira el clip si el propio texto suena a podcast', () => {
    expect(readingCue([T('Ana', "In this podcast, we'll be understanding how our brains change when we fall in love.")], 0)).toMatch(/podcast/);
  });

  it('una pregunta normal del profe no es pista', () => {
    const turns = [
      T('Profe', 'How was the fusion food, finally? Did you like it?'),
      T('Ana', 'It was honestly one of the best meals we had in a long time, my wife loved it.'),
    ];
    expect(readingCue(turns, 1)).toBeNull();
    // "already" no es "read": por palabras enteras.
    expect(readingCue([T('Profe', 'Have you already finished?'), turns[1]], 1)).toBeNull();
  });
});

describe('excerptEndSeconds (fin del clip)', () => {
  const t = (at: string, text: string, speaker = 'Alumno'): Turn => ({ at, speaker, text });

  it('si la cita llega al final de la intervención, termina donde empieza la siguiente', () => {
    const turns = [t('8:20', 'I went to the beach with my family last weekend and it was great'), t('8:27', 'Nice!', 'Profe')];
    const loc = locateExcerpt(turns, turns[0].text)!;
    expect(excerptEndSeconds(turns, loc, excerptWordCount(turns[0].text), 500)).toBe(507);
  });

  it('en una intervención larga lo estima por la posición de la última palabra', () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`);
    const turns = [t('10:00', words.join(' ')), t('10:50', 'Ok', 'Profe')];
    // Palabras 0-19 de 100 en 50 s → termina hacia el segundo 10 (+1 de margen).
    const loc = locateExcerpt(turns, words.slice(0, 20).join(' '))!;
    expect(excerptEndSeconds(turns, loc, 20, 600)).toBe(611);
  });

  it('un silencio largo antes de la siguiente no alarga el clip: se estima por palabras', () => {
    const turns = [t('5:00', 'I think that my English is getting better every week'), t('6:30', 'Yes', 'Profe')];
    const loc = locateExcerpt(turns, turns[0].text)!;
    // 10 palabras a 2,5 por segundo = 4 s, +1 de margen.
    expect(excerptEndSeconds(turns, loc, 10, 300)).toBe(305);
  });

  it('nunca menos de 4 s ni más de 20 s', () => {
    const turns = [t('1:00', 'yes I do like it'), t('1:01', 'Ok', 'Profe')];
    const loc = locateExcerpt(turns, 'yes I do like it')!;
    expect(excerptEndSeconds(turns, loc, 5, 60)).toBe(64);
  });
});
