// Persistencia de class_analyses. SOLO SERVIDOR.
//
// Vive aparte de las rutas porque el guardado del TRANSCRIPT y el guardado del
// INFORME de IA son ahora dos pasos independientes (y dos endpoints):
//
//   1. /api/ai/save-transcript   → escribe el transcript. Rápido, sin IA. Nunca
//                                  debe fallar por culpa del modelo.
//   2. /api/ai/analyze-transcript → genera el informe y lo pega sobre esa fila.
//                                  Si falla, la clase ya está guardada y cuenta
//                                  para finanzas; queda "Reintentar análisis".
//
// Todas las escrituras toleran que falten columnas opcionales (migraciones aún
// no corridas): PGRST204 / 42703 → se reintenta sin ese grupo de columnas.

import { supabase } from '@/lib/supabase';
import { isRiskSignal, type TranscriptIA } from '@/lib/aiTypes';
import { flagLabel } from '@/lib/transcriptValidation';
import { statusForDecision, type TranscriptVerdict } from '@/lib/transcriptVerdict';

type Row = Record<string, unknown>;

const isMissingCol = (e: { code?: string } | null): boolean =>
  e?.code === 'PGRST204' || e?.code === '42703';

// Grupos de columnas opcionales, en el orden en que se van descartando si la
// base todavía no las tiene.
const OPTIONAL_GROUPS: string[][] = [
  ['analysis_status', 'analysis_error', 'analysis_updated_at'],           // supabase-transcript-flow.sql
  ['transcript_validation_score', 'transcript_validation_flags',
   'ai_authenticity_check', 'validation_status'],                          // supabase-transcript-validation.sql
  ['transcript_hash'],                                                     // supabase-transcript-hash.sql
  ['join_log_id'],                                                         // supabase-join-log-link.sql
];

function omit(row: Row, keys: string[]): Row {
  const out = { ...row };
  for (const k of keys) delete out[k];
  return out;
}

/** Ejecuta la escritura descartando grupos de columnas opcionales si no existen. */
async function writeWithFallback(
  label: string,
  run: (row: Row) => PromiseLike<{ error: { code?: string; message: string } | null }>,
  row: Row,
): Promise<{ error?: string }> {
  let current = row;
  for (let i = 0; i <= OPTIONAL_GROUPS.length; i++) {
    const { error } = await run(current);
    if (!error) return {};
    if (!isMissingCol(error) || i === OPTIONAL_GROUPS.length) {
      console.error(`[transcriptStore] ${label} falló:`, error);
      return { error: error.message };
    }
    console.warn(`[transcriptStore] ${label}: columnas no migradas (${OPTIONAL_GROUPS[i].join(', ')}), reintentando sin ellas.`);
    current = omit(current, OPTIONAL_GROUPS[i]);
  }
  return { error: 'No se pudo escribir el análisis.' };
}

export interface TranscriptRowInput {
  transcript: string;
  studentName: string;
  studentId?: string | null;
  teacherId?: string | null;
  classNumber?: number | null;
  classDate?: string | null;
  transcriptHash?: string | null;
  joinLogId?: string | null;
  /** Si viene, se ACTUALIZA esa fila en vez de insertar una nueva. */
  replaceId?: string | null;
}

/**
 * Paso 1 — guarda el TRANSCRIPT (sin informe). Devuelve el id de la fila.
 * `analysis_status` queda en 'pending': el informe llega en el paso 2.
 */
