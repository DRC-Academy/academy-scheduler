// Avisos de CAMPANITA del plazo de 24 h del transcript. SOLO SERVIDOR.
//
// Recorre las clases de cada profesor con el estado de lib/transcriptDeadline
// (la MISMA función que pintan Mis clases, la ficha, Asistencias y Finanzas) y
// deja una notificación in-app por clase para:
//   (a) 'transcript_deadline_6h' → quedan menos de 6 h de plazo;
//   (b) 'transcript_vencido'     → el plazo acaba de vencer (en los últimos días).
//
// Lo ejecutan dos sitios:
//   · el cron diario de fin de día (app/api/cron/daily-transcript-reminder),
//     después de mandar los correos de recordatorio;
//   · el endpoint suelto /api/cron/transcripts-vencidos, pensado para que Zapier
//     lo llame cada hora (el plan Hobby de Vercel solo permite crons diarios).
//
// IDEMPOTENTE por construcción: el id de la notificación es determinista
// (`tx_dl_<profesor>_<fecha>_<alumno>_<6h|vencida>`) y se inserta con upsert +
// ignoreDuplicates, igual que las alertas de bono de 6 meses
// (dbUpsertTeacherAlerts). Dos corridas —o Zapier y el cron a la vez— no pueden
// avisar dos veces de la misma clase en la misma categoría, sin tabla extra.
//
// NO manda emails. Solo campanita.
//
// DOS FILTROS: las filas salen de finanzas (calculateTeacherFinance), pero cada
// clase se vuelve a mirar con la regla común (transcriptStatusForClass): si para
// ella el transcript ya está subido, o es una falta del alumno, no se avisa. Así
// la campanita dice lo mismo que el pop-up, la ficha y Mis clases aunque el
// emparejamiento de finanzas (matchCand) difiera en algún caso.
//
// Y al SUBIR un transcript, resolveTranscriptNotices (lib/transcriptNotices)
// marca como resueltos los avisos que ya hubiera de esa clase.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dbGetTeachers, dbGetStudents, dbGetAssignments, dbGetClassJoinLogs, dbGetClassRecords,
  dbGetClassTranscripts, dbGetFinanceRates, dbGetFinancePayments, dbGetManualApprovals,
  dbGetScoringEvents,
} from '@/lib/db';
import { calculateTeacherFinance, rowHoursLabel, transcriptNeedsTeacher, type ClassFinanceRow } from '@/lib/finance';
import { gridOccupancyOfTeacher, fmtDateDMY } from '@/lib/teacherClasses';
import {
  hoursLeftLabel, deadlineLabel, reopenedDeadlineFor, transcriptStatusForClass, transcriptStatusNeedsTeacher,
  type ClassRecordRef, type ClassTranscriptRef,
} from '@/lib/transcriptDeadline';
import { nkName } from '@/lib/sessions';
import { deadlineNoticeId } from '@/lib/transcriptNotices';
import type { ClassJoinLog } from '@/types';
import { getSpainParts } from '@/lib/spainTime';

/** Una vencida se avisa si venció hace menos de esto: las viejas ya no son noticia. */
const RECIEN_VENCIDA_DIAS = 7;

export interface DeadlineNotice {
  id: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  date: string;
  hours: string;
  kind: '6h' | 'vencida';
  title: string;
  body: string;
}

export interface DeadlineNoticeResult {
  /** Clases que hoy están en una de las dos categorías. */
  candidates: DeadlineNotice[];
  /** Cuántas notificaciones NUEVAS se crearon (las ya existentes no cuentan). */
  created: number;
  /** Cuántas ya existían (idempotencia). */
  skipped: number;
}

export { deadlineNoticeId, resolveTranscriptNotices } from '@/lib/transcriptNotices';

/**
 * ¿Sigue faltando el transcript de esta fila de finanzas según la regla común?
 * false = ya está subido (o en revisión) o es una falta del alumno: no se avisa.
 * La usan la campanita y el email de fin de día.
 */
export function stillMissingTranscript(
  row: Pick<ClassFinanceRow, 'studentName' | 'date' | 'hour' | 'durationHours'>,
  ctx: { teacherId: string; analyses: ClassTranscriptRef[]; records: ClassRecordRef[]; joinLogs: ClassJoinLog[]; now: number },
): boolean {
  const name = nkName(row.studentName);
  const logs = ctx.joinLogs.filter(l =>
    l.teacherId === ctx.teacherId && l.scheduledDate === row.date && nkName(l.studentName) === name);
  return transcriptStatusNeedsTeacher(transcriptStatusForClass({
    analyses: ctx.analyses, records: ctx.records,
    teacherId: ctx.teacherId, studentName: row.studentName, date: row.date,
    startHour: row.hour, durationHours: row.durationHours ?? 1,
    joinLogIds: logs.map(l => l.id), reopenedDeadlineAt: reopenedDeadlineFor(logs), now: ctx.now,
  }));
}

/** Mes 'YYYY-MM' de un instante, en hora de España. */
function monthOf(ms: number): string {
  return getSpainParts(new Date(ms)).dateStr.slice(0, 7);
}

