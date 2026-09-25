// Lógica server-side compartida por las rutas del test: elegir la próxima pregunta
// según el progreso y la dificultad actual, fijándola (current_question_id) para que
// una recarga devuelva la MISMA pregunta hasta que se responda.
//
// VELOCIDAD (sep/2026). Al pulsar "Siguiente" el alumno esperaba 1–1,5 s (hasta
// 3 s) y NO por la IA: la lectura no la usa. Eran 8 consultas a Supabase una
// detrás de otra, cada una cruzando de la función de Vercel (Washington) a la
// base. Ahora:
//   · el banco de preguntas (unas 60, fijas) se guarda en memoria unos minutos:
//     buscar la pregunta respondida y elegir la siguiente ya no cuesta viajes;
//   · la sesión y sus respuestas se leen en UNA consulta (loadSessionWithAnswers);
//   · la siguiente pregunta se calcula en memoria (pickNext) con las respuestas
//     ya conocidas, sin volver a leerlas después de guardar.
// La elección de pregunta es EXACTAMENTE la misma que antes (selectNextQuestion
// con la misma dificultad y las mismas ya respondidas): no toca la precisión.

import { supabase } from '@/lib/supabase';
import { SECTION_ORDER, SECTION_COUNT, GRAND_TOTAL } from './constants';
import { selectNextQuestion } from './adaptive';
import type { LTSection, LTQuestionPublic, LTProgress } from './types';

const PUBLIC_COLS = 'id, section, cefr_level, difficulty, prompt_text, question_text, options, writing_prompt, writing_min_words';

/** Pregunta del banco tal como la usa el SERVIDOR: con la respuesta correcta. Nunca sale al cliente. */
export interface BankQuestion extends LTQuestionPublic {
  correct_answer: number | null;
}

export interface SessionLite {
  id: string;
  current_difficulty: number | null;
  current_question_id: string | null;
  questions_answered: unknown;
}

export interface AnsweredLite { question_id: string; section: string; answered_at?: string | null }

export interface NextResult {
  question: LTQuestionPublic | null;
  progress: LTProgress;
  done: boolean;
  currentQuestionId: string | null;
}

// ── Banco en memoria ─────────────────────────────────────────────────────────
// Vercel reutiliza la misma instancia de la función entre peticiones, así que la
// caché dura mientras la instancia viva. 5 minutos: si se edita o desactiva una
// pregunta en Supabase, como mucho tarda eso en notarse.
const BANK_TTL_MS = 5 * 60_000;
let bankCache: { at: number; rows: BankQuestion[] } | null = null;

/** Preguntas ACTIVAS del banco, desde la memoria si está fresca. */
export async function loadBank(): Promise<BankQuestion[]> {
  if (bankCache && Date.now() - bankCache.at < BANK_TTL_MS) return bankCache.rows;
  const { data, error } = await supabase
    .from('level_test_questions').select(`${PUBLIC_COLS}, correct_answer`).eq('is_active', true);
  if (error) {
    console.error('[level-test] No se pudo leer el banco de preguntas:', error);
    // Mejor un banco viejo que ninguno; si no hay ni eso, vacío (el test se para
    // en "no podemos continuar" y la sesión queda intacta para retomarla).
    return bankCache?.rows ?? [];
  }
  bankCache = { at: Date.now(), rows: (data ?? []) as unknown as BankQuestion[] };
  return bankCache.rows;
}

/** Busca una pregunta por id: primero en el banco, y si no está (p. ej. se desactivó a mitad de test), en la base. */
export async function findQuestion(bank: BankQuestion[], id: string): Promise<BankQuestion | null> {
  const hit = bank.find(q => q.id === id);
  if (hit) return hit;
  const { data } = await supabase
    .from('level_test_questions').select(`${PUBLIC_COLS}, correct_answer`).eq('id', id).maybeSingle();
  return (data as unknown as BankQuestion) ?? null;
}

/** Lo que ve el alumno: la pregunta SIN la respuesta correcta. */
export function toPublic(q: BankQuestion | LTQuestionPublic): LTQuestionPublic {
  return {
    id: q.id, section: q.section, cefr_level: q.cefr_level, difficulty: q.difficulty,
    prompt_text: q.prompt_text, question_text: q.question_text, options: q.options,
    writing_prompt: q.writing_prompt, writing_min_words: q.writing_min_words,
  };
}

