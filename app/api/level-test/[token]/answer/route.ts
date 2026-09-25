// POST público: recibe la respuesta a la pregunta actual.
//  · Reading  → califica (compara con correct_answer) y ajusta current_difficulty.
//  · Writing  → filtro determinista → IA (Haiku) → ai_score/ai_feedback.
// Devuelve el resultado + la próxima pregunta (o done=true si terminó el test).
//
// La escritura tiene TRES desenlaces posibles y los tres guardan la fila:
//   1. válida            → ai_score con nota; el test puntúa normal.
//   2. no válida         → ai_score null + invalid_reason; nivel PROVISIONAL.
//   3. IA no disponible  → ai_score null + 'ai_unavailable' + ai_error con el
//                          motivo REAL (p. ej. saldo agotado); nivel PROVISIONAL.
// El 3 no es culpa del alumno y por eso NO marca writing_valid=false: se guarda
// igual para que la respuesta cuente hacia las 17 y no pierda el test entero por
// una caída ajena. Se puede reevaluar después desde el admin (lib/levelTest/reevaluate).
//
// VELOCIDAD (sep/2026): tres viajes a la base en vez de ocho, en este orden:
//   1. sesión + respuestas en una consulta (el banco de preguntas sale de memoria);
//   2. guardar la respuesta;
//   3. avanzar la sesión y fijar ya la pregunta siguiente, en un solo update.
// La siguiente pregunta se elige en memoria con la misma regla de siempre
// (ver lib/levelTest/server). Guardar y avanzar siguen yendo EN ESE ORDEN, no en
// paralelo: si la respuesta no se guarda, la sesión no puede avanzar.

import { supabase } from '@/lib/supabase';
import {
  findQuestion, loadBank, loadSessionWithAnswers, parseAnswered, pickNext, type AnsweredLite,
} from '@/lib/levelTest/server';
import { getNextDifficulty } from '@/lib/levelTest/adaptive';
import { checkWritingAttempt, type InvalidReason } from '@/lib/levelTest/attemptValidity';
import { evaluateWriting } from '@/lib/evaluateWriting';
import type { Cefr, WritingEvaluation } from '@/lib/levelTest/types';

export const dynamic = 'force-dynamic';

interface Body {
  question_id?: string;
  selected_answer?: number;
  written_response?: string;
  time_spent_seconds?: number;
}

// Las columnas nuevas se corren a mano y pueden no existir todavía. Si Postgres
// se queja de columna inexistente (42703) se reintenta quitando capas: primero
// ai_error (supabase-level-test-ai-error, la más nueva), luego las de
// supabase-level-test-v2.sql. Se pierde el dato nuevo, pero el alumno no se
// queda encerrado en la misma pregunta.
type Row = Record<string, unknown>;

async function insertAnswerRow(base: Row, extra: Row, newest: Row) {
  const first = await supabase.from('level_test_answers').insert({ ...base, ...extra, ...newest });
  if (first.error?.code !== '42703') return first;
  console.warn('[level-test/answer] Falta la columna ai_error; se guarda la respuesta sin ella.');
  const second = await supabase.from('level_test_answers').insert({ ...base, ...extra });
  if (second.error?.code !== '42703') return second;
  console.warn('[level-test/answer] Faltan columnas de supabase-level-test-v2.sql; se guarda la respuesta sin ellas.');
  return supabase.from('level_test_answers').insert(base);
}

