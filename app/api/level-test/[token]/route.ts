// GET público del Test de Nivel: devuelve el estado de la sesión + la próxima
// pregunta a responder (adaptativa). No requiere login (token). Es resumible: al
// recargar retoma la misma pregunta (current_question_id).

import { supabase } from '@/lib/supabase';
import { computeNext } from '@/lib/levelTest/server';

export const dynamic = 'force-dynamic';

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
      },
    });
  }

  // Expirado.
  const expired = s.expires_at && new Date(s.expires_at).getTime() < Date.now();
  if (s.status === 'expired' || expired) {
    if (s.status !== 'expired') {
      await supabase.from('level_test_sessions').update({ status: 'expired' }).eq('id', s.id);
    }
    return Response.json({ status: 'expired' });
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
  });
}
