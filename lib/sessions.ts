// ── Sesiones de varias horas: celdas contiguas = UNA sola clase larga ─────────
//
// REGLA (estricta, sin que el profesor marque nada): dos o más celdas del MISMO
// alumno, el MISMO día, en horas consecutivas (17:00 y 18:00) son UNA sesión de
// N horas. Una sesión tiene UN enlace de Meet, UN acceso (class_join_log), UN
// transcript y UNA validación; para finanzas y para el límite mensual del alumno
// vale N (`billingUnits`), porque las tarifas y los límites (1h→5, 2h→9, 3h→14…)
// están expresados en HORAS.
//
// Acá viven solo las primitivas de horas, sin tipos de dominio, para que las
// compartan los cinco sitios que agrupan: la expansión de clases
// (lib/teacherClasses), las asistencias (lib/attendance), la liquidación
// (lib/finance), el calendario (components/VisualCalendar) y la auditoría del
// admin (lib/db). Si cada uno dedujera la contigüidad por su cuenta volveríamos a
// tener cinco respuestas distintas a "¿cuánto dura esta clase?", que es justo el
// problema que hace que hoy una sesión de 2h se pague como 1.

/** Verde y amarillo DRC del badge de duración. */
export const DRC_GREEN = '#1E9E3A';
export const DRC_YELLOW = '#FFC400';

/** 'HH:00' | 'HH' | 'H' → 17. NaN si no parsea. */
export function hourNum(hour: string | number | undefined | null): number {
  if (typeof hour === 'number') return Number.isFinite(hour) ? Math.trunc(hour) : NaN;
  return parseInt((hour ?? '').trim(), 10);
}

/** 17 → '17:00'. */
export function hourText(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

/** Nombre normalizado del alumno: el grid lo guarda como texto libre. */
export function nkName(name: string | undefined | null): string {
  return (name ?? '').trim().toLowerCase();
}

/** ¿`b` empieza justo cuando termina `a`? (17:00 → 18:00) */
export function isNextHour(a: string | number, b: string | number): boolean {
  const x = hourNum(a), y = hourNum(b);
  return Number.isFinite(x) && Number.isFinite(y) && y === x + 1;
}

/**
 * Longitud de la racha de horas CONSECUTIVAS que contiene `anchor`.
 * Devuelve 0 si `anchor` no está en la lista (no se inventa la sesión).
 *   [12,13,15] · anchor 12 → 2      [12,13,15] · anchor 15 → 1
 *   [14,18]    · anchor 14 → 1      []         · anchor 14 → 0
 *
 * Es la pieza que decide cuánto vale una clase en finanzas, así que solo cuenta
 * horas REALMENTE pegadas: dos clases sueltas el mismo día (14:00 y 18:00) no
 * forman una sesión, porque un único acceso no puede dar fe de las dos.
 */
export function contiguousRunLength(hours: Array<number | string>, anchor: number | string): number {
  const a = hourNum(anchor);
  if (!Number.isFinite(a)) return 0;
  const set = new Set<number>();
  for (const h of hours) {
    const n = hourNum(h);
    if (Number.isFinite(n)) set.add(n);
  }
  if (!set.has(a)) return 0;
  let start = a;
  while (set.has(start - 1)) start--;
  let end = a;
  while (set.has(end + 1)) end++;
  return end - start + 1;
}

/** Primera hora de la racha contigua que contiene `anchor` (el propio anchor si no está). */
export function runStartHour(hours: Array<number | string>, anchor: number | string): number {
  const a = hourNum(anchor);
  if (!Number.isFinite(a)) return a;
  const set = new Set<number>();
  for (const h of hours) {
    const n = hourNum(h);
    if (Number.isFinite(n)) set.add(n);
  }
  if (!set.has(a)) return a;
  let start = a;
  while (set.has(start - 1)) start--;
  return start;
}

/**
 * Identificador ESTABLE de la sesión. No se persiste en ninguna tabla: se
 * recalcula igual en cada pantalla a partir de datos que ya existen, así que no
 * puede desincronizarse de la realidad del calendario.
 */
export function sessionIdOf(
  teacherId: string, studentName: string, dateIso: string, startHour: string | number,
): string {
  const h = hourNum(startHour);
  return `${teacherId}|${nkName(studentName)}|${dateIso}|${Number.isFinite(h) ? hourText(h) : startHour}`;
}

/** "17:00 - 19:00" para una sesión de 2h; "17:00" para una de 1h. */
export function sessionRangeLabel(startHour: string | number, durationHours: number): string {
  const h = hourNum(startHour);
  if (!Number.isFinite(h)) return String(startHour ?? '');
  if (durationHours <= 1) return hourText(h);
  return `${hourText(h)} - ${hourText(h + durationHours)}`;
}

/** "2h" / "3h". null si dura una hora: ahí no se muestra badge. */
export function durationBadgeLabel(durationHours: number): string | null {
  return durationHours > 1 ? `${durationHours}h` : null;
}

/**
 * Agrupa una lista en rachas de horas consecutivas. `sameSession` decide qué
 * elementos pueden encadenarse (mismo alumno, mismo día…); `hourOf` da la hora.
 * No ordena por fecha: eso lo hace el llamador, que es quien sabe su modelo.
 */
export function groupByContiguousHour<T>(
  items: T[],
  hourOf: (item: T) => string | number,
  sameSession: (prev: T, next: T) => boolean,
): T[][] {
  const sorted = [...items].sort((a, b) => hourNum(hourOf(a)) - hourNum(hourOf(b)));
  const runs: T[][] = [];
  let run: T[] = [];
  for (const item of sorted) {
    const prev = run[run.length - 1];
    if (prev && sameSession(prev, item) && isNextHour(hourOf(prev), hourOf(item))) {
      run.push(item);
    } else {
      if (run.length) runs.push(run);
      run = [item];
    }
  }
  if (run.length) runs.push(run);
  return runs;
}
