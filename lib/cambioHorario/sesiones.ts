// Sesiones RECURRENTES de un alumno en el calendario de su profesor. Función pura.
//
// Una sesión es un bloque de casillas contiguas del mismo día cuyo alumno
// recurrente (baseStudentOf) se llama EXACTAMENTE como el de la assignment (sin
// espacios al principio y al final), igual que la liberación de la Fase 0. El
// calendario manda: assignments.slots es un espejo suyo.

import type { Grid } from '@/types';
import { baseStudentOf } from '@/lib/cells';
import { hourText } from '@/lib/sessions';

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export interface Sesion {
  dia: string;
  /** Inicio en hora de España ('15:00'). */
  hora: string;
  /** Horas (casillas contiguas). */
  duracion: number;
  claves: string[];
}

export function sesionesDelAlumno(grid: Grid, alumno: string): Sesion[] {
  const nombre = alumno.trim();
  if (!nombre) return [];
  const horasPorDia = new Map<string, number[]>();
  for (const [key, cell] of Object.entries(grid)) {
    if (!cell || (baseStudentOf(cell) ?? '').trim() !== nombre) continue;
    const usc = key.lastIndexOf('_');
    const dia = key.slice(0, usc);
    const h = Number(key.slice(usc + 1, usc + 3));
    if (!DIAS.includes(dia) || !(h >= 0 && h <= 23) || !/^\d{2}:00$/.test(key.slice(usc + 1))) continue;
    (horasPorDia.get(dia) ?? horasPorDia.set(dia, []).get(dia)!).push(h);
  }
  const out: Sesion[] = [];
  for (const dia of DIAS) {
    const horas = [...new Set(horasPorDia.get(dia) ?? [])].sort((a, b) => a - b);
    let i = 0;
    while (i < horas.length) {
      let j = i;
      while (j + 1 < horas.length && horas[j + 1] === horas[j] + 1) j++;
      const bloque = horas.slice(i, j + 1);
      out.push({ dia, hora: hourText(bloque[0]), duracion: bloque.length, claves: bloque.map(h => `${dia}_${hourText(h)}`) });
      i = j + 1;
    }
  }
  return out;
}
