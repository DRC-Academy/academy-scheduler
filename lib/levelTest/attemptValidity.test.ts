import { describe, it, expect } from 'vitest';
import {
  checkWritingAttempt,
  analyzeAttempt,
  tokenizeWords,
  MIN_DIVERSITY_RATIO,
  MIN_DISTINCT_WORDS,
  MAX_WORD_SHARE,
} from './attemptValidity';

// ── Textos de referencia ─────────────────────────────────────────────────────

// Relleno para pasar el contador de palabras. Es el caso que motivó todo esto.
const RELLENO = 'a a a a';

// Relleno más elaborado: repite y puntúa, para que no baste con mirar la
// puntuación.
const RELLENO_PUNTUADO = 'a a a. a a a. a a a. a a a.';

// A1 LEGÍTIMO: corto, simple, repetitivo, con errores — y real. ESTE es el caso
// que importa. Que la basura caiga es fácil; lo difícil es no llevarse por
// delante a un principiante de verdad, que es precisamente quien escribe con
// vocabulario corto y estructuras repetidas.
const A1_LEGITIMO = [
  'Hi. My name is Ana and I am twenty five years old.',
  'I live in Madrid with my mother and my father.',
  'I have one sister. She is a teacher.',
  'I work in a small shop near my house.',
  'I like music and films.',
  'On Sunday I go to the park with my friends.',
  'I study English because I want a better job.',
].join(' ');

// A1 aún más pelado: el mínimo que un principiante entrega de verdad.
const A1_MINIMO = [
  'My name is Pablo. I am from Sevilla.',
  'I have a dog. His name is Toby.',
  'I like football and pizza. I work in a bar.',
  'My English is not good but I want to learn.',
].join(' ');

const B2_LEGITIMO = [
  'Although I have been working in marketing for almost a decade, I still find',
  'that the most challenging part of the job is persuading clients to take risks.',
  'Most of them would rather repeat a campaign that performed reasonably well than',
  'try something genuinely new, which is understandable but ultimately limiting.',
  'In my experience, the best results come from a compromise: keeping a proven',
  'structure while changing the tone or the channel.',
].join(' ');

// ── El caso que importa: el A1 legítimo NO puede caer ────────────────────────

describe('checkWritingAttempt — un intento legítimo nunca se descarta', () => {
  it('acepta un texto A1 real: corto, simple y repetitivo', () => {
    const r = checkWritingAttempt(A1_LEGITIMO);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('acepta un A1 todavía más pelado', () => {
    const r = checkWritingAttempt(A1_MINIMO);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('acepta un texto B2', () => {
    const r = checkWritingAttempt(B2_LEGITIMO);
    expect(r.valid).toBe(true);
    expect(r.reason).toBeNull();
  });

  // Documenta CUÁNTO margen tiene el A1 legítimo contra cada umbral. Si un
  // cambio futuro de umbrales lo deja al borde, este test lo dice antes de que
  // se note en producción con un alumno real.
  it('el A1 legítimo pasa cada umbral con margen, no por los pelos', () => {
    const s = analyzeAttempt(A1_LEGITIMO);
    expect(s.diversityRatio).toBeGreaterThan(MIN_DIVERSITY_RATIO * 1.5);
    expect(s.distinctWords).toBeGreaterThan(MIN_DISTINCT_WORDS * 1.5);
    expect(s.topWordShare).toBeLessThan(MAX_WORD_SHARE * 0.6);
    expect(s.hasSentenceEnd).toBe(true);
  });
});

// ── Basura ───────────────────────────────────────────────────────────────────

describe('checkWritingAttempt — descarta lo que no es un intento', () => {
  it('descarta "a a a a"', () => {
    const r = checkWritingAttempt(RELLENO);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('low_diversity');
  });

  it('descarta el relleno aunque esté puntuado', () => {
    const r = checkWritingAttempt(RELLENO_PUNTUADO);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('low_diversity');
  });

  it('descarta el texto vacío y el de solo espacios', () => {
    expect(checkWritingAttempt('').valid).toBe(false);
    expect(checkWritingAttempt('    \n  ').valid).toBe(false);
  });
});

// ── Una regla por test, con el mínimo texto que la dispara ───────────────────

describe('checkWritingAttempt — cada regla, aislada', () => {
  it('low_diversity: palabras distintas / totales por debajo de 0,3', () => {
    // 6 distintas sobre 21 = 0,29.
    const texto = 'the cat and the dog and the cat and the dog and the cat and the dog and the cat.';
    const s = analyzeAttempt(texto);
    expect(s.diversityRatio).toBeLessThan(MIN_DIVERSITY_RATIO);
    expect(checkWritingAttempt(texto).reason).toBe('low_diversity');
  });

  it('few_distinct: variado pero con menos de 15 palabras distintas', () => {
    const texto = 'My dog is big. My cat is small. My house is old.';
    const s = analyzeAttempt(texto);
    expect(s.diversityRatio).toBeGreaterThanOrEqual(MIN_DIVERSITY_RATIO);
    expect(s.distinctWords).toBeLessThan(MIN_DISTINCT_WORDS);
    expect(checkWritingAttempt(texto).reason).toBe('few_distinct');
  });

  it('no_sentence_end: texto largo y variado sin un solo . ! ? …', () => {
    const texto = A1_LEGITIMO.replace(/[.!?…]/g, '');
    expect(analyzeAttempt(texto).hasSentenceEnd).toBe(false);
    expect(checkWritingAttempt(texto).reason).toBe('no_sentence_end');
  });

  it('word_dominance: una sola palabra por encima del 40% del texto', () => {
    const texto = [
      'the the the the the the the the the the the the the the the',
      'cat dog house tree water paper music window garden bottle pencil flower river mountain silver.',
    ].join(' ');
    const s = analyzeAttempt(texto);
    // Pasa las tres reglas anteriores: solo puede caer por dominancia.
    expect(s.diversityRatio).toBeGreaterThanOrEqual(MIN_DIVERSITY_RATIO);
    expect(s.distinctWords).toBeGreaterThanOrEqual(MIN_DISTINCT_WORDS);
    expect(s.hasSentenceEnd).toBe(true);
    expect(s.topWordShare).toBeGreaterThan(MAX_WORD_SHARE);
    expect(checkWritingAttempt(texto).reason).toBe('word_dominance');
  });

  it('acepta ! ? y … como cierre de frase, no solo el punto', () => {
    for (const cierre of ['!', '?', '…']) {
      const texto = A1_LEGITIMO.replace(/[.!?…]/g, '') + cierre;
      expect(checkWritingAttempt(texto).valid).toBe(true);
    }
  });
});

// ── Tokenizado ───────────────────────────────────────────────────────────────

describe('tokenizeWords', () => {
  it('normaliza mayúsculas y puntuación: "Hello," y "hello" son la misma', () => {
    expect(analyzeAttempt('Hello, hello. HELLO!').distinctWords).toBe(1);
  });

  it('no parte las contracciones', () => {
    expect(tokenizeWords("don't stop")).toEqual(["don't", 'stop']);
  });

  it('no parte las palabras acentuadas si el alumno mezcla idiomas', () => {
    expect(tokenizeWords('mañana café')).toEqual(['mañana', 'café']);
  });

  it('el texto vacío no da NaN', () => {
    const s = analyzeAttempt('');
    expect(s.totalWords).toBe(0);
    expect(s.diversityRatio).toBe(0);
    expect(s.topWordShare).toBe(0);
    expect(s.topWord).toBeNull();
  });
});