// ── Sesión + respuestas en una sola consulta ─────────────────────────────────
// Fila completa de level_test_sessions (select '*'): las rutas leen sus columnas
// sueltas (status, expires_at, student_id…) sin un tipo por cada una.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SessionRow = Record<string, any> & SessionLite;

/**
 * Lee la sesión por token junto con sus respuestas (question_id, section,
 * answered_at). Una consulta en vez de tres. Si la relación no se pudiera
 * embeber, cae a dos consultas: más lento, pero funciona igual.
 */
export async function loadSessionWithAnswers(token: string): Promise<{
  session: SessionRow | null; answers: AnsweredLite[]; error: unknown;
}> {
  const embedded = await supabase
    .from('level_test_sessions')
    .select('*, level_test_answers(question_id, section, answered_at)')
    .eq('token', token).maybeSingle();
  if (!embedded.error) {
    if (!embedded.data) return { session: null, answers: [], error: null };
    const { level_test_answers: ans, ...session } = embedded.data as Record<string, unknown>;
    return { session: session as SessionRow, answers: (ans ?? []) as AnsweredLite[], error: null };
  }

  console.warn('[level-test] No se pudo embeber las respuestas; se leen aparte:', embedded.error.message);
  const s = await supabase.from('level_test_sessions').select('*').eq('token', token).maybeSingle();
  if (s.error || !s.data) return { session: null, answers: [], error: s.error };
  const a = await supabase
    .from('level_test_answers').select('question_id, section, answered_at').eq('session_id', s.data.id);
  return { session: s.data as SessionRow, answers: (a.data ?? []) as AnsweredLite[], error: null };
}

// ── Elegir la próxima pregunta (en memoria) ──────────────────────────────────
/**
 * Próxima pregunta + progreso, a partir de lo que ya se sabe. PURO salvo por el
 * azar de selectNextQuestion entre empatadas. NO persiste nada: el caller decide
 * si guarda `currentQuestionId` en la sesión.
 */
export function pickNext(
  bank: BankQuestion[],
  answered: AnsweredLite[],
  currentDifficulty: number | null,
  currentQuestionId: string | null,
  fixedQuestion?: BankQuestion | null,
): NextResult {
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
  let q: BankQuestion | null = null;
  if (currentQuestionId && !answeredIds.includes(currentQuestionId)) {
    const fixed = fixedQuestion?.id === currentQuestionId ? fixedQuestion : bank.find(b => b.id === currentQuestionId);
    if (fixed && fixed.section === currentSection) q = fixed;
  }
  if (!q) q = selectNextQuestion(bank, currentSection, currentDifficulty ?? 3, answeredIds);

  const progress: LTProgress = {
    section: currentSection, sectionIndex, sectionTotal: SECTION_ORDER.length,
    answeredInSection: countIn(currentSection), totalInSection: SECTION_COUNT[currentSection],
    answeredTotal, grandTotal: GRAND_TOTAL, done: false,
  };
  return { question: q ? toPublic(q) : null, done: false, currentQuestionId: q ? q.id : null, progress };
}

/** Versión con lectura, para el GET: respuestas de la base + banco de la memoria. */
export async function computeNext(session: SessionLite, knownAnswers?: AnsweredLite[]): Promise<NextResult> {
  const [answers, bank] = await Promise.all([
    knownAnswers
      ? Promise.resolve(knownAnswers)
      : supabase.from('level_test_answers').select('question_id, section').eq('session_id', session.id)
          .then(r => (r.data ?? []) as AnsweredLite[]),
    loadBank(),
  ]);
  // La pregunta fijada puede estar desactivada (no está en el banco): se busca aparte.
  const fixed = session.current_question_id && !bank.some(b => b.id === session.current_question_id)
    ? await findQuestion(bank, session.current_question_id)
    : null;
  return pickNext(bank, answers, session.current_difficulty, session.current_question_id, fixed);
}

// questions_answered puede venir como array (jsonb) o string JSON.
export function parseAnswered(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}
