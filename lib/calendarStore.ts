// Escrituras y lecturas del CALENDARIO con el cliente de Supabase INYECTADO.
//
// Es el código que vivía dentro de lib/db.ts (lectura estricta, patch por
// casillas, historial, reconciliación de asignaciones), movido aquí para que lo
// pueda usar el servidor con la service key sin pasar por la anon key del
// navegador. lib/db.ts delega en estas funciones con su cliente de siempre, así
// que para las pantallas no cambia nada.
//
// NO importa lib/supabase.ts ni nada que lo importe: el cliente llega siempre
// por parámetro.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssignedSlot, Grid } from '@/types';
import { baseStudentOf } from '@/lib/cells';
import { applyChanges, normLoose, type GridChanges, type StudentCellEvent } from '@/lib/gridPatch';

export type Db = SupabaseClient;

// Normaliza para comparaciones tolerantes (trim + lower).
const normKey = (x: unknown): string => String(x ?? '').trim().toLowerCase();

// ── Lectura ───────────────────────────────────────────────────────────────────

/** El calendario no se pudo leer: la pantalla debe avisar y NO dejar editar. */
export class CalendarReadError extends Error {
  constructor(teacherId: string, detail: string) {
    super(`No se pudo leer el calendario (${teacherId}): ${detail}`);
    this.name = 'CalendarReadError';
  }
}

/**
 * Lectura ESTRICTA. Un profesor sin fila de calendario devuelve {} (es legítimo:
 * todavía no pintó nada); un error de lectura LANZA CalendarReadError.
 */
export async function readTeacherGridWith(db: Db, teacherId: string): Promise<Grid> {
  const { data, error } = await db
    .from('teacher_calendars')
    .select('grid')
    .eq('teacher_id', teacherId)
    .maybeSingle();
  if (error) throw new CalendarReadError(teacherId, error.message);
  return ((data?.grid as Grid | null) ?? {});
}

// ── Actor ─────────────────────────────────────────────────────────────────────

/** Desde dónde se tocó el calendario. Va al historial (calendar_changes.origin). */
export type CalendarOrigin = 'profesor' | 'admin' | 'alumnos' | 'setter' | 'clases' | 'sistema' | 'restauracion';

/** Quién toca el calendario y desde dónde. */
export interface CalendarActor {
  role: string;
  name: string;
  origin: CalendarOrigin;
}

/** Operaciones automáticas (cambio de profesor, eliminar alumno, quitar duplicado). */
export const SYSTEM_ACTOR: CalendarActor = { role: 'sistema', name: 'Sistema', origin: 'sistema' };

// ── Patch ─────────────────────────────────────────────────────────────────────

export interface CalendarPatchResult {
  /** El calendario REAL justo antes de este patch (lo devuelve la función). */
  before: Grid;
  /** El calendario REAL después de este patch. */
  after: Grid;
  applied: string[];
  /** Casillas que NO se aplicaron porque ya no valían lo esperado. */
  conflicts: string[];
}

/**
 * Llama a apply_calendar_patch: bloquea la fila del profesor y aplica cada
 * casilla solo si sigue valiendo `expected`. OJO: NO es todo o nada; las casillas
 * que coinciden se guardan aunque otras vuelvan como conflicto. Quien necesite
 * todo o nada lo tiene que revertir él (ver lib/transferencia/core.ts).
 *
 * Sin la función (PGRST202/42883) aplica la misma regla desde aquí, sin
 * atomicidad. LANZA si no se pudo guardar.
 */
export async function applyCalendarPatchWith(db: Db, teacherId: string, changes: GridChanges): Promise<CalendarPatchResult> {
  const { data, error } = await db.rpc('apply_calendar_patch', {
    p_teacher_id: teacherId,
    p_changes: changes,
  });

  if (error) {
    // Función sin crear: la misma regla desde acá. No es atómica —hay unos
    // milisegundos entre leer y escribir— pero ya no pisa lo que otros cambiaron.
    const missing = error.code === 'PGRST202' || error.code === '42883';
    if (!missing) throw new Error(`No se pudo guardar el calendario: ${error.message}`);
    console.warn('[calendario] apply_calendar_patch no existe: guardado por casillas desde el cliente.');
    const before = await readTeacherGridWith(db, teacherId);
    const r = applyChanges(before, changes);
    if (r.applied.length > 0) {
      const { error: upErr } = await db.from('teacher_calendars').upsert(
        { teacher_id: teacherId, grid: r.grid, updated_at: new Date().toISOString() },
        { onConflict: 'teacher_id' },
      );
      if (upErr) throw new Error(`No se pudo guardar el calendario: ${upErr.message}`);
    }
    return { before, after: r.grid, applied: r.applied, conflicts: r.conflicts };
  }

  const r = data as { before: Grid | null; grid: Grid | null; applied: string[] | null; conflicts: string[] | null };
  return { before: r.before ?? {}, after: r.grid ?? {}, applied: r.applied ?? [], conflicts: r.conflicts ?? [] };
}

