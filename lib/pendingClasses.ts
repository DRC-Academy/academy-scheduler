// Clases PENDIENTES: el profesor entró por el botón "Ingresar a clase" pero
// todavía no subió el transcript (o se lo rechazaron).
//
// Es la pieza que evita que una clase quede sin sitio donde completarla: el
// ingreso deja constancia de que la clase existió, y esta lista la mantiene
// visible hasta que se cierra con el transcript.
//
// QUÉ ES "UNA CLASE" ACÁ: un bloque de ingresos del mismo alumno en la misma
// fecha con horas contiguas. Antes era CADA clic, así que un doble clic (o los
// dos ingresos de una sesión de 2 h) generaban dos "clases pendientes" y el
// profesor pegaba el mismo transcript dos veces. La guarda de dbLogClassJoin ya
// no deja crear el duplicado, pero los 148 clics repetidos de antes siguen en la
// base y hay que agruparlos.
//
// CÓMO SE DECIDE SI TIENE TRANSCRIPT: con la regla única de
// lib/transcriptDeadline (findTranscriptFor + getTranscriptStatus), la misma que
// usan finanzas, Mis clases y Asistencias. Antes la ficha ignoraba
// `validation_status` y daba por cubierta una clase con el transcript rechazado.

import type { ClassJoinLog } from '@/types';
import type { ClassAnalysisRow } from '@/lib/aiTypes';
import {
  findTranscriptFor, getTranscriptStatus, reopenedDeadlineFor, transcriptNeedsTeacher,
  type TranscriptStatusResult, type TranscriptExclusions,
} from '@/lib/transcriptDeadline';
import { hourNum } from '@/lib/sessions';

export interface PendingClass {
  /** Ingreso principal del bloque (el primero por hora). Es el vínculo que hereda el transcript. */
  joinLogId: string;
  /** Todos los ingresos del bloque (dos en una sesión de 2 h o en un doble clic). */
  joinLogIds: string[];
  date: string;           // fecha REAL del ingreso — el profe no la teclea
  time: string;           // hora de inicio 'HH:00'
  studentName: string;
  /** Horas del bloque: 2 si hubo ingresos a las 17:00 y a las 18:00. */
  durationHours: number;
  /** Estado frente al plazo de 24 h: 'pendiente' o 'vencido' (los subidos no se listan). */
  deadline: TranscriptStatusResult;
}

const nk = (s: string) => (s ?? '').trim().toLowerCase();

/**
 * Ingresos de un alumno que aún no tienen transcript válido, agrupados por
 * clase y con su estado frente al plazo. Del más reciente al más antiguo.
 */
export function pendingClassesFor(args: {
  studentName: string;
  teacherId: string;
  joinLogs: ClassJoinLog[];
  analyses: ClassAnalysisRow[];
  /** Instante actual (epoch ms). Por defecto, ahora. */
  now?: number;
}): PendingClass[] {
  const { studentName, teacherId, joinLogs, analyses } = args;
  const now = args.now ?? Date.now();

  const mine = joinLogs
    .filter(l => l.teacherId === teacherId && nk(l.studentName) === nk(studentName))
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate)
      || (hourNum(a.scheduledTime) || 0) - (hourNum(b.scheduledTime) || 0));   // antiguo → nuevo

  // Bloques: misma fecha y horas contiguas (o repetidas) = una clase.
  const groups: ClassJoinLog[][] = [];
  for (const l of mine) {
    const last = groups[groups.length - 1];
    if (last && last[0].scheduledDate === l.scheduledDate) {
      const prevHour = hourNum(last[last.length - 1].scheduledTime);
      const h = hourNum(l.scheduledTime);
      if (!Number.isFinite(prevHour) || !Number.isFinite(h) || h - prevHour <= 1) { last.push(l); continue; }
    }
    groups.push([l]);
  }

  // Los transcripts sin vínculo se consumen de uno en uno (respaldo ±1 día de las
  // clases anteriores al plazo): sin esto el transcript del lunes taparía también
  // la clase del martes y esa clase desaparecería de pendientes para siempre.
  const used: TranscriptExclusions = new Set();

  const out: PendingClass[] = [];
  for (const g of groups) {
    const ids = g.map(l => l.id);
    const first = g[0];
    const hours = g.map(l => hourNum(l.scheduledTime)).filter(Number.isFinite) as number[];
    const declared = Math.max(...g.map(l => l.durationHours ?? 0), 0);
    const durationHours = Math.max(
      1, declared, hours.length ? Math.max(...hours) - Math.min(...hours) + 1 : 1,
    );

    const transcript = findTranscriptFor(analyses, {
      teacherId, studentName, dateIso: first.scheduledDate, joinLogIds: ids, exclude: used,
    });
    const deadline = getTranscriptStatus({
      date: first.scheduledDate, startHour: first.scheduledTime, durationHours,
      transcript, reopenedDeadlineAt: reopenedDeadlineFor(g), now,
    });
    if (!transcriptNeedsTeacher(deadline.transcriptState)) continue;   // subido o en revisión

    out.push({
      joinLogId: first.id,
      joinLogIds: ids,
      date: first.scheduledDate,
      time: first.scheduledTime,
      studentName: first.studentName,
      durationHours,
      deadline,
    });
  }
  return out.reverse();   // más reciente primero
}

/** Total de pendientes del profesor, para el aviso de la cabecera. */
export function countPendingForTeacher(args: {
  teacherId: string;
  joinLogs: ClassJoinLog[];
  analyses: ClassAnalysisRow[];
  now?: number;
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
      now: args.now,
    }).length;
  }
  return total;
}
