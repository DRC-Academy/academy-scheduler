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

/**
 * ¿El nombre de una celda corresponde a este alumno? Match TOLERANTE por nombre
 * completo o nombre de pila (la celda puede guardar solo "Ana"). OJO: es laxo a
 * propósito y puede confundir a dos alumnos con el mismo nombre de pila ("Ana
 * López" y "Ana María"); por eso nunca decide sola qué celda ocupar.
 */
export function cellIsStudentLoose(cellStudent: string | undefined, studentName: string): boolean {
  const nk = (x: unknown): string => String(x ?? '').trim().toLowerCase();
  const cs = nk(cellStudent);
  if (!cs) return false;
  const full  = nk(studentName);
  const first = nk(studentName.split(' ')[0]);
  return cs === full || cs === first || full.startsWith(cs) || cs.startsWith(first);
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

// ── Hueco libre para el ALUMNO (operaciones con origen 'lms') ─────────────────
//
// ÚNICO criterio de "libre" para todo lo que pide el alumno desde el LMS (cambio
// de profesor, cambio de horario puntual o desde una fecha). Ninguna otra parte
// del código debe repetir esta condición: se llama a esta función.
//
// Es más estricto que isAssignableCell, que sigue mandando para admin, setter y
// scripts. Diferencias:
//   · rango: aquí la hora tiene que estar dentro de calendar_start_hour..
//     calendar_end_hour (ambos incluidos, por defecto 9..22). isAssignableCell no
//     mira el rango.
//   · marcas puntuales: isAssignableCell acepta una casilla 'bloqueado' o
//     'reprogramada' cuyo fondo es 'libre', sea de la semana que sea. Aquí no vale
//     si la marca cae en la semana afectada (o en una posterior, en un cambio
//     "desde"): ese día la casilla no está libre.
//   · reservas: isAssignableCell no conoce class_recoveries; aquí una reserva viva
//     (teacher_proposals en 'esperando_alumno') tapa la hora.
//   · la sesión propia: isAssignableCell nunca acepta una casilla 'ocupado'; aquí
//     se puede admitir la del mismo alumno cuando se desplaza su sesión con el
//     mismo profesor (14-16 → 15-17).
// Coinciden en lo demás: sin pintar y 'no_work' nunca son libres.
//
// Función PURA: las reservas y el rango los carga quien llama.

export type MotivoHuecoNoLibre =
  | 'clave_invalida'   // no es 'Lunes'..'Sábado' + 'HH:00' entre 00 y 23
  | 'fuera_de_rango'   // fuera de calendar_start_hour..calendar_end_hour
  | 'sin_pintar'       // la casilla no existe en el grid (vale 'no_work')
  | 'no_work'
  | 'ocupado'          // otro alumno recurrente (o el mismo fuera de la excepción)
  | 'en_recuperacion'  // marca 'bloqueado' en la semana afectada
  | 'reprogramada'     // marca 'reprogramada' en la semana afectada
  | 'reservado';       // reserva viva de una recuperación

export type ResultadoHueco = { libre: true } | { libre: false; motivo: MotivoHuecoNoLibre };

export interface ContextoHuecoAlumno {
  /** teachers.calendar_start_hour / calendar_end_hour; null o ausente → 9 / 22. */
  horaInicio?: number | null;
  horaFin?: number | null;
  /**
   * A qué clases afecta la operación:
   *   · 'puntual' → solo la clase de `fecha`;
   *   · 'desde'   → todas las semanas a partir de `fecha` (la primera clase con el
   *                 horario nuevo). Un cambio de profesor es 'desde'.
   * Fechas 'YYYY-MM-DD', calendario de España.
   */
  alcance: { tipo: 'puntual' | 'desde'; fecha: string };
  /** Reservas vivas del profesor destino (reservationsOf de classRecoveryStore). */
  reservas: ReadonlyArray<{ date: string; hour: string }>;
  /**
   * ÚNICA excepción: cambio de horario con el MISMO profesor. Se aceptan como
   * destino las casillas de `claves` (las de la sesión que se mueve) ocupadas por
   * `alumno`. Para un cambio de profesor no se pasa nunca.
   */
  sesionPropia?: { alumno: string; claves: readonly string[] };
}

export const HORA_INICIO_POR_DEFECTO = 9;
export const HORA_FIN_POR_DEFECTO = 22;

const normNombre = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

/** Día de la semana ('Lunes'..'Domingo') de una fecha ISO, sin depender de la zona del proceso. */
function diaDeIso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
  return dow === 0 ? 'Domingo' : DAY_ORDER[dow - 1];
}