function noticeFor(teacherId: string, teacherName: string, r: ClassFinanceRow, kind: '6h' | 'vencida'): DeadlineNotice {
  const cuando = `${fmtDateDMY(r.date)}${r.hour ? ` · ${rowHoursLabel(r)}` : ''}`;
  const hours = r.hour ? rowHoursLabel(r) : '';
  if (kind === '6h') {
    return {
      id: deadlineNoticeId(teacherId, r.date, r.studentName, kind),
      teacherId, teacherName, studentName: r.studentName, date: r.date, hours, kind,
      title: `⏳ ${hoursLeftLabel(r.deadline.hoursLeft)} para el transcript de ${r.studentName}`,
      body: `La clase con ${r.studentName} (${cuando}) sigue sin transcript y el plazo termina ${deadlineLabel(r.deadline.deadlineAt)} (hora de España). `
        + 'Sin transcript, el alumno no puede generar su práctica y la clase no se valida para el pago.',
    };
  }
  return {
    id: deadlineNoticeId(teacherId, r.date, r.studentName, kind),
    teacherId, teacherName, studentName: r.studentName, date: r.date, hours, kind,
    title: `🔴 Transcript vencido · ${r.studentName}`,
    body: `El plazo de 24 horas para subir el transcript de la clase con ${r.studentName} (${cuando}) ha vencido: `
      + 'la clase no se valida para el pago. Si crees que es un error, escribe al equipo para que reabra el plazo.',
  };
}

/**
 * Calcula las clases a avisar y, salvo en modo `dry`, crea las notificaciones
 * que falten. `now` en epoch ms (por defecto, ahora).
 */
export async function notifyTranscriptDeadlines(args: {
  admin: SupabaseClient;
  now?: number;
  dry?: boolean;
}): Promise<DeadlineNoticeResult> {
  const now = args.now ?? Date.now();

  const [
    teachers, students, assignments, joinLogs, classRecords,
    classAnalyses, rates, payments, manualApprovals, scoringEvents,
  ] = await Promise.all([
    dbGetTeachers(), dbGetStudents(), dbGetAssignments(), dbGetClassJoinLogs(), dbGetClassRecords(),
    dbGetClassTranscripts(), dbGetFinanceRates(), dbGetFinancePayments(), dbGetManualApprovals(),
    dbGetScoringEvents(),
  ]);

  // El mes en curso y el anterior: una clase del 30 vence el 1 del mes siguiente.
  const meses = [...new Set([monthOf(now), monthOf(now - 10 * 86_400_000)])];
  const recienMs = RECIEN_VENCIDA_DIAS * 86_400_000;

  const candidates: DeadlineNotice[] = [];
  for (const t of teachers) {
    for (const monthYear of meses) {
      const result = calculateTeacherFinance({
        teacherId: t.id, teacherName: t.name, monthYear,
        assignments, joinLogs, classRecords, classAnalyses, rates,
        scoringEvents, students, manualApprovals,
        payment: payments.find(p => p.teacherId === t.id && p.monthYear === monthYear) ?? null,
        teacherBonuses: [],
        gridOccupancy: gridOccupancyOfTeacher(t),
        now,
      });
      const ctx = { teacherId: t.id, analyses: classAnalyses, records: classRecords, joinLogs, now };
      for (const r of result.rows) {
        // Regla común: si ya está subido o es una falta del alumno, no se avisa.
        if ((r.status === 'a_revisar' || r.status === 'vencida') && !stillMissingTranscript(r, ctx)) continue;
        // (a) Pendiente, es tarea del profesor y quedan menos de 6 h.
        if (r.status === 'a_revisar' && transcriptNeedsTeacher(r.transcriptState) && r.deadline.urgent) {
          candidates.push(noticeFor(t.id, t.name, r, '6h'));
        }
        // (b) Vencida hace poco.
        if (r.status === 'vencida' && r.deadline.deadlineAt != null && now - r.deadline.deadlineAt <= recienMs) {
          candidates.push(noticeFor(t.id, t.name, r, 'vencida'));
        }
      }
    }
  }

  if (args.dry || candidates.length === 0) return { candidates, created: 0, skipped: 0 };

  const createdAt = new Date(now).toISOString();
  const rows = candidates.map(c => ({
    id:          c.id,
    target_user: c.teacherId,
    target_role: null,
    title:       c.title,
    body:        c.body,
    type:        c.kind === '6h' ? 'transcript_deadline_6h' : 'transcript_vencido',
    read_by:     [],
    created_at:  createdAt,
    created_by:  'sistema',
  }));

  // ignoreDuplicates: las que ya existen se quedan como están (incluido su
  // read_by). `select('id')` devuelve solo las insertadas de verdad.
  const { data, error } = await args.admin
    .from('notifications')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
    .select('id');
  if (error) {
    console.error('[transcript-deadlines] No se pudieron crear las notificaciones:', error);
    throw new Error(`No se pudieron crear las notificaciones: ${error.message}`);
  }
  const created = data?.length ?? 0;
  return { candidates, created, skipped: candidates.length - created };
}
