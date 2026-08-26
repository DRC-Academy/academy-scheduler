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
import { isRiskCause, isRiskSignal, type TranscriptIA } from '@/lib/aiTypes';
import { normalizeDetections, normalizeSuggestion } from '@/lib/interventions';
import { flagLabel } from '@/lib/transcriptValidation';
import { statusForDecision, type TranscriptVerdict } from '@/lib/transcriptVerdict';

type Row = Record<string, unknown>;

const isMissingCol = (e: { code?: string } | null): boolean =>
  e?.code === 'PGRST204' || e?.code === '42703';

// Columnas que dependen de una migración posterior: pueden no existir todavía.
// El valor es el script que las crea, para que el aviso del log diga qué correr.
//
// OJO — este mapa NO define orden ni grupos a propósito. La versión anterior
// descartaba GRUPOS EN CASCADA hasta que la escritura pasaba, así que una sola
// columna ausente al final de la lista tiraba por el camino todas las columnas
// anteriores AUNQUE EXISTIERAN (así se perdieron transcript_hash y los scores de
// validación en todas las filas). Ahora se descarta exactamente la columna que
// la base dice que falta, y ninguna más.
const OPTIONAL_COLUMNS: Record<string, string> = {
  intervention_suggestion:     'supabase-interventions.sql',
  analysis_status:             'supabase-transcript-flow.sql',
  analysis_error:              'supabase-transcript-flow.sql',
  analysis_updated_at:         'supabase-transcript-flow.sql',
  transcript_validation_score: 'supabase-transcript-validation.sql',
  transcript_validation_flags: 'supabase-transcript-validation.sql',
  ai_authenticity_check:       'supabase-transcript-validation.sql',
  validation_status:           'supabase-transcript-validation.sql',
  validation_details:          'supabase-validation-details.sql',
  transcript_hash:             'supabase-transcript-hash.sql',
  join_log_id:                 'supabase-join-log-link.sql',
  detections:                  'supabase-risk-actions.sql',
  risk_cause:                  'supabase-risk-actions.sql',
};

/**
 * Nombre de la columna que la base dice que no existe. Los dos formatos reales:
 *   42703    → «column class_analyses.validation_status does not exist»
 *   PGRST204 → «Could not find the 'validation_status' column of 'class_analyses'…»
 */
function missingColumnOf(error: { message?: string }): string | null {
  const msg = error.message ?? '';
  const m = /column\s+(?:[\w$]+\.)?"?([a-zA-Z0-9_]+)"?\s+does not exist/i.exec(msg)
    ?? /could not find the '([^']+)' column/i.exec(msg);
  return m?.[1] ?? null;
}

