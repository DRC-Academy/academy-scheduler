// Carga de datos de /mis-alumnos.
//
// IMPORTANTE — por qué NO filtramos por student_profiles.teacher_id:
// ese campo está NULL en todas las fichas históricas (se empezó a rellenar
// después), así que filtrar por él devolvería cero alumnos. Y aunque estuviera
// relleno, quedaría obsoleto al cambiar a un alumno de profesor: la ficha
// seguiría apuntando al profe anterior y el nuevo no la vería.
//
// La fuente de verdad de quién enseña a quién son los ASSIGNMENTS. Traemos las
// fichas y los análisis de los alumnos de este profesor, emparejando por
// student_id y, como respaldo, por nombre normalizado (el mismo criterio
// tolerante que usa el resto del sistema).

import { supabase } from '@/lib/supabase';
import type { ClassAnalysisRow, StudentProfileRow } from '@/lib/aiTypes';
import type { Assignment } from '@/types';

export const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const PROFILE_COLS = `
  id, student_id, student_name, teacher_id, form_responses, form_completed_at, form_token_id,
  initial_diagnosis, strong_points, weak_points, learning_style, personal_objective, occupation,
  recommended_focus, current_level, current_block, grammar_focus, vocabulary_focus,
  risk_signal, risk_explanation, risk_updated_at, progress_score,
  total_classes_analyzed, last_class_analyzed_at, next_class_content, next_class_generated_at,
  level_test_cefr, level_test_score, level_test_completed_at, level_test_evaluation, level_test_session_id,
  ai_ficha, ai_status, created_at, updated_at
`.replace(/\s+/g, ' ').trim();

// Igual que con los análisis: si supabase-interventions.sql todavía no se corrió,
// pedir estas columnas haría fallar la consulta ENTERA (42703) y la página del
// alumno se quedaría vacía. Se reintenta sin ellas.
const PROFILE_COLS_EXTRA = `${PROFILE_COLS}, active_intervention, active_intervention_at, unattended_alerts`;

const ANALYSIS_COLS = `
  id, student_id, teacher_id, student_name, class_number, transcript,
  class_summary, errors_detected, progress_notes, topics_covered, next_class_guide,
  risk_signal, risk_explanation, analyzed_at, class_date, class_title, next_class_content
`.replace(/\s+/g, ' ').trim();

// Columnas de migraciones posteriores (vínculo con el ingreso, validación, estado
// del análisis). Si la base no las tiene, Supabase falla la consulta ENTERA con
// 42703 → se reintenta sin ellas para no dejar la página en blanco.
const ANALYSIS_COLS_EXTRA = `${ANALYSIS_COLS}, join_log_id, validation_status, analysis_status, analysis_error`;

export interface StudentBundle {
  assignment: Assignment;
  profile: StudentProfileRow | null;
  analyses: ClassAnalysisRow[];     // más reciente primero
}

/** Índice de fichas/análisis por student_id y por nombre normalizado. */
function indexBy<T extends { student_id?: string | null; student_name?: string | null }>(rows: T[]) {
  const byId = new Map<string, T[]>();
  const byName = new Map<string, T[]>();
  for (const r of rows) {
    if (r.student_id) {
      const l = byId.get(r.student_id) ?? []; l.push(r); byId.set(r.student_id, l);
    }
    if (r.student_name) {
      const k = norm(r.student_name);
      const l = byName.get(k) ?? []; l.push(r); byName.set(k, l);
    }
  }
  return { byId, byName };
}

function lookup<T extends { student_id?: string | null; student_name?: string | null }>(
  idx: { byId: Map<string, T[]>; byName: Map<string, T[]> },
  a: Assignment,
): T[] {
  if (a.studentId && idx.byId.has(a.studentId)) return idx.byId.get(a.studentId)!;
  return idx.byName.get(norm(a.studentName)) ?? [];
}

/**
 * Trae todo lo que necesita la página, en paralelo, y lo combina por alumno.
 * `assignments` viene del contexto de la app (ya cargado): es la fuente de verdad.
 */
export async function loadStudentBundles(assignments: Assignment[]): Promise<StudentBundle[]> {
  const readAnalyses = (cols: string) =>
    supabase.from('class_analyses').select(cols).order('analyzed_at', { ascending: false });
  const readProfiles = (cols: string) => supabase.from('student_profiles').select(cols);
  const missingCol = (e: { code?: string } | null) => e?.code === '42703' || e?.code === 'PGRST204';

  const [firstProfiles, firstTry] = await Promise.all([
    readProfiles(PROFILE_COLS_EXTRA),
    readAnalyses(ANALYSIS_COLS_EXTRA),
  ]);

  const profilesRes = missingCol(firstProfiles.error) ? await readProfiles(PROFILE_COLS) : firstProfiles;
  const analysesRes = missingCol(firstTry.error) ? await readAnalyses(ANALYSIS_COLS) : firstTry;

  if (profilesRes.error) console.error('[mis-alumnos] Error al leer student_profiles:', profilesRes.error);
  if (analysesRes.error) console.error('[mis-alumnos] Error al leer class_analyses:', analysesRes.error);

  const profiles = (profilesRes.data ?? []) as unknown as StudentProfileRow[];
  const analyses = (analysesRes.data ?? []) as unknown as ClassAnalysisRow[];

  const pIdx = indexBy(profiles);
  const aIdx = indexBy(analyses);

  // Un alumno puede tener varios assignments (varios horarios): agrupamos por
  // alumno y nos quedamos con el que tenga más slots como principal.
  const seen = new Map<string, Assignment>();
  for (const a of assignments) {
    const key = a.studentId || `name:${norm(a.studentName)}`;
    const prev = seen.get(key);
    if (!prev || (a.slots?.length ?? 0) > (prev.slots?.length ?? 0)) seen.set(key, a);
  }

  return Array.from(seen.values()).map(assignment => ({
    assignment,
    profile: lookup(pIdx, assignment)[0] ?? null,
    analyses: lookup(aIdx, assignment),
  }));
}
