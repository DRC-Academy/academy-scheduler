// ¿Puede este alumno cambiar su horario por su cuenta desde el LMS?
//
// Regla: exactamente UNA assignment activa y plan individual. Cada exclusión es
// una función con nombre propio para poder ajustarla sin tocar el resto, y solo
// excluye cuando hay un dato que la confirma: un alumno sin product_name (no se
// sabe su plan) es elegible.
//
// TODO(en-pausa): la pausa todavía NO excluye a nadie. La tabla student_pauses no
// existe en producción (supabase-student-pauses.sql sin correr) y no se consulta
// WooCommerce en vivo a propósito. Cuando exista, un alumno con una pausa abierta
// (student_pauses con ended_on null) pasa a NO_ELEGIBLE con detalle 'EN_PAUSA'.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssignedSlot } from '@/types';
import type { DetalleNoElegible } from '@/lib/cambioHorario/errors';

type Db = SupabaseClient;

export interface AlumnoElegibilidad {
  id: string;
  name: string;
  email: string | null;
  product_name: string | null;
  company_plan_months: number | null;
  is_oritalk: boolean | null;
}

export interface AsignacionElegibilidad {
  id: string;
  teacher_id: string;
  teacher_name: string;
  student_id: string | null;
  student_name: string;
  student_email: string | null;
  status: string | null;
  slots: AssignedSlot[] | null;
}

const contiene = (texto: string | null | undefined, buscado: string): boolean =>
  (texto ?? '').toLowerCase().includes(buscado.toLowerCase());

/** Oritalk: students.is_oritalk = true. */
export function esPlanOritalk(alumno: Pick<AlumnoElegibilidad, 'is_oritalk'>): boolean {
  return alumno.is_oritalk === true;
}

/** Empresa: company_plan_months no nulo, o product_name con "Empresa" (sin distinguir mayúsculas). */
export function esPlanEmpresa(alumno: Pick<AlumnoElegibilidad, 'company_plan_months' | 'product_name'>): boolean {
  return alumno.company_plan_months != null || contiene(alumno.product_name, 'empresa');
}

const claveSlot = (s: AssignedSlot) => `${s.day}_${String(parseInt(s.hour, 10)).padStart(2, '0')}`;

/**
 * Criterio PRINCIPAL de dos alumnos: otra assignment activa del MISMO profesor
 * comparte alguna casilla recurrente (día + hora) con la de este alumno. Es la
 * casilla compartida de los planes de dos alumnos: el segundo tiene ficha propia
 * con los mismos horarios.
 */
export function compartenCasillaConOtroAlumno(
  asignacion: Pick<AsignacionElegibilidad, 'id' | 'teacher_id' | 'slots'>,
  otrasActivasDelProfe: Array<Pick<AsignacionElegibilidad, 'id' | 'teacher_id' | 'slots' | 'status'>>,
): boolean {
  const mias = new Set((asignacion.slots ?? []).map(claveSlot));
  if (mias.size === 0) return false;
  return otrasActivasDelProfe.some(o =>
    o.id !== asignacion.id && o.teacher_id === asignacion.teacher_id && (o.status ?? 'active') === 'active'
    && (o.slots ?? []).some(s => mias.has(claveSlot(s))));
}

/** Plan de dos alumnos: criterio principal (casilla compartida) o refuerzo (product_name con "dos alumnos"). */
export function esPlanDosAlumnos(
  alumno: Pick<AlumnoElegibilidad, 'product_name'>,
  asignacion: Pick<AsignacionElegibilidad, 'id' | 'teacher_id' | 'slots'>,
  otrasActivasDelProfe: Array<Pick<AsignacionElegibilidad, 'id' | 'teacher_id' | 'slots' | 'status'>>,
): boolean {
  return compartenCasillaConOtroAlumno(asignacion, otrasActivasDelProfe) || contiene(alumno.product_name, 'dos alumnos');
}

export type ResultadoElegibilidad =
  | { elegible: true; asignacion: AsignacionElegibilidad }
  | { elegible: false; detalle: DetalleNoElegible; asignacion: AsignacionElegibilidad | null };

/**
 * Decide la elegibilidad con los datos ya cargados. Orden: primero que haya
 * exactamente una assignment activa (sin ella no hay profesor ni horario), luego
 * las exclusiones de plan.
 */
export function evaluarElegibilidad(datos: {
  alumno: AlumnoElegibilidad;
  activasDelAlumno: AsignacionElegibilidad[];
  /** Assignments activas del profesor de la assignment del alumno (puede incluirla). */
  activasDelProfe: AsignacionElegibilidad[];
}): ResultadoElegibilidad {
  const activas = datos.activasDelAlumno.filter(a => (a.status ?? 'active') === 'active');
  if (activas.length === 0) return { elegible: false, detalle: 'SIN_ASIGNACION_ACTIVA', asignacion: null };
  if (activas.length > 1) return { elegible: false, detalle: 'VARIAS_ASIGNACIONES', asignacion: null };
  const asignacion = activas[0];
  if (esPlanOritalk(datos.alumno)) return { elegible: false, detalle: 'ORITALK', asignacion };
  if (esPlanEmpresa(datos.alumno)) return { elegible: false, detalle: 'EMPRESA', asignacion };
  if (esPlanDosAlumnos(datos.alumno, asignacion, datos.activasDelProfe)) return { elegible: false, detalle: 'PLAN_DOS_ALUMNOS', asignacion };
  // TODO(en-pausa): aquí, pausa abierta en student_pauses → { elegible: false, detalle: 'EN_PAUSA' }.
  return { elegible: true, asignacion };
}

const COLS_ASG = 'id, teacher_id, teacher_name, student_id, student_name, student_email, status, slots';

/**
 * Carga lo necesario y evalúa. Devuelve null si el alumno no existe. LANZA ante
 * un error de lectura (decir "no elegible" por un fallo de red confundiría).
 */
export async function cargarElegibilidadWith(db: Db, studentId: string): Promise<{ alumno: AlumnoElegibilidad; resultado: ResultadoElegibilidad } | null> {
  const { data: alumno, error } = await db.from('students')
    .select('id, name, email, product_name, company_plan_months, is_oritalk').eq('id', studentId).maybeSingle();
  if (error) throw new Error(`no se pudo leer el alumno: ${error.message}`);
  if (!alumno) return null;

  const { data: suyas, error: e2 } = await db.from('assignments').select(COLS_ASG).eq('student_id', studentId).eq('status', 'active');
  if (e2) throw new Error(`no se pudieron leer sus asignaciones: ${e2.message}`);
  const activasDelAlumno = (suyas ?? []) as AsignacionElegibilidad[];

  let activasDelProfe: AsignacionElegibilidad[] = [];
  if (activasDelAlumno.length === 1) {
    const { data: delProfe, error: e3 } = await db.from('assignments').select(COLS_ASG)
      .eq('teacher_id', activasDelAlumno[0].teacher_id).eq('status', 'active');
    if (e3) throw new Error(`no se pudieron leer las asignaciones del profesor: ${e3.message}`);
    activasDelProfe = (delProfe ?? []) as AsignacionElegibilidad[];
  }
  const a = alumno as AlumnoElegibilidad;
  return { alumno: a, resultado: evaluarElegibilidad({ alumno: a, activasDelAlumno, activasDelProfe }) };
}
