// Uso de la GENERACIÓN DE CLASES CON IA: lectura del registro y resumen por
// profesor.
//
// El registro lo escribe /api/ai/generate-next-class, que es el único sitio por
// el que pasan las tres entradas de la herramienta (pegar transcripción en la
// ficha del alumno, el botón "Generar clase" y NextClassModal). Ver
// supabase-ai-usage.sql para el porqué de la tabla y de lo que NO guarda.
//
// EGRESS: estas consultas piden columnas una a una y ninguna es pesada. Nunca
// `select('*')`, porque mañana alguien añade una columna gorda a la tabla y el
// listado del admin empieza a descargarla sin que nadie lo pida.

import { supabase } from '@/lib/supabase';
import { sinProfesoresDePrueba } from '@/lib/externalTeachers';

/**
 * De dónde salió la generación.
 *
 * `transcript` es LA acción que se quería medir: el profesor pegó la
 * transcripción de la clase que acaba de dar y la plataforma encadenó la
 * siguiente. `directa` es el mismo motor sin transcripción delante (primera
 * clase del alumno, regenerar, clase genérica).
 *
 * Se distinguen en vez de registrar solo la primera porque las dos son "usar la
 * herramienta": un profesor que genera clases sin pegar transcripción no es un
 * profesor que no la usa, y meterlo en la lista de "sin usar" sería señalar a
 * alguien que sí la está aprovechando.
 */
export type GenerationOrigin = 'transcript' | 'directa';

export const ORIGIN_LABEL: Record<GenerationOrigin, string> = {
  transcript: 'Con transcripción',
  directa:    'Directa',
};

export interface AiGenerationRow {
  id: string;
  teacher_id: string | null;
  teacher_name: string | null;
  student_id: string | null;
  student_name: string;
  origin: GenerationOrigin;
  created_at: string;
}

export const AI_GENERATION_COLS =
  'id, teacher_id, teacher_name, student_id, student_name, origin, created_at';

export interface AiGenerationsResult {
  rows: AiGenerationRow[];
  /** true = la tabla no existe todavía (falta correr supabase-ai-usage.sql). */
  missingTable: boolean;
}

/**
 * El registro entero, del más reciente al más antiguo.
 *
 * Se trae completo a propósito: son metadatos (seis campos cortos por fila) y
 * los filtros de la pestaña son instantáneos si se aplican en memoria. Si algún
 * día la tabla creciera hasta molestar, el sitio donde poner el límite es este.
 */
export async function fetchAiGenerations(limit = 5000): Promise<AiGenerationsResult> {
  const { data, error } = await supabase
    .from('ai_class_generations')
    .select(AI_GENERATION_COLS)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    // 42P01 / PGRST205 = la tabla todavía no existe. No es un fallo: es que la
    // migración no se corrió, y la pestaña lo dice en vez de quedarse vacía.
    const missingTable = error.code === '42P01' || error.code === 'PGRST205';
    if (!missingTable) console.error('[aiUsage] No se pudo leer el registro:', error);
    return { rows: [], missingTable };
  }
  return { rows: (data ?? []) as unknown as AiGenerationRow[], missingTable: false };
}

// ── Resumen por profesor ─────────────────────────────────────────────────────

export const norm = (s: string | null | undefined): string =>
  (s ?? '').trim().toLowerCase();

export interface TeacherUsage {
  teacherId: string;
  teacherName: string;
  total: number;
  /** De las anteriores, cuántas salieron de pegar una transcripción. */
  fromTranscript: number;
  /** ISO de la última generación, o null si nunca usó la herramienta. */
  lastUsed: string | null;
  /**
   * false = el registro tiene filas a nombre de alguien que ya no está en la
   * lista de profesores. No se descartan: son uso real de la herramienta y
   * esconderlas haría que los totales no cuadraran con el listado detallado.
   */
  known: boolean;
}

export interface UsageSummary {
  perTeacher: TeacherUsage[];
  /** Profesores activos que han usado la herramienta al menos una vez. */
  usan: number;
  /** Profesores activos en total: el denominador del "X de Y". */
  totalProfesores: number;
}

interface TeacherLite { id: string; name: string }

/**
 * Cruza el registro con la lista de profesores.
 *
 * Incluye a TODOS los profesores, también a los que tienen cero: esos son
 * justamente los que la pestaña quiere enseñar. El cruce es por id y, si la fila
 * no lo trae, por nombre normalizado — el mismo criterio tolerante que usa el
 * resto del sistema, porque NextClassModal se abre desde sitios que solo conocen
 * el nombre del profesor.
 *
 * Las cuentas de prueba (t1/t2) quedan fuera: aparecerían para siempre en la
 * lista de "sin usar" y estropearían el "X de Y profesores".
 */
export function summarizeByTeacher(
  rows: readonly AiGenerationRow[],
  teachers: readonly TeacherLite[],
): UsageSummary {
  const activos = sinProfesoresDePrueba(teachers);

  const porId = new Map<string, TeacherUsage>();
  const porNombre = new Map<string, TeacherUsage>();

  for (const t of activos) {
    const entry: TeacherUsage = {
      teacherId: t.id, teacherName: t.name,
      total: 0, fromTranscript: 0, lastUsed: null, known: true,
    };
    porId.set(t.id, entry);
    if (t.name) porNombre.set(norm(t.name), entry);
  }

  // Filas cuyo profesor ya no está en la lista (borrado, archivado o cuenta de
  // prueba). Se agrupan por nombre para no perder el total.
  const huerfanas = new Map<string, TeacherUsage>();

  for (const r of rows) {
    const nombre = r.teacher_name?.trim() || '(sin profesor)';
    let entry = (r.teacher_id ? porId.get(r.teacher_id) : undefined)
      ?? porNombre.get(norm(r.teacher_name));

    if (!entry) {
      const clave = norm(nombre);
      entry = huerfanas.get(clave);
      if (!entry) {
        entry = {
          teacherId: r.teacher_id ?? '', teacherName: nombre,
          total: 0, fromTranscript: 0, lastUsed: null, known: false,
        };
        huerfanas.set(clave, entry);
      }
    }

    entry.total += 1;
    if (r.origin === 'transcript') entry.fromTranscript += 1;
    // El listado llega ordenado, pero no se da por hecho: se compara.
    if (!entry.lastUsed || r.created_at > entry.lastUsed) entry.lastUsed = r.created_at;
  }

  const perTeacher = [...porId.values(), ...huerfanas.values()];
  return {
    perTeacher,
    usan: perTeacher.filter(t => t.known && t.total > 0).length,
    totalProfesores: activos.length,
  };
}

export type UsageSort = 'sin-usar' | 'mas-activos';

/**
 * `sin-usar` (el orden por defecto) pone delante lo que hay que mirar: primero
 * los que nunca la han usado, y detrás el resto de más frío a más reciente. Es
 * el orden que contesta "¿a quién tengo que llamar?".
 *
 * `mas-activos` es el de siempre, por volumen, para ver quién le saca partido.
 */
export function sortUsage(list: readonly TeacherUsage[], sort: UsageSort): TeacherUsage[] {
  const out = [...list];
  if (sort === 'mas-activos') {
    return out.sort((a, b) => b.total - a.total || a.teacherName.localeCompare(b.teacherName, 'es'));
  }
  return out.sort((a, b) => {
    if (!a.lastUsed && !b.lastUsed) return a.teacherName.localeCompare(b.teacherName, 'es');
    if (!a.lastUsed) return -1;
    if (!b.lastUsed) return 1;
    return a.lastUsed.localeCompare(b.lastUsed);
  });
}
