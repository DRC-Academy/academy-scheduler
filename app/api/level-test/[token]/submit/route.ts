// POST público: finaliza el test. Calcula reading/writing/overall → CEFR, marca la
// sesión como 'completed' y —clave— refleja el resultado en la FICHA del alumno
// (student_profiles), igual que el formulario vuelca su ficha. Idempotente.

import { supabase } from '@/lib/supabase';
import { calculateReadingScore, calculateWritingScore, calculateOverall, scoreToCefr } from '@/lib/levelTest/scoring';
import type { LTAnswerLite, LTSection } from '@/lib/levelTest/types';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!token) return Response.json({ error: 'Falta el token.' }, { status: 400 });

  const { data: s, error } = await supabase
    .from('level_test_sessions').select('*').eq('token', token).maybeSingle();
  if (error) return Response.json({ error: 'Error del servidor.' }, { status: 500 });
  if (!s) return Response.json({ error: 'Este link no es válido.' }, { status: 404 });

  // Idempotente: si ya se cerró, devolver el resultado guardado.
  if (s.status === 'completed') {
    return Response.json({
      reading_score: s.reading_score, writing_score: s.writing_score,
      overall_score: s.overall_score, cefr_level: s.cefr_level, ai_evaluation: s.ai_evaluation,
    });
  }

  const { data: answers } = await supabase
    .from('level_test_answers')
    .select('section, difficulty, is_correct, ai_score, ai_feedback')
    .eq('session_id', s.id);
  const rows = (answers ?? []) as Array<{ section: string; difficulty: number; is_correct: boolean | null; ai_score: number | null; ai_feedback: unknown }>;
  const lite: LTAnswerLite[] = rows.map(a => ({
    section: a.section as LTSection, difficulty: a.difficulty, is_correct: a.is_correct, ai_score: a.ai_score,
  }));

  const readingScore = calculateReadingScore(lite);
  const writingScore = calculateWritingScore(lite);
  const overall = calculateOverall(readingScore, writingScore);
  const cefr = scoreToCefr(overall);
  const aiEvaluation = rows.find(a => a.section === 'writing' && a.ai_feedback)?.ai_feedback ?? null;
  const now = new Date().toISOString();

  const { error: updErr } = await supabase.from('level_test_sessions').update({
    reading_score: readingScore,
    writing_score: writingScore,
    overall_score: overall,
    cefr_level: cefr,
    ai_evaluation: aiEvaluation,
    status: 'completed',
    completed_at: now,
    current_question_id: null,
  }).eq('id', s.id);
  if (updErr) {
    console.error('[level-test/submit] Error al cerrar la sesión:', updErr);
    return Response.json({ error: 'No se pudo finalizar el test.' }, { status: 500 });
  }

  // Reflejar el resultado en la ficha del alumno (misma tabla que el formulario).
  if (s.student_id) {
    const fichaRow = {
      student_name:            s.student_name || s.candidate_name,
      level_test_cefr:         cefr,
      level_test_score:        overall,
      level_test_completed_at: now,
      level_test_evaluation:   aiEvaluation,
      level_test_session_id:   s.id,
      updated_at:              now,
    };
    let profErr = (await supabase.from('student_profiles').upsert(
      { id: s.student_id, student_id: s.student_id, ...fichaRow },
      { onConflict: 'id' },
    )).error;
    // Si la FK de student_id falla (alumno no está en 'students'), guardar sin vincular.
    if (profErr?.code === '23503') {
      profErr = (await supabase.from('student_profiles').upsert(
        { id: `sp_lt_${s.id}`, student_id: null, ...fichaRow },
        { onConflict: 'id' },
      )).error;
    }
    if (profErr) console.error('[level-test/submit] Error al reflejar en la ficha:', profErr);
  }

  // Aviso al profesor (best-effort), igual que el formulario.
  if (s.teacher_id) {
    const { error: notifErr } = await supabase.from('notifications').insert({
      id:          `notif_leveltest_${Date.now()}`,
      target_user: s.teacher_id,
      target_role: null,
      title:       `📝 ${s.student_name || s.candidate_name} completó el test de nivel`,
      body:        `Resultado: ${cefr} (${overall}/100). Lo ves en la ficha del alumno.`,
      type:        'level_test_completed',
      read_by:     [],
      created_at:  now,
      created_by:  'test-nivel',
    });
    if (notifErr) console.error('[level-test/submit] Error al notificar al profe:', notifErr);
  }

  return Response.json({
    reading_score: readingScore, writing_score: writingScore,
    overall_score: overall, cefr_level: cefr, ai_evaluation: aiEvaluation,
  });
}
