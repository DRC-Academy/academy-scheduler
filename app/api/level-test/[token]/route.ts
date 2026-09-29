// GET público del Test de Nivel: devuelve el estado de la sesión + la próxima
// pregunta a responder (adaptativa). No requiere login (token). Es resumible: al
// recargar retoma la misma pregunta (current_question_id).
//
// Caducidad (28/09/2026, lib/levelTest/canonical):
//   · Prueba de ALUMNO: no caduca por fecha. Vale mientras el alumno esté activo
//     (lib/levelTest/studentAccess); si no, 'unavailable'. Un enlace antiguo del
//     alumno redirige a su prueba principal ('redirect'), y una marcada
//     'expired'/'abandoned' por la regla vieja se reabre donde se quedó.
//   · Prueba de LEAD: caduca por fecha, como siempre.
//
// ?peek=1 → solo el estado, para la pantalla de bienvenida: no empieza la prueba
// ni elige pregunta.

import { supabase } from '@/lib/supabase';
import { computeNext, loadSessionWithAnswers } from '@/lib/levelTest/server';
import { GRAND_TOTAL } from '@/lib/levelTest/constants';
import { pickCanonical, sessionExpired } from '@/lib/levelTest/canonical';
import { loadStudentSessions } from '@/lib/levelTest/createSession';
import { canTakeLevelTest } from '@/lib/levelTest/studentAccess';

export const dynamic = 'force-dynamic';

// Respuestas DISTINTAS de la sesión. Solo hace falta para decidir entre
// 'expired' y 'abandoned'.
function countAnswers(answers: Array<{ question_id: string }>): number {
  return new Set(answers.map(r => r.question_id)).size;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!token) return Response.json({ error: 'Falta el token.' }, { status: 400 });

  // Sesión y respuestas en una sola consulta (ver lib/levelTest/server).
  const { session: s, answers, error } = await loadSessionWithAnswers(token);

  if (error) {
    console.error('[level-test GET] Error al leer la sesión:', error);
    return Response.json({ error: 'Error del servidor.' }, { status: 500 });
  }
  if (!s) return Response.json({ status: 'invalid' }, { status: 404 });
  const peek = new URL(request.url).searchParams.get('peek') === '1';

  // Ya completado → devolver el resultado (para la pantalla de resultados).
  if (s.status === 'completed') {
    return Response.json({
      status: 'completed',
      candidate_name: s.candidate_name,
      student_name: s.student_name,
      result: {
        reading_score: s.reading_score,
        writing_score: s.writing_score,
        overall_score: s.overall_score,
        cefr_level: s.cefr_level,
        ai_evaluation: s.ai_evaluation,
        // Sin nota de escritura, el nivel salió solo de la lectura.
        provisional: s.writing_score == null,
      },
    });
  }

  if (s.student_id) {
    // ── Prueba de un alumno: sin fecha de caducidad ─────────────────────────
    // 1) ¿Es su prueba principal? Si tiene otra terminada, o una con más
    //    respuestas, este enlace (viejo) lleva a esa.
    try {
      const principal = pickCanonical(await loadStudentSessions({ studentId: s.student_id }));
      if (principal.kind !== 'none' && principal.token !== s.token) {
        return Response.json({ status: 'redirect', token: principal.token });
      }
    } catch (e) {
      console.error('[level-test GET] No se pudo elegir la prueba principal:', e);
    }

    // 2) ¿Sigue activo?
    if (!(await canTakeLevelTest(s.student_id))) {
      return Response.json({ status: 'unavailable' });
    }

    // 3) Marcas de la regla vieja: se reabre donde se quedó.
    if (s.status === 'expired' || s.status === 'abandoned') {
      const reabierta = countAnswers(answers) > 0 ? 'in_progress' : 'pending';
      await supabase.from('level_test_sessions').update({ status: reabierta }).eq('id', s.id);
      s.status = reabierta;
    }
  } else {
    // ── Prueba de un lead: caduca por fecha ─────────────────────────────────
    // Caducó a medias: no hay nivel y ya no se puede retomar.
    if (s.status === 'abandoned') return Response.json({ status: 'abandoned' });

    // Expirado. Se distingue del abandono: 'expired' es el enlace que caducó sin
    // que nadie lo abriera; 'abandoned' es el que se empezó y quedó a medias. Para
    // el candidato la pantalla es la misma; para el admin no son lo mismo.
    if (sessionExpired({ student_id: s.student_id, status: s.status, expires_at: s.expires_at })) {
      const answered = countAnswers(answers);
      const nuevoEstado = answered > 0 && answered < GRAND_TOTAL ? 'abandoned' : 'expired';
      if (s.status !== nuevoEstado) {
        await supabase.from('level_test_sessions').update({ status: nuevoEstado }).eq('id', s.id);
      }
      return Response.json({ status: nuevoEstado });
    }
  }

  // Solo el estado, para la bienvenida: todavía no se empieza.
  if (peek) {
    return Response.json({
      status: 'ready',
      resuming: countAnswers(answers) > 0,
      candidate_name: s.candidate_name,
      student_name: s.student_name,
    });
  }

  // pending → in_progress (empieza el test).
  if (s.status === 'pending') {
    await supabase.from('level_test_sessions')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', s.id);
    s.status = 'in_progress';
  }

  const next = await computeNext(s, answers);

  // Fijar la pregunta actual si cambió (resumibilidad).
  if (next.currentQuestionId !== s.current_question_id) {
    await supabase.from('level_test_sessions')
      .update({ current_question_id: next.currentQuestionId })
      .eq('id', s.id);
  }

  return Response.json({
    status: 'in_progress',
    candidate_name: s.candidate_name,
    student_name: s.student_name,
    question: next.question,
    progress: next.progress,
    done: next.done,
    // Lo que el submit va a exigir. El cliente lo usa para no llamar a finalizar
    // cuando sabe de antemano que la compuerta lo va a rechazar.
    answered: next.progress.answeredTotal,
    total: GRAND_TOTAL,
  });
}
