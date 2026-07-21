// Clases PENDIENTES: el profesor entró por el botón "Ingresar a clase" pero
// todavía no subió el transcript.
//
// Es la pieza que evita que una clase quede sin sitio donde completarla: el
// ingreso deja constancia de que la clase existió, y esta lista la mantiene
// visible hasta que se cierra con el transcript.

import type { ClassJoinLog } from '@/types';
import type { ClassAnalysisRow } from '@/lib/aiTypes';

export interface PendingClass {
  joinLogId: string;      // vínculo explícito que hereda el transcript
  date: string;           // fecha REAL del ingreso — el profe no la teclea
  time: string;
  studentName: string;
}

const nk = (s: string) => (s ?? '').trim().toLowerCase();

/**
 * Ingresos de un alumno que aún no tienen transcript.
 *
 * Un ingreso se considera cubierto si:
 *   · algún análisis lo referencia por join_log_id (vínculo explícito), o
 *   · hay un análisis del mismo alumno en esa fecha ±1 día (respaldo para las
 *     clases anteriores al vínculo, que no tienen join_log_id).
 */
export function pendingClassesFor(args: {
  studentName: string;
  teacherId: string;
  joinLogs: ClassJoinLog[];
  analyses: ClassAnalysisRow[];
}): PendingClass[] {
  const { studentName, teacherId, joinLogs, analyses } = args;

  const linked = new Set(
    analyses.map(a => (a as { join_log_id?: string | null }).join_log_id).filter(Boolean) as string[],
  );

  // Transcripts SIN vínculo (los anteriores a esta función). Se consumen uno a
  // uno: si se comprobara "¿hay algún análisis a ±1 día?" sin consumirlo, un
  // transcript del lunes taparía también la clase del martes y esa clase
  // desaparecería de pendientes para siempre.
  const freeDates = analyses
    .filter(a => (a.transcript ?? '').trim() && !(a as { join_log_id?: string | null }).join_log_id)
    .map(a => a.class_date || (a.analyzed_at ?? '').slice(0, 10))
    .filter(Boolean) as string[];

  const dist = (x: string, y: string) =>
    Math.abs((new Date(x + 'T00:00:00').getTime() - new Date(y + 'T00:00:00').getTime()) / 86_400_000);

  const mine = joinLogs
    .filter(l => l.teacherId === teacherId && nk(l.studentName) === nk(studentName))
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));   // antiguo → nuevo

  const out: PendingClass[] = [];
  for (const l of mine) {
    if (linked.has(l.id)) continue;                     // cubierta por vínculo

    // Respaldo: consumir un transcript sin vínculo. Fecha exacta primero.
    let i = freeDates.findIndex(d => d === l.scheduledDate);
    if (i < 0) i = freeDates.findIndex(d => dist(d, l.scheduledDate) <= 1);
    if (i >= 0) { freeDates.splice(i, 1); continue; }   // cubierta y consumida

    out.push({
      joinLogId: l.id,
      date: l.scheduledDate,
      time: l.scheduledTime,
      studentName: l.studentName,
    });
  }
  return out.reverse();   // más reciente primero
}

/** Total de pendientes del profesor, para el aviso de la cabecera. */
export function countPendingForTeacher(args: {
  teacherId: string;
  joinLogs: ClassJoinLog[];
  analyses: ClassAnalysisRow[];
}): number {
  const names = new Set(
    args.joinLogs.filter(l => l.teacherId === args.teacherId).map(l => nk(l.studentName)),
  );
  let total = 0;
  for (const name of names) {
    const original = args.joinLogs.find(l => nk(l.studentName) === name)?.studentName ?? name;
    total += pendingClassesFor({
      studentName: original,
      teacherId: args.teacherId,
      joinLogs: args.joinLogs,
      analyses: args.analyses.filter(a => nk(a.student_name) === name),
    }).length;
  }
  return total;
}
