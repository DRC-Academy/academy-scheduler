// Helpers de cliente del módulo de IA: leer la ficha del alumno, regenerarla,
// analizar clases y generar la siguiente.
//
// Ojo: importa tipos desde lib/aiTypes (que no arrastra el SDK). No importar
// lib/analyzeForm, lib/nextClass ni lib/analyzeTranscript desde el cliente.

import { supabase } from '@/lib/supabase';
import {
  asObject, isRiskSignal,
  type AvatarDomain, type ClassType, type ClassAnalysisRow, type FichaIA,
  type GeneratedClassIA, type RiskSignal, type StudentProfileRow, type TranscriptIA,
} from '@/lib/aiTypes';

export type { StudentProfileRow, ClassAnalysisRow } from '@/lib/aiTypes';

const PROFILE_COLS = `
  id, student_id, student_name, teacher_id, form_responses, form_completed_at, form_token_id,
  initial_diagnosis, strong_points, weak_points, learning_style, personal_objective, occupation,
  recommended_focus, current_level, current_block, grammar_focus, vocabulary_focus,
  risk_signal, risk_explanation, risk_updated_at, progress_score,
  total_classes_analyzed, last_class_analyzed_at, next_class_content, next_class_generated_at,
  ai_ficha, ai_status, created_at, updated_at
`.replace(/\s+/g, ' ').trim();

const ANALYSIS_COLS = `
  id, student_id, teacher_id, student_name, class_number, transcript,
  class_summary, errors_detected, progress_notes, topics_covered, next_class_guide,
  risk_signal, risk_explanation, analyzed_at, class_date, class_title, next_class_content
`.replace(/\s+/g, ' ').trim();

// Columnas de migraciones posteriores. Se piden aparte porque si la base todavía
// no las tiene, Supabase devuelve error 42703 y la consulta ENTERA falla (la
// página del alumno se quedaría vacía). Se reintenta sin ellas.
const ANALYSIS_COLS_EXTRA = `${ANALYSIS_COLS}, join_log_id, validation_status, analysis_status, analysis_error`;

const isMissingCol = (e: { code?: string } | null | undefined): boolean =>
  e?.code === '42703' || e?.code === 'PGRST204';

export { asObject, fichaFromRow } from '@/lib/aiTypes';

export function riskOf(row: { risk_signal?: string | null } | null | undefined): RiskSignal | null {
  return row && isRiskSignal(row.risk_signal) ? row.risk_signal : null;
}