// ── Asignaciones de un profesor (lo mínimo que necesitan historial y reconciliación) ──

interface AssignmentLite {
  id: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  slots: AssignedSlot[];
}

/** Más recientes primero: el historial se queda con la primera que coincide por nombre. */
async function assignmentsOfTeacher(db: Db, teacherId: string): Promise<AssignmentLite[]> {
  const { data, error } = await db
    .from('assignments')
    .select('id, student_id, student_name, student_email, slots')
    .eq('teacher_id', teacherId)
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return (data as Array<{ id: string; student_id: string; student_name: string; student_email: string; slots: AssignedSlot[] | null }>)
    .map(r => ({ id: r.id, studentId: r.student_id, studentName: r.student_name, studentEmail: r.student_email, slots: r.slots ?? [] }));
}

// ── Historial ─────────────────────────────────────────────────────────────────

/**
 * Escribe los movimientos en calendar_changes (tabla de SOLO AÑADIR: anon y
 * authenticated tienen insert y select, nada más). Sin la tabla, avisa y sigue.
 * `opts.assignmentId` fija la asignación de todas las filas cuando quien llama la
 * conoce (cambio de profesor); si no, se busca por nombre en ese profesor.
 * LANZA si el insert falla por otra causa.
 */
export async function logCalendarChangesWith(
  db: Db, teacherId: string, events: StudentCellEvent[], actor: CalendarActor, opts: { assignmentId?: string } = {},
): Promise<void> {
  if (events.length === 0) return;
  const [{ data: t }, assignments] = await Promise.all([
    db.from('teachers').select('name').eq('id', teacherId).maybeSingle(),
    opts.assignmentId ? Promise.resolve([] as AssignmentLite[]) : assignmentsOfTeacher(db, teacherId),
  ]);
  const asgIdOf = (name: string) => opts.assignmentId
    ?? (assignments.find(a => normKey(a.studentName) === normKey(name))
      ?? assignments.find(a => normLoose(a.studentName) === normLoose(name)))?.id
    ?? null;

  const rows = events.map(e => ({
    teacher_id:    teacherId,
    teacher_name:  (t as { name?: string } | null)?.name ?? null,
    student_name:  e.studentName,
    assignment_id: asgIdOf(e.studentName),
    day:           e.day,
    hour:          e.hour,
    action:        e.action,
    actor_role:    actor.role,
    actor_name:    actor.name,
    origin:        actor.origin,
    detail:        e.previousName ? { nombre_anterior: e.previousName } : null,
  }));
  const { error } = await db.from('calendar_changes').insert(rows);
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') {
      console.warn('[calendario] Falta la tabla calendar_changes.');
      return;
    }
    throw error;
  }
}

// ── Celdas ocupadas ───────────────────────────────────────────────────────────

export interface OcupadoCell { student: string; day: string; hour: string; }

// Extrae las celdas 'ocupado' con nombre de alumno de un grid.
export function extractOcupadoCells(grid: Grid | null | undefined): OcupadoCell[] {
  const out: OcupadoCell[] = [];
  for (const [key, cell] of Object.entries(grid ?? {})) {
    // Alumno RECURRENTE: incluye las celdas tapadas por una recuperación puntual,
    // que si no quedarían fuera de la auditoría de vínculos.
    const student = cell ? baseStudentOf(cell)?.trim() : undefined;
    if (student) {
      const [day, hour] = key.split('_');
      out.push({ student, day, hour });
    }
  }
  return out;
}

