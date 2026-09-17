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

/**
 * Lo poco que hace falta de `students`: los dos textos donde está escrito qué
 * compró el alumno.
 *
 * `product_name` es el nombre del producto de WooCommerce y es la MEJOR fuente
 * para saber si prepara un examen: de los 63 alumnos de examen de septiembre de
 * 2026, **54 solo se detectan por aquí** ("Preparación B2 First Certificate",
 * "intensivo PET"), frente a 1 por `assignments.plan` y 4 por `objetivo`. Sin
 * estas dos columnas la detección de meta se pierde a casi todos.
 */
export interface StudentLite {
  plan: string | null;
  product_name: string | null;
}

/** Solo esas dos. Ningún dato personal más del que la ficha ya muestra. */
export const STUDENT_COLS = 'plan, product_name';

/**
 * Lo poco que hace falta de `assignments`: horas del plan, textos del objetivo y
 * el día en que empezó con el profesor (de ahí sale la fecha del diploma).
 */
export interface AssignmentLite {
  weekly_hours: number | null;
  plan: string | null;
  objetivo: string | null;
  student_level: string | null;
  slots: Array<{ day: string; hour: string }> | null;
  /** `YYYY-MM-DD` (la columna fue `text`: puede traer cualquier cosa, lib/diplomaPlazo la valida). */
  start_date: string | null;
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
export const ASSIGNMENT_COLS = 'weekly_hours, plan, objetivo, student_level, slots, start_date';

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

/**
 * El día en que el alumno empezó: la MENOR `start_date` de todas sus assignments,
 * no la de la que gana en `pickAssignment`. Un cambio de profesor crea otra fila
 * con otra fecha, y el diploma se cuenta desde que empezó el curso, no desde el
 * último profesor. Es además la misma regla que usa el LMS para el drip
 * (`vista_perfil_alumno.fecha_inicio`), así los dos relojes coinciden.
 */
export function earliestStartDate(rows: AssignmentLite[]): string | null {
  const fechas = rows
    .map(r => (typeof r.start_date === 'string' ? r.start_date.trim() : ''))
    .filter(f => /^\d{4}-\d{2}-\d{2}/.test(f))
    .sort();
  return fechas[0] ?? null;
}

/** Horas semanales del plan. Las celdas del calendario mandan sobre el número guardado. */
export function resolveWeeklyHours(a: AssignmentLite | null): number | null {
  if (!a) return null;
  const fromSlots = a.slots?.length ?? 0;
  if (fromSlots > 0) return fromSlots;
  const stored = Number(a.weekly_hours ?? 0);
  return stored > 0 ? stored : null;
}
