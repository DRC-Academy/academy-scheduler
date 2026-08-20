// GET público del Test de Nivel: devuelve el estado de la sesión + la próxima
// pregunta a responder (adaptativa). No requiere login (token). Es resumible: al
// recargar retoma la misma pregunta (current_question_id).

import { supabase } from '@/lib/supabase';
import { computeNext } from '@/lib/levelTest/server';
import { GRAND_TOTAL } from '@/lib/levelTest/constants';

export const dynamic = 'force-dynamic';

// Respuestas DISTINTAS de la sesión. Solo se consulta cuando hace falta decidir
// entre 'expired' y 'abandoned'.
async function countAnswers(sessionId: string): Promise<number> {
  const { data } = await supabase
    .from('level_test_answers').select('question_id').eq('session_id', sessionId);
  return new Set((data ?? []).map(r => (r as { question_id: string }).question_id)).size;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!token) return Response.json({ error: 'Falta el token.' }, { status: 400 });

  const { data: s, error } = await supabase
    .from('level_test_sessions')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    console.error('[level-test GET] Error al leer la sesión:', error);
    return Response.json({ error: 'Error del servidor.' }, { status: 500 });
  }
  if (!s) return Response.json({ status: 'invalid' }, { status: 404 });

  // Ya completado → devolver el resultado (para la pantalla de resultados).
  if (s.status === 'completed') {
    return Response.json({
      status: 'completed',
      candidate_name: s.candidate_name,
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

  // Caducó a medias: no hay nivel y ya no se puede retomar.
  if (s.status === 'abandoned') return Response.json({ status: 'abandoned' });

  // Expirado. Se distingue del abandono: 'expired' es el enlace que caducó sin
  // que nadie lo abriera; 'abandoned' es el que se empezó y quedó a medias. Para
  // el alumno la pantalla es la misma; para el admin no son lo mismo.
  const expired = s.expires_at && new Date(s.expires_at).getTime() < Date.now();
  if (s.status === 'expired' || expired) {
    const answered = await countAnswers(s.id);
    const nuevoEstado = answered > 0 && answered < GRAND_TOTAL ? 'abandoned' : 'expired';
    if (s.status !== nuevoEstado) {
      await supabase.from('level_test_sessions').update({ status: nuevoEstado }).eq('id', s.id);
    }
    return Response.json({ status: nuevoEstado });
  }

  // pending → in_progress (empieza el test).
  if (s.status === 'pending') {
    await supabase.from('level_test_sessions')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', s.id);
    s.status = 'in_progress';
  }

  const next = await computeNext(s);

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