// Agrupa las celdas ocupado por nombre de alumno (normalizado), conservando el
// nombre tal como aparece y todos sus slots.
export function groupCellsByStudent(cells: OcupadoCell[]): Map<string, { name: string; slots: AssignedSlot[] }> {
  const byName = new Map<string, { name: string; slots: AssignedSlot[] }>();
  for (const c of cells) {
    const k = normKey(c.student);
    if (!byName.has(k)) byName.set(k, { name: c.student, slots: [] });
    byName.get(k)!.slots.push({ day: c.day, hour: c.hour });
  }
  return byName;
}

const DAY_ORDER_SLOTS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Clave estable de un horario, para comparar dos listas de slots sin ruido de orden. */
export function slotsKey(slots: AssignedSlot[]): string {
  return [...slots]
    .map(s => `${DAY_ORDER_SLOTS.indexOf(s.day)}|${String(parseInt(s.hour, 10)).padStart(2, '0')}`)
    .sort()
    .join(',');
}

/** Slots ordenados (día, hora) tal como se guardan en la ficha. */
export function sortSlots(slots: AssignedSlot[]): AssignedSlot[] {
  return [...slots].sort((a, b) =>
    DAY_ORDER_SLOTS.indexOf(a.day) - DAY_ORDER_SLOTS.indexOf(b.day) ||
    parseInt(a.hour, 10) - parseInt(b.hour, 10));
}

// ── El calendario manda: horario de las fichas y alta/baja ────────────────────

/**
 * EL CALENDARIO MANDA: copia a la ficha del alumno el horario que dice el grid.
 *
 * El calendario es la prueba real de qué clases existen — si el profesor y el
 * alumno acuerdan otro horario, se refleja ahí — así que `assignments.slots` es
 * un espejo suyo, no una segunda opinión. De `slots` salen la agenda del
 * profesor, las asistencias y, sobre todo, la DURACIÓN de la clase: dos horas
 * seguidas en el grid son una sesión de 2h que se paga doble. Mientras las dos
 * fuentes pudieron discrepar, hubo alumnos cobrando 2 horas con una sola celda
 * ocupada en el calendario.
 *
 * Solo toca a los alumnos que están EN el grid: al que se quedó sin celdas lo
 * gestiona el cambio de `status` (su horario se conserva como histórico). Y solo
 * escribe cuando el horario cambió de verdad, porque esto corre en cada
 * autoguardado del calendario.
 */
export async function syncSlotsFromGridWith(db: Db, teacherId: string, grid: Grid, onlyStudent?: string): Promise<number> {
  const enGrid = groupCellsByStudent(extractOcupadoCells(grid));
  if (enGrid.size === 0) return 0;

  const assignments = await assignmentsOfTeacher(db, teacherId);
  const objetivo = onlyStudent ? normKey(onlyStudent) : null;
  let actualizados = 0;

  for (const a of assignments) {
    if (objetivo && normKey(a.studentName) !== objetivo) continue;
    const desdeGrid = enGrid.get(normKey(a.studentName));
    if (!desdeGrid) continue;                                   // no está en el grid → lo ve el status
    if (slotsKey(desdeGrid.slots) === slotsKey(a.slots ?? [])) continue;   // ya coinciden

    const slots = sortSlots(desdeGrid.slots);
    const { error } = await db.from('assignments').update({
      slots,
      weekly_hours: slots.length,
      availability: slots.map(s => `${s.day} ${s.hour}`).join(', '),
    }).eq('id', a.id);

    if (error) {
      console.error(`[calendario] No se pudo sincronizar el horario de ${a.studentName} desde el calendario:`, error);
      continue;
    }
    actualizados++;
    console.log(
      `[calendario] ${a.studentName}: horario actualizado desde el calendario ` +
      `(${(a.slots ?? []).length}h → ${slots.length}h).`,
    );
  }
  return actualizados;
}

/** Alumno que acaba de quedarse SIN ninguna celda en el calendario del profesor. */
export interface StudentLeftGrid {
  assignmentId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
}

/**
 * Quita del calendario: los datos que se guardan en la asignación al perder su
 * última casilla. "Manual" = la quitó una persona desde un calendario (profesor,
 * admin, setter...); las operaciones del sistema (cambio de profesor, eliminar
 * alumno, quitar duplicado) no cuentan como quita manual.
 */
