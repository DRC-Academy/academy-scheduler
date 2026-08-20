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
// level_test_provisional* llegan con supabase-level-test-v2.sql. Van AQUÍ, en el
// grupo con reintento, y no en PROFILE_COLS: si se pidieran en el grupo base y el
// SQL no se hubiera corrido, la ficha del alumno se quedaría en blanco.
const PROFILE_COLS_EXTRA = `${PROFILE_COLS}, active_intervention, active_intervention_at, unattended_alerts, level_test_provisional, level_test_provisional_reason`;

// SIN `transcript`. El profesor no lee nunca el texto: sus vistas solo muestran
// el ESTADO (subido / pendiente / en revisión), y para eso alcanza el booleano
// `has_transcript` (columna generada, ver supabase-has-transcript.sql). Traer el
// texto costaba 11,8 MB por carga y le ponía en el navegador las transcripciones
// de los alumnos de todos los demás profesores.
const ANALYSIS_COLS = `
  id, student_id, teacher_id, student_name, class_number, has_transcript,
  class_summary, errors_detected, progress_notes, topics_covered, next_class_guide,
  risk_signal, risk_explanation, analyzed_at, class_date, class_title, next_class_content
`.replace(/\s+/g, ' ').trim();

// Respaldo para bases sin la migración de has_transcript: se pide el texto, como
// antes. Solo cambia el peso, no el comportamiento.
const ANALYSIS_COLS_LEGACY = ANALYSIS_COLS.replace('has_transcript', 'transcript');

// Columnas de migraciones posteriores (vínculo con el ingreso, validación, estado
// del análisis). Si la base no las tiene, Supabase falla la consulta ENTERA con
// 42703 → se reintenta sin ellas para no dejar la página en blanco.
const ANALYSIS_COLS_EXTRA = `${ANALYSIS_COLS}, join_log_id, validation_status, analysis_status, analysis_error`;
const ANALYSIS_COLS_EXTRA_LEGACY = `${ANALYSIS_COLS_LEGACY}, join_log_id, validation_status, analysis_status, analysis_error`;

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
  // FILTRO POR PROFESOR EN LA BASE, no en JavaScript.
  //
  // Antes esta consulta traía las 361 filas de la tabla y recién después las
  // cruzaba contra los assignments para decidir qué pintar. El filtro era
  // cosmético: al profesor con más clases le llegaban igualmente 307
  // transcripciones de alumnos de otros 19 profesores (8,3 MB) que su navegador
  // recibía aunque la interfaz no las mostrara. Filtrando acá, esos datos no
  // viajan.
  //
  // Efecto conocido: un alumno que cambió de profesor deja de mostrar, en la
  // vista del profesor nuevo, las clases que dio con el anterior — son de otro
  // teacher_id. Hoy afecta a 2 alumnos de 116 (los transferidos).
  const teacherIds = [...new Set(assignments.map(a => a.teacherId).filter(Boolean))];

  const readAnalyses = (cols: string) =>
    supabase.from('class_analyses').select(cols)
      .in('teacher_id', teacherIds)
      .order('analyzed_at', { ascending: false });
  const readProfiles = (cols: string) => supabase.from('student_profiles').select(cols);
  const missingCol = (e: { code?: string } | null) => e?.code === '42703' || e?.code === 'PGRST204';

  // Sin assignments no hay nada que traer, y un `.in()` vacío devolvería la
  // tabla entera en algunas versiones de PostgREST.
  if (teacherIds.length === 0) return [];

  const [firstProfiles, firstTry] = await Promise.all([
    readProfiles(PROFILE_COLS_EXTRA),
    readAnalyses(ANALYSIS_COLS_EXTRA),
  ]);

  const profilesRes = missingCol(firstProfiles.error) ? await readProfiles(PROFILE_COLS) : firstProfiles;
  // Cascada: has_transcript + columnas nuevas → has_transcript solo → texto
  // (base sin la migración de has_transcript).
  let analysesRes = firstTry;
  if (missingCol(analysesRes.error)) analysesRes = await readAnalyses(ANALYSIS_COLS);
  if (missingCol(analysesRes.error)) analysesRes = await readAnalyses(ANALYSIS_COLS_EXTRA_LEGACY);
  if (missingCol(analysesRes.error)) analysesRes = await readAnalyses(ANALYSIS_COLS_LEGACY);

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
