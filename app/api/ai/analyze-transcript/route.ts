// Analiza la transcripción de una clase y devuelve el informe pedagógico + la
// señal de riesgo de baja.
//
// El análisis y el guardado están SEPARADOS a propósito: el profesor puede
// regenerar o editar antes de guardar (paso 3 del flujo "Registrar clase dada").
//   · POST { transcript, ... }            → sólo analiza, no guarda.
//   · POST { save: true, analysis, ... }  → guarda el análisis (posiblemente editado).

import { supabase } from '@/lib/supabase';
import { analyzeTranscript } from '@/lib/analyzeTranscript';
import { isRiskSignal, type TranscriptIA } from '@/lib/aiTypes';

interface Body {
  transcript?: string;
  studentProfile?: Record<string, unknown> | null;
  classHistory?: unknown[] | null;
  classNumber?: number | null;
  classDate?: string | null;
  studentName?: string;
  teacherName?: string;
  plan?: string;
  level?: string;
  // Guardado
  save?: boolean;
  analysis?: TranscriptIA;
  studentId?: string | null;
  teacherId?: string | null;
  profileId?: string | null;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const studentName = body.studentName?.trim();
  if (!studentName) return Response.json({ error: 'Falta studentName.' }, { status: 400 });

  // ── Guardar un análisis ya revisado por el profesor ──
  if (body.save) {
    if (!body.analysis || !body.transcript?.trim()) {
      return Response.json({ error: 'Faltan datos (analysis, transcript).' }, { status: 400 });
    }
    const saved = await persistAnalysis(body, body.analysis, body.transcript.trim(), studentName);
    if (saved.error) return Response.json({ error: saved.error }, { status: 500 });
    return Response.json({ saved: true, analysisId: saved.id });
  }

  // ── Analizar ──
  const transcript = body.transcript?.trim();
  if (!transcript) return Response.json({ error: 'Falta la transcripción.' }, { status: 400 });

  const result = await analyzeTranscript({
    transcript,
    studentName,
    teacherName: body.teacherName?.trim() || '',
    plan: body.plan,
    level: body.level,
    classNumber: body.classNumber,
    classDate: body.classDate,
    studentProfile: body.studentProfile,
    classHistory: body.classHistory,
  });

  if (result.status !== 'ready' || !result.data) {
    return Response.json(
      { error: result.error ?? 'No se pudo analizar la transcripción.', status: result.status },
      { status: 502 },
    );
  }
  return Response.json({ analysis: result.data, status: result.status });
}

// Guarda en class_analyses, actualiza la ficha del alumno y avisa al admin si hay riesgo.
// Ojo con el esquema real: el timestamp es `analyzed_at` y NO existe `teacher_name`.
async function persistAnalysis(
  body: Body, a: TranscriptIA, transcript: string, studentName: string,
): Promise<{ id?: string; error?: string }> {
  const now = new Date().toISOString();
  const id = `ca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const risk = isRiskSignal(a.riskSignal) ? a.riskSignal : 'verde';

  const { error: insErr } = await supabase.from('class_analyses').insert({
    id,
    student_id:       body.studentId || null,
    teacher_id:       body.teacherId || null,
    student_name:     studentName,
    class_number:     body.classNumber ?? null,
    class_date:       body.classDate || null,
    class_title:      a.classTitle,
    transcript,                       // NOT NULL en la base
    class_summary:    a.classSummary,
    errors_detected:  a.errorsDetected,
    progress_notes:   a.progressNotes,
    topics_covered:   a.topicsCovered,
    next_class_guide: a.nextClassGuide,
    risk_signal:      risk,
    risk_explanation: a.riskExplanation,
    analyzed_at:      now,
  });
  if (insErr) {
    console.error('[analyze-transcript] Error al guardar class_analyses:', insErr);
    return { error: `No se pudo guardar el análisis: ${insErr.message}` };
  }

  // Ficha del alumno: riesgo, progreso y contadores.
  const profileId = await resolveProfileId(body, studentName);
  if (profileId) {
    const total = await countAnalyses(body.studentId, studentName);
    const { error } = await supabase.from('student_profiles').update({
      risk_signal:            risk,
      risk_explanation:       a.riskExplanation,
      risk_updated_at:        now,
      progress_score:         clampScore(a.progressScore),
      total_classes_analyzed: total,
      last_class_analyzed_at: body.classDate || now,
      updated_at:             now,
    }).eq('id', profileId);
    if (error) console.error('[analyze-transcript] Error al actualizar la ficha:', error);
  }

  if (risk === 'amarillo' || risk === 'rojo') {
    await notifyAdmin(risk, studentName, body, a);
  }
  return { id };
}

async function resolveProfileId(body: Body, studentName: string): Promise<string | null> {
  if (body.profileId) return body.profileId;
  if (body.studentId) {
    const { data } = await supabase.from('student_profiles').select('id').eq('student_id', body.studentId).maybeSingle();
    if (data) return data.id;
  }
  const { data } = await supabase.from('student_profiles').select('id').ilike('student_name', studentName).maybeSingle();
  return data?.id ?? null;
}

async function countAnalyses(studentId: string | null | undefined, studentName: string): Promise<number> {
  const q = supabase.from('class_analyses').select('*', { count: 'exact', head: true });
  const { count } = studentId ? await q.eq('student_id', studentId) : await q.ilike('student_name', studentName);
  return count ?? 0;
}

const clampScore = (n: number): number =>
  Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 5;

async function notifyAdmin(
  risk: 'amarillo' | 'rojo', studentName: string, body: Body, a: TranscriptIA,
): Promise<void> {
  const teacher = body.teacherName?.trim() || 'sin asignar';
  const clase = body.classNumber != null ? `Clase ${body.classNumber} analizada` : 'Clase analizada';

  const notif = risk === 'rojo'
    ? {
        title: `🔴 ALERTA — ${studentName} en riesgo de baja`,
        body:  `Profesor: ${teacher} · Acción recomendada: contactar al alumno esta semana.\n\nMotivo: ${a.riskExplanation}`,
        type:  'ai_risk_red',
      }
    : {
        title: `⚠️ ${studentName} — Señal de atención`,
        body:  `Profesor: ${teacher} · ${clase}\nMotivo: ${a.riskExplanation}`,
        type:  'ai_risk_yellow',
      };

  const { error } = await supabase.from('notifications').insert({
    id:          `notif_risk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    target_user: null,
    target_role: 'admin',
    ...notif,
    read_by:     [],
    created_at:  new Date().toISOString(),
    created_by:  'ia',
  });
  if (error) console.error('[analyze-transcript] Error al crear la notificación de riesgo:', error);
}
