// Testimoniales — lectura del transcript, análisis de fluidez y guardado en
// `transcript_fluency` (supabase-testimoniales.sql). SOLO SERVIDOR.
//
// Se lanza con `after()` desde el guardado del transcript, en una función de
// Vercel distinta de la del análisis de riesgo con Opus. Todo es best-effort:
// pase lo que pase aquí, la clase ya está guardada y el informe de riesgo sigue
// su camino. Un fallo de la IA deja la fila en 'failed' para reintentar
// (scripts/fluidez.mts --reintentar).
//
// El NÚMERO DE CLASE del alumno no se escribe aquí: lo calcula la vista
// transcript_fluency_numbered a partir de `student_key` y la fecha de la clase.

import 'server-only';

import { supabase } from '@/lib/supabase';
import { normName } from '@/lib/retention';
import { prepareFluency, formatTurnsForAi, excerptFound, type FluencyPrep } from '@/lib/fluency';
import { analyzeFluency, FLUENCY_MODEL, type FluencyIA } from '@/lib/analyzeFluency';

type Row = Record<string, unknown>;

export type FluencyRunStatus = 'ready' | 'skipped' | 'failed' | 'missing' | 'no_table';

export interface FluencyRunResult {
  analysisId: string;
  status: FluencyRunStatus;
  /** La fila tal como se guardó (o se guardaría, en dryRun). */
  row?: Row;
  prep?: FluencyPrep;
  ai?: FluencyIA | null;
  error?: string;
  /** Agrupación del alumno, la misma que la vista (student_id de la clase o student_key). */
  studentGroup?: string;
}

/** La tabla aún no existe (SQL sin correr): se salta sin romper nada. */
function isMissingTable(err: { code?: string } | null | undefined): boolean {
  return err?.code === '42P01' || err?.code === 'PGRST205';
}

// ── Agrupación del alumno ─────────────────────────────────────────────────────

let studentsCache: { at: number; list: Array<{ id: string; name: string }> } | null = null;

async function studentsByName(): Promise<Array<{ id: string; name: string }>> {
  if (studentsCache && Date.now() - studentsCache.at < 5 * 60_000) return studentsCache.list;
  const { data, error } = await supabase.from('students').select('id, name');
  if (error) {
    console.warn('[fluency] No se pudo leer students para emparejar por nombre:', error.message);
    return [];
  }
  const list = (data ?? []).map((s: Row) => ({ id: String(s.id), name: String(s.name ?? '') }));
  studentsCache = { at: Date.now(), list };
  return list;
}

/**
 * Clave que agrupa los transcripts de un alumno: su id, o, si la clase no lo
 * trae (14% en sep/2026), el id del ÚNICO alumno con ese nombre normalizado
 * (sin acentos, espacios ni mayúsculas). Si no hay uno solo, 'name:<nombre>'.
 */
export async function resolveStudentKey(studentId: string | null, studentName: string | null): Promise<string> {
  if (studentId) return studentId;
  const key = normName(studentName);
  const matches = (await studentsByName()).filter(s => normName(s.name) === key);
  return matches.length === 1 ? matches[0].id : `name:${key}`;
}

// ── El análisis de una clase ─────────────────────────────────────────────────

const EMPTY_RESULT: Row = {
  skip_reason: null,
  fluency_score: null, unscorable_reason: null, student_talk_share: null,
  hesitation_level: null, spanish_usage: null, fluency_evidence: null,
  best_excerpt: null, best_excerpt_at: null, best_excerpt_found: null,
  worst_excerpt: null, worst_excerpt_at: null, worst_excerpt_found: null,
  last_error: null,
};

const clampShare = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
const orNull = (s: unknown): string | null => (typeof s === 'string' && s.trim() ? s.trim() : null);

/**
 * Analiza (o descarta) un transcript y guarda el resultado. Con `dryRun` no
 * escribe nada: devuelve lo que guardaría (sí llama a la IA si no se descarta).
 */
