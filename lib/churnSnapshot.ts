// Captura una "foto" de churn de un alumno: reúne su historial reciente, calcula
// las señales deterministas (lib/churnSignals) + el análisis por IA (lib/analyzeChurn),
// combina en un riesgo y lo guarda en churn_snapshots. SOLO SERVIDOR.
//
// Reutilizado por:
//   · la BAJA MANUAL desde el panel (label 'churned') — la vía real en DRC: el
//     admin ve "cancelado" en WooSubscriptions y borra al alumno a mano.
//   · el webhook de cancelación de WooCommerce (label 'churned'), si algún día
//     se conecta.
//   · el escaneo de alumnos activos (label 'active') — la vigilancia temprana.
//   · el backfill de bajas antiguas (label 'churned', con asOfIso).

import { supabase } from '@/lib/supabase';
import { computeChurnSignals, type ChurnSignals } from '@/lib/churnSignals';
import { analyzeChurnTranscripts, type ChurnAiAnalysis } from '@/lib/analyzeChurn';

const WINDOW = 10;

export interface ChurnSnapshotResult {
  id: string;
  studentName: string;
  signals: ChurnSignals;
  ai: ChurnAiAnalysis | null;
  combinedRisk: number;
}

// Combina la heurística determinista con el riesgo de la IA. Sin IA, se usa solo
// la determinista (algo más conservadora). Es un placeholder hasta tener dataset.
function combineRisk(signals: ChurnSignals, ai: ChurnAiAnalysis | null): number {
  if (!ai) return signals.deterministicRisk;
  const base = Math.round(signals.deterministicRisk * 0.5 + ai.risk_score * 0.5);
  const bump = ai.explicit_quit ? 25 : 0;   // mención explícita de dejarlo pesa mucho
  return Math.max(0, Math.min(100, base + bump));
}

export async function captureChurnSnapshot(args: {
  studentId?: string | null;
  studentName: string;
  teacherId?: string | null;
  trigger: 'cancellation' | 'manual_dropout' | 'active_check' | 'manual';
  label: 'churned' | 'active';
  // Control de coste de la IA: 'always' (bajas y manual), 'gated' (escaneo: solo si
  // el riesgo determinista ya es apreciable), 'never'. Por defecto 'always'.
  aiMode?: 'always' | 'gated' | 'never';
  /**
   * Fecha a la que se refiere la foto. Por defecto ahora. El backfill de bajas
   * antiguas pasa la fecha REAL de la baja: sin esto, "días desde la última
   * clase" se mediría contra hoy y saldría inflado en cada baja recuperada.
   */
  asOfIso?: string;
}): Promise<ChurnSnapshotResult | null> {
  const studentName = args.studentName?.trim();
  if (!studentName) return null;
  const asOf = args.asOfIso || new Date().toISOString();

  // 1) Reunir el historial reciente. class_records/join_logs se filtran por nombre;
  //    los análisis por student_id si lo hay (más fiable) y por nombre si no.
  const [recRes, logRes, anaRes] = await Promise.all([
    supabase.from('class_records').select('student_name, class_date, class_type').ilike('student_name', studentName).order('class_date', { ascending: false }).limit(40),
    supabase.from('class_join_logs').select('student_name, scheduled_date, punctuality').ilike('student_name', studentName).order('scheduled_date', { ascending: false }).limit(40),
    (args.studentId
      ? supabase.from('class_analyses').select('student_name, class_date, analyzed_at, risk_signal, transcript').eq('student_id', args.studentId).order('analyzed_at', { ascending: false }).limit(WINDOW)
      : supabase.from('class_analyses').select('student_name, class_date, analyzed_at, risk_signal, transcript').ilike('student_name', studentName).order('analyzed_at', { ascending: false }).limit(WINDOW)),
  ]);

  const records  = (recRes.data ?? []) as Array<{ student_name: string; class_date: string | null; class_type: string | null }>;
  const logs     = (logRes.data ?? []) as Array<{ student_name: string; scheduled_date: string | null; punctuality?: string | null }>;
  const analyses = (anaRes.data ?? []) as Array<{ student_name: string; class_date?: string | null; analyzed_at?: string | null; risk_signal?: string | null; transcript?: string | null }>;

  // 2) Señales deterministas.
  const signals = computeChurnSignals({ studentName, records, logs, analyses, window: WINDOW, nowIso: asOf });

  // 3) Análisis por IA (best-effort) sobre las transcripciones disponibles.
  const aiMode = args.aiMode ?? 'always';
  const runAi = aiMode === 'always' || (aiMode === 'gated' && signals.deterministicRisk >= 25);
  let ai: ChurnAiAnalysis | null = null;
  if (runAi) {
    try {
      const res = await analyzeChurnTranscripts({
        studentName,
        transcripts: analyses.map(a => ({ date: a.class_date ?? a.analyzed_at ?? null, text: a.transcript ?? '' })),
      });
      ai = res.data;
    } catch (e) {
      console.error('[churnSnapshot] Análisis IA falló (no bloquea):', e);
    }
  }

  const combinedRisk = combineRisk(signals, ai);

  // 4) Guardar la foto (resiliente si la tabla aún no existe → PGRST205).
  const id = `chs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const row = {
    id,
    student_id:   args.studentId ?? null,
    student_name: studentName,
    teacher_id:   args.teacherId ?? null,
    captured_at:  asOf,
    trigger:      args.trigger,
    label:        args.label,
    classes_analyzed:      signals.classesAnalyzed,
    cancellations:         signals.cancellations,
    late_count:            signals.lateCount,
    risk_flags:            signals.riskFlags,
    days_since_last_class: signals.daysSinceLastClass,
    avg_speaking_pct:      signals.avgSpeakingPct,
    speaking_trend:        signals.speakingTrend,
    deterministic_risk:    signals.deterministicRisk,
    ai_risk_score:         ai?.risk_score ?? null,
    ai_participation:      ai?.participation ?? null,
    ai_explicit_quit:      ai?.explicit_quit ?? null,
    ai_reasoning:          ai?.reasoning ?? null,
    combined_risk:         combinedRisk,
    alerted:               false,
    signals:               signals as unknown as Record<string, unknown>,
    ai_raw:                (ai as unknown as Record<string, unknown>) ?? null,
  };
  const { error } = await supabase.from('churn_snapshots').insert(row);
  if (error) {
    console.error('[churnSnapshot] No se pudo guardar la foto de churn:', error.message);
    if (error.code === 'PGRST205') return null;   // tabla sin migrar
  }

  return { id, studentName, signals, ai, combinedRisk };
}

// Marca una foto como "ya alertada" (para no repetir el aviso al mismo alumno).
export async function markChurnAlerted(id: string): Promise<void> {
  await supabase.from('churn_snapshots').update({ alerted: true }).eq('id', id);
}
