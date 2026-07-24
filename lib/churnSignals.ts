// Señales de riesgo de baja (churn) — parte DETERMINISTA y PURA.
//
// A partir del historial reciente de un alumno (clases registradas, ingresos y
// transcripciones) calcula señales objetivas que, combinadas con el análisis por
// IA, alimentan la predicción de bajas. NO toca base ni red: es testeable.
//
// Contexto: el sistema arranca a RECOPILAR desde hoy. Con la muestra actual (pocas
// bajas) la predicción no es fiable; el valor está en registrar estas señales en
// cada baja real para tener dataset en ~3 meses.

export interface ChurnRecordLite { student_name: string; class_date: string | null; class_type: string | null; }
export interface ChurnJoinLite   { student_name: string; scheduled_date: string | null; punctuality?: string | null; }
export interface ChurnAnalysisLite { student_name: string; class_date?: string | null; analyzed_at?: string | null; risk_signal?: string | null; transcript?: string | null; }

// Tipos de clase que cuentan como "cancelación/ausencia" (señal de desenganche).
const CANCEL_TYPES = new Set([
  'falta_sin_aviso', 'cancelacion_hora', 'falta_con_aviso', 'reprogramada', 'cancelada_con_preaviso',
]);

export interface ChurnSignals {
  window: number;              // tamaño de la ventana pedida (p. ej. 10)
  classesAnalyzed: number;     // clases realmente encontradas en la ventana
  cancellations: number;       // cancelaciones/ausencias recientes
  lateCount: number;           // ingresos con retraso (late / very_late)
  riskFlags: number;           // análisis con señal amarillo/rojo en la ventana
  daysSinceLastClass: number | null;
  avgSpeakingPct: number | null;   // % medio de habla del alumno (de los transcripts)
  speakingTrend: 'up' | 'stable' | 'down' | 'unknown';
  speakingByClass: number[];       // % por clase (recientes → antiguas), para el dataset
  deterministicRisk: number;       // 0-100, heurística SOLO con señales objetivas
}

const nkey = (s: string) => (s ?? '').trim().toLowerCase();
const firstName = (s: string) => nkey(s).split(/\s+/)[0] ?? '';

function sameStudent(a: string, b: string): boolean {
  const na = nkey(a), nb = nkey(b);
  if (!na || !nb) return false;
  return na === nb || firstName(a) === firstName(b) || na.startsWith(nb) || nb.startsWith(na);
}

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso.slice(0, 10) + 'T00:00:00').getTime();
  const b = new Date(bIso.slice(0, 10) + 'T00:00:00').getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

// % de habla del alumno en un transcript con etiquetas "Nombre:". Cuenta palabras
// de las líneas del alumno vs. el total de líneas etiquetadas. null si no se puede.
export function speakingPctOf(transcript: string | null | undefined, studentName: string): number | null {
  if (!transcript) return null;
  const target = firstName(studentName);
  if (!target) return null;
  const lineRe = /^\s*([\p{L}][\p{L}.'-]*(?:\s[\p{L}.'-]+){0,3})\s*:\s*(.*)$/u;
  let studentWords = 0, totalWords = 0, labeled = 0;
  for (const line of transcript.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (!m) continue;
    labeled++;
    const speaker = firstName(m[1]);
    const words = m[2].trim() ? m[2].trim().split(/\s+/).length : 0;
    totalWords += words;
    if (speaker === target || m[1].trim().toLowerCase().includes(target)) studentWords += words;
  }
  if (labeled < 4 || totalWords === 0) return null;   // muy poco etiquetado → no fiable
  return Math.round((studentWords / totalWords) * 100);
}

export function computeChurnSignals(input: {
  studentName: string;
  records: ChurnRecordLite[];
  logs: ChurnJoinLite[];
  analyses: ChurnAnalysisLite[];
  window?: number;
  nowIso?: string;
}): ChurnSignals {
  const window = input.window ?? 10;
  const now = input.nowIso ?? new Date().toISOString();

  // Clases recientes por fecha (records = la fuente de "clases dadas/ausencias").
  const myRecords = input.records
    .filter(r => sameStudent(r.student_name, input.studentName))
    .sort((a, b) => (b.class_date ?? '').localeCompare(a.class_date ?? ''))
    .slice(0, window);
  const myLogs = input.logs
    .filter(l => sameStudent(l.student_name, input.studentName))
    .sort((a, b) => (b.scheduled_date ?? '').localeCompare(a.scheduled_date ?? ''))
    .slice(0, window);
  const myAnalyses = input.analyses
    .filter(a => sameStudent(a.student_name, input.studentName))
    .sort((a, b) => (b.class_date ?? b.analyzed_at ?? '').localeCompare(a.class_date ?? a.analyzed_at ?? ''))
    .slice(0, window);

  const cancellations = myRecords.filter(r => CANCEL_TYPES.has(r.class_type ?? '')).length;
  const lateCount = myLogs.filter(l => l.punctuality === 'late' || l.punctuality === 'very_late').length;
  const riskFlags = myAnalyses.filter(a => a.risk_signal === 'amarillo' || a.risk_signal === 'rojo').length;

  // Días desde la última actividad conocida.
  const lastDates = [
    ...myRecords.map(r => r.class_date),
    ...myLogs.map(l => l.scheduled_date),
    ...myAnalyses.map(a => a.class_date ?? a.analyzed_at ?? null),
  ].filter(Boolean) as string[];
  const lastIso = lastDates.sort().at(-1) ?? null;
  const daysSinceLastClass = lastIso ? Math.max(0, daysBetween(lastIso, now)) : null;

  // % de habla por clase (recientes → antiguas) y tendencia.
  const speakingByClass = myAnalyses
    .map(a => speakingPctOf(a.transcript, input.studentName))
    .filter((n): n is number => n != null);
  const avgSpeakingPct = speakingByClass.length
    ? Math.round(speakingByClass.reduce((s, n) => s + n, 0) / speakingByClass.length)
    : null;
  let speakingTrend: ChurnSignals['speakingTrend'] = 'unknown';
  if (speakingByClass.length >= 3) {
    const half = Math.floor(speakingByClass.length / 2);
    const recent = speakingByClass.slice(0, half);        // más nuevas
    const older = speakingByClass.slice(half);            // más viejas
    const avg = (xs: number[]) => xs.reduce((s, n) => s + n, 0) / xs.length;
    const diff = avg(recent) - avg(older);
    speakingTrend = diff <= -8 ? 'down' : diff >= 8 ? 'up' : 'stable';
  }

  // Heurística determinista (0-100). Placeholder conservador hasta tener dataset:
  // pondera lo objetivo; la IA aporta lo semántico por separado.
  const deterministicRisk = Math.max(0, Math.min(100, Math.round(
    cancellations * 12 +
    lateCount * 6 +
    riskFlags * 12 +
    (speakingTrend === 'down' ? 15 : 0) +
    (daysSinceLastClass != null && daysSinceLastClass > 14 ? 15 : 0)
  )));

  return {
    window,
    classesAnalyzed: Math.max(myRecords.length, myLogs.length, myAnalyses.length),
    cancellations, lateCount, riskFlags, daysSinceLastClass,
    avgSpeakingPct, speakingTrend, speakingByClass, deterministicRisk,
  };
}