export async function runFluencyFor(
  analysisId: string, opts: { dryRun?: boolean } = {},
): Promise<FluencyRunResult> {
  const prev = await supabase.from('transcript_fluency').select('attempts').eq('analysis_id', analysisId).maybeSingle();
  if (isMissingTable(prev.error)) {
    console.warn('[fluency] Falta la tabla transcript_fluency (supabase-testimoniales.sql): se salta.');
    return { analysisId, status: 'no_table' };
  }

  // Lectura de UNA fila con su transcript: nunca en listados (ver has_transcript).
  const { data: ca, error: caErr } = await supabase
    .from('class_analyses')
    .select('id, transcript, student_id, student_name, teacher_id')
    .eq('id', analysisId)
    .maybeSingle();
  if (caErr || !ca) return { analysisId, status: 'missing', error: caErr?.message ?? 'No existe la clase.' };

  let teacherName: string | null = null;
  if (ca.teacher_id) {
    const { data: t } = await supabase.from('teachers').select('name').eq('id', ca.teacher_id).maybeSingle();
    teacherName = (t?.name as string | undefined) ?? null;
  }

  const studentName = String(ca.student_name ?? '');
  const prep = prepareFluency(String(ca.transcript ?? ''), { teacherName, studentName });
  const now = new Date().toISOString();
  const attempts = Number(prev.data?.attempts ?? 0);

  const row: Row = {
    analysis_id:     analysisId,
    student_key:     await resolveStudentKey((ca.student_id as string | null) ?? null, studentName),
    word_count:      prep.wordCount,
    speaker_count:   prep.speakers.length,
    teacher_speaker: prep.teacherSpeaker,
    student_speaker: prep.studentSpeaker,
    fathom_url:      prep.fathomUrl,
    ...EMPTY_RESULT,
    updated_at:      now,
  };

  let status: FluencyRunStatus;
  let ai: FluencyIA | null = null;
  let error: string | undefined;

  if (prep.skip) {
    status = 'skipped';
    Object.assign(row, { status, skip_reason: prep.skip, analyzed_at: now });
  } else {
    // 'pending' ANTES de llamar a la IA: si Vercel corta la función a mitad de
    // la llamada, la fila queda marcada para reintentar en vez de no existir.
    if (!opts.dryRun) {
      await supabase.from('transcript_fluency').upsert({ ...row, status: 'pending' }, { onConflict: 'analysis_id' });
    }
    const res = await analyzeFluency({
      turnsText:  formatTurnsForAi(prep),
      studentName,
      teacherName,
      rolesKnown: !!prep.teacherSpeaker,
      labelShare: prep.labelShare,
    });
    // Sin clave de la API no hubo intento real: no se gasta uno de los reintentos.
    Object.assign(row, { model: FLUENCY_MODEL, attempts: attempts + (res.status === 'skipped' ? 0 : 1) });

    if (res.status === 'ready' && res.data) {
      ai = res.data;
      status = 'ready';
      const ok = ai.evaluable;
      Object.assign(row, {
        status,
        analyzed_at:         now,
        fluency_score:       ok ? ai.fluency_score : null,
        unscorable_reason:   ok ? null : (orNull(ai.unscorable_reason) ?? 'La IA no pudo evaluar la fluidez.'),
        student_talk_share:  clampShare(ai.student_talk_share),
        hesitation_level:    ok ? ai.hesitation_level : null,
        spanish_usage:       ai.spanish_usage,
        fluency_evidence:    orNull(ai.fluency_evidence),
        best_excerpt:        ok ? orNull(ai.best_fluent_excerpt) : null,
        best_excerpt_at:     ok ? orNull(ai.best_fluent_at) : null,
        best_excerpt_found:  ok && orNull(ai.best_fluent_excerpt) ? excerptFound(prep.turns, ai.best_fluent_excerpt) : null,
        worst_excerpt:       ok ? orNull(ai.worst_struggle_excerpt) : null,
        worst_excerpt_at:    ok ? orNull(ai.worst_struggle_at) : null,
        worst_excerpt_found: ok && orNull(ai.worst_struggle_excerpt) ? excerptFound(prep.turns, ai.worst_struggle_excerpt) : null,
      });
    } else {
      status = 'failed';
      error = res.error ?? `La IA no respondió (${res.status}).`;
      Object.assign(row, { status, last_error: error.slice(0, 500) });
    }
  }

  if (!opts.dryRun) {
    const { error: upErr } = await supabase.from('transcript_fluency').upsert(row, { onConflict: 'analysis_id' });
    if (upErr) {
      console.error(`[fluency] No se pudo guardar ${analysisId}:`, upErr.message);
      return { analysisId, status: 'failed', row, prep, ai, error: upErr.message };
    }
  }
  const studentGroup = (ca.student_id as string | null) ?? String(row.student_key);
  return { analysisId, status, row, prep, ai, error, studentGroup };
}
