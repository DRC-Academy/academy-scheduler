// Tipos del Test de Nivel. Los payloads de la API pasan las columnas de la base
// tal cual (snake_case) para minimizar mapeos; el UI las consume así.

export type LTSection = 'reading_completion' | 'reading_passage' | 'reading_email' | 'writing';
export type Cefr = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
// Dónde cae un texto dentro de su banda MCER (ver constants.cefrToScore).
export type CefrPosition = 'low' | 'mid' | 'high';

// Pregunta como la recibe el cliente (Reading SIN `correct_answer`).
export interface LTQuestionPublic {
  id: string;
  section: LTSection;
  cefr_level: Cefr;
  difficulty: number;
  prompt_text: string | null;      // pasaje/email (passage/email)
  question_text: string | null;    // la pregunta (reading)
  options: string[] | null;        // reading
  writing_prompt: string | null;   // writing
  writing_min_words: number | null;// writing
}

export interface LTProgress {
  section: LTSection;
  sectionIndex: number;  // 0-based dentro de SECTION_ORDER
  sectionTotal: number;  // cantidad de secciones
  answeredInSection: number;
  totalInSection: number;
  answeredTotal: number;
  grandTotal: number;
  done: boolean;         // no quedan preguntas → listo para submit
}

// Forma mínima para el scoring.
export interface LTAnswerLite {
  section: LTSection;
  difficulty: number;
  is_correct: boolean | null;
  ai_score: number | null;
}

export interface WritingScoreFeedback { score: number; feedback: string }

export interface WritingEvaluation {
  score: number;                 // 0–100 en escala ABSOLUTA; lo deriva el código con cefrToScore(cefr_level, within_level)
  cefr_level: Cefr;              // nivel que demuestra el texto EN SÍ, no "cuánto cumplió la consigna"
  within_level: CefrPosition;    // posición dentro de la banda
  evidence: string;              // justificación en inglés (uso interno)
  grammar: WritingScoreFeedback;
  vocabulary: WritingScoreFeedback;
  coherence: WritingScoreFeedback;
  task_completion: WritingScoreFeedback;
  overall_feedback: string;
  strengths: string[];
  areas_for_improvement: string[];
}

export interface LTResult {
  reading_score: number;
  writing_score: number;
  overall_score: number;
  cefr_level: Cefr;
  ai_evaluation: WritingEvaluation | null;
}
