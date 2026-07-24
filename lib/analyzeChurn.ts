// Análisis por IA del riesgo de baja (churn) — SOLO SERVIDOR. Best-effort.
// Lee las últimas transcripciones del alumno y detecta señales SEMÁNTICAS que no
// se ven en los números: menos participación, menciones de dejarlo, desmotivación.
// Modelo: claude-haiku-4-5 (barato; el volumen puede ser alto en el escaneo).

import { askClaudeJson } from '@/lib/anthropic';

export interface ChurnAiAnalysis {
  risk_score: number;                 // 0-100 riesgo de baja
  participation: 'high' | 'medium' | 'low' | 'unknown';
  speaking_trend: 'up' | 'stable' | 'down' | 'unknown';
  explicit_quit: boolean;             // ¿menciona explícitamente dejarlo?
  quit_evidence: string[];            // citas textuales si las hay
  signals: string[];                  // señales de desenganche detectadas
  reasoning: string;                  // 1-2 frases en español
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['risk_score', 'participation', 'speaking_trend', 'explicit_quit', 'quit_evidence', 'signals', 'reasoning'],
  properties: {
    risk_score:     { type: 'integer', description: '0-100' },
    participation:  { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
    speaking_trend: { type: 'string', enum: ['up', 'stable', 'down', 'unknown'] },
    explicit_quit:  { type: 'boolean' },
    quit_evidence:  { type: 'array', items: { type: 'string' } },
    signals:        { type: 'array', items: { type: 'string' } },
    reasoning:      { type: 'string' },
  },
} as const;

const SYSTEM = `Eres un analista de retención de una academia de inglés online. A partir de las últimas clases de un alumno (transcripciones, de más reciente a más antigua), estimas su riesgo de darse de baja.

Busca señales de DESENGANCHE:
- Menor participación: respuestas más cortas, monosílabos, silencios, el profesor habla cada vez más y el alumno menos.
- Caída del porcentaje de habla del alumno a lo largo de las clases.
- Menciones EXPLÍCITAS o implícitas de dejarlo, pausar, "no tengo tiempo", "quizás lo deje", "me está costando mucho", falta de motivación, frustración recurrente.
- Cancelaciones o retrasos mencionados, excusas repetidas.
- Tono general: desmotivación, apatía, quejas.

Sé prudente: con pocas clases o sin señales claras, riesgo bajo y participation 'unknown'. Devuelve SOLO el JSON del esquema, en español.`;

export async function analyzeChurnTranscripts(args: {
  studentName: string;
  transcripts: Array<{ date: string | null; text: string }>;   // recientes → antiguas
}): Promise<{ data: ChurnAiAnalysis | null; status: 'ready' | 'skipped' | 'error' }> {
  const usable = args.transcripts.filter(t => t.text && t.text.trim().length > 40).slice(0, 10);
  if (usable.length === 0) return { data: null, status: 'skipped' };

  const blocks = usable
    .map((t, i) => `--- Clase ${i + 1}${t.date ? ` (${t.date})` : ''} ---\n${t.text.slice(0, 1800)}`)
    .join('\n\n');

  const prompt = `Alumno: ${args.studentName}. Estas son sus últimas ${usable.length} clases (de más reciente a más antigua). Analiza el riesgo de baja:\n\n${blocks}`;

  const res = await askClaudeJson<ChurnAiAnalysis>({
    model: 'claude-haiku-4-5',
    system: SYSTEM,
    prompt,
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 900,
    label: 'churn-analysis',
  });
  return { data: res.data, status: res.status };
}
