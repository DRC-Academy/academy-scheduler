// POST público: finaliza el test. Calcula reading/writing/overall → CEFR, marca la
// sesión como 'completed' y —clave— refleja el resultado en la FICHA del alumno
// (student_profiles), igual que el formulario vuelca su ficha. Idempotente.
//
// COMPUERTA (cambio B): no se emite nivel desde un test incompleto. El nivel va a
// la ficha, avisa al profesor y alimenta la generación de ejercicios con IA: con
// media prueba no se sostiene ninguna de las tres cosas. Se exigen las
// GRAND_TOTAL respuestas (17: 6+5+5 de lectura + 1 de escritura).
//   · incompleto y el enlace vigente → 409 y la sesión intacta en 'in_progress',
//     para que el alumno pueda retomarla. NO es un error: es "todavía no".
//   · incompleto y el enlace caducado → 'abandoned', sin nivel y sin vuelta atrás.
//
// PROVISIONAL (cambio A.3): si la escritura no se pudo puntuar —intento no válido
// o IA caída— el nivel sale solo de la lectura y queda marcado como provisional.
// El motivo real viaja a la ficha del profesor; al alumno se le da siempre el
// mismo texto neutro.

import { supabase } from '@/lib/supabase';
import { assessReading, calculateWritingScore, calculateOverall, scoreToCefr } from '@/lib/levelTest/scoring';
import { GRAND_TOTAL } from '@/lib/levelTest/constants';
import type { LTAnswerLite, LTSection } from '@/lib/levelTest/types';

export const dynamic = 'force-dynamic';

interface AnswerRow {
  question_id: string;
  section: string;
  difficulty: number;
  is_correct: boolean | null;
  ai_score: number | null;
  ai_feedback: unknown;
  answered_at: string | null;
  invalid_reason?: string | null;
}

const BASE_COLS = 'question_id, section, difficulty, is_correct, ai_score, ai_feedback, answered_at';

// invalid_reason llega con supabase-level-test-v2.sql, que se corre a mano. Si
// todavía no existe, pedirla haría fallar la consulta ENTERA (42703) y el test
// no se podría cerrar. Se reintenta sin ella.
// ORDEN CRONOLÓGICO obligatorio: `assessReading` mide la ventana FINAL del test
// (las últimas 8 respuestas de lectura). Sin este order by, la ventana sería un
// subconjunto arbitrario y la banda saldría mal.
async function loadAnswers(sessionId: string): Promise<AnswerRow[]> {
  const q = (cols: string) => supabase
    .from('level_test_answers').select(cols).eq('session_id', sessionId)
    .order('answered_at', { ascending: true });

  const withExtra = await q(`${BASE_COLS}, invalid_reason`);
  if (!withExtra.error) return (withExtra.data ?? []) as unknown as AnswerRow[];
  if (withExtra.error.code !== '42703') {
    console.error('[level-test/submit] Error al leer las respuestas:', withExtra.error);
    return [];
  }
  console.warn('[level-test/submit] Falta invalid_reason (supabase-level-test-v2.sql); se lee sin ella.');
  const base = await q(BASE_COLS);
  return (base.data ?? []) as unknown as AnswerRow[];
}

type Row = Record<string, unknown>;

async function updateSession(sessionId: string, base: Row, extra: Row) {
  const first = await supabase.from('level_test_sessions').update({ ...base, ...extra }).eq('id', sessionId);
  if (first.error?.code !== '42703') return first;
  console.warn('[level-test/submit] Faltan columnas de supabase-level-test-v2.sql; se actualiza la sesión sin ellas.');
  // Si lo único que se quería escribir eran las columnas nuevas, no queda nada
  // que hacer: un update vacío es un error, no un no-op.
  if (Object.keys(base).length === 0) return first;
  return supabase.from('level_test_sessions').update(base).eq('id', sessionId);
}