export async function persistTranscript(
  input: TranscriptRowInput, verdict: TranscriptVerdict,
): Promise<{ id?: string; error?: string }> {
  const now = new Date().toISOString();
  const id = input.replaceId || `ca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const content: Row = {
    transcript:      input.transcript,      // NOT NULL en la base
    transcript_hash: input.transcriptHash || null,
    join_log_id:     input.joinLogId || null,
    analyzed_at:     now,

    transcript_validation_score: verdict.structure.score,
    transcript_validation_flags: verdict.flags,
    validation_status:           statusForDecision(verdict.decision),

    analysis_status:     'pending',
    analysis_error:      null,
    analysis_updated_at: now,
  };

  if (input.replaceId) {
    const res = await writeWithFallback(
      'update transcript',
      row => supabase.from('class_analyses').update(row).eq('id', input.replaceId as string),
      content,
    );
    return res.error ? { error: `No se pudo guardar la transcripción: ${res.error}` } : { id };
  }

  const base: Row = {
    id,
    student_id:   input.studentId || null,
    teacher_id:   input.teacherId || null,
    student_name: input.studentName,
    class_number: input.classNumber ?? null,
    class_date:   input.classDate || null,
  };
  const res = await writeWithFallback(
    'insert transcript',
    row => supabase.from('class_analyses').insert(row),
    { ...base, ...content },
  );
  return res.error ? { error: `No se pudo guardar la transcripción: ${res.error}` } : { id };
}

/** Paso 2 — pega el informe de IA sobre una fila ya guardada. */
export async function persistAnalysisFields(
  analysisId: string, a: TranscriptIA,
): Promise<{ error?: string }> {
  const now = new Date().toISOString();
  const content: Row = {
    class_title:      a.classTitle,
    class_summary:    a.classSummary,
    errors_detected:  a.errorsDetected,
    progress_notes:   a.progressNotes,
    topics_covered:   a.topicsCovered,
    next_class_guide: a.nextClassGuide,
    risk_signal:      isRiskSignal(a.riskSignal) ? a.riskSignal : 'verde',
    risk_explanation: a.riskExplanation,

    analysis_status:     'ready',
    analysis_error:      null,
    analysis_updated_at: now,
  };
  return writeWithFallback(
    'update análisis',
    row => supabase.from('class_analyses').update(row).eq('id', analysisId),
    content,
  );
}

/** El análisis falló: la clase queda guardada y marcada para reintentar. */
export async function markAnalysisFailed(analysisId: string, message: string): Promise<void> {
  await writeWithFallback(
    'marcar análisis fallido',
    row => supabase.from('class_analyses').update(row).eq('id', analysisId),
    {
      analysis_status:     'failed',
      analysis_error:      message.slice(0, 500),
      analysis_updated_at: new Date().toISOString(),
    },
  );
}

/** Degrada una clase a revisión (lo usa la capa 3 cuando corre después del guardado). */
export async function markForReview(
  analysisId: string, ai: Record<string, unknown> | null, flags: string[],
): Promise<void> {
  await writeWithFallback(
    'marcar a revisión',
    row => supabase.from('class_analyses').update(row).eq('id', analysisId),
    { validation_status: 'review', ai_authenticity_check: ai, transcript_validation_flags: flags },
  );
}

// ── Ficha del alumno ─────────────────────────────────────────────────────────

export async function resolveProfileId(args: {
  profileId?: string | null; studentId?: string | null; studentName: string;
}): Promise<string | null> {
  if (args.profileId) return args.profileId;
  if (args.studentId) {
    const { data } = await supabase.from('student_profiles').select('id').eq('student_id', args.studentId).maybeSingle();
    if (data) return data.id;
  }
  const { data } = await supabase.from('student_profiles').select('id').ilike('student_name', args.studentName).maybeSingle();
  return data?.id ?? null;
}

const clampScore = (n: number): number =>
  Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 5;

/** Vuelca riesgo, progreso y contadores del análisis en la ficha del alumno. */
export async function updateProfileFromAnalysis(args: {
  profileId: string;
  studentId?: string | null;
  studentName: string;
  classDate?: string | null;
  analysis: TranscriptIA;
}): Promise<void> {
  const now = new Date().toISOString();
  const q = supabase.from('class_analyses').select('*', { count: 'exact', head: true });
  const { count } = args.studentId
    ? await q.eq('student_id', args.studentId)
    : await q.ilike('student_name', args.studentName);

  const { error } = await supabase.from('student_profiles').update({
    risk_signal:            isRiskSignal(args.analysis.riskSignal) ? args.analysis.riskSignal : 'verde',
    risk_explanation:       args.analysis.riskExplanation,
    risk_updated_at:        now,
    progress_score:         clampScore(args.analysis.progressScore),
    total_classes_analyzed: count ?? 0,
    last_class_analyzed_at: args.classDate || now,
    updated_at:             now,
  }).eq('id', args.profileId);
  if (error) console.error('[transcriptStore] Error al actualizar la ficha:', error);
}

// ── Notificaciones al admin ──────────────────────────────────────────────────

async function insertNotification(
  prefix: string, notif: { title: string; body: string; type: string }, createdBy: string,
): Promise<void> {
  const { error } = await supabase.from('notifications').insert({
    id:          `notif_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    target_user: null,
    target_role: 'admin',
    ...notif,
    read_by:     [],
    created_at:  new Date().toISOString(),
    created_by:  createdBy,
  });
  if (error) console.error('[transcriptStore] Error al crear la notificación:', error);
}

