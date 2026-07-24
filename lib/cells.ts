import type { Cell, CellState, Grid } from '@/types';

// Estado RECURRENTE vs marca PUNTUAL de una celda del calendario.
//
// 'bloqueado' ("En recuperación") y 'reprogramada' NO son estados permanentes del
// horario: son marcas de UNA semana concreta (`weekDate` = lunes de esa semana) que
// tapan temporalmente el estado de fondo (`baseState`). El resto de las semanas la
// celda vale lo que dice `baseState`.
//
// Esto vive acá y no dentro de VisualCalendar porque hay cuatro lugares que deciden
// si un horario admite un alumno recurrente (db, setter, teacher, students) y antes
// cada uno miraba `cell.state` crudo: una recuperación puntual el martes 15/07
// bloqueaba el martes 15:00 para siempre.

const DAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** ¿El estado es una marca puntual de una sola semana? */
export function isPuntualState(state: CellState): boolean {
  return state === 'bloqueado' || state === 'reprogramada';
}

/**
 * Estado recurrente de fondo: descarta la marca puntual si la celda tiene una.
 * Sin `weekDate` no se puede saber a qué semana pertenece la marca, así que la
 * celda se toma como permanente (compatibilidad con grids viejos).
 */
export function baseStateOf(cell: Cell): CellState {
  if (isPuntualState(cell.state) && cell.weekDate) return cell.baseState ?? 'libre';
  return cell.state;
}

/**
 * Alumno RECURRENTE de la celda, ignorando al de la marca puntual. En las celdas
 * puntuales `student` es quien recupera / a quien se le movió la clase; el alumno
 * fijo del horario vive en `baseStudent`. El fallback a `student` cubre las celdas
 * creadas antes de que existiera `baseStudent` (reprogramada: mismo alumno).
 */
export function baseStudentOf(cell: Cell): string | undefined {
  if (baseStateOf(cell) !== 'ocupado') return undefined;
  if (isPuntualState(cell.state) && cell.weekDate) return cell.baseStudent ?? cell.student;
  return cell.student;
}

/** Celda resuelta a su estado recurrente: lo que se ve en las demás semanas. */
export function baseCellOf(cell: Cell): Cell {
  const state = baseStateOf(cell);
  const student = baseStudentOf(cell);
  return student ? { state, student } : { state };
}

/**
 * ¿La celda admite que se le asigne un alumno con horario RECURRENTE?
 * Sí para 'libre' y para las puntuales cuyo fondo es 'libre'. No para 'ocupado'
 * (ya hay un alumno fijo) ni 'no_work' (el profe no trabaja ese horario).
 */
export function isAssignableCell(cell: Cell | undefined): boolean {
  return !!cell && baseStateOf(cell) === 'libre';
}

/**
 * Escribe el estado RECURRENTE de una celda conservando la marca puntual que
 * tuviera encima: asignar un alumno fijo a un horario con una recuperación no
 * borra esa recuperación, que sigue pintada en su semana. Para reemplazar la celda
 * entera (borrar la marca) se asigna el objeto directamente, sin este helper.
 */
export function withBaseState(prev: Cell | undefined, state: CellState, student?: string): Cell {
  const named = state === 'ocupado' ? student : undefined;
  if (prev && isPuntualState(prev.state) && prev.weekDate) {
    return { ...prev, baseState: state, baseStudent: named };
  }
  return named ? { state, student: named } : { state };
}

/** Keys `${day}_${hour}` del grid que admiten un alumno recurrente. */
export function assignableCellKeys(grid: Grid): string[] {
  return Object.entries(grid).filter(([, cell]) => isAssignableCell(cell)).map(([key]) => key);
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Fecha real (YYYY-MM-DD) de la marca puntual de la celda: lunes de `weekDate`
 * desplazado al día de la key. Null si la celda no tiene marca puntual.
 */
export function puntualDateOf(key: string, cell: Cell): string | null {
  if (!isPuntualState(cell.state) || !cell.weekDate) return null;
  const usc = key.lastIndexOf('_');
  if (usc < 0) return null;
  const dayIdx = DAY_ORDER.indexOf(key.slice(0, usc));
  if (dayIdx < 0) return null;
  const monday = new Date(cell.weekDate + 'T00:00:00');
  if (isNaN(monday.getTime())) return null;
  const date = new Date(monday);
  date.setDate(monday.getDate() + dayIdx);
  return toISO(date);
}

/**
 * Mapa key → fecha de la marca puntual, solo para las celdas que además siguen
 * siendo asignables. Alimenta el aviso "tiene una recuperación puntual el X".
 */
export function puntualCellDates(grid: Grid): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, cell] of Object.entries(grid)) {
    if (!isAssignableCell(cell)) continue;
    const date = puntualDateOf(key, cell);
    if (date) out[key] = date;
  }
  return out;
}

/** 'YYYY-MM-DD' → 'DD/MM' para los avisos de la UI. */
export function formatPuntualDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return d && m ? `${d}/${m}` : iso;
}
