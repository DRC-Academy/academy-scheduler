// Cron de FIN DE DÍA (23:59 hora de Argentina): recuerda al profesor los
// transcripts que le faltan por subir.
//
// QUÉ AVISA — exactamente las clases en estado "pendiente de transcript" de la
// regla de dos niveles (ver la cabecera de lib/finance.ts):
//   · NIVEL 1: la clase entró a finanzas porque el profesor pulsó "Unirse a
//     clase" (hay class_join_log). Las clases SIN ingreso no existen para el
//     pago, así que NO se mencionan: nombrarlas solo confundiría.
//   · NIVEL 2: todavía no tiene transcript válido, así que no se cobra.
//
// El criterio NO se reimplementa acá: se llama a `calculateTeacherFinance`, la
// misma función que pinta /mis-clases y /finanzas, y se filtran las filas de hoy
// con status 'a_revisar'. Si mañana cambia la regla, este correo la sigue sola.
// (Las filas 'excede_limite' quedan fuera a propósito: subir el transcript no
// las haría cobrables, porque lo que las frena es el límite mensual del plan.)
//
// ANTI-DUPLICADO — "reservar y luego enviar": antes de escribir un solo correo
// se inserta la fila del día en `daily_reminder_log` (id determinista). Si la
// fila ya existía, ese profesor ya recibió su email hoy y se salta. Si el envío
// falla, la reserva se borra para que la próxima corrida lo reintente.
// Requiere haber corrido supabase-daily-reminder-log.sql.

import {
  dbGetTeachers, dbGetStudents, dbGetAssignments, dbGetClassJoinLogs, dbGetClassRecords,
  dbGetClassTranscripts, dbGetFinanceRates, dbGetFinancePayments, dbGetManualApprovals,
  dbGetScoringEvents,
} from '@/lib/db';
import { supabase } from '@/lib/supabase';
import { calculateTeacherFinance, rowHoursLabel, transcriptNeedsTeacher } from '@/lib/finance';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { fetchTeacher, sendDailyTranscriptReminder, type PendingTranscriptClass } from '@/lib/emailNotifications';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// El tipo de aviso va dentro del id, no en una columna: la tabla que ya existe
// en la base es (id, teacher_id, reminder_date, classes_count, sent_at) y este
// cron se adapta a ella en vez de pedir una migración para arrancar.
const claimId = (teacherId: string, date: string) => `drl_transcript_${teacherId}_${date}`;

