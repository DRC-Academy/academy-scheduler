// Reevaluación de las redacciones que la IA NO pudo evaluar. SOLO SERVIDOR.
//
// Origen: del 14/09 al 16/09/2026 la cuenta de Anthropic se quedó sin saldo y 6
// pruebas de nivel cerraron con la redacción en 'ai_unavailable': nivel
// PROVISIONAL calculado solo con la lectura (y topado en B2 por la compuerta de
// C1/C2). El texto del alumno sí se guardó, así que se puede evaluar ahora.
//
// Lo lanza el admin con el botón "Reevaluar redacciones sin evaluar" de la
// pestaña Tests de nivel (app/api/admin/reevaluate-writing). Por cada redacción:
//   1. se pasa el texto guardado por la MISMA evaluación que en la prueba;
//   2. si la prueba está cerrada, se recalcula el nivel final con la MISMA regla
//      que el cierre normal (lib/levelTest/finalResult);
//   3. se actualizan la sesión y la ficha del alumno (solo si la ficha sigue
//      apuntando a ESTA prueba: una prueba más nueva no se pisa).
// AVISOS (decisión de Facundo, 25/09/2026):
//   · al ALUMNO nunca se le avisa: ni email ni nada;
//   · al PROFESOR, solo por la campanita y solo si el nivel cambia, con el nivel
//     anterior y el nuevo. Sin email. Si el nivel queda igual, nadie se entera.
// No se toca completed_at: la prueba se hizo cuando se hizo.

import 'server-only';

import { supabase } from '@/lib/supabase';
import { evaluateWriting } from '@/lib/evaluateWriting';
import { computeFinalResult, type FinalAnswerRow } from './finalResult';
import type { Cefr } from './types';

export interface ReevalItem {
  answerId: string;
  alumno: string;
  resultado: 'arreglada' | 'no_valida' | 'sigue_fallando';
  nivelAntes?: string | null;
  nivelDespues?: string | null;
  error?: string;
  profesorAvisado?: boolean;
}

interface PendingRow {
  id: string;
  session_id: string;
  question_id: string;
  written_response: string | null;
}

type Row = Record<string, unknown>;

/** Redacciones con la IA caída, de la más antigua a la más nueva. */
async function loadPending(): Promise<PendingRow[]> {
  const { data, error } = await supabase
    .from('level_test_answers')
    .select('id, session_id, question_id, written_response')
    .eq('section', 'writing').eq('invalid_reason', 'ai_unavailable')
    .order('answered_at', { ascending: true });
  if (error) {
    console.error('[reevaluate] No se pudieron leer las redacciones pendientes:', error);
    return [];
  }
  return (data ?? []) as PendingRow[];
}

export async function countPendingWritings(): Promise<number> {
  return (await loadPending()).length;
}

/** update con la columna ai_error; si todavía no existe (42703), sin ella. */
async function updateAnswer(id: string, base: Row, aiError: string | null) {
  const first = await supabase.from('level_test_answers').update({ ...base, ai_error: aiError }).eq('id', id);
  if (first.error?.code !== '42703') return first;
  return Object.keys(base).length ? supabase.from('level_test_answers').update(base).eq('id', id) : first;
}

async function updateProfile(sessionId: string, base: Row, extra: Row) {
  const first = await supabase.from('student_profiles').update({ ...base, ...extra }).eq('level_test_session_id', sessionId);
  if (first.error?.code !== '42703') return first;
  return supabase.from('student_profiles').update(base).eq('level_test_session_id', sessionId);
}

/**
 * Reevalúa como mucho `limit` redacciones pendientes, saltando las de `skip`
 * (las que ya fallaron en esta misma tanda, para no reintentarlas en bucle).
 */
export async function reevaluatePendingWritings(opts: { limit: number; skip: string[] }): Promise<{
  items: ReevalItem[]; remaining: number;
}> {
  const skip = new Set(opts.skip);
  const pending = (await loadPending()).filter(p => !skip.has(p.id));
  const batch = pending.slice(0, opts.limit);
  const items: ReevalItem[] = [];
  for (const row of batch) items.push(await reevaluateOne(row));
  return { items, remaining: pending.length - batch.length };
}

