// ── Datos de la ficha de progreso: columnas y reglas compartidas ──────────────
//
// Lo que las DOS rutas de la ficha tienen en común, sin React y sin cliente de
// base de datos, para que lo pueda importar tanto el navegador como el servidor:
//
//   · /progreso/[token]  → consulta desde el navegador con la anon key
//   · /progreso-cuenta   → consulta desde el servidor con la service role key
//
// Las listas de columnas viven acá y no en cada ruta a propósito: son la promesa
// de que la ficha NUNCA pide un transcript. Duplicadas, la segunda ruta se habría
// llevado el texto completo de cada clase al navegador del alumno sin que nadie lo
// notara.

/** Lo poco que hace falta de `assignments`: horas del plan y textos del objetivo. */
export interface AssignmentLite {
  weekly_hours: number | null;
  plan: string | null;
  objetivo: string | null;
  student_level: string | null;
  slots: Array<{ day: string; hour: string }> | null;
}

/**
 * Columnas de `student_profiles`. NINGUNA es un transcript ni una nota interna:
 * lo que sale de acá pasa además por el cortafuegos de lib/studentFacing antes de
 * mostrarse.
 */
export const PROFILE_COLS =
  'id, student_id, student_name, strong_points, weak_points, personal_objective, recommended_focus, ' +
  'current_level, level_test_cefr, total_classes_analyzed';

/**
 * El nivel confirmado por el profesor manda sobre el de la prueba (ver
 * lib/effectiveLevel). Llega con supabase-teacher-level.sql: si esa migración no
 * se corrió, pedir la columna rompería la consulta ENTERA con un 42703 y el alumno
 * vería su página de progreso vacía. Por eso se pide aparte y se reintenta sin
 * ella (`isMissingColumnError`).
 */
export const PROFILE_COLS_EXTRA = PROFILE_COLS + ', teacher_confirmed_level';

/** Resúmenes de clase. `transcript` NO se pide: la ficha no lo muestra. */
export const ANALYSIS_COLS =
  'id, student_id, student_name, class_number, class_summary, class_title, analyzed_at, class_date';

/**
 * `status` NO se pide: la columna puede no estar migrada (ver
 * supabase-assignment-status.sql) y pedirla rompería la consulta con un 42703.
 */
export const ASSIGNMENT_COLS = 'weekly_hours, plan, objetivo, student_level, slots';

/** ¿El error es "esa columna no existe"? Entonces se reintenta sin ella. */
export function isMissingColumnError(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42703' || error?.code === 'PGRST204';
}

/**
 * El alumno puede tener más de una fila en `assignments` (cambios de profesor,
 * altas viejas sin borrar). Gana la que tenga MÁS celdas asignadas: es la que
 * describe el plan que está dando de verdad.
 */
export function pickAssignment(rows: AssignmentLite[]): AssignmentLite | null {
  if (rows.length === 0) return null;
  const score = (a: AssignmentLite) => Math.max(a.slots?.length ?? 0, a.weekly_hours ?? 0);
  return rows.reduce((best, r) => (score(r) > score(best) ? r : best), rows[0]);
}

/** Horas semanales del plan. Las celdas del calendario mandan sobre el número guardado. */
export function resolveWeeklyHours(a: AssignmentLite | null): number | null {
  if (!a) return null;
  const fromSlots = a.slots?.length ?? 0;
  if (fromSlots > 0) return fromSlots;
  const stored = Number(a.weekly_hours ?? 0);
  return stored > 0 ? stored : null;
}
