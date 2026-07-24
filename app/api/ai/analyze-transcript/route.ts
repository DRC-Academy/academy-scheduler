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
import { computeTranscriptVerdict, type TranscriptVerdict } from '@/lib/transcriptVerdict';
import { flagLabel } from '@/lib/transcriptValidation';

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
  /** Huella del transcript, para detectar subidas duplicadas. */
  transcriptHash?: string | null;
  /** Si viene, se ACTUALIZA esa fila en vez de insertar una nueva. */
  replaceId?: string | null;
  /** Ingreso (class_join_logs.id) al que pertenece esta clase. */
  joinLogId?: string | null;
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
    const transcript = body.transcript.trim();

    // BLOQUE 1 — Verificación en 3 capas ANTES de guardar. Si el veredicto es
    // 'blocked', NO se persiste el transcript y se avisa al profesor con lenguaje
    // neutro (el class_record ya existe → la clase queda 'a revisar' en finanzas).
    const verdict = await computeTranscriptVerdict({
      teacherId:   body.teacherId || '',
      teacherName: body.teacherName?.trim() || '',
      studentName,
      classDate:   body.classDate || new Date().toISOString().slice(0, 10),
      transcript,
      level:       body.level,
      excludeId:   body.replaceId,
    });

    if (verdict.decision === 'blocked') {
      await notifyAdminTranscript(verdict, studentName, body, 'blocked');
      return Response.json({
        saved: false, blocked: true,
        validation: verdictPayload(verdict),
      });
    }

    const saved = await persistAnalysis(body, body.analysis, transcript, studentName, verdict);
    if (saved.error) return Response.json({ error: saved.error }, { status: 500 });

    if (verdict.decision === 'review') {
      await notifyAdminTranscript(verdict, studentName, body, 'review');
    }
    return Response.json({
      saved: true, analysisId: body.replaceId || saved.id, replaced: !!body.replaceId,
      validation: verdictPayload(verdict),
    });
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
  body: Body, a: TranscriptIA, transcript: string, studentName: string, verdict?: TranscriptVerdict,
): Promise<{ id?: string; error?: string }> {
  const now = new Date().toISOString();
  const id = `ca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const risk = isRiskSignal(a.riskSignal) ? a.riskSignal : 'verde';

  // Campos de validación (Bloque 1). Se degradan sin romper si las columnas aún no
  // existen (el insert reintenta sin ellas más abajo).
  const validationCols = verdict ? {
    transcript_validation_score: verdict.structure.score,
    transcript_validation_flags: verdict.flags,
    ai_authenticity_check:       verdict.ai ?? null,
    validation_status:           verdict.decision === 'review' ? 'review' : 'ok',
  } : {};

  // Campos base (sin validación) — para reintentar si esas columnas no existen aún.
  const contentBase = {
    class_title:      a.classTitle,
    transcript,                       // NOT NULL en la base
    transcript_hash:  body.transcriptHash || null,
    join_log_id:      body.joinLogId || null,
    class_summary:    a.classSummary,
    errors_detected:  a.errorsDetected,
    progress_notes:   a.progressNotes,
    topics_covered:   a.topicsCovered,
    next_class_guide: a.nextClassGuide,
    risk_signal:      risk,
    risk_explanation: a.riskExplanation,
    analyzed_at:      now,
  };
  const content = { ...contentBase, ...validationCols };
  // La columna transcript_hash es opcional en algunas bases; PGRST204 = columna
  // inexistente → reintentamos sin las columnas de validación (Bloque 1 recién
  // migrado). El resto del análisis se guarda igual.
  const isMissingCol = (e: { code?: string } | null) => e?.code === 'PGRST204' || e?.code === '42703';

  if (body.replaceId) {
    let { error: updErr } = await supabase.from('class_analyses').update(content).eq('id', body.replaceId);
    if (updErr && isMissingCol(updErr)) {
      ({ error: updErr } = await supabase.from('class_analyses').update(contentBase).eq('id', body.replaceId));
    }
    if (updErr) {
      console.error('[analyze-transcript] Error al reemplazar class_analyses:', updErr);
      return { error: `No se pudo reemplazar el análisis: ${updErr.message}` };
    }
  } else {
    const baseRow = {
      id,
      student_id:   body.studentId || null,
      teacher_id:   body.teacherId || null,
      student_name: studentName,
      class_number: body.classNumber ?? null,
      class_date:   body.classDate || null,
    };
    let { error: insErr } = await supabase.from('class_analyses').insert({ ...baseRow, ...content });
    if (insErr && isMissingCol(insErr)) {
      ({ error: insErr } = await supabase.from('class_analyses').insert({ ...baseRow, ...contentBase }));
    }
    if (insErr) {
      console.error('[analyze-transcript] Error al guardar class_analyses:', insErr);
      return { error: `No se pudo guardar el análisis: ${insErr.message}` };
    }
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

// Payload de validación que se devuelve al cliente (mensajes neutros al profesor).
function verdictPayload(v: TranscriptVerdict) {
  return {
    decision:     v.decision,
    score:        v.structure.score,
    flags:        v.flags,
    flagLabels:   v.flags.map(flagLabel),
    teacherTitle: v.teacherTitle,
    teacherBody:  v.teacherBody,
    similarityPct: v.cross.similarityPct,
    ai:           v.ai ? { authentic: v.ai.authentic, confidence: v.ai.confidence, reasoning: v.ai.reasoning } : null,
  };
}

// Aviso al admin cuando un transcript se bloquea o queda en revisión. Incluye los
// flags legibles y, si hubo similitud alta, el registro parecido.
async function notifyAdminTranscript(
  v: TranscriptVerdict, studentName: string, body: Body, kind: 'blocked' | 'review',
): Promise<void> {
  const teacher = body.teacherName?.trim() || 'sin asignar';
  const flagsTxt = v.flags.map(flagLabel).join(', ') || 'ninguno';
  const simTxt = v.cross.similarMatch
    ? `\nSimilitud ${v.cross.similarityPct}% con la clase de ${v.cross.similarMatch.studentName} (${v.cross.similarMatch.classDate ?? 's/f'}).`
    : '';
  const aiTxt = v.ai ? `\nIA: ${v.ai.authentic ? 'auténtica' : 'sospechosa'} (${v.ai.confidence}%) — ${v.ai.reasoning}` : '';

  const notif = kind === 'blocked'
    ? {
        title: `🚫 Transcripción bloqueada — ${teacher}`,
        body:  `Clase de ${studentName} (${body.classDate ?? 's/f'}). Score ${v.structure.score}/100.\nSeñales: ${flagsTxt}.${simTxt}${aiTxt}`,
        type:  'transcript_blocked',
      }
    : {
        title: `⚠️ Transcripción a revisar — ${teacher}`,
        body:  `Clase de ${studentName} (${body.classDate ?? 's/f'}). Score ${v.structure.score}/100.\nSeñales: ${flagsTxt}.${simTxt}${aiTxt}`,
        type:  'transcript_review',
      };

  const { error } = await supabase.from('notifications').insert({
    id:          `notif_tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    target_user: null,
    target_role: 'admin',
    ...notif,
    read_by:     [],
    created_at:  new Date().toISOString(),
    created_by:  'sistema',
  });
  if (error) console.error('[analyze-transcript] Error al crear la notificación de validación:', error);
}