/** Lunes ('YYYY-MM-DD') de la semana de una fecha ISO. */
function lunesDeIso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay();
  t.setUTCDate(t.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return t.toISOString().slice(0, 10);
}

/**
 * ¿La casilla `clave` ('Martes_15:00') del grid del profesor DESTINO es un hueco
 * válido para el alumno? Criterio estricto: estado efectivo 'libre' pintado por
 * el profesor, dentro de su rango y sin reserva viva. Para una sesión de varias
 * horas se llama una vez por casilla.
 */
export function esHuecoLibreParaAlumno(grid: Grid, clave: string, ctx: ContextoHuecoAlumno): ResultadoHueco {
  const no = (motivo: MotivoHuecoNoLibre): ResultadoHueco => ({ libre: false, motivo });

  const usc = clave.lastIndexOf('_');
  const dia = usc > 0 ? clave.slice(0, usc) : '';
  const hora = usc > 0 ? clave.slice(usc + 1) : '';
  const h = /^\d{2}:00$/.test(hora) ? Number(hora.slice(0, 2)) : NaN;
  if (!DAY_ORDER.includes(dia) || !(h >= 0 && h <= 23)) return no('clave_invalida');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx.alcance.fecha)) return no('clave_invalida');
  // Una operación puntual tiene que caer el mismo día de la semana que la casilla.
  if (ctx.alcance.tipo === 'puntual' && diaDeIso(ctx.alcance.fecha) !== dia) return no('clave_invalida');

  const desde = ctx.horaInicio ?? HORA_INICIO_POR_DEFECTO;
  const hasta = ctx.horaFin ?? HORA_FIN_POR_DEFECTO;
  if (h < desde || h > hasta) return no('fuera_de_rango');

  const raw = grid[clave];
  if (!raw) return no('sin_pintar');

  // Estado efectivo en las semanas afectadas.
  let efectiva: Cell = raw;
  if (isPuntualState(raw.state)) {
    if (!raw.weekDate) return no(raw.state === 'bloqueado' ? 'en_recuperacion' : 'reprogramada'); // marca sin semana: permanente
    const lunes = lunesDeIso(ctx.alcance.fecha);
    const afecta = ctx.alcance.tipo === 'puntual' ? raw.weekDate === lunes : raw.weekDate >= lunes;
    if (afecta) return no(raw.state === 'bloqueado' ? 'en_recuperacion' : 'reprogramada');
    efectiva = baseCellOf(raw); // marca de otra semana (pasada): no cuenta
  }

  if (efectiva.state === 'no_work') return no('no_work');
  if (efectiva.state === 'ocupado') {
    const propia = ctx.sesionPropia;
    const esPropia = !!propia && propia.claves.includes(clave)
      && normNombre(efectiva.student) !== '' && normNombre(efectiva.student) === normNombre(propia.alumno);
    if (!esPropia) return no('ocupado');
  } else if (efectiva.state !== 'libre') {
    return no('ocupado'); // estado desconocido: nunca se ofrece
  }

  const reservada = ctx.reservas.some(r =>
    r.hour === hora && (ctx.alcance.tipo === 'puntual'
      ? r.date === ctx.alcance.fecha
      : r.date >= ctx.alcance.fecha && diaDeIso(r.date) === dia));
  if (reservada) return no('reservado');

  return { libre: true };
}

/** 'YYYY-MM-DD' → 'DD/MM' para los avisos de la UI. */
export function formatPuntualDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return d && m ? `${d}/${m}` : iso;
}
