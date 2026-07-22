// Lógica server-side compartida por las rutas del test: elegir la próxima pregunta
// según el progreso y la dificultad actual, fijándola (current_question_id) para que
// una recarga devuelva la MISMA pregunta hasta que se responda.

import { supabase } from '@/lib/supabase';
import { SECTION_ORDER, SECTION_COUNT, GRAND_TOTAL } from './constants';
import { selectNextQuestion } from './adaptive';
import type { LTSection, LTQuestionPublic, LTProgress } from './types';

const PUBLIC_COLS = 'id, section, cefr_level, difficulty, prompt_text, question_text, options, writing_prompt, writing_min_words';

export interface SessionLite {
  id: string;
  current_difficulty: number | null;
  current_question_id: string | null;
  questions_answered: unknown;
}

export interface NextResult {
  question: LTQuestionPublic | null;
  progress: LTProgress;
  done: boolean;
  currentQuestionId: string | null;
}

// Devuelve la próxima pregunta a responder + el progreso. NO persiste nada; el
// caller decide si guardar `currentQuestionId` en la sesión.
export async function computeNext(session: SessionLite): Promise<NextResult> {
  const { data: ansRows } = await supabase
    .from('level_test_answers')
    .select('question_id, section')
    .eq('session_id', session.id);
  const answered = (ansRows ?? []) as Array<{ question_id: string; section: string }>;
  const answeredIds = answered.map(a => a.question_id);
  const countIn = (sec: LTSection) => answered.filter(a => a.section === sec).length;

  // Primera sección no completa.
  let currentSection: LTSection | null = null;
  let sectionIndex = 0;
  for (let i = 0; i < SECTION_ORDER.length; i++) {
    const sec = SECTION_ORDER[i];
    if (countIn(sec) < SECTION_COUNT[sec]) { currentSection = sec; sectionIndex = i; break; }
  }

  const answeredTotal = answeredIds.length;

  if (!currentSection) {
    const last = SECTION_ORDER[SECTION_ORDER.length - 1];
    return {
      question: null, done: true, currentQuestionId: null,
      progress: {
        section: last, sectionIndex: SECTION_ORDER.length - 1, sectionTotal: SECTION_ORDER.length,
        answeredInSection: SECTION_COUNT[last], totalInSection: SECTION_COUNT[last],
        answeredTotal, grandTotal: GRAND_TOTAL, done: true,
      },
    };
  }

  // Reutilizar la pregunta fijada si sigue vigente y es de la sección actual.
  let q: LTQuestionPublic | null = null;
  if (session.current_question_id && !answeredIds.includes(session.current_question_id)) {
    const { data } = await supabase.from('level_test_questions').select(PUBLIC_COLS)
      .eq('id', session.current_question_id).maybeSingle();
    if (data && (data as LTQuestionPublic).section === currentSection) q = data as LTQuestionPublic;
  }
  if (!q) {
    const { data: pool } = await supabase.from('level_test_questions').select(PUBLIC_COLS)
      .eq('section', currentSection).eq('is_active', true);
    q = selectNextQuestion((pool ?? []) as LTQuestionPublic[], currentSection, session.current_difficulty ?? 3, answeredIds);
  }

  const progress: LTProgress = {
    section: currentSection, sectionIndex, sectionTotal: SECTION_ORDER.length,
    answeredInSection: countIn(currentSection), totalInSection: SECTION_COUNT[currentSection],
    answeredTotal, grandTotal: GRAND_TOTAL, done: false,
  };
  return { question: q, done: false, currentQuestionId: q ? q.id : null, progress };
}

// questions_answered puede venir como array (jsonb) o string JSON.
export function parseAnswered(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}