async function updateSessionRow(sessionId: string, base: Row, extra: Row) {
  const first = await supabase.from('level_test_sessions').update({ ...base, ...extra }).eq('id', sessionId);
  if (first.error?.code !== '42703') return first;
  console.warn('[level-test/answer] Faltan columnas de supabase-level-test-v2.sql; se actualiza la sesión sin ellas.');
  return supabase.from('level_test_sessions').update(base).eq('id', sessionId);
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

  // ── Viaje 1: sesión + respuestas (y el banco, de memoria) ──────────────────
  const [{ session: s, answers, error }, bank] = await Promise.all([
    loadSessionWithAnswers(token),
    loadBank(),
  ]);
  if (error) return Response.json({ error: 'Error del servidor.' }, { status: 500 });
  if (!s) return Response.json({ error: 'Este link no es válido.' }, { status: 404 });
  if (s.status === 'completed') return Response.json({ error: 'El test ya fue completado.' }, { status: 409 });
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) {
    await supabase.from('level_test_sessions').update({ status: 'expired' }).eq('id', s.id);
    return Response.json({ error: 'Este link ya expiró.' }, { status: 410 });
  }

  // Rate-limit básico: rechazar envíos demasiado seguidos (anti-abuso simple).
  const lastAt = answers.reduce<number>((m, a) => Math.max(m, a.answered_at ? new Date(a.answered_at).getTime() : 0), 0);
  if (lastAt && Date.now() - lastAt < 700) {
    return Response.json({ error: 'Demasiado rápido, espera un momento.' }, { status: 429 });
  }

  // Ya respondidas: las filas de la base mandan; questions_answered es la copia
  // de la sesión y se suma por si quedó alguna sin su fila.
  const answeredIds = new Set([...answers.map(a => a.question_id), ...parseAnswered(s.questions_answered)]);

  const q = await findQuestion(bank, questionId);
  if (!q) return Response.json({ error: 'Pregunta no encontrada.' }, { status: 404 });

  let isCorrect: boolean | null = null;
  let aiScore: number | null = null;
  let aiFeedback: WritingEvaluation | null = null;
  let aiError: string | null = null;
  let invalidReason: InvalidReason | null = null;
  // null = "no lo sabemos" (todavía no hay escritura, o la IA no respondió), que
  // no es lo mismo que false = "no es un intento válido".
  let writingValid: boolean | null = null;
  let newDifficulty = s.current_difficulty ?? 3;
  // La dificultad con la que el adaptativo PIDIÓ esta pregunta, antes de moverla.
  // Distinta de q.difficulty cuando el banco del nivel estaba agotado y
  // selectNextQuestion tuvo que servir la más cercana.
  const targetDifficulty = s.current_difficulty ?? 3;

  if (q.section === 'writing') {
    const written = (body.written_response || '').trim();
    if (!written) return Response.json({ error: 'Falta la respuesta escrita.' }, { status: 400 });

    // Barrera 1 — determinista, antes de la IA: si no es un intento, no se gasta
    // ni un token.
    const check = checkWritingAttempt(written);
    if (!check.valid) {
      writingValid = false;
      invalidReason = check.reason;
    } else {
      // Barrera 2 — la IA, para el galimatías que el filtro no puede ver.
      // El try/catch es deliberado: askClaudeJson ya captura lo suyo, pero una
      // excepción que se escape aquí NO puede costarle el test al alumno.
      try {
        const res = await evaluateWriting({
          cefrLevel: q.cefr_level as Cefr,
          writingPrompt: q.writing_prompt || '',
          writtenResponse: written,
        });
        if (!res.data) {
          invalidReason = 'ai_unavailable';
          aiError = res.error ?? `La IA no respondió (${res.status}).`;
          console.error(`[level-test/answer] Redacción sin evaluar (sesión ${s.id}): ${aiError}`);
        } else if (!res.data.is_valid_attempt) {
          writingValid = false;
          invalidReason = 'ai_invalid';
          aiFeedback = res.data;   // el "por qué" queda para el profesor
        } else {
          writingValid = true;
          aiScore = res.data.score;
          aiFeedback = res.data;
        }
      } catch (err) {
        console.error('[level-test/answer] La evaluación de escritura lanzó una excepción:', err);
        invalidReason = 'ai_unavailable';
        aiError = `Excepción: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } else {
    const sel = typeof body.selected_answer === 'number' ? body.selected_answer : -1;
    isCorrect = sel === q.correct_answer;
    newDifficulty = getNextDifficulty(s.current_difficulty ?? 3, isCorrect);
  }

  // Guardar la respuesta y avanzar la sesión (idempotente: no reinsertar si ya
  // se respondió esta pregunta — p. ej. doble submit).
  let known: AnsweredLite[] = answers;
  let difficultyAfter = s.current_difficulty ?? 3;

  if (!answeredIds.has(q.id)) {
    // ── Viaje 2: la respuesta ────────────────────────────────────────────────
    const { error: insErr } = await insertAnswerRow({
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
    }, {
      target_difficulty: targetDifficulty,
      invalid_reason: invalidReason,
    }, {
      ai_error: aiError,
    });
    if (insErr) {
      console.error('[level-test/answer] Error al guardar la respuesta:', insErr);
      return Response.json({ error: 'No se pudo guardar la respuesta.' }, { status: 500 });
    }

    known = [...answers, { question_id: q.id, section: q.section, answered_at: new Date().toISOString() }];
    difficultyAfter = newDifficulty;
    // La siguiente se decide YA, en memoria, para fijarla en el mismo update.
    const next = pickNext(bank, known, difficultyAfter, null);
    const newAnswered = [...new Set([...parseAnswered(s.questions_answered), q.id])];

    // ── Viaje 3: avanzar la sesión y fijar la siguiente pregunta ─────────────
    // Este update SÍ se comprueba: si falla en silencio, questions_answered se
    // queda atrás y el alumno recibe otra vez la misma pregunta.
    const { error: updErr } = await updateSessionRow(s.id, {
      questions_answered: newAnswered,
      current_difficulty: newDifficulty,
      current_question_id: next.currentQuestionId,
      // Normalmente ya lo marcó el GET al empezar; por si acaso, en el mismo viaje.
      ...(s.status === 'pending' ? { status: 'in_progress', started_at: new Date().toISOString() } : {}),
    }, {
      answered_count: new Set(known.map(a => a.question_id)).size,
      // Solo se tocan al responder la escritura: si no, se pisaría el veredicto
      // con null en cada pregunta de lectura posterior.
      ...(q.section === 'writing'
        ? { writing_valid: writingValid, writing_invalid_reason: invalidReason }
        : {}),
    });
    if (updErr) {
      console.error('[level-test/answer] Error al avanzar la sesión:', updErr);
      return Response.json({ error: 'No se pudo guardar el avance.' }, { status: 500 });
    }

    return Response.json(payload(next));
  }

  // Doble envío de una pregunta ya respondida: no se guarda nada, solo se
  // devuelve la pregunta en curso (la fijada, si sigue vigente).
  const next = pickNext(bank, known, difficultyAfter, s.current_question_id);
  if (next.currentQuestionId !== s.current_question_id) {
    await supabase.from('level_test_sessions')
      .update({ current_question_id: next.currentQuestionId }).eq('id', s.id);
  }
  return Response.json(payload(next));

  function payload(next: ReturnType<typeof pickNext>) {
    return {
      is_correct: isCorrect,
      // Si la escritura no se puntuó, el feedback NO viaja al alumno: vería el
      // motivo y aprendería qué esquivar. El "por qué" queda en la fila de la
      // respuesta, para el profesor.
      ai_feedback: q!.section === 'writing' && aiScore != null ? aiFeedback : undefined,
      done: next.done,
      question: next.question,
      progress: next.progress,
    };
  }
}