function calendarRemovalFields(actor: CalendarActor): Record<string, unknown> {
  return {
    calendar_removed_at:     new Date().toISOString(),
    calendar_removed_manual: actor.origin !== 'sistema',
    calendar_removed_by:     actor.name,
    calendar_removed_role:   actor.role,
  };
}

export const CALENDAR_REMOVAL_CLEARED = {
  calendar_removed_at: null, calendar_removed_manual: null,
  calendar_removed_by: null, calendar_removed_role: null,
};

/**
 * Marca inactivos los assignments cuyo alumno acaba de perder su ÚLTIMA celda, y
 * reactiva los de quien vuelve a tener alguna. Nunca borra: el histórico de
 * clases contadas se conserva.
 *
 * Se compara ANTES vs DESPUÉS a propósito, en vez de desactivar todo lo que no
 * esté en el grid. Un barrido general marcaría inactivos de golpe a los
 * assignments que ya estaban huérfanos de antes. Esto solo reacciona al cambio
 * real: "se liberó la última celda de X".
 *
 * Best-effort: si la columna `status` no está migrada, se avisa y sigue.
 */
export async function reconcileAssignmentStatusWith(
  db: Db, teacherId: string, before: Grid, after: Grid, actor: CalendarActor,
): Promise<StudentLeftGrid[]> {
  const namesOf = (g: Grid) => new Set(extractOcupadoCells(g).map(c => normKey(c.student)));
  const antes   = namesOf(before);
  const despues = namesOf(after);

  const liberados = [...antes].filter(n => !despues.has(n));     // perdió su última celda
  const recuperados = [...despues].filter(n => !antes.has(n));   // volvió al grid

  // El horario de los que SIGUEN en el grid también se reconcilia: ver
  // syncSlotsFromGridWith. Antes solo se miraba el alta/baja completa, así que un
  // alumno que pasaba de dos horas seguidas a una conservaba las dos en su ficha
  // para siempre — y la agenda y finanzas seguían tratándolo como clase de 2h.
  await syncSlotsFromGridWith(db, teacherId, after);

  if (liberados.length === 0 && recuperados.length === 0) return [];

  const assignments = await assignmentsOfTeacher(db, teacherId);
  const idsOf = (names: string[]) => {
    const set = new Set(names);
    return assignments.filter(a => set.has(normKey(a.studentName))).map(a => a.id);
  };

  const cambios: Array<{ ids: string[]; status: string; extra: Record<string, unknown> }> = [
    { ids: idsOf(liberados),   status: 'inactive', extra: calendarRemovalFields(actor) },
    { ids: idsOf(recuperados), status: 'active',   extra: CALENDAR_REMOVAL_CLEARED },
  ].filter(c => c.ids.length > 0);

  for (const { ids, status, extra } of cambios) {
    let { error } = await db.from('assignments').update({ status, ...extra }).in('id', ids);
    // Sin las columnas calendar_removed_* (SQL sin correr): al menos el status.
    if (error && (error.code === '42703' || error.code === 'PGRST204') && /calendar_removed/.test(error.message)) {
      console.warn('[calendario] Faltan las columnas calendar_removed_*.');
      ({ error } = await db.from('assignments').update({ status }).in('id', ids));
    }
    if (error) {
      if (error.code === '42703' || error.code === 'PGRST204') {
        console.warn(
          '[calendario] La columna assignments.status no existe todavía. ' +
          'Corré supabase-assignment-status.sql para que el calendario pueda retirar alumnos sin borrarlos.',
        );
        break;   // sin columna no hay status que reconciliar; el resto sigue igual
      }
      console.error('[calendario] No se pudo actualizar el status de los assignments:', error);
      break;
    }
    console.log(`[calendario] ${ids.length} assignment(s) de ${teacherId} marcados '${status}'.`);
  }

  // Quiénes se quedaron sin horario. El llamador decide qué hacer con ellos: si
  // su suscripción está CANCELADA se eliminan del sistema, y si no, siguen
  // asignados al profesor como "actualmente sin tomar clases". Esa decisión NO se
  // toma acá: necesita consultar WooCommerce y, cuando implica borrar, que una
  // persona lo confirme.
  const salidos = new Set(liberados);
  return assignments
    .filter(a => salidos.has(normKey(a.studentName)))
    .map(a => ({
      assignmentId: a.id,
      studentId:    a.studentId,
      studentName:  a.studentName,
      studentEmail: a.studentEmail,
    }));
}
