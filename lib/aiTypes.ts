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

// ── Sistema de avatares (metodología de enseñanza) ────────────────────────────
// Un avatar = Dominio × Nivel × Tipo de clase. Define el balance de secuencia
// (input → práctica guiada → producción) que el material debe respetar.
export type AvatarDomain = 'social' | 'laboral' | 'educacional';
export type ClassType    = 'metodologia_aplicada' | 'conversacion_guiada';
export type CEFRLevel    = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

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
  // Avatar + diagnóstico operativo (metodología):
  domain: AvatarDomain;      // dominio inferido del contexto del alumno
  priorities: string[];      // puntos a trabajar, ordenados de más a menos importante
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
  next_class_content: GeneratedClassIA | string | null;
  next_class_generated_at: string | null;
  // Test de Nivel (se refleja acá al completarse, ver app/api/level-test/.../submit)
  level_test_cefr: string | null;
  level_test_score: number | null;
  level_test_completed_at: string | null;
  level_test_evaluation: Record<string, unknown> | null;
  level_test_session_id: string | null;
  // Formato anterior (markdown) — se conserva para fichas viejas.
  ai_ficha: string | null;
  ai_status: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// Extras de la ficha que no tienen columna propia (dominio, prioridades,
// sugerencia de primera clase). Se serializan como JSON en la columna `ai_ficha`
// (que antes guardaba markdown legacy), para no tocar el esquema de Supabase.
interface FichaExtras {
  domain?: AvatarDomain;
  priorities?: string[];
  firstClassSuggestion?: string;
}

function parseFichaExtras(aiFicha: string | null | undefined): FichaExtras {
  if (!aiFicha) return {};
  try {
    const v = JSON.parse(aiFicha);
    return v && typeof v === 'object' ? (v as FichaExtras) : {};
  } catch {
    return {};   // fichas viejas: ai_ficha era markdown, no JSON
  }
}

const VALID_DOMAINS: AvatarDomain[] = ['social', 'laboral', 'educacional'];
function coerceDomain(v: unknown): AvatarDomain {
  return VALID_DOMAINS.includes(v as AvatarDomain) ? (v as AvatarDomain) : 'social';
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
    // Dominio + prioridades + primera clase → JSON en ai_ficha (sin columna propia).
    ai_ficha: JSON.stringify({
      domain:               f.domain,
      priorities:           f.priorities ?? [],
      firstClassSuggestion: f.firstClassSuggestion,
    } satisfies FichaExtras),
  };
}

/** Lee la ficha desde las columnas. Devuelve null si no hay nada guardado. */
export function fichaFromRow(r: Partial<StudentProfileRow> | null | undefined): FichaIA | null {
  if (!r) return null;
  const any =
    r.initial_diagnosis || r.strong_points || r.weak_points || r.learning_style ||
    r.personal_objective || r.occupation || r.recommended_focus;
  if (!any) return null;
  const extras = parseFichaExtras(r.ai_ficha);
  return {
    initialDiagnosis:     r.initial_diagnosis  ?? '',
    strongPoints:         r.strong_points      ?? '',
    weakPoints:           r.weak_points        ?? '',
    learningStyle:        r.learning_style     ?? '',
    personalObjective:    r.personal_objective ?? '',
    occupation:           r.occupation         ?? '',
    recommendedFocus:     r.recommended_focus  ?? '',
    firstClassSuggestion: extras.firstClassSuggestion ?? '',   // la primera clase vive en next_class_content
    domain:               coerceDomain(extras.domain),
    priorities:           Array.isArray(extras.priorities) ? extras.priorities : [],
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
  next_class_content: GeneratedClassIA | string | null;
  /** Ingreso ("Ingresar a clase") al que pertenece esta clase, si se registró así. */
  join_log_id?: string | null;
  /** 'ok' | 'review' | 'approved' | 'rejected' — validación del transcript. */
  validation_status?: string | null;
  /** 'ready' | 'pending' | 'failed' — estado del informe de IA (puede reintentarse). */
  analysis_status?: string | null;
  analysis_error?: string | null;
}

/** ¿El informe de IA de esta clase quedó a medias? (transcript guardado, informe no) */
export function needsAnalysis(r: ClassAnalysisRow): boolean {
  if (r.analysis_status === 'ready') return false;
  if (r.analysis_status === 'pending' || r.analysis_status === 'failed') return true;
  // Base sin migrar (sin analysis_status): se deduce del contenido.
  return !(r.class_summary ?? '').trim();
}

/** Bloque de una clase generada (warm-up, contenido, práctica, cierre). */
export interface ClassBlock {
  title: string;
  duration: string;
  content: string;
}

/**
 * Clase generada por la IA en modo METODOLOGÍA APLICADA (fases visibles:
 * input → práctica guiada → producción). Se guarda en next_class_content (jsonb).
 * `classType` puede faltar en clases viejas → se asume 'metodologia_aplicada'.
 */
export interface NextClassIA {
  classType?: 'metodologia_aplicada';
  classNumber: number;
  classTitle: string;
  duration: string;
  objectives: string[];
  warmUp: ClassBlock;
  mainContent: ClassBlock;
  practiceActivity: ClassBlock;
  closing: ClassBlock;
  challenge?: string;        // desafío para llevarse: tarea real antes de la próxima clase
  teacherNotes: string;
  connectionToPrevious: string;
}

/**
 * Clase generada en modo CONVERSACIÓN GUIADA (B1+). No tiene fases input/
 * práctica/producción: es charla continua guiada por el tópico del alumno, con
 * una habilidad preparada de antemano (tomada de las prioridades del diagnóstico).
 */
export interface ConversacionGuiadaIA {
  classType: 'conversacion_guiada';
  classNumber: number;
  classTitle: string;
  duration: string;
  skillObjective: string;        // la habilidad preparada que se sostiene pase lo que pase
  priorityAddressed: string;     // qué prioridad del diagnóstico trabaja esta clase
  suggestedOpeners: string[];    // aperturas de tópico (el alumno define el tema final)
  guidingQuestions: string[];    // preguntas dirigidas para sostener y profundizar la charla
  correctionFocus: string;       // qué errores/patrones corregir en vivo, sin cortar el flujo
  challenge?: string;            // desafío para llevarse: tarea real antes de la próxima clase
  teacherNotes: string;
  connectionToPrevious: string;
}

/** Cualquier clase generada, en cualquiera de los dos modos. */
export type GeneratedClassIA = NextClassIA | ConversacionGuiadaIA;

/** True si la clase es del modo conversación guiada. */
export function isConversacionGuiada(c: GeneratedClassIA | null | undefined): c is ConversacionGuiadaIA {
  return !!c && (c as ConversacionGuiadaIA).classType === 'conversacion_guiada';
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