async function upsertProfile(row: Row, extra: Row) {
  const first = await supabase.from('student_profiles').upsert({ ...row, ...extra }, { onConflict: 'id' });
  if (first.error?.code !== '42703') return first;
  console.warn('[level-test/submit] Faltan columnas de provisional en student_profiles; se vuelca la ficha sin ellas.');
  return supabase.from('student_profiles').upsert(row, { onConflict: 'id' });
}

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
      // En una sesión ya cerrada, sin nota de escritura ⇒ el nivel salió solo de
      // la lectura ⇒ provisional.
      provisional: s.writing_score == null,
    });
  }
  if (s.status === 'abandoned') {
    return Response.json({ error: 'Este test quedó sin terminar y el enlace ya expiró.', abandoned: true }, { status: 410 });
  }

  const rows = await loadAnswers(s.id);

  // ── Compuerta: ¿está completo? ─────────────────────────────────────────────
  // Se cuentan preguntas DISTINTAS, no filas: no hay unique en
  // (session_id, question_id), así que una respuesta duplicada no puede abrir la
  // compuerta antes de tiempo.
  const answeredCount = new Set(rows.map(r => r.question_id)).size;

  if (answeredCount < GRAND_TOTAL) {
    const expired = s.expires_at && new Date(s.expires_at).getTime() < Date.now();

    if (expired) {
      await updateSession(s.id, { status: 'abandoned' }, { answered_count: answeredCount });
      return Response.json({
        error: 'Este test quedó sin terminar y el enlace ya expiró.',
        abandoned: true, answered: answeredCount, total: GRAND_TOTAL,
      }, { status: 410 });
    }

    // Vigente: la sesión NO se toca (sigue 'in_progress' y se puede retomar).
    // Solo se refresca el contador para que el admin vea por dónde va.
    await updateSession(s.id, {}, { answered_count: answeredCount });
    return Response.json({
      error: 'El test todavía no está completo.',
      incomplete: true, answered: answeredCount, total: GRAND_TOTAL,
    }, { status: 409 });
  }

  // ── Cálculo ────────────────────────────────────────────────────────────────
  const lite: LTAnswerLite[] = rows.map(a => ({
    section: a.section as LTSection, difficulty: a.difficulty, is_correct: a.is_correct, ai_score: a.ai_score,
  }));

  // `lite` viene en orden cronológico (loadAnswers ordena por answered_at), que es
  // lo que `assessReading` necesita para quedarse con la ventana final.
  const reading = assessReading(lite);
  const readingScore = reading?.score ?? null;
  const writingScore = calculateWritingScore(lite);
  const overall = calculateOverall(readingScore, writingScore);
  const cefr = scoreToCefr(overall);

  // Provisional = la escritura no aportó. Da igual por qué: el 40% del criterio
  // no está y el nivel no es definitivo.
  const writingRow = rows.find(a => a.section === 'writing');
  const provisional = writingScore == null;
  const provisionalReason = provisional
    ? (writingRow?.invalid_reason ?? (writingRow ? 'ai_unavailable' : null))
    : null;

  // El feedback solo se muestra si la escritura se puntuó de verdad. Con un
  // intento descartado, enseñárselo al alumno sería enseñarle qué esquivar.
  const aiEvaluation = !provisional ? (writingRow?.ai_feedback ?? null) : null;
  const now = new Date().toISOString();

  const { error: updErr } = await updateSession(s.id, {
    reading_score: readingScore,
    writing_score: writingScore,
    overall_score: overall,
    cefr_level: cefr,
    ai_evaluation: aiEvaluation,
    status: 'completed',
    completed_at: now,
    current_question_id: null,
  }, {
    answered_count: answeredCount,
  });
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
    // El motivo REAL va aquí: es lo que el profesor necesita para saber si repetir
    // la prueba o darla por buena.
    const fichaExtra = {
      level_test_provisional:        provisional,
      level_test_provisional_reason: provisionalReason,
    };
    let profErr = (await upsertProfile(
      { id: s.student_id, student_id: s.student_id, ...fichaRow }, fichaExtra,
    )).error;
    // Si la FK de student_id falla (alumno no está en 'students'), guardar sin vincular.
    if (profErr?.code === '23503') {
      profErr = (await upsertProfile(
        { id: `sp_lt_${s.id}`, student_id: null, ...fichaRow }, fichaExtra,
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
      body:        provisional
        ? `Resultado PROVISIONAL: ${cefr} (${overall}/100), solo con la parte de lectura porque la escritura no se pudo puntuar. Lo ves en la ficha del alumno.`
        : `Resultado: ${cefr} (${overall}/100). Lo ves en la ficha del alumno.`,
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
    provisional,
  });
}
