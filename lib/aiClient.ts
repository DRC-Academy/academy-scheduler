// Helpers de cliente del módulo de IA: leer la ficha del alumno, regenerarla,
// analizar clases y generar la siguiente.
//
// Ojo: importa tipos desde lib/aiTypes (que no arrastra el SDK). No importar
// lib/analyzeForm, lib/nextClass ni lib/analyzeTranscript desde el cliente.

import { supabase } from '@/lib/supabase';
import {
  asObject, isRiskSignal,
  type ClassAnalysisRow, type FichaIA, type NextClassIA, type RiskSignal,
  type StudentProfileRow, type TranscriptIA,
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
  let q = supabase.from('class_analyses').select(ANALYSIS_COLS)
    .order('analyzed_at', { ascending: false }).limit(args.limit ?? 50);
  if (args.studentId) q = q.eq('student_id', args.studentId);
  else if (args.studentName?.trim()) q = q.ilike('student_name', args.studentName.trim());
  else return [];

  const { data, error } = await q;
  if (error) { console.error('[aiClient] Error al leer class_analyses:', error); return []; }
  return (data ?? []) as unknown as ClassAnalysisRow[];
}

/** Todos los análisis (panel de admin). */
export async function fetchAllClassAnalyses(limit = 500): Promise<ClassAnalysisRow[]> {
  const { data, error } = await supabase.from('class_analyses').select(ANALYSIS_COLS)
    .order('analyzed_at', { ascending: false }).limit(limit);
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
}

/** Sólo analiza: no guarda nada (el profesor revisa antes). */
export async function analyzeTranscriptOnly(args: AnalyzeArgs): Promise<TranscriptIA> {
  const res = await fetch('/api/ai/analyze-transcript', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'No se pudo analizar la transcripción.');
  return data.analysis as TranscriptIA;
}

/** Guarda el análisis (posiblemente editado por el profesor). */
export async function saveAnalysis(args: AnalyzeArgs & { analysis: TranscriptIA }): Promise<void> {
  const res = await fetch('/api/ai/analyze-transcript', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...args, save: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'No se pudo guardar el análisis.');
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
  persist?: boolean;
}): Promise<NextClassIA> {
  const res = await fetch('/api/ai/generate-next-class', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'No se pudo generar la clase.');
  return data.nextClass as NextClassIA;
}

/** Marca la clase generada como lista (la persiste en la ficha). */
export async function saveNextClass(profileId: string, nextClass: NextClassIA): Promise<void> {
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
