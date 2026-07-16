// Tipos del módulo de IA — SIN dependencias.
//
// Vive aparte a propósito: lib/analyzeForm, lib/firstClass, lib/nextClass y
// lib/analyzeTranscript importan el SDK de Anthropic (sólo servidor). Los
// componentes cliente importan los tipos desde acá para que el SDK no termine
// en el bundle del navegador.
//
// IMPORTANTE — los nombres de columna de Supabase son la fuente de verdad:
// student_profiles guarda la ficha en COLUMNAS SEPARADAS (initial_diagnosis,
// strong_points, …), no en un JSON. class_analyses usa `analyzed_at` como
// timestamp y NO tiene `teacher_name`.

export type AiStatus = 'ready' | 'skipped' | 'error';

export type RiskSignal = 'verde' | 'amarillo' | 'rojo';

/** Ficha inicial del alumno, tal como la devuelve la IA (camelCase). */
export interface FichaIA {
  initialDiagnosis: string;
  strongPoints: string;
  weakPoints: string;
  learningStyle: string;
  personalObjective: string;
  occupation: string;
  recommendedFocus: string;
  firstClassSuggestion: string;
}

/** Fila de student_profiles (snake_case = columnas reales). */
export interface StudentProfileRow {
  id: string;
  student_id: string | null;
  student_name: string | null;
  teacher_id: string | null;
  form_responses: Record<string, unknown> | string | null;
  form_completed_at: string | null;
  form_token_id: string | null;
  // Ficha (Sección A)
  initial_diagnosis: string | null;
  strong_points: string | null;
  weak_points: string | null;
  learning_style: string | null;
  personal_objective: string | null;
  occupation: string | null;
  recommended_focus: string | null;
  // Seguimiento (Sección B)
  current_level: string | null;
  current_block: string | null;
  grammar_focus: string | null;
  vocabulary_focus: string | null;
  risk_signal: string | null;
  risk_explanation: string | null;
  risk_updated_at: string | null;
  progress_score: number | null;
  total_classes_analyzed: number | null;
  last_class_analyzed_at: string | null;
  next_class_content: NextClassIA | string | null;
  next_class_generated_at: string | null;
  // Formato anterior (markdown) — se conserva para fichas viejas.
  ai_ficha: string | null;
  ai_status: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Convierte la respuesta de la IA a las columnas de student_profiles. */
export function fichaToColumns(f: FichaIA): Record<string, string> {
  return {
    initial_diagnosis:  f.initialDiagnosis,
    strong_points:      f.strongPoints,
    weak_points:        f.weakPoints,
    learning_style:     f.learningStyle,
    personal_objective: f.personalObjective,
    occupation:         f.occupation,
    recommended_focus:  f.recommendedFocus,
  };
}

/** Lee la ficha desde las columnas. Devuelve null si no hay nada guardado. */
export function fichaFromRow(r: Partial<StudentProfileRow> | null | undefined): FichaIA | null {
  if (!r) return null;
  const any =
    r.initial_diagnosis || r.strong_points || r.weak_points || r.learning_style ||
    r.personal_objective || r.occupation || r.recommended_focus;
  if (!any) return null;
  return {
    initialDiagnosis:     r.initial_diagnosis  ?? '',
    strongPoints:         r.strong_points      ?? '',
    weakPoints:           r.weak_points        ?? '',
    learningStyle:        r.learning_style     ?? '',
    personalObjective:    r.personal_objective ?? '',
    occupation:           r.occupation         ?? '',
    recommendedFocus:     r.recommended_focus  ?? '',
    firstClassSuggestion: '',   // no se persiste: la primera clase vive en next_class_content
  };
}

export interface NextClassGuide {
  priority: string;
  warmUp: string;
  mainFocus: string;
  activity: string;
  notes: string;
}

/** Análisis de una transcripción. */
export interface TranscriptIA {
  classTitle: string;
  classSummary: string;
  errorsDetected: string;
  progressNotes: string;
  topicsCovered: string;
  progressScore: number;      // 1-10
  riskSignal: RiskSignal;
  riskExplanation: string;
  nextClassGuide: NextClassGuide;
}

/** Fila de class_analyses (snake_case = columnas reales). */
export interface ClassAnalysisRow {
  id: string;
  student_id: string | null;
  teacher_id: string | null;
  student_name: string;
  class_number: number | null;
  transcript: string;          // NOT NULL en la base
  class_summary: string | null;
  errors_detected: string | null;
  progress_notes: string | null;
  topics_covered: string | null;
  next_class_guide: NextClassGuide | string | null;
  risk_signal: string | null;
  risk_explanation: string | null;
  analyzed_at: string;         // ← el timestamp se llama así, NO created_at
  class_date: string | null;
  class_title: string | null;
  next_class_content: NextClassIA | string | null;
}

/** Bloque de una clase generada (warm-up, contenido, práctica, cierre). */
export interface ClassBlock {
  title: string;
  duration: string;
  content: string;
}

/** Clase generada por la IA. Se guarda en next_class_content (jsonb). */
export interface NextClassIA {
  classNumber: number;
  classTitle: string;
  duration: string;
  objectives: string[];
  warmUp: ClassBlock;
  mainContent: ClassBlock;
  practiceActivity: ClassBlock;
  closing: ClassBlock;
  teacherNotes: string;
  connectionToPrevious: string;
}

export const RISK_META: Record<RiskSignal, { label: string; emoji: string; color: string; bg: string; border: string }> = {
  verde:    { label: 'En buen camino', emoji: '🟢', color: '#166534', bg: 'rgba(30,158,58,0.12)',  border: 'rgba(30,158,58,0.4)' },
  amarillo: { label: 'Atención',       emoji: '🟡', color: '#92400e', bg: 'rgba(255,196,0,0.16)',  border: 'rgba(255,196,0,0.5)' },
  rojo:     { label: 'Riesgo de baja', emoji: '🔴', color: '#991b1b', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.4)' },
};

export function isRiskSignal(v: unknown): v is RiskSignal {
  return v === 'verde' || v === 'amarillo' || v === 'rojo';
}

/** Las columnas jsonb pueden llegar como objeto o como string JSON. */
export function asObject<T>(v: T | string | null | undefined): T | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return null; }
  }
  return v;
}
