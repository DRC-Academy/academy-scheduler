// Marcas del calendario de UNA clase reprogramada. Función PURA.
//
// La usan el "Reprogramar" del profesor (components/MisClasesPanel.tsx) y el
// cambio de horario PUNTUAL pedido por el alumno (lib/cambioHorario/core.ts), así
// que las dos vías dejan el calendario exactamente igual:
//   · celda ORIGINAL → 'reprogramada' (tachada, gris) esa semana, con
//     rescheduledTo = la fecha nueva;
//   · celda de la NUEVA fecha/hora → 'bloqueado' (recuperación) esa semana, con
//     recoveryFor = la fecha original → aparece en Próximas clases el día
//     correcto y cuenta al darse (finanzas).
//
// Una sesión de 2 h mueve SUS DOS HORAS. Antes se marcaba una sola celda a cada
// lado: la segunda hora de la clase original seguía pareciendo una clase normal y
// en el destino solo se reponía 1 h de las 2, así que el profesor perdía una hora
// de pago en cada reprogramación de una clase larga.

import type { Grid } from '@/types';
import { baseCellOf } from '@/lib/cells';
import { nkName } from '@/lib/sessions';
import { dayNameFromIso, mondayIsoOfIso } from '@/lib/teacherClasses';

export interface MarcasReprogramacionInput {
  studentName: string;
  /** Fecha de la clase que se mueve (YYYY-MM-DD, España). */
  originalDate: string;
  /** Hora de inicio de la clase que se mueve ('15:00'). */
  originalHour: string;
  /** Horas de la sesión (1 a 4). */
  durationHours: number;
  /** Fecha y hora de inicio nuevas. */
  newDate: string;
  newHour: string;
}

const esIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
const hh = (n: number) => `${String(n).padStart(2, '0')}:00`;

/**
 * Devuelve el grid con las marcas de la reprogramación. Si alguna fecha no es
 * válida, devuelve el grid tal cual (no marca nada).
 */
export function marcasDeReprogramacion(grid: Grid, p: MarcasReprogramacionInput): Grid {
  if (!esIso(p.originalDate) || !esIso(p.newDate)) return grid;
  const horas = Math.max(1, Math.min(Math.round(p.durationHours || 1), 4));
  const origStart = parseInt(p.originalHour, 10);
  const newStart  = parseInt(p.newHour, 10);
  const origDay = dayNameFromIso(p.originalDate);
  const newDay  = dayNameFromIso(p.newDate);
  const next: Grid = { ...grid };

  for (let i = 0; i < horas; i++) {
    const origKey = `${origDay}_${Number.isFinite(origStart) && i > 0 ? hh(origStart + i) : p.originalHour}`;
    const newKey  = `${newDay}_${Number.isFinite(newStart) && i > 0 ? hh(newStart + i) : p.newHour}`;
    // baseCellOf: el fondo de la celda (nunca otra marca puntual), con su
    // alumno recurrente, que puede no ser el de la clase que se mueve.
    const baseOrig = next[origKey] ? baseCellOf(next[origKey]) : null;
    // Solo se tacha la hora que era de este alumno: si la sesión de 2 h
    // ya no existe en el calendario, la segunda celda se deja como está.
    if (i === 0 || (baseOrig && nkName(baseOrig.student) === nkName(p.studentName))) {
      next[origKey] = {
        state: 'reprogramada', student: p.studentName,
        weekDate: mondayIsoOfIso(p.originalDate),
        baseState: baseOrig ? baseOrig.state : 'ocupado',
        baseStudent: baseOrig ? baseOrig.student : p.studentName,
        rescheduledTo: p.newDate,
      };
    }
    const baseNew = next[newKey] ? baseCellOf(next[newKey]) : null;
    // No pisar una clase recurrente real en la nueva celda.
    if (!baseNew || baseNew.state !== 'ocupado') {
      next[newKey] = {
        state: 'bloqueado', student: p.studentName,
        weekDate: mondayIsoOfIso(p.newDate),
        baseState: baseNew ? baseNew.state : 'libre',
        recoveryFor: p.originalDate,
      };
    }
  }
  return next;
}