function omit(row: Row, keys: string[]): Row {
  const out = { ...row };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * Ejecuta la escritura descartando SOLO las columnas opcionales que la base
 * reporte como inexistentes, una por una. Todo lo demás se conserva.
 *
 * Una vez corridas las migraciones este fallback no descarta nada: la primera
 * escritura pasa y no se emite ningún aviso. Queda como red de seguridad para un
 * entorno nuevo o una migración a medias, pero siempre dejando rastro en el log.
 */
async function writeWithFallback(
  label: string,
  run: (row: Row) => PromiseLike<{ error: { code?: string; message: string } | null }>,
  row: Row,
): Promise<{ error?: string }> {
  let current = row;
  const dropped: string[] = [];

  // Cota: como mucho una vuelta por columna opcional, más el intento inicial.
  for (let i = 0; i <= Object.keys(OPTIONAL_COLUMNS).length; i++) {
    const { error } = await run(current);

    if (!error) {
      if (dropped.length) {
        console.warn(
          `[transcriptStore] ${label}: guardado SIN las columnas [${dropped.join(', ')}] porque no existen en la base. ` +
          `Corré ${[...new Set(dropped.map(c => OPTIONAL_COLUMNS[c]))].join(' y ')} para que dejen de perderse.`,
        );
      }
      return {};
    }

    if (!isMissingCol(error)) {
      console.error(`[transcriptStore] ${label} falló:`, error);
      return { error: error.message };
    }

    const col = missingColumnOf(error);

    // No se pudo identificar la columna: último recurso, se van todas las
    // opcionales que queden. Solo así, y avisando fuerte.
    if (!col) {
      const remaining = Object.keys(OPTIONAL_COLUMNS).filter(c => c in current);
      if (remaining.length === 0) {
        console.error(`[transcriptStore] ${label} falló y no se pudo identificar la columna:`, error);
        return { error: error.message };
      }
      console.warn(
        `[transcriptStore] ${label}: falta una columna pero el error no dice cuál (${error.message}). ` +
        `Se reintenta sin las opcionales restantes [${remaining.join(', ')}].`,
      );
      dropped.push(...remaining);
      current = omit(current, remaining);
      continue;
    }

    // La columna que falta no es opcional → es un problema real de esquema y
    // silenciarlo escondería un bug. Se corta acá.
    if (!(col in OPTIONAL_COLUMNS)) {
      console.error(
        `[transcriptStore] ${label}: falta la columna OBLIGATORIA "${col}" en class_analyses. ` +
        'Revisá el esquema: no se descarta porque el dato es imprescindible.',
      );
      return { error: error.message };
    }

    // La base reporta una columna que ya no estamos enviando: sin salida.
    if (!(col in current)) {
      console.error(`[transcriptStore] ${label}: la base pide "${col}" pero no está en la escritura.`, error);
      return { error: error.message };
    }

    console.warn(
      `[transcriptStore] ${label}: la columna "${col}" no existe en la base (la crea ${OPTIONAL_COLUMNS[col]}). ` +
      'Se descarta SOLO esa columna y se reintenta; el resto se guarda igual.',
    );
    dropped.push(col);
    current = omit(current, [col]);
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
  /** Duración CONTRATADA: 120 en una sesión de 2 h, 60 por defecto. */
  durationMinutes?: number | null;
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
    validation_status:           statusForDecision(verdict.decision, verdict.structure.score),
    // Lo que MIRÓ la validación, no solo su conclusión. El panel del admin lo
    // enseña en "Datos de la clase" para que el score y la alerta se puedan
    // contrastar sin abrir el transcript. La duración contratada solo se conoce
    // acá: si no se guarda, después no hay de dónde sacarla.
    validation_details: {
      durationExpectedMin: input.durationMinutes ?? 60,
      durationRecordedMin: verdict.cross.estimatedDurationMin,
      timestampCount:      verdict.structure.timestampCount,
      hasAccess:           verdict.cross.hasAccess,
      daysLate:            verdict.cross.daysLate,
      similarityPct:       verdict.cross.similarityPct,
    },

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
    risk_cause:       isRiskCause(a.riskCause) ? a.riskCause : null,
    // Detecciones con su acción emparejada. Se guardan SIEMPRE, también en las
    // clases en verde: son hallazgos pedagógicos, no señales de baja.
    detections:       normalizeDetections(a.detections),
    // Sugerencia de intervención de esta clase (null si la clase salió en verde).
    intervention_suggestion: normalizeSuggestion(a.interventionSuggestion),

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

/**
 * Deja constancia de lo que encontró la capa 3 (IA de autenticidad) cuando corre
 * DESPUÉS del guardado, sin tocar el estado de validación.
 *
 * ANTES ESTO DESPAGABA CLASES HACIA ATRÁS. La función ponía
 * `validation_status: 'review'` sobre clases que ya estaban en 'ok' —o sea, que
 * ya contaban para el pago— y lo hacía minutos después de que el profesor viera
 * "Clase guardada ✓, cuenta para tu pago". Nadie le avisaba: la clase
 * simplemente dejaba de sumar y reaparecía como "Pendiente de transcript".
 *
 * Ahora el hallazgo se guarda (`ai_authenticity_check` + `transcript_validation_flags`)
 * y se le avisa al admin, pero el estado NO baja: sacar una clase de 'ok' o de
 * 'auto_approved' es una decisión de una persona, y para eso está el botón
 * "Reabrir" del panel (dbReopenTranscript).
 */
export async function recordLateAuthenticityCheck(
  analysisId: string, ai: Record<string, unknown> | null, flags: string[],
): Promise<void> {
  console.warn(
    `[transcriptStore] La verificación tardía marcó señales en ${analysisId} [${flags.join(', ')}]. ` +
    'Se guardan como constancia y se avisa al admin; el estado de validación NO se toca ' +
    '(una clase ya aprobada solo la reabre una persona).',
  );
  await writeWithFallback(
    'registrar verificación tardía',
    row => supabase.from('class_analyses').update(row).eq('id', analysisId),
    { ai_authenticity_check: ai, transcript_validation_flags: flags },
  );
}

// ── Ficha del alumno ─────────────────────────────────────────────────────────

export async function resolveProfileId(args: {
  profileId?: string | null; studentId?: string | null; studentName: string;
}): Promise<string | null> {
  if (args.profileId) return args.profileId;
  // `.limit(1)` antes de maybeSingle: sin él, dos fichas con el mismo nombre
  // hacen que PostgREST devuelva error en vez de la ficha.
  if (args.studentId) {
    const { data } = await supabase.from('student_profiles').select('id')
      .eq('student_id', args.studentId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (data) return data.id;
  }
  const { data } = await supabase.from('student_profiles').select('id')
    .ilike('student_name', args.studentName.trim())
    .order('updated_at', { ascending: false }).limit(1).maybeSingle();
  return data?.id ?? null;
}

/**
 * La ficha del alumno, creándola si no existe.
 *
 * Por qué: hasta ahora la señal de riesgo solo se guardaba `if (profileId)`, y la
 * ficha únicamente nacía cuando el alumno completaba el formulario inicial. Los
 * alumnos que nunca lo completaron (la mayoría) quedaban con el riesgo enterrado
 * en class_analyses y sin ficha donde colgar la intervención: la campanita
 * avisaba y el panel del admin se veía vacío.
 *
 * La ficha creada acá es MÍNIMA y queda marcada con `ai_status: 'auto'` para
 * distinguirla de una ficha completa del formulario. El id se elige a propósito
 * igual al `student_id` cuando lo hay, que es la misma convención que usa
 * /api/forms/submit: así, si el alumno completa el formulario más tarde, su
 * upsert `onConflict: 'id'` ENRIQUECE esta misma fila en vez de duplicarla.
 */
export async function ensureProfileId(args: {
  profileId?: string | null;
  studentId?: string | null;
  studentName: string;
  teacherId?: string | null;
}): Promise<string | null> {
  const existing = await resolveProfileId(args);
  if (existing) return existing;

  const name = args.studentName.trim();
  if (!name) return null;

  // Sin student_id explícito, se busca el alumno por nombre: es lo que permite
  // que la ficha nazca ya vinculada y que el formulario posterior la reutilice.
  let studentId = args.studentId ?? null;
  if (!studentId) {
    const { data } = await supabase.from('students').select('id')
      .ilike('name', name).limit(1).maybeSingle();
    studentId = data?.id ?? null;
  }

  const now = new Date().toISOString();
  const row: Row = {
    student_name: name,
    student_id:   studentId,
    teacher_id:   args.teacherId ?? null,
    ai_status:    'auto',          // ← marca: ficha nacida sola (análisis o clase genérica), no del formulario
    created_at:   now,
    updated_at:   now,
  };
  const id = studentId ?? `sp_auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let { error } = await supabase.from('student_profiles')
    .upsert({ id, ...row }, { onConflict: 'id' });

  // El alumno no está en `students` (vínculo solo por nombre): se guarda la ficha
  // sin vincular en vez de perder el riesgo. Mismo criterio que /api/forms/submit.
  if (error?.code === '23503') {
    ({ error } = await supabase.from('student_profiles').upsert(
      { id: `sp_auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...row, student_id: null },
      { onConflict: 'id' },
    ));
  }

  if (error) {
    console.error(`[transcriptStore] No se pudo crear la ficha automática de "${name}":`, error);
    return null;
  }

  console.log(`[transcriptStore] Ficha automática creada para "${name}" (id ${id}, ai_status 'auto').`);
  return id;
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