/** Fecha y hora de pared en Argentina (UTC-3 todo el año, no tiene horario de verano). */
function argentinaParts(now: Date): { dateStr: string; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  return { dateStr: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

/**
 * Qué día hay que repasar. Normalmente el de hoy en Argentina, porque el cron
 * dispara a las 23:59.
 *
 * Pero si la corrida llega pasada la medianoche (los crons de Vercel en plan
 * Hobby se disparan "dentro de la hora", y un reintento manual puede caer aún
 * más tarde), "hoy" ya sería el día siguiente y el email saldría vacío o no
 * saldría. Entre las 00:00 y las 05:00 se repasa el día que acaba de terminar,
 * que es el que el profesor tiene en la cabeza.
 */
function dayToReport(now: Date): string {
  const { dateStr, hour } = argentinaParts(now);
  if (hour >= 5) return dateStr;
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface TeacherPending {
  teacherId: string;
  teacherName: string;
  classes: PendingTranscriptClass[];
}

export async function GET(request: Request): Promise<Response> {
  // El endpoint manda correos, así que la protección no es opcional: sin
  // CRON_SECRET configurado no se ejecuta (mejor no hacer nada que quedar
  // abierto a que cualquiera dispare emails a todos los profesores).
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[cron transcript-reminder] Falta CRON_SECRET en el entorno.');
    return Response.json({ error: 'CRON_SECRET no configurado' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }

  const url = new URL(request.url);
  // `date` (YYYY-MM-DD) para repasar un día concreto y `dry=1` para ver a quién
  // se le escribiría sin mandar nada ni reservar el día.
  const dateParam = url.searchParams.get('date');
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(dateParam ?? '') ? dateParam! : dayToReport(new Date());
  const dryRun = url.searchParams.get('dry') === '1';
  const monthYear = targetDate.slice(0, 7);

  let pendientes: TeacherPending[];
  try {
    pendientes = await findPending(targetDate, monthYear);
  } catch (err) {
    console.error('[cron transcript-reminder] Error al calcular las clases pendientes:', err);
    return Response.json({ error: 'Error del servidor' }, { status: 500 });
  }

  if (dryRun) {
    return Response.json({
      ok: true, dryRun: true, date: targetDate,
      teachers: pendientes.map(t => ({
        teacherName: t.teacherName,
        classes: t.classes.map(c => `${c.studentName}${c.hours ? ` ${c.hours}` : ''}`),
      })),
    });
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const t of pendientes) {
    try {
      const reserved = await claimToday(t, targetDate);
      if (!reserved) { skipped++; continue; }   // ya se le escribió hoy

      const teacher = await fetchTeacher(t.teacherId);
      const ok = teacher ? await sendDailyTranscriptReminder(teacher, t.classes) : false;

      if (ok) {
        sent++;
      } else {
        failed++;
        // Se libera el día: el correo no salió, así que la próxima corrida (o un
        // disparo manual) tiene que poder intentarlo otra vez.
        await releaseToday(t.teacherId, targetDate);
      }
    } catch (err) {
      failed++;
      console.error(`[cron transcript-reminder] Fallo con ${t.teacherName}:`, err);
      await releaseToday(t.teacherId, targetDate);
    }
  }

  console.log(`[cron transcript-reminder] ${targetDate}: ${sent} enviado(s), ${skipped} ya avisado(s), ${failed} fallido(s).`);
  return Response.json({ ok: true, date: targetDate, candidates: pendientes.length, sent, skipped, failed });
}

/**
 * Profesores con clases de `targetDate` en estado "pendiente de transcript".
 *
 * Una sola lectura de cada tabla para todos los profesores; el cálculo por
 * profesor es en memoria.
 */
async function findPending(targetDate: string, monthYear: string): Promise<TeacherPending[]> {
  const [
    teachers, students, assignments, joinLogs, classRecords,
    classAnalyses, rates, payments, manualApprovals, scoringEvents,
  ] = await Promise.all([
    dbGetTeachers(), dbGetStudents(), dbGetAssignments(), dbGetClassJoinLogs(), dbGetClassRecords(),
    dbGetClassTranscripts(), dbGetFinanceRates(), dbGetFinancePayments(), dbGetManualApprovals(),
    dbGetScoringEvents(),
  ]);

  const out: TeacherPending[] = [];
  for (const t of teachers) {
    const result = calculateTeacherFinance({
      teacherId: t.id, teacherName: t.name, monthYear,
      assignments, joinLogs, classRecords, classAnalyses, rates,
      scoringEvents, students, manualApprovals,
      payment: payments.find(p => p.teacherId === t.id && p.monthYear === monthYear) ?? null,
      gridOccupancy: gridOccupancyOfTeacher(t),
    });

    // Pendientes de HOY, pero solo aquellas en las que el profesor tiene algo que
    // hacer (transcriptNeedsTeacher: falta subirlo, o el equipo lo rechazó).
    //
    // Las que están EN REVISIÓN se quedan fuera a propósito: el profesor ya subió
    // su transcript y está esperando al equipo. Decirle "todavía no lo has
    // subido" lo mandaría a pegarlo otra vez, que es el bucle que ya se corrigió
    // en el panel de "Mis clases".
    const classes = result.rows
      .filter(r => r.date === targetDate && r.status === 'a_revisar' && transcriptNeedsTeacher(r.transcriptState))
      .map(r => ({
        studentName: r.studentName,
        hours: r.hour ? rowHoursLabel(r) : undefined,
        rejected: r.transcriptState === 'rejected',
      }));

    if (classes.length > 0) out.push({ teacherId: t.id, teacherName: t.name, classes });
  }
  return out;
}

/**
 * Reserva el envío del día. `true` = reservado por esta corrida (hay que enviar);
 * `false` = ya existía (ese profesor ya recibió el email hoy) o no se pudo
 * reservar, y en ese caso NO se envía: ante la duda, mejor callado que duplicado.
 */
async function claimToday(t: TeacherPending, date: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('daily_reminder_log')
    .upsert({
      id:            claimId(t.teacherId, date),
      teacher_id:    t.teacherId,
      reminder_date: date,
      classes_count: t.classes.length,
      sent_at:       new Date().toISOString(),
    }, { onConflict: 'id', ignoreDuplicates: true })
    .select('id');

  if (error) {
    // 42P01 = la tabla no existe todavía: falta correr supabase-daily-reminder-log.sql.
    if (error.code === '42P01') {
      console.error('[cron transcript-reminder] Falta la tabla daily_reminder_log. Corré supabase-daily-reminder-log.sql antes de activar el cron.');
    } else {
      console.error('[cron transcript-reminder] No se pudo reservar el envío:', error);
    }
    return false;
  }
  // Con ignoreDuplicates, `data` vacío significa que la fila ya estaba.
  return (data?.length ?? 0) > 0;
}

async function releaseToday(teacherId: string, date: string): Promise<void> {
  const { error } = await supabase.from('daily_reminder_log').delete().eq('id', claimId(teacherId, date));
  if (error) console.error('[cron transcript-reminder] No se pudo liberar la reserva:', error);
}