async function reevaluateOne(row: PendingRow): Promise<ReevalItem> {
  const { data: s } = await supabase.from('level_test_sessions').select('*').eq('id', row.session_id).maybeSingle();
  const alumno = (s?.student_name || s?.candidate_name || '(sin nombre)') as string;
  const base: ReevalItem = { answerId: row.id, alumno, resultado: 'sigue_fallando' };

  const written = (row.written_response || '').trim();
  if (!s || !written) return { ...base, error: !s ? 'La sesión de la prueba ya no existe.' : 'La redacción está vacía.' };

  const { data: q } = await supabase
    .from('level_test_questions').select('writing_prompt, cefr_level').eq('id', row.question_id).maybeSingle();

  // ── 1. La evaluación, igual que en la prueba ───────────────────────────────
  let res: Awaited<ReturnType<typeof evaluateWriting>>;
  try {
    res = await evaluateWriting({
      cefrLevel: (q?.cefr_level ?? 'B1') as Cefr,
      writingPrompt: q?.writing_prompt || '',
      writtenResponse: written,
    });
  } catch (err) {
    res = { data: null, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }

  if (!res.data) {
    const msg = res.error ?? 'La IA no respondió.';
    await updateAnswer(row.id, {}, msg);
    return { ...base, error: msg };
  }

  const valid = res.data.is_valid_attempt;
  const { error: ansErr } = await updateAnswer(row.id, {
    ai_score: valid ? res.data.score : null,
    ai_feedback: res.data,
    invalid_reason: valid ? null : 'ai_invalid',
  }, null);
  if (ansErr) return { ...base, error: `No se pudo guardar la evaluación: ${ansErr.message}` };

  const resultado: ReevalItem['resultado'] = valid ? 'arreglada' : 'no_valida';
  const sessionWriting = { writing_valid: valid, writing_invalid_reason: valid ? null : 'ai_invalid' };

  // Prueba sin cerrar: basta con dejar la respuesta evaluada; el nivel lo
  // calculará el cierre normal cuando el alumno la termine.
  if (s.status !== 'completed') {
    await supabase.from('level_test_sessions').update(sessionWriting).eq('id', s.id);
    return { ...base, resultado };
  }

  // ── 2. Nivel final, con la misma regla que el cierre ───────────────────────
  const { data: answers } = await supabase
    .from('level_test_answers')
    .select('section, difficulty, is_correct, ai_score, ai_feedback, invalid_reason')
    .eq('session_id', s.id).order('answered_at', { ascending: true });
  const r = computeFinalResult((answers ?? []) as FinalAnswerRow[]);
  const nivelAntes = (s.cefr_level ?? null) as string | null;

  const { error: sesErr } = await supabase.from('level_test_sessions').update({
    reading_score: r.readingScore,
    writing_score: r.writingScore,
    overall_score: r.overall,
    cefr_level: r.cefr,
    ai_evaluation: r.aiEvaluation,
    ...sessionWriting,
  }).eq('id', s.id);
  if (sesErr) return { ...base, resultado, error: `Evaluada, pero no se pudo actualizar la prueba: ${sesErr.message}` };

  // ── 3. Ficha del alumno (solo la que apunta a esta prueba) ─────────────────
  const { error: profErr } = await updateProfile(s.id, {
    level_test_cefr: r.cefr,
    level_test_score: r.overall,
    level_test_evaluation: r.aiEvaluation,
    updated_at: new Date().toISOString(),
  }, {
    level_test_provisional: r.provisional,
    level_test_provisional_reason: r.provisionalReason,
  });
  if (profErr) console.error(`[reevaluate] ${alumno}: no se pudo actualizar la ficha:`, profErr);

  // ── Aviso al profesor: campanita, solo si el nivel cambió ──────────────────
  let profesorAvisado = false;
  if (s.teacher_id && nivelAntes !== r.cefr) {
    const { error: notifErr } = await supabase.from('notifications').insert({
      id:          `notif_leveltest_reeval_${row.id}`,
      target_user: s.teacher_id,
      target_role: null,
      title:       `📝 Nivel actualizado: ${alumno}`,
      body:        `La redacción de su prueba de nivel no se pudo evaluar en su día (fallo de la IA) y se ha evaluado ahora. ` +
                   `Nivel anterior: ${nivelAntes ?? 'sin nivel'} (provisional). Nivel nuevo: ${r.cefr}${r.provisional ? ' (sigue siendo provisional)' : ''}. ` +
                   'Lo ves en la ficha del alumno. Al alumno no se le ha enviado ningún aviso.',
      type:        'level_test_reevaluated',
      read_by:     [],
      created_at:  new Date().toISOString(),
      created_by:  'test-nivel',
    });
    if (notifErr) console.error(`[reevaluate] ${alumno}: no se pudo avisar al profesor:`, notifErr);
    profesorAvisado = !notifErr;
  }

  return { ...base, resultado, nivelAntes, nivelDespues: r.cefr, profesorAvisado };
}
