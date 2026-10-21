// Búsqueda de la pantalla Setter > Buscar: cruza los días y horas elegidos con
// la disponibilidad que ya trae cada profesor (`libreCells`, ver lib/db y
// lib/cells). Puro y sin red: todo se calcula en pantalla con lo que ya está en
// memoria, no se pide nada nuevo a Supabase ni se toca cómo se guarda nada.
//
// Una "franja" es cada cosa que el setter pidió que el profesor tenga libre:
//   · Día + hora → cada combinación día × hora (2 días × 3 horas = 6 franjas).
//   · Solo día   → cada día; cuenta si tiene AL MENOS una hora libre ese día.
//   · Solo hora  → cada hora; cuenta si está libre a esa hora ALGÚN día.
// En "Día + hora" con solo días elegidos se comporta como "Solo día", y con solo
// horas como "Solo hora".
import type { AssignedSlot, Teacher, TeacherStatus } from '@/types';

export type SearchMode = 'dayhour' | 'day' | 'hour';
export type Coverage = 'all' | 'any';
export type SortKey = 'suggested' | 'spots' | 'load' | 'name';

// Los días que tiene el calendario del profesor (VisualCalendar.DAYS). El
// domingo NO está: quedan celdas viejas de 'Domingo' en algunos grids que el
// profesor no puede ver ni editar, y contarlas mostraría huecos fantasma.
export const SEARCH_DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'] as const;

export const DAY_SHORT: Record<string, string> = {
  Lunes: 'Lun', Martes: 'Mar', Miércoles: 'Mié', Jueves: 'Jue', Viernes: 'Vie', Sábado: 'Sáb',
};

/** Estados que se pueden filtrar. 'no_availability' / 'vacation' nunca salen: no se les puede asignar nada. */
export const FILTER_STATUSES = ['available', 'almost_full', 'busy'] as const;
export type FilterStatus = typeof FILTER_STATUSES[number];
export const DEFAULT_STATUSES: FilterStatus[] = ['available', 'almost_full'];

const STATUS_RANK: Partial<Record<TeacherStatus, number>> = { available: 0, almost_full: 1, busy: 2 };

export interface SetterQuery {
  mode: SearchMode;
  days: string[];
  hours: string[];        // 'HH:00'
  coverage: Coverage;
  name: string;
  specialties: string[];  // vacío = Todas; si hay varias, el profesor tiene que tener todas
  statuses: FilterStatus[];
}

export interface Franja {
  key: string;
  label: string;   // "Lun 18:00" · "Lun" · "18:00"
  free: boolean;
}

export interface TeacherMatch {
  teacher: Teacher;
  matched: number;
  total: number;
  franjas: Franja[];
  /** Celdas concretas libres que justifican las franjas (para resaltar en el calendario y los avisos ♻️). */
  freeCells: AssignedSlot[];
}

const byHour = (a: string, b: string) => parseInt(a) - parseInt(b);
const byDay = (a: string, b: string) =>
  SEARCH_DAYS.indexOf(a as typeof SEARCH_DAYS[number]) - SEARCH_DAYS.indexOf(b as typeof SEARCH_DAYS[number]);

/** Días y horas que de verdad entran en juego según el modo (el bloque atenuado no cuenta). */
export function activeSelection(q: Pick<SetterQuery, 'mode' | 'days' | 'hours'>): {
  mode: SearchMode | 'none'; days: string[]; hours: string[];
} {
  const days  = q.mode === 'hour' ? [] : [...q.days].sort(byDay);
  const hours = q.mode === 'day'  ? [] : [...q.hours].sort(byHour);
  if (days.length && hours.length) return { mode: 'dayhour', days, hours };
  if (days.length)  return { mode: 'day', days, hours: [] };
  if (hours.length) return { mode: 'hour', days: [], hours };
  return { mode: 'none', days: [], hours: [] };
}

function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf('_');
  return [key.slice(0, i), key.slice(i + 1)];
}

export function matchTeacher(t: Teacher, q: Pick<SetterQuery, 'mode' | 'days' | 'hours'>): TeacherMatch {
  const sel = activeSelection(q);
  const libre = new Set(t.libreCells ?? []);
  const franjas: Franja[] = [];
  const freeCells: AssignedSlot[] = [];

  if (sel.mode === 'dayhour') {
    for (const day of sel.days) for (const hour of sel.hours) {
      const free = libre.has(`${day}_${hour}`);
      franjas.push({ key: `${day}_${hour}`, label: `${DAY_SHORT[day] ?? day} ${hour}`, free });
      if (free) freeCells.push({ day, hour });
    }
  } else if (sel.mode === 'day') {
    const daySet = new Set(sel.days);
    const byDayHours = new Map<string, string[]>();
    for (const key of libre) {
      const [day, hour] = splitKey(key);
      if (!daySet.has(day)) continue;
      byDayHours.set(day, [...(byDayHours.get(day) ?? []), hour]);
    }
    for (const day of sel.days) {
      const hrs = (byDayHours.get(day) ?? []).sort(byHour);
      franjas.push({ key: day, label: DAY_SHORT[day] ?? day, free: hrs.length > 0 });
      for (const hour of hrs) freeCells.push({ day, hour });
    }
  } else if (sel.mode === 'hour') {
    for (const hour of sel.hours) {
      const dys = SEARCH_DAYS.filter(d => libre.has(`${d}_${hour}`));
      franjas.push({ key: hour, label: hour, free: dys.length > 0 });
      for (const day of dys) freeCells.push({ day, hour });
    }
  }

  return { teacher: t, matched: franjas.filter(f => f.free).length, total: franjas.length, franjas, freeCells };
}

function compare(a: TeacherMatch, b: TeacherMatch, sort: SortKey): number {
  const name = a.teacher.name.localeCompare(b.teacher.name, 'es');
  switch (sort) {
    case 'name':  return name;
    case 'spots': return b.teacher.freeSpots - a.teacher.freeSpots || name;
    case 'load':  return a.teacher.weeklyLoad - b.teacher.weeklyLoad || name;
    default:
      // Sugerido: más franjas cubiertas → mejor estado → más cupos.
      return b.matched - a.matched
        || (STATUS_RANK[a.teacher.status] ?? 9) - (STATUS_RANK[b.teacher.status] ?? 9)
        || b.teacher.freeSpots - a.teacher.freeSpots
        || name;
  }
}

export function searchTeachers(teachers: Teacher[], q: SetterQuery, sort: SortKey): TeacherMatch[] {
  const name = q.name.trim().toLowerCase();
  return teachers
    .filter(t => (q.statuses as TeacherStatus[]).includes(t.status))
    .filter(t => !name || t.name.toLowerCase().includes(name))
    .filter(t => q.specialties.every(sp => (t.specialties ?? []).includes(sp)))
    .map(t => matchTeacher(t, q))
    .filter(m => m.total === 0 || (q.coverage === 'all' ? m.matched === m.total : m.matched > 0))
    .sort((a, b) => compare(a, b, sort));
}

/** Primer profesor de la lista al que se le puede asignar: ni Completo, ni bloqueado, ni sin cupos. */
export function pickRecommended(rows: TeacherMatch[]): TeacherMatch | undefined {
  return rows.find(m => m.teacher.status !== 'busy' && !m.teacher.isBlocked && m.teacher.freeSpots > 0);
}
