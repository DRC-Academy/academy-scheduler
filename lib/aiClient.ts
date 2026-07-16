// Helpers de cliente del módulo de IA: leer la ficha del alumno, generar la
// primera clase y analizar transcripciones.
//
// Ojo: importa tipos desde lib/aiTypes (que no arrastra el SDK). No importar
// lib/analyzeForm ni lib/firstClass desde componentes cliente.

import { supabase } from '@/lib/supabase';
import { isRiskSignal, type FichaIA, type FirstClassIA, type TranscriptIA, type RiskSignal } from '@/lib/aiTypes';

export interface StudentProfileRow {
  id: string;
  student_id: string | null;
  student_name: string | null;
  form_token_id: string | null;
  form_responses: Record<string, unknown> | string | null;
  ai_ficha: string | null;                 // formato anterior (markdown)
  ai_ficha_json: FichaIA | string | null;  // formato actual
  ai_first_class: FirstClassIA | string | null;
  ai_status: string | null;
  risk_signal: string | null;
}

const PROFILE_COLS =
  'id, student_id, student_name, form_token_id, form_responses, ai_ficha, ai_ficha_json, ai_first_class, ai_status, risk_signal';

// Las columnas jsonb pueden llegar como objeto o como string, según cómo se haya
// creado la tabla. Normalizamos a objeto en ambos casos.
export function asObject<T>(v: T | string | null | undefined): T | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return null; }
  }
  return v;
}

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
    if (data) return data as StudentProfileRow;
  }
  if (args.formTokenId) {
    const { data } = await supabase.from('student_profiles').select(PROFILE_COLS)
      .eq('form_token_id', args.formTokenId).limit(1).maybeSingle();
    if (data) return data as StudentProfileRow;
  }
  if (args.studentName?.trim()) {
    const { data } = await supabase.from('student_profiles').select(PROFILE_COLS)
      .ilike('student_name', args.studentName.trim()).order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (data) return data as StudentProfileRow;
  }
  return null;
}

// ── Primera clase ─────────────────────────────────────────────────────────────
export async function generateAndSaveFirstClass(args: {
  profileId: string;
  studentName: string;
  teacherName: string;
  plan?: string | null;
  level?: string | null;
  studentProfile: FichaIA;
}): Promise<FirstClassIA> {
  const res = await fetch('/api/ai/generate-first-class', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      studentName: args.studentName,
      teacherName: args.teacherName,
      plan: args.plan ?? undefined,
      level: args.level ?? undefined,
      studentProfile: args.studentProfile,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'No se pudo generar la primera clase.');

  const firstClass = data.firstClass as FirstClassIA;
  // Cacheamos para no volver a pagar la generación en cada apertura.
  const { error } = await supabase.from('student_profiles')
    .update({ ai_first_class: firstClass, updated_at: new Date().toISOString() })
    .eq('id', args.profileId);
  if (error) console.error('[aiClient] No se pudo guardar la primera clase:', error);

  return firstClass;
}

// ── Transcripciones ───────────────────────────────────────────────────────────
export interface ClassAnalysisRow {
  id: string;
  student_id: string | null;
  student_name: string;
  teacher_id: string | null;
  teacher_name: string | null;
  class_number: number | null;
  class_summary: string | null;
  errors_detected: string | null;
  progress_notes: string | null;
  topics_covered: string | null;
  risk_signal: string | null;
  risk_explanation: string | null;
  next_class_guide: unknown;
  created_at: string;
}

const ANALYSIS_COLS =
  'id, student_id, student_name, teacher_id, teacher_name, class_number, class_summary, errors_detected, progress_notes, topics_covered, risk_signal, risk_explanation, next_class_guide, created_at';

export async function fetchClassAnalyses(args: {
  studentId?: string | null;
  studentName?: string | null;
  limit?: number;
}): Promise<ClassAnalysisRow[]> {
  let q = supabase.from('class_analyses').select(ANALYSIS_COLS)
    .order('created_at', { ascending: false }).limit(args.limit ?? 10);
  if (args.studentId) q = q.eq('student_id', args.studentId);
  else if (args.studentName?.trim()) q = q.ilike('student_name', args.studentName.trim());
  else return [];

  const { data, error } = await q;
  if (error) { console.error('[aiClient] Error al leer class_analyses:', error); return []; }
  return (data ?? []) as ClassAnalysisRow[];
}

/** Todos los análisis (para el panel de admin). */
export async function fetchAllClassAnalyses(limit = 500): Promise<ClassAnalysisRow[]> {
  const { data, error } = await supabase.from('class_analyses').select(ANALYSIS_COLS)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) { console.error('[aiClient] Error al leer class_analyses:', error); return []; }
  return (data ?? []) as ClassAnalysisRow[];
}

export async function analyzeTranscriptAndSave(args: {
  transcript: string;
  studentName: string;
  teacherName: string;
  studentId?: string | null;
  teacherId?: string | null;
  profileId?: string | null;
  plan?: string | null;
  level?: string | null;
  classNumber?: number | null;
  studentProfile?: FichaIA | null;
  classHistory?: unknown[] | null;
}): Promise<TranscriptIA> {
  const res = await fetch('/api/ai/analyze-transcript', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...args, persist: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'No se pudo analizar la transcripción.');
  return data.analysis as TranscriptIA;
}

/** Resumen liviano de las fichas con señal de riesgo (panel de admin). */
export async function fetchRiskProfiles(): Promise<Array<{
  id: string; student_id: string | null; student_name: string | null; risk_signal: string | null; updated_at: string | null;
}>> {
  const { data, error } = await supabase.from('student_profiles')
    .select('id, student_id, student_name, risk_signal, updated_at')
    .order('updated_at', { ascending: false });
  if (error) { console.error('[aiClient] Error al leer student_profiles:', error); return []; }
  return data ?? [];
}
