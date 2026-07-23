// POST público: recibe la respuesta a la pregunta actual.
//  · Reading  → califica (compara con correct_answer) y ajusta current_difficulty.
//  · Writing  → evalúa con IA (Haiku) y guarda ai_score/ai_feedback.
// Devuelve el resultado + la próxima pregunta (o done=true si terminó el test).

import { supabase } from '@/lib/supabase';
import { computeNext, parseAnswered } from '@/lib/levelTest/server';
import { getNextDifficulty } from '@/lib/levelTest/adaptive';
import { evaluateWriting } from '@/lib/evaluateWriting';
import type { Cefr, WritingEvaluation } from '@/lib/levelTest/types';

export const dynamic = 'force-dynamic';

interface Body {
  question_id?: string;
  selected_answer?: number;
  written_response?: string;
  time_spent_seconds?: number;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  let body: Body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'JSON inválido' }, { status: 400 }); }

  const questionId = body.question_id?.trim();
  if (!token || !questionId) {
    return Response.json({ error: 'Faltan datos (token, question_id).' }, { status: 400 });
  }

  const { data: s, error } = await supabase
    .from('level_test_sessions').select('*').eq('token', token).maybeSingle();
  if (error) return Response.json({ error: 'Error del servidor.' }, { status: 500 });
  if (!s) return Response.json({ error: 'Este link no es válido.' }, { status: 404 });
  if (s.status === 'completed') return Response.json({ error: 'El test ya fue completado.' }, { status: 409 });
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) {
    await supabase.from('level_test_sessions').update({ status: 'expired' }).eq('id', s.id);
    return Response.json({ error: 'Este link ya expiró.' }, { status: 410 });
  }
  if (s.status === 'pending') {
    await supabase.from('level_test_sessions')
      .update({ status: 'in_progress', started_at: new Date().toISOString() }).eq('id', s.id);
  }

  // Rate-limit básico: rechazar envíos demasiado seguidos (anti-abuso simple).
  const { data: lastArr } = await supabase
    .from('level_test_answers').select('answered_at')
    .eq('session_id', s.id).order('answered_at', { ascending: false }).limit(1);
  const last = lastArr?.[0]?.answered_at;
  if (last && Date.now() - new Date(last).getTime() < 700) {
    return Response.json({ error: 'Demasiado rápido, espera un momento.' }, { status: 429 });
  }

  const answeredIds = parseAnswered(s.questions_answered);

  const { data: q } = await supabase
    .from('level_test_questions')
    .select('id, section, difficulty, cefr_level, correct_answer, writing_prompt')
    .eq('id', questionId).maybeSingle();
  if (!q) return Response.json({ error: 'Pregunta no encontrada.' }, { status: 404 });

  let isCorrect: boolean | null = null;
  let aiScore: number | null = null;
  let aiFeedback: WritingEvaluation | null = null;
  let newDifficulty = s.current_difficulty ?? 3;

  if (q.section === 'writing') {
    const written = (body.written_response || '').trim();
    if (!written) return Response.json({ error: 'Falta la respuesta escrita.' }, { status: 400 });
    const res = await evaluateWriting({
      cefrLevel: q.cefr_level as Cefr,
      writingPrompt: q.writing_prompt || '',
      writtenResponse: written,
    });
    if (res.data) { aiScore = res.data.score; aiFeedback = res.data; }
  } else {
    const sel = typeof body.selected_answer === 'number' ? body.selected_answer : -1;
    isCorrect = sel === q.correct_answer;
    newDifficulty = getNextDifficulty(s.current_difficulty ?? 3, isCorrect);
  }

  // Guardar la respuesta y avanzar la sesión (idempotente: no reinsertar si ya
  // se respondió esta pregunta — p. ej. doble submit).
  if (!answeredIds.includes(q.id)) {
    const { error: insErr } = await supabase.from('level_test_answers').insert({
      session_id: s.id,
      question_id: q.id,
      section: q.section,
      difficulty: q.difficulty,
      selected_answer: q.section === 'writing' ? null : (typeof body.selected_answer === 'number' ? body.selected_answer : null),
      is_correct: isCorrect,
      written_response: q.section === 'writing' ? (body.written_response || '') : null,
      ai_score: aiScore,
      ai_feedback: aiFeedback,
      time_spent_seconds: body.time_spent_seconds ?? null,
    });
    if (insErr) {
      console.error('[level-test/answer] Error al guardar la respuesta:', insErr);
      return Response.json({ error: 'No se pudo guardar la respuesta.' }, { status: 500 });
    }
    const newAnswered = [...answeredIds, q.id];
    await supabase.from('level_test_sessions').update({
      questions_answered: newAnswered,
      current_difficulty: newDifficulty,
      current_question_id: null,
    }).eq('id', s.id);
    s.questions_answered = newAnswered;
    s.current_difficulty = newDifficulty;
    s.current_question_id = null;
  }

  const next = await computeNext(s);
  if (next.currentQuestionId !== s.current_question_id) {
    await supabase.from('level_test_sessions')
      .update({ current_question_id: next.currentQuestionId }).eq('id', s.id);
  }

  return Response.json({
    is_correct: isCorrect,
    ai_feedback: q.section === 'writing' ? aiFeedback : undefined,
    done: next.done,
    question: next.question,
    progress: next.progress,
  });
}
