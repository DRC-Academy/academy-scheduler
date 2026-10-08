// ── Horario de un alumno en una fecha PASADA ─────────────────────────────────
//
// El horario recurrente (`assignments.slots`, espejo del calendario) no tiene
// fechas: es el de HOY. Proyectarlo hacia atrás está bien mientras no cambie,
// pero tras un cambio de horario fijo (lo haga el profesor en su calendario o el
// alumno desde el LMS) los martes pasados desaparecían y los jueves pasados
// salían como "🔴 No ingresó", aunque esos jueves todavía no tuviera clase.
//
// calendar_changes guarda cada alta ('agregado') y baja ('quitado') de una
// casilla recurrente con su instante. Partiendo del horario de hoy y deshaciendo
// los cambios POSTERIORES a una fecha, sale el horario que tenía ese día.
//
// Límites, a propósito:
//   · calendar_changes existe desde el 29/09/2026 y TeachersContext solo carga
//     los últimos días (SLOT_CHANGES_DIAS): antes de eso se proyecta el horario
//     de hoy, como siempre.
//   · Granularidad de DÍA: vale el horario que tenía a las 00:00 (España) de esa
//     fecha. Un cambio a media mañana cuenta desde el día siguiente. El
//     autoservicio exige más de 24 h para la primera clase nueva y para la
//     última vieja, así que ahí no cambia nada.
//   · 'renombrado' no cambia horas: se ignora.
//
// Módulo PURO.

import type { AssignedSlot, SlotChange } from '@/types';
import { spainWallClockToEpoch } from '@/lib/spainTime';
import { hourNum, hourText, nkName } from '@/lib/sessions';

/** Días de historial que carga TeachersContext. */
export const SLOT_CHANGES_DIAS = 100;

const clave = (day: string, hour: string | number) => `${day}|${hourNum(hour)}`;

/** Los cambios de UN alumno (por nombre normalizado), del más nuevo al más viejo. */
export function changesOfStudent(changes: readonly SlotChange[] | undefined, studentName: string): SlotChange[] {
  const n = nkName(studentName);
  return (changes ?? [])
    .filter(c => (c.action === 'agregado' || c.action === 'quitado') && nkName(c.studentName) === n)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Horario que tenía el alumno el `dateIso` (a las 00:00 de España), o `null` si
 * no cambió nada desde entonces (vale el de hoy). `changes` son los de ESE
 * alumno con ESE profesor, del más nuevo al más viejo (changesOfStudent).
 */
export function slotsOnDate(current: readonly AssignedSlot[], changes: readonly SlotChange[], dateIso: string): AssignedSlot[] | null {
  const desde = spainWallClockToEpoch(dateIso, 0);
  const posteriores = changes.filter(c => Date.parse(c.createdAt) > desde);
  if (posteriores.length === 0) return null;

  const set = new Map<string, AssignedSlot>();
  for (const s of current) set.set(clave(s.day, s.hour), s);
  // Deshacer del más nuevo al más viejo: un alta posterior no existía; una baja
  // posterior sí existía.
  for (const c of posteriores) {
    const h = hourNum(c.hour);
    if (!Number.isFinite(h)) continue;
    const k = clave(c.day, h);
    if (c.action === 'agregado') set.delete(k);
    else set.set(k, { day: c.day, hour: hourText(h) });
  }
  const out = [...set.values()];
  const igual = out.length === current.length && current.every(s => set.has(clave(s.day, s.hour)));
  return igual ? null : out;
}
