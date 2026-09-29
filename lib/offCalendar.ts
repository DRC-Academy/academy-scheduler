import type { Assignment, AssignedSlot, Grid } from '@/types';
import { baseStateOf, baseStudentOf } from '@/lib/cells';
import { normLoose, splitCellKey } from '@/lib/gridPatch';

// ALUMNOS FUERA DE CALENDARIO
//
// Una asignación dice "este alumno es de este profesor", pero el calendario del
// profesor (teacher_calendars.grid) identifica a sus alumnos SOLO por el nombre
// escrito en cada casilla. Cuando las dos fuentes no coinciden, en Alumnos el
// alumno figura con un profesor en cuyo calendario no está.
//
// Este módulo es la misma lógica que la consulta de diagnóstico de sep/2026,
// en puro (sin Supabase): la usan la pestaña "Fuera de calendario" del admin y
// el aviso "(fuera de calendario)" de Alumnos.

/** Profesor de prueba "Sebastian (test)": sus alumnos no se listan. */
export const OFF_CALENDAR_EXCLUDED_TEACHERS = new Set(['t1']);

const VISIBLE_DAYS = new Set(['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']);

/** Lo mismo que el cruce de lib/db.ts: trim + minúsculas. */
const normKey = (x: unknown): string => String(x ?? '').trim().toLowerCase();

/** ¿La casilla se dibuja en el calendario? (día mostrado y hora 00–23). */
function isVisibleKey(key: string): boolean {
  const p = splitCellKey(key);
  if (!p || !VISIBLE_DAYS.has(p.day)) return false;
  const m = /^(\d{1,2})(:\d{2})?$/.exec(p.hour);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  return h >= 0 && h <= 23;
}

export type OffCalendarCause =
  /** Está en su calendario, pero en una casilla que la pantalla no dibuja. */
  | { kind: 'oculto'; keys: string[] }
  /** Está en su calendario con el nombre escrito distinto (tildes, espacios...). */
  | { kind: 'nombre_distinto'; gridNames: string[] }
  /** Aparece en el calendario de OTRO profesor. */
  | { kind: 'otro_profesor'; others: Array<{ teacherId: string; teacherName: string; gridName: string }> }
  /** Su profesor no tiene ningún calendario guardado. */
  | { kind: 'sin_calendario' }
  /** No está en ningún calendario. `tuvo` = la asignación está inactiva: tuvo casillas y las perdió. */
  | { kind: 'sin_horario'; tuvo: boolean };

/** Cómo está hoy, en el calendario de su profesor, cada horario de la ficha. */
export interface SlotStatus extends AssignedSlot {
  state: 'libre' | 'ocupado' | 'no_work' | 'sin_casilla';
  /** Quién ocupa la casilla, si está ocupada. */
  occupant?: string;
}

export interface OffCalendarRow {
  assignment: Assignment;
  teacherName: string;
  cause: OffCalendarCause;
  slotStatus: SlotStatus[];
}

/** Estado de una casilla para restaurar: solo 'libre' admite al alumno. */
export function slotStatusOf(grid: Grid, slot: AssignedSlot): SlotStatus {
  const cell = grid[`${slot.day}_${slot.hour}`];
  if (!cell) return { ...slot, state: 'sin_casilla' };
  const base = baseStateOf(cell);
  if (base === 'ocupado') return { ...slot, state: 'ocupado', occupant: baseStudentOf(cell) };
  if (base === 'libre') return { ...slot, state: 'libre' };
  return { ...slot, state: 'no_work' };
}

/**
 * Asignaciones (activas e inactivas) cuyo alumno no se ve en el calendario de su
 * profesor. `grids` tiene SOLO a los profesores con fila en teacher_calendars.
 */