/** Aviso al admin cuando una clase queda pendiente de validación. */
export async function notifyAdminTranscript(
  v: TranscriptVerdict, studentName: string,
  ctx: { teacherName?: string; classDate?: string | null },
): Promise<void> {
  const teacher = ctx.teacherName?.trim() || 'sin asignar';
  const flagsTxt = v.flags.map(flagLabel).join(', ') || 'ninguno';
  const simTxt = v.cross.similarMatch
    ? `\nSimilitud ${v.cross.similarityPct}% con la clase de ${v.cross.similarMatch.studentName} (${v.cross.similarMatch.classDate ?? 's/f'}).`
    : '';
  const aiTxt = v.ai ? `\nIA: ${v.ai.authentic ? 'auténtica' : 'sospechosa'} (${v.ai.confidence}%) — ${v.ai.reasoning}` : '';
  const detalle = `Clase de ${studentName} (${ctx.classDate ?? 's/f'}). Score ${v.structure.score}/100.\nSeñales: ${flagsTxt}.${simTxt}${aiTxt}`;

  await insertNotification('tx', v.decision === 'blocked'
    ? { title: `🚫 Transcripción muy dudosa — ${teacher}`, body: detalle, type: 'transcript_blocked' }
    : { title: `⚠️ Transcripción a revisar — ${teacher}`,   body: detalle, type: 'transcript_review' },
    'sistema',
  );
}

/** Aviso al admin por señal de riesgo de baja del alumno. */
export async function notifyAdminRisk(
  risk: 'amarillo' | 'rojo', studentName: string,
  ctx: { teacherName?: string; classNumber?: number | null }, a: TranscriptIA,
): Promise<void> {
  const teacher = ctx.teacherName?.trim() || 'sin asignar';
  const clase = ctx.classNumber != null ? `Clase ${ctx.classNumber} analizada` : 'Clase analizada';

  await insertNotification('risk', risk === 'rojo'
    ? {
        title: `🔴 ALERTA — ${studentName} en riesgo de baja`,
        body:  `Profesor: ${teacher} · Acción recomendada: contactar al alumno esta semana.\n\nMotivo: ${a.riskExplanation}`,
        type:  'ai_risk_red',
      }
    : {
        title: `⚠️ ${studentName} — Señal de atención`,
        body:  `Profesor: ${teacher} · ${clase}\nMotivo: ${a.riskExplanation}`,
        type:  'ai_risk_yellow',
      },
    'ia',
  );
}

/** Payload de validación que se devuelve al cliente (mensajes neutros al profesor). */
export function verdictPayload(v: TranscriptVerdict) {
  return {
    decision:      v.decision,
    score:         v.structure.score,
    flags:         v.flags,
    flagLabels:    v.flags.map(flagLabel),
    teacherTitle:  v.teacherTitle,
    teacherBody:   v.teacherBody,
    similarityPct: v.cross.similarityPct,
    ai:            v.ai ? { authentic: v.ai.authentic, confidence: v.ai.confidence, reasoning: v.ai.reasoning } : null,
  };
}
