// ── Buscar al alumno por email y cargar su ficha, DESDE EL SERVIDOR ───────────
//
// Lo que /progreso-cuenta necesita y que /progreso/[token] no: encontrar al alumno
// sin token, a partir del email con el que compró en WooCommerce.
//
// SE BUSCA EN DOS COLUMNAS, y esto es lo importante de este archivo:
//
//   · students.email            — el email del alumno
//   · assignments.student_email — el email de la assignment
//
// Suenan a lo mismo y no lo son. En septiembre de 2026 hay 15 alumnos donde las dos
// no coinciden y 14 emails que existen SOLO en la assignment, casi todos porque
// quien paga es el padre o la madre: Luca Robledo está en `students` con
// laura_r_v@icloud.com y en su assignment con laurarobledortv@gmail.com. La cuenta
// de WooCommerce puede ser cualquiera de las dos. Buscando solo en `students`, esos
// 14 alumnos verían "todavía no tenemos tu ficha" teniendo ficha.
//
// EL EMAIL NO ESTÁ NORMALIZADO EN LA BASE (6 de 200 tienen mayúsculas), así que se
// compara siempre en minúsculas. No hace falta ningún SQL para eso.
//
// PUEDE DEVOLVER VARIOS. Hoy ningún email apunta a dos alumnos —lo comprobé
// uniendo las dos columnas—, pero un padre con dos hijos es cuestión de tiempo, y
// entonces la página tiene que preguntar cuál quiere ver en vez de elegir por su
// cuenta.

import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import {
  PROFILE_COLS, PROFILE_COLS_EXTRA, ANALYSIS_COLS, ASSIGNMENT_COLS,
  STUDENT_COLS, isMissingColumnError, pickAssignment,
  type AssignmentLite, type StudentLite,
} from '@/lib/progresoData';
import { normalizeProgresoEmail } from '@/lib/progresoSignature';
import type { ClassAnalysisRow, StudentProfileRow } from '@/lib/aiTypes';

/** Un alumno encontrado por email. Lo mínimo para elegir y para cargar la ficha. */
export interface ProgresoStudent {
  id: string;
  name: string;
}

/** Todo lo que la ficha necesita, ya cargado. */
export interface ProgresoPayload {
  student: ProgresoStudent;
  profile: StudentProfileRow | null;
  analyses: ClassAnalysisRow[];
  assignment: AssignmentLite | null;
  /** `plan` y `product_name`: de ahí sale la meta cuando prepara un examen. */
  studentLite: StudentLite | null;
}

export type ProgresoLookup =
  | { kind: 'sin_configurar' }
  | { kind: 'no_encontrado' }
  | { kind: 'varios'; students: ProgresoStudent[] }
  | { kind: 'uno'; student: ProgresoStudent };

const nk = normalizeProgresoEmail;

/**
 * Alumnos cuyo email —en cualquiera de las dos columnas— es `email`.
 *
 * Trae las dos listas enteras y compara en memoria en vez de filtrar en la base.
 * Con 200 alumnos es instantáneo, y evita depender de `ilike` con caracteres que
 * hay que escapar (un email con `%` o `_` haría de comodín y podría devolver a
 * otro alumno, que es justo lo que esta ruta no puede permitirse).
 */
export async function findStudentsByEmail(email: string): Promise<ProgresoLookup> {
  const db = getSupabaseAdmin();
  if (!db) return { kind: 'sin_configurar' };

  const buscado = nk(email);
  if (!buscado) return { kind: 'no_encontrado' };

  const [sRes, aRes] = await Promise.all([
    db.from('students').select('id, name, email'),
    db.from('assignments').select('student_id, student_name, student_email'),
  ]);

  if (sRes.error) {
    console.error('[progreso-cuenta] No se pudieron leer los alumnos:', sRes.error.message);
    return { kind: 'sin_configurar' };
  }

  const encontrados = new Map<string, ProgresoStudent>();
  type SRow = { id: string; name: string; email: string | null };
  const students = (sRes.data ?? []) as SRow[];

  for (const s of students) {
    if (nk(s.email) === buscado) encontrados.set(s.id, { id: s.id, name: s.name });
  }

  // La segunda vía: el email de la assignment. Solo se aceptan las que apuntan a un
  // alumno que existe — una assignment huérfana no tiene ficha que mostrar.
  if (!aRes.error) {
    type ARow = { student_id: string | null; student_name: string | null; student_email: string | null };
    const porId = new Map(students.map(s => [s.id, s]));
    for (const a of (aRes.data ?? []) as ARow[]) {
      if (nk(a.student_email) !== buscado || !a.student_id) continue;
      const s = porId.get(a.student_id);
      if (s) encontrados.set(s.id, { id: s.id, name: s.name });
    }
  } else {
    // No es motivo para no enseñar nada: la vía principal ya funcionó o no.
    console.error('[progreso-cuenta] No se pudieron leer las assignments:', aRes.error.message);
  }

  const lista = [...encontrados.values()].sort((x, y) => x.name.localeCompare(y.name, 'es'));
  if (lista.length === 0) return { kind: 'no_encontrado' };
  if (lista.length > 1) return { kind: 'varios', students: lista };
  return { kind: 'uno', student: lista[0] };
}

/**
 * La ficha, las clases y la assignment de un alumno. Mismas tablas y MISMAS
 * columnas que /progreso/[token] (lib/progresoData): nunca el transcript.
 */
export async function loadProgresoFor(student: ProgresoStudent): Promise<ProgresoPayload | null> {
  const db = getSupabaseAdmin();
  if (!db) return null;

  const profileQ = (cols: string) =>
    db.from('student_profiles').select(cols).eq('student_id', student.id).limit(1);

  const [firstP, aRes, asgRes, stRes] = await Promise.all([
    profileQ(PROFILE_COLS_EXTRA),
    db.from('class_analyses').select(ANALYSIS_COLS)
      .eq('student_id', student.id).order('analyzed_at', { ascending: false }),
    db.from('assignments').select(ASSIGNMENT_COLS).eq('student_id', student.id),
    db.from('students').select(STUDENT_COLS).eq('id', student.id).limit(1),
  ]);

  // Mismo respaldo que la otra ruta: si supabase-teacher-level.sql no se corrió, se
  // reintenta sin esa columna en vez de dejar la ficha vacía.
  const pRes = isMissingColumnError(firstP.error) ? await profileQ(PROFILE_COLS) : firstP;

  return {
    student,
    profile: (pRes.data?.[0] ?? null) as unknown as StudentProfileRow | null,
    analyses: (aRes.data ?? []) as unknown as ClassAnalysisRow[],
    assignment: pickAssignment((asgRes.data ?? []) as unknown as AssignmentLite[]),
    studentLite: (stRes.data?.[0] ?? null) as unknown as StudentLite | null,
  };
}
