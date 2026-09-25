import { describe, it, expect } from 'vitest';
import { pickNext, toPublic, type BankQuestion, type AnsweredLite } from './server';
import { computeFinalResult, type FinalAnswerRow } from './finalResult';
import type { LTSection } from './types';

// Banco sintético: 10 preguntas por (sección de lectura, dificultad) + 3 de escritura.
function q(section: LTSection, difficulty: number, n: number): BankQuestion {
  return {
    id: `${section}-${difficulty}-${n}`, section, difficulty, cefr_level: 'B1',
    prompt_text: null, question_text: 'x', options: ['a', 'b'], writing_prompt: null, writing_min_words: null,
    correct_answer: 0,
  };
}
const BANK: BankQuestion[] = [];
for (const s of ['reading_completion', 'reading_passage', 'reading_email'] as LTSection[]) {
  for (let d = 1; d <= 6; d++) for (let n = 0; n < 10; n++) BANK.push(q(s, d, n));
}
for (let n = 0; n < 3; n++) BANK.push(q('writing', 3, n));

const answered = (section: LTSection, k: number): AnsweredLite[] =>
  Array.from({ length: k }, (_, i) => ({ question_id: `${section}-9-${i}`, section }));

describe('pickNext — la siguiente pregunta en memoria', () => {
  it('empieza por completion, en la dificultad pedida', () => {
    const r = pickNext(BANK, [], 3, null);
    expect(r.done).toBe(false);
    expect(r.question?.section).toBe('reading_completion');
    expect(r.question?.difficulty).toBe(3);
    expect(r.progress.answeredTotal).toBe(0);
  });

  it('nunca manda la respuesta correcta al cliente', () => {
    const r = pickNext(BANK, [], 3, null);
    expect(r.question).not.toHaveProperty('correct_answer');
    expect(toPublic(BANK[0])).not.toHaveProperty('correct_answer');
  });

  it('con completion lleno pasa a passage', () => {
    const r = pickNext(BANK, answered('reading_completion', 6), 5, null);
    expect(r.question?.section).toBe('reading_passage');
    expect(r.question?.difficulty).toBe(5);
    expect(r.progress.sectionIndex).toBe(1);
  });

  it('respeta la pregunta fijada si sigue vigente y es de la sección', () => {
    const fijada = 'reading_completion-6-4';
    const r = pickNext(BANK, [], 3, fijada);
    expect(r.currentQuestionId).toBe(fijada);
  });

  it('no repite una pregunta ya respondida', () => {
    const ya: AnsweredLite[] = BANK.filter(b => b.section === 'reading_completion' && b.difficulty === 3).slice(0, 5)
      .map(b => ({ question_id: b.id, section: b.section }));
    for (let i = 0; i < 20; i++) {
      const r = pickNext(BANK, ya, 3, null);
      expect(ya.map(a => a.question_id)).not.toContain(r.currentQuestionId);
    }
  });

  it('con las 17 respondidas, done', () => {
    const todas = [
      ...answered('reading_completion', 6), ...answered('reading_passage', 5),
      ...answered('reading_email', 5), ...answered('writing', 1),
    ];
    const r = pickNext(BANK, todas, 3, null);
    expect(r.done).toBe(true);
    expect(r.question).toBeNull();
  });
});

describe('computeFinalResult — mismo nivel en el cierre y en la reevaluación', () => {
  const lectura = (dif: number, ok: boolean): FinalAnswerRow =>
    ({ section: 'reading_completion', difficulty: dif, is_correct: ok, ai_score: null, ai_feedback: null });
  const rows16 = Array.from({ length: 16 }, (_, i) => lectura(4, i % 2 === 0));

  it('sin escritura puntuada: provisional, con el motivo guardado', () => {
    const r = computeFinalResult([...rows16, {
      section: 'writing', difficulty: 3, is_correct: null, ai_score: null, ai_feedback: null, invalid_reason: 'ai_unavailable',
    }]);
    expect(r.provisional).toBe(true);
    expect(r.provisionalReason).toBe('ai_unavailable');
    expect(r.aiEvaluation).toBeNull();
    expect(r.writingScore).toBeNull();
  });

  it('con escritura puntuada: definitivo y con el feedback para el alumno', () => {
    const fb = { cefr_level: 'B2' };
    const r = computeFinalResult([...rows16, {
      section: 'writing', difficulty: 3, is_correct: null, ai_score: 58, ai_feedback: fb, invalid_reason: null,
    }]);
    expect(r.provisional).toBe(false);
    expect(r.writingScore).toBe(58);
    expect(r.aiEvaluation).toBe(fb);
  });
});
