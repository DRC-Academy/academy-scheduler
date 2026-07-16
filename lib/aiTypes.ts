// Tipos del módulo de IA — SIN dependencias.
//
// Vive aparte a propósito: lib/analyzeForm, lib/firstClass y lib/analyzeTranscript
// importan el SDK de Anthropic (sólo servidor). Los componentes cliente importan
// los tipos desde acá para que el SDK no termine en el bundle del navegador.

export type AiStatus = 'ready' | 'skipped' | 'error';

export type RiskSignal = 'verde' | 'amarillo' | 'rojo';

/** Ficha inicial del alumno. Se guarda en student_profiles.ai_ficha_json. */
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

/** Primera clase generada. Se guarda en student_profiles.ai_first_class. */
export interface FirstClassIA {
  classTitle: string;
  duration: string;
  warmUp: string;
  mainContent: string;
  practiceActivity: string;
  closingTask: string;
  teacherNotes: string;
}

export interface NextClassGuide {
  priority: string;
  warmUp: string;
  mainFocus: string;
  activity: string;
  notes: string;
}

/** Análisis de una transcripción. Se guarda en class_analyses. */
export interface TranscriptIA {
  classSummary: string;
  errorsDetected: string;
  progressNotes: string;
  topicsCovered: string;
  riskSignal: RiskSignal;
  riskExplanation: string;
  nextClassGuide: NextClassGuide;
}

export const RISK_META: Record<RiskSignal, { label: string; emoji: string; color: string; bg: string; border: string }> = {
  verde:    { label: 'En buen camino', emoji: '🟢', color: '#166534', bg: 'rgba(30,158,58,0.12)',  border: 'rgba(30,158,58,0.4)' },
  amarillo: { label: 'Atención',       emoji: '🟡', color: '#92400e', bg: 'rgba(255,196,0,0.16)',  border: 'rgba(255,196,0,0.5)' },
  rojo:     { label: 'Riesgo de baja', emoji: '🔴', color: '#991b1b', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.4)' },
};

export function isRiskSignal(v: unknown): v is RiskSignal {
  return v === 'verde' || v === 'amarillo' || v === 'rojo';
}