export function findOffCalendar(params: {
  assignments: Assignment[];
  grids: Map<string, Grid>;
  teacherNames: Map<string, string>;
  /** Nombre en la ficha de Alumnos (students.name) por id, para el cruce tolerante. */
  studentNames?: Map<string, string>;
  exclude?: Set<string>;
}): OffCalendarRow[] {
  const { assignments, grids, teacherNames, studentNames, exclude = OFF_CALENDAR_EXCLUDED_TEACHERS } = params;

  // Por profesor: casillas con alumno recurrente (nombre tal cual + clave).
  const cellsByTeacher = new Map<string, Array<{ key: string; name: string }>>();
  for (const [teacherId, grid] of grids) {
    const list: Array<{ key: string; name: string }> = [];
    for (const [key, cell] of Object.entries(grid ?? {})) {
      const name = cell ? baseStudentOf(cell)?.trim() : undefined;
      if (name) list.push({ key, name });
    }
    cellsByTeacher.set(teacherId, list);
  }

  const out: OffCalendarRow[] = [];
  for (const a of assignments) {
    if (exclude.has(a.teacherId)) continue;
    const k = normKey(a.studentName);
    const loose = new Set([normLoose(a.studentName)]);
    const alt = studentNames?.get(a.studentId);
    if (alt) loose.add(normLoose(alt));

    const own = cellsByTeacher.get(a.teacherId);
    const ownExact = (own ?? []).filter(c => normKey(c.name) === k);
    if (ownExact.some(c => isVisibleKey(c.key))) continue;   // se ve: todo bien

    const grid = grids.get(a.teacherId) ?? {};
    const slotStatus = (a.slots ?? []).map(s => slotStatusOf(grid, s));
    const teacherName = teacherNames.get(a.teacherId) ?? a.teacherName;
    const push = (cause: OffCalendarCause) => out.push({ assignment: a, teacherName, cause, slotStatus });

    if (ownExact.length > 0) { push({ kind: 'oculto', keys: ownExact.map(c => c.key) }); continue; }

    const ownLoose = [...new Set((own ?? []).filter(c => loose.has(normLoose(c.name))).map(c => c.name))];
    if (ownLoose.length > 0) { push({ kind: 'nombre_distinto', gridNames: ownLoose }); continue; }

    const others: Array<{ teacherId: string; teacherName: string; gridName: string }> = [];
    for (const [tid, cells] of cellsByTeacher) {
      if (tid === a.teacherId) continue;
      const hit = cells.find(c => loose.has(normLoose(c.name)));
      if (hit) others.push({ teacherId: tid, teacherName: teacherNames.get(tid) ?? tid, gridName: hit.name });
    }
    if (others.length > 0) { push({ kind: 'otro_profesor', others }); continue; }

    if (!grids.has(a.teacherId)) { push({ kind: 'sin_calendario' }); continue; }
    push({ kind: 'sin_horario', tuvo: (a.status ?? 'active') !== 'active' });
  }
  return out;
}

/** Texto corto de la causa, para la tabla del admin. */
export function causeLabel(c: OffCalendarCause): string {
  switch (c.kind) {
    case 'oculto':          return `Está en su calendario en una casilla que no se ve (${c.keys.join(', ')})`;
    case 'nombre_distinto': return `En su calendario con el nombre escrito distinto: "${c.gridNames.join('" / "')}"`;
    case 'otro_profesor':   return `Está con otro profesor: ${c.others.map(o => o.teacherName).join(', ')}`;
    case 'sin_calendario':  return 'Su profesor no tiene calendario guardado';
    case 'sin_horario':     return c.tuvo
      ? 'Tuvo horario y se lo quitaron'
      : 'Nunca apareció en el calendario (o se lo quitaron antes de sep/2026)';
  }
}

// ── "(fuera de calendario)" en Alumnos ─────────────────────────────────────────

const ROLE_LABEL: Record<string, string> = { teacher: 'profesor', admin: 'admin', setter: 'setter', sistema: 'sistema' };

/** 'YYYY-MM-DDTHH…' → 'DD/MM/YYYY' en hora de España. */
function fechaEs(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/** ¿La asignación está fuera del calendario? Hoy: status 'inactive'. */
export function isOffCalendar(a: Assignment): boolean {
  return (a.status ?? 'active') !== 'active';
}

/** Quién y cuándo sacó al alumno del calendario, en una frase. */
export function removalText(a: Assignment): string {
  if (!a.calendarRemovedAt) return 'No hay registro de quién ni cuándo lo quitó (fue antes de sep/2026).';
  const cuando = fechaEs(a.calendarRemovedAt);
  if (a.calendarRemovedManual === false) return `Salió del calendario por una operación del sistema el ${cuando}.`;
  const rol = a.calendarRemovedRole ? ` (${ROLE_LABEL[a.calendarRemovedRole] ?? a.calendarRemovedRole})` : '';
  return `Lo quitó ${a.calendarRemovedBy ?? 'alguien'}${rol} del calendario el ${cuando}.`;
}
