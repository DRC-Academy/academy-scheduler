import type { Cell, Grid } from '@/types';
import { baseStudentOf } from '@/lib/cells';

// GUARDADO DEL CALENDARIO POR CASILLAS (no por grid entero).
//
// Hasta sep/2026 cada guardado mandaba el grid COMPLETO que tenía la pantalla en
// memoria, y ganaba el último que guardaba: una pestaña abierta desde hacía horas
// borraba a los alumnos que el setter había asignado mientras tanto, y el admin
// editando desde Alumnos con una copia vieja "revivía" a alumnos que el profesor
// ya había quitado. Ahora la pantalla manda solo las casillas que tocó, cada una
// con el valor que tenía cuando la pantalla la cargó (`expected`). La base
// (función apply_calendar_patch, supabase-calendar-history.sql) aplica cada
// casilla solo si nadie la cambió desde entonces; si alguien la cambió, esa
// casilla vuelve como conflicto y NO se pisa.
//
// Módulo puro: sin Supabase, para poder probarlo.

/** Una casilla tocada: lo que la pantalla vio y lo que quiere dejar. null = sin casilla. */
export interface CellChange {
  expected: Cell | null;
  next: Cell | null;
}

export type GridChanges = Record<string, CellChange>;

/**
 * Forma canónica de una casilla para compararla: sin campos undefined/null y con
 * las claves ordenadas. Es lo mismo que ve Postgres: JSON.stringify descarta los
 * undefined y jsonb ignora el orden de las claves.
 */
function canonical(cell: Cell | null | undefined): string {
  if (!cell) return '';
  const entries = Object.entries(cell)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

export function cellsEqual(a: Cell | null | undefined, b: Cell | null | undefined): boolean {
  return canonical(a) === canonical(b);
}

/** Copia de la casilla sin campos undefined, lista para mandar como JSON. */
function clean(cell: Cell | null | undefined): Cell | null {
  if (!cell) return null;
  return JSON.parse(JSON.stringify(cell)) as Cell;
}

/** Casillas que cambiaron entre lo que la pantalla tenía (`prev`) y lo que quiere (`next`). */
export function diffGrids(prev: Grid, next: Grid): GridChanges {
  const out: GridChanges = {};
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
  for (const key of keys) {
    const a = prev?.[key];
    const b = next?.[key];
    if (cellsEqual(a, b)) continue;
    out[key] = { expected: clean(a), next: clean(b) };
  }
  return out;
}

/**
 * Aplica los cambios sobre el grid actual con la MISMA regla que la función de
 * la base: cada casilla solo si sigue valiendo lo que la pantalla vio. Es el
 * respaldo cuando la función no está (SQL sin correr) y lo que prueban los tests.
 */
export function applyChanges(current: Grid, changes: GridChanges): { grid: Grid; applied: string[]; conflicts: string[] } {
  const grid: Grid = { ...current };
  const applied: string[] = [];
  const conflicts: string[] = [];
  for (const [key, ch] of Object.entries(changes)) {
    if (!cellsEqual(grid[key], ch.expected)) { conflicts.push(key); continue; }
    if (ch.next) grid[key] = ch.next; else delete grid[key];
    applied.push(key);
  }
  return { grid, applied, conflicts };
}

/** 'Lunes_14:00' → { day: 'Lunes', hour: '14:00' }. Null si la clave no tiene esa forma. */
export function splitCellKey(key: string): { day: string; hour: string } | null {
  const usc = key.lastIndexOf('_');
  if (usc <= 0) return null;
  return { day: key.slice(0, usc), hour: key.slice(usc + 1) };
}

/**
 * Nombre normalizado TOLERANTE: sin tildes, minúsculas, espacios colapsados.
 * La app cruza grid ↔ assignments solo con trim+lower (normKey de lib/db.ts);
 * esto sirve para DETECTAR los nombres que ese cruce no reconoce ("María" vs
 * "Maria", dobles espacios), nunca para decidir pertenencia.
 */
export function normLoose(x: unknown): string {
  return String(x ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Movimiento de un alumno RECURRENTE en una casilla, para el historial. */
export interface StudentCellEvent {
  key: string;
  day: string;
  hour: string;
  action: 'agregado' | 'quitado' | 'renombrado';
  studentName: string;
  /** Solo en 'renombrado': cómo estaba escrito antes. */
  previousName?: string;
}

/**
 * Qué alumnos entraron, salieron o cambiaron de grafía en las casillas `keys`,
 * comparando el grid de antes con el de después. Mira al alumno RECURRENTE
 * (baseStudentOf): pintar o quitar una recuperación puntual no es alta ni baja.
 */
export function studentEvents(before: Grid, after: Grid, keys: string[]): StudentCellEvent[] {
  const out: StudentCellEvent[] = [];
  for (const key of keys) {
    const pos = splitCellKey(key);
    if (!pos) continue;
    const oldS = (before[key] ? baseStudentOf(before[key]) : undefined)?.trim() || undefined;
    const newS = (after[key] ? baseStudentOf(after[key]) : undefined)?.trim() || undefined;
    if (oldS === newS) continue;
    if (oldS && newS && normLoose(oldS) === normLoose(newS)) {
      out.push({ key, ...pos, action: 'renombrado', studentName: newS, previousName: oldS });
      continue;
    }
    if (oldS) out.push({ key, ...pos, action: 'quitado', studentName: oldS });
    if (newS) out.push({ key, ...pos, action: 'agregado', studentName: newS });
  }
  return out;
}
