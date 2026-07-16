// Analiza la transcripción de una clase y devuelve el informe pedagógico + la
// señal de riesgo de baja.
//
// Si se pasa `persist: true`, además:
//   · guarda el análisis en class_analyses,
//   · actualiza risk_signal en student_profiles,
//   · notifica al admin si el riesgo es 'amarillo' o 'rojo'.
// La persistencia se hace acá (y no en el cliente) para que el análisis y sus
// efectos viajen juntos: si la IA responde, el registro queda sí o sí.

import { supabase } from '@/lib/supabase';
import { analyzeTranscript, type TranscriptIA } from '@/lib/analyzeTranscript';

interface Body {
  transcript?: string;
  studentProfile?: Record<string, unknown> | null;
  classHistory?: unknown[] | null;
  classNumber?: number | null;
  studentName?: string;
  teacherName?: string;
  plan?: string;
  level?: string;
  // Persistencia (opcional)
  persist?: boolean;
  studentId?: string | null;
  teacherId?: string | null;
  profileId?: string | null;   // id de la fila de student_profiles a actualizar
}

const RISK_LABEL: Record<string, string> = {
  amarillo: '🟡 Atención',
  rojo:     '🔴 Riesgo de baja',
};

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const transcript = body.transcript?.trim();
  const studentName = body.studentName?.trim();
  if (!transcript || !studentName) {
    return Response.json({ error: 'Faltan datos (transcript, studentName).' }, { status: 400 });
  }

  const result = await analyzeTranscript({
    transcript,
    studentName,
    teacherName: body.teacherName?.trim() || '',
    plan: body.plan,
    level: body.level,
    classNumber: body.classNumber,
    studentProfile: body.studentProfile,
    classHistory: body.classHistory,
  });

  if (result.status !== 'ready' || !result.data) {
    return Response.json(
      { error: result.error ?? 'No se pudo analizar la transcripción.', status: result.status },
      { status: 502 },
    );
  }

  const analysis = result.data;
  if (body.persist) {
    await persistAnalysis(body, analysis, transcript);
  }

  return Response.json({ analysis, status: result.status });
}

// Guarda el análisis y sus efectos. No lanza: si algo falla lo registramos, pero
// el profesor ya tiene su informe y no queremos perdérselo por un error de BD.
async function persistAnalysis(body: Body, analysis: TranscriptIA, transcript: string): Promise<void> {
  const now = new Date().toISOString();
  const studentName = body.studentName!.trim();

  const { error: insErr } = await supabase.from('class_analyses').insert({
    id:               `ca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    student_id:       body.studentId || null,
    student_name:     studentName,
    teacher_id:       body.teacherId || null,
    teacher_name:     body.teacherName?.trim() || null,
    class_number:     body.classNumber ?? null,
    transcript,
    class_summary:    analysis.classSummary,
    errors_detected:  analysis.errorsDetected,
    progress_notes:   analysis.progressNotes,
    topics_covered:   analysis.topicsCovered,
    risk_signal:      analysis.riskSignal,
    risk_explanation: analysis.riskExplanation,
    next_class_guide: analysis.nextClassGuide,
    created_at:       now,
  });
  if (insErr) console.error('[analyze-transcript] Error al guardar class_analyses:', insErr);

  // Señal de riesgo en la ficha del alumno.
  const target = body.profileId
    ? supabase.from('student_profiles').update({ risk_signal: analysis.riskSignal, updated_at: now }).eq('id', body.profileId)
    : body.studentId
      ? supabase.from('student_profiles').update({ risk_signal: analysis.riskSignal, updated_at: now }).eq('student_id', body.studentId)
      : null;
  if (target) {
    const { error } = await target;
    if (error) console.error('[analyze-transcript] Error al actualizar risk_signal:', error);
  }

  // Aviso al admin si hay riesgo.
  if (analysis.riskSignal === 'amarillo' || analysis.riskSignal === 'rojo') {
    const { error } = await supabase.from('notifications').insert({
      id:          `notif_risk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      target_user: null,
      target_role: 'admin',
      title:       `${RISK_LABEL[analysis.riskSignal]} — ${studentName}`,
      body:        `${analysis.riskExplanation}${body.teacherName ? ` (Profesor/a: ${body.teacherName})` : ''}`,
      type:        analysis.riskSignal === 'rojo' ? 'ai_risk_red' : 'ai_risk_yellow',
      read_by:     [],
      created_at:  now,
      created_by:  'ia',
    });
    if (error) console.error('[analyze-transcript] Error al crear la notificación de riesgo:', error);
  }
}
