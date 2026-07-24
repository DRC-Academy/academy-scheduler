// CAPA 2 — Verificación cruzada del transcript (Bloque 1). SOLO SERVIDOR.
// Compara el transcript contra otras fuentes de verdad del sistema:
//   A) ¿Hubo acceso por "Ingresar a clase"? (class_join_logs)
//   B) ¿La duración según el último timestamp es coherente?
//   C) ¿Se subió dentro de una ventana razonable (≤7 días)?
//   D) ¿Es demasiado parecido a otras transcripciones recientes del profesor?
//
// Devuelve flags (mismos slugs que la capa 1) + datos para el panel del admin.

import { supabase } from '@/lib/supabase';

export interface CrossCheckInput {
  teacherId: string;
  studentName: string;
  classDate: string;              // 'YYYY-MM-DD'
  transcript: string;
  durationMinutes?: number;
  lastTimestampMinutes: number | null;
  uploadedAtIso?: string;         // por defecto, ahora
  /** id de la fila actual (al reemplazar) para excluirla de la comparación. */
  excludeId?: string | null;
}

export interface SimilarMatch {
  id: string;
  studentName: string;
  classDate: string | null;
  similarityPct: number;
}

export interface CrossCheckResult {
  flags: string[];
  hasAccess: boolean;
  estimatedDurationMin: number | null;
  daysLate: number;
  similarityPct: number;          // máxima similitud hallada (0-100)
  similarMatch: SimilarMatch | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const nkey = (s: string) => (s ?? '').trim().toLowerCase();

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso.slice(0, 10) + 'T00:00:00').getTime();
  const b = new Date(bIso.slice(0, 10) + 'T00:00:00').getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

// Normaliza a tokens (minúsculas, sin puntuación) para comparar contenido.
function tokenize(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Conjunto de "shingles" de 8 palabras.
function shingles(tokens: string[], n = 8): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) {
    set.add(tokens.slice(i, i + n).join(' '));
  }
  return set;
}

// % de frases de 8 palabras del texto NUEVO que también aparecen en el OTRO.
export function shingleSimilarity(a: string, b: string): number {
  const sa = shingles(tokenize(a));
  const sb = shingles(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const s of sa) if (sb.has(s)) common++;
  return (common / sa.size) * 100;
}

export async function runTranscriptCrossChecks(input: CrossCheckInput): Promise<CrossCheckResult> {
  const flags: string[] = [];
  const durationMinutes = input.durationMinutes ?? 60;
  const uploadedAt = input.uploadedAtIso ?? new Date().toISOString();

  // ── A) Existencia del acceso (class_join_logs, tolerancia ±1 día) ──
  let hasAccess = false;
  try {
    const { data } = await supabase
      .from('class_join_logs')
      .select('student_name, scheduled_date')
      .eq('teacher_id', input.teacherId);
    hasAccess = (data ?? []).some(l =>
      nkey(l.student_name) === nkey(input.studentName) &&
      Math.abs(daysBetween(l.scheduled_date, input.classDate)) <= 1);
  } catch (e) {
    console.error('[crossCheck] Error al leer class_join_logs:', e);
  }
  if (!hasAccess) flags.push('sin_acceso_registrado');

  // ── B) Coherencia de duración (solo si hay timestamps) ──
  const estimatedDurationMin = input.lastTimestampMinutes;
  if (estimatedDurationMin != null) {
    const minExpected = durationMinutes >= 60 ? 20 : 10;
    if (estimatedDurationMin < minExpected) flags.push('duracion_insuficiente');
  }

  // ── C) Ventana temporal (>7 días de retraso) ──
  const daysLate = daysBetween(input.classDate, uploadedAt);
  if (daysLate > 7) flags.push('registro_tardio');

  // ── D) Similitud con las últimas 5 transcripciones del profesor ──
  let similarityPct = 0;
  let similarMatch: SimilarMatch | null = null;
  try {
    const { data } = await supabase
      .from('class_analyses')
      .select('id, student_name, class_date, transcript, analyzed_at')
      .eq('teacher_id', input.teacherId)
      .order('analyzed_at', { ascending: false })
      .limit(6); // 5 + posible fila actual que luego excluimos
    const prev = (data ?? []).filter(r => r.id !== input.excludeId).slice(0, 5);
    for (const r of prev) {
      if (!r.transcript) continue;
      const sim = shingleSimilarity(input.transcript, r.transcript);
      if (sim > similarityPct) {
        similarityPct = sim;
        similarMatch = { id: r.id, studentName: r.student_name, classDate: r.class_date, similarityPct: Math.round(sim) };
      }
    }
  } catch (e) {
    console.error('[crossCheck] Error al comparar similitud:', e);
  }
  if (similarityPct > 35) flags.push('alta_similitud');

  return {
    flags,
    hasAccess,
    estimatedDurationMin,
    daysLate,
    similarityPct: Math.round(similarityPct),
    similarMatch,
  };
}