/** Busca la ficha de un alumno: por student_id, luego por token, luego por nombre. */
export async function fetchStudentProfile(args: {
  studentId?: string | null;
  formTokenId?: string | null;
  studentName?: string | null;
}): Promise<StudentProfileRow | null> {
  if (args.studentId) {
    const { data } = await supabase.from('student_profiles').select(PROFILE_COLS)
      .eq('student_id', args.studentId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (data) return data as unknown as StudentProfileRow;
  }
  if (args.formTokenId) {
    const { data } = await supabase.from('student_profiles').select(PROFILE_COLS)
      .eq('form_token_id', args.formTokenId).limit(1).maybeSingle();
    if (data) return data as unknown as StudentProfileRow;
  }
  if (args.studentName?.trim()) {
    const { data } = await supabase.from('student_profiles').select(PROFILE_COLS)
      .ilike('student_name', args.studentName.trim()).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (data) return data as unknown as StudentProfileRow;
  }
  return null;
}

/** Regenera la ficha desde las respuestas guardadas y la persiste. */
export async function regenerateFicha(args: {
  profileId: string; teacherName?: string; plan?: string | null; level?: string | null;
}): Promise<FichaIA> {
  const res = await fetch('/api/ai/analyze-form', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId: args.profileId,
      teacherName: args.teacherName,
      plan: args.plan ?? undefined,
      level: args.level ?? undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'No se pudo generar la ficha.');
  return data.ficha as FichaIA;
}

// ── Clases analizadas ─────────────────────────────────────────────────────────
export async function fetchClassAnalyses(args: {
  studentId?: string | null; studentName?: string | null; limit?: number;
}): Promise<ClassAnalysisRow[]> {
  const build = (cols: string) => {
    let q = supabase.from('class_analyses').select(cols)
      .order('analyzed_at', { ascending: false }).limit(args.limit ?? 50);
    if (args.studentId) q = q.eq('student_id', args.studentId);
    else if (args.studentName?.trim()) q = q.ilike('student_name', args.studentName.trim());
    return q;
  };
  if (!args.studentId && !args.studentName?.trim()) return [];

  let { data, error } = await build(ANALYSIS_COLS_EXTRA);
  if (error && isMissingCol(error)) ({ data, error } = await build(ANALYSIS_COLS));
  if (error) { console.error('[aiClient] Error al leer class_analyses:', error); return []; }
  return (data ?? []) as unknown as ClassAnalysisRow[];
}

/** Todos los análisis (panel de admin). */
export async function fetchAllClassAnalyses(limit = 500): Promise<ClassAnalysisRow[]> {
  const build = (cols: string) => supabase.from('class_analyses').select(cols)
    .order('analyzed_at', { ascending: false }).limit(limit);

  let { data, error } = await build(ANALYSIS_COLS_EXTRA);
  if (error && isMissingCol(error)) ({ data, error } = await build(ANALYSIS_COLS));
  if (error) { console.error('[aiClient] Error al leer class_analyses:', error); return []; }
  return (data ?? []) as unknown as ClassAnalysisRow[];
}

/** Convierte una fila de class_analyses al shape que devuelve la IA. */
export function analysisFromRow(r: ClassAnalysisRow): TranscriptIA {
  return {
    classTitle:      r.class_title ?? '',
    classSummary:    r.class_summary ?? '',
    errorsDetected:  r.errors_detected ?? '',
    progressNotes:   r.progress_notes ?? '',
    topicsCovered:   r.topics_covered ?? '',
    progressScore:   5,
    riskSignal:      isRiskSignal(r.risk_signal) ? r.risk_signal : 'verde',
    riskExplanation: r.risk_explanation ?? '',
    nextClassGuide:  asObject(r.next_class_guide) ?? { priority: '', warmUp: '', mainFocus: '', activity: '', notes: '' },
  };
}

// ── Analizar / guardar una clase ──────────────────────────────────────────────
export interface AnalyzeArgs {
  transcript: string;
  studentName: string;
  teacherName: string;
  studentId?: string | null;
  teacherId?: string | null;
  profileId?: string | null;
  plan?: string | null;
  level?: string | null;
  classNumber?: number | null;
  classDate?: string | null;
  studentProfile?: FichaIA | null;
  classHistory?: unknown[] | null;
  /** Huella para detectar duplicados (se guarda junto al análisis). */
  transcriptHash?: string | null;
  /** Si viene, reemplaza el transcript de esa fila en vez de crear otra. */
  replaceId?: string | null;
  /** Ingreso al que pertenece la clase (vínculo explícito con finanzas). */
  joinLogId?: string | null;
}

/** Sólo analiza: no guarda nada (el profesor revisa antes). */
export async function analyzeTranscriptOnly(args: AnalyzeArgs): Promise<TranscriptIA> {
  const data = await postJson<{ analysis: TranscriptIA }>(
    '/api/ai/analyze-transcript', args, 'No se pudo analizar la transcripción.',
  );
  return data.analysis;
}

export interface TranscriptValidation {
  decision: 'ok' | 'review' | 'blocked';
  score: number;
  flags: string[];
  flagLabels: string[];
  teacherTitle: string;
  teacherBody: string;
  similarityPct?: number;
  ai?: { authentic: boolean; confidence: number; reasoning: string } | null;
}
export interface SaveAnalysisResult {
  saved: boolean;
  /** false → el transcript se guardó pero el informe de IA no. */
  analyzed?: boolean;
  analysisId?: string;
  /** @deprecated el guardado ya nunca se cancela; queda por compatibilidad. */
  blocked?: boolean;
  validation?: TranscriptValidation | null;
}

/** Guarda transcript + análisis en un paso (el profesor ya revisó el informe).
 *  Nunca bloquea: como mucho la clase queda pendiente de validación. */
export async function saveAnalysis(args: AnalyzeArgs & { analysis: TranscriptIA }): Promise<SaveAnalysisResult> {
  return postJson<SaveAnalysisResult>(
    '/api/ai/analyze-transcript', { ...args, save: true }, 'No se pudo guardar el análisis.',
  );
}

// ── Registrar una clase: GUARDAR primero, ANALIZAR después ───────────────────
//
// El orden importa. Antes se analizaba y solo después se guardaba: si la IA
// tardaba o fallaba, el profesor perdía el registro de la clase y esta quedaba
// como "a revisar" en finanzas. Ahora el transcript se persiste en el primer
// paso (rápido, sin IA) y el informe se pega encima; si el informe falla, la
// clase ya está registrada y queda el botón "Reintentar análisis".

export interface RegisterClassResult {
  /** Id de la fila de class_analyses. La clase YA está guardada si viene. */
  analysisId: string;
  validation: TranscriptValidation | null;
  /** false → el transcript se guardó pero el informe de IA no salió. */
  analyzed: boolean;
  analysisError?: string;
}

/** Paso 1 — guarda el transcript. Devuelve el id de la fila creada. */
export async function saveTranscriptOnly(args: AnalyzeArgs): Promise<{
  analysisId: string; validation: TranscriptValidation | null;
}> {
  const data = await postJson<{ analysisId?: string; validation?: TranscriptValidation | null }>(
    '/api/ai/save-transcript',
    {
      transcript: args.transcript,
      studentName: args.studentName,
      studentId: args.studentId,
      teacherId: args.teacherId,
      teacherName: args.teacherName,
      classNumber: args.classNumber,
      classDate: args.classDate,
      level: args.level,
      transcriptHash: args.transcriptHash,
      joinLogId: args.joinLogId,
      replaceId: args.replaceId,
    },
    'No se pudo guardar la clase.',
  );
  if (!data.analysisId) throw new Error('No se pudo guardar la clase.');
  return { analysisId: data.analysisId, validation: data.validation ?? null };
}

/** Paso 2 — genera el informe sobre una fila ya guardada. No lanza: la clase
 *  ya está a salvo, así que un fallo acá solo se informa. */
export async function runAnalysisFor(args: AnalyzeArgs & { analysisId: string }): Promise<{
  analyzed: boolean; error?: string;
}> {
  try {
    const data = await postJson<{ analyzed?: boolean; error?: string }>(
      '/api/ai/analyze-transcript',
      {
        analysisId: args.analysisId,
        studentName: args.studentName,
        teacherName: args.teacherName,
        studentId: args.studentId,
        teacherId: args.teacherId,
        profileId: args.profileId,
        plan: args.plan,
        level: args.level,
        classNumber: args.classNumber,
        classDate: args.classDate,
        studentProfile: args.studentProfile,
        classHistory: args.classHistory,
      },
      'No se pudo generar el análisis.',
    );
    return { analyzed: !!data.analyzed, error: data.error };
  } catch (err) {
    return { analyzed: false, error: err instanceof Error ? err.message : 'No se pudo generar el análisis.' };
  }
}

/** Flujo completo del profesor: guardar y luego analizar. */
export async function registerClassWithTranscript(args: AnalyzeArgs): Promise<RegisterClassResult> {
  const { analysisId, validation } = await saveTranscriptOnly(args);   // si esto falla, sí lanza
  const { analyzed, error } = await runAnalysisFor({ ...args, analysisId });
  return { analysisId, validation, analyzed, analysisError: error };
}

/** "Reintentar análisis": vuelve a analizar un transcript ya guardado. */
export async function retryAnalysis(args: {
  analysisId: string;
  studentName: string;
  teacherName?: string;
  studentId?: string | null;
  teacherId?: string | null;
  profileId?: string | null;
  plan?: string | null;
  level?: string | null;
  studentProfile?: FichaIA | null;
  classHistory?: unknown[] | null;
}): Promise<{ analyzed: boolean; error?: string }> {
  return runAnalysisFor({
    ...args,
    transcript: '',                 // el servidor usa el transcript guardado
    teacherName: args.teacherName ?? '',
  });
}

// Mensajes de error CLAROS: sin esto, un corte de la función serverless devuelve
// una respuesta sin JSON y el profesor solo veía "No se pudo…" sin más pistas.
async function postJson<T>(url: string, body: unknown, fallbackMsg: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[aiClient] Fallo de red en ${url}:`, err);
    throw new Error('No hay conexión con el servidor. Revisá tu internet e intentá de nuevo.');
  }

  const raw = await res.text();
  let data: Record<string, unknown> = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* respuesta sin JSON (timeout/HTML) */ }

  if (!res.ok) {
    console.error(`[aiClient] ${url} respondió ${res.status}:`, raw.slice(0, 500));
    if (res.status === 504 || res.status === 502 || (!raw && res.status >= 500)) {
      throw new Error('El servidor tardó demasiado en responder. Volvé a intentarlo en un minuto.');
    }
    throw new Error(typeof data.error === 'string' ? data.error : `${fallbackMsg} (error ${res.status})`);
  }
  return data as T;
}

// ── Siguiente clase ───────────────────────────────────────────────────────────
export async function generateNextClassClient(args: {
  profileId: string;
  studentName: string;
  teacherName: string;
  classNumber: number;
  studentProfile: FichaIA;
  lastAnalysis?: TranscriptIA | null;
  classHistory?: unknown[] | null;
  plan?: string | null;
  level?: string | null;
  domain?: AvatarDomain | null;
  classType?: ClassType | null;
  persist?: boolean;
}): Promise<GeneratedClassIA> {
  const res = await fetch('/api/ai/generate-next-class', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'No se pudo generar la clase.');
  return data.nextClass as GeneratedClassIA;
}

/** Marca la clase generada como lista (la persiste en la ficha). */
export async function saveNextClass(profileId: string, nextClass: GeneratedClassIA): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('student_profiles')
    .update({ next_class_content: nextClass, next_class_generated_at: now, updated_at: now })
    .eq('id', profileId);
  if (error) throw new Error(`No se pudo guardar la clase: ${error.message}`);
}

/** Resumen liviano de las fichas con riesgo (panel de admin). */
export async function fetchRiskProfiles(): Promise<StudentProfileRow[]> {
  const { data, error } = await supabase.from('student_profiles').select(PROFILE_COLS)
    .order('updated_at', { ascending: false });
  if (error) { console.error('[aiClient] Error al leer student_profiles:', error); return []; }
  return (data ?? []) as unknown as StudentProfileRow[];
}
