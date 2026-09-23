// ── Lectura del dashboard de uso (SOLO SERVIDOR) ──────────────────────────────
//
// Lee de la base lo que necesita lib/teacherUsage y devuelve el informe ya
// calculado. Lo llama /api/admin/teacher-usage: el navegador recibe totales por
// semana y por profesor, nunca las filas.
//
// EGRESS. Cada tabla grande se pide SOLO en la ventana de semanas que se muestra
// y solo con las columnas que el cálculo usa. De class_analyses se pide
// `has_transcript` (la columna generada), jamás el texto — ver
// supabase-has-transcript.sql y memoria del arreglo de egress.
//
// Las tablas nuevas (usage_events, scheduled_class_snapshots) pueden no existir
// todavía: sin ellas el informe sale igual y `avisos` dice qué script falta.

import 'server-only';
import { supabase } from '@/lib/supabase';
import { dbGetTeachers, fetchAllPages } from '@/lib/db';
import { dbGetStudentDropouts, periodIndex, type StudentPeriod } from '@/lib/studentPeriod';
import { construirSeguimiento } from '@/lib/levelTestSeguimiento';
import { studentKeyOf, type FormTokenRow, type StudentRow, type DropoutRow } from '@/lib/formReminders';
import type { LevelTestInfo } from '@/lib/levelTestClient';
import { PROFESORES_DE_PRUEBA } from '@/lib/externalTeachers';
import { TRANSCRIPT_DEADLINE_START_DATE, type ClassTranscriptRef } from '@/lib/transcriptDeadline';
import { addDaysIso } from '@/lib/teacherClasses';
import { getSpainParts } from '@/lib/spainTime';
import { nkName } from '@/lib/sessions';
import type { ClassJoinLog, ClassRecord } from '@/types';
import {
  buildWeeks, construirInformeUso, proyectarCalendario,
  type ClaseProgramada, type EnvioPrueba, type GeneracionIA, type AlertaRiesgo, type EventoUso, type InformeUso,
} from '@/lib/teacherUsage';

type Fila = Record<string, unknown>;
type Res = PromiseLike<{ data: Fila[] | null; error: { message: string; code?: string } | null }>;

/** Lectura paginada que no revienta: ante error devuelve [] y lo anota. */
async function leer(label: string, run: (from: number, to: number) => Res, errores: string[]): Promise<Fila[]> {
  const { rows, error } = await fetchAllPages<Fila>(label, run);
  if (error) {
    errores.push(label);
    console.warn(`[teacher-usage] ${label}:`, error.message);
  }
  return rows;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const sn = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export async function cargarInformeUso(opts: { semanas: number; now?: number }): Promise<InformeUso & { avisos: string[] }> {
  const now = opts.now ?? Date.now();
  const hoy = getSpainParts(new Date(now)).dateStr;
  const semanas = buildWeeks(hoy, opts.semanas);
  const desde = semanas[0].start;
  // Instantes: un día de margen por la diferencia entre UTC y la hora española.
  const desdeTs = `${addDaysIso(desde, -1)}T00:00:00Z`;
  const errores: string[] = [];

  const [
    teachers, dropouts, asignaciones, tokens, sesiones, alumnos, bajas, perfiles,
    generaciones, logsRaw, recordsRaw, analysesRaw, eventosRaw, fotosRaw, alertasRaw,
  ] = await Promise.all([
    dbGetTeachers(),
    dbGetStudentDropouts(),
    leer('assignments', (f, t) => supabase.from('assignments')
      .select('id, teacher_id, student_id, student_name, start_date, created_at').order('id').range(f, t), errores),
    leer('form_tokens', (f, t) => supabase.from('form_tokens')
      .select('id, token, student_id, student_name, student_email, teacher_id, teacher_name, assignment_id, plan, level, status, created_at, completed_at, expires_at, form_reminder_count, form_reminder_last_sent, test_reminder_count, test_reminder_last_sent, reminder_variant')
      .order('id').range(f, t), errores),
    leer('level_test_sessions', (f, t) => supabase.from('level_test_sessions')
      .select('id, token, status, expires_at, completed_at, student_id, student_name, candidate_name, candidate_email, cefr_level, overall_score, created_at')
      .order('id').range(f, t), errores),
    leer('students', (f, t) => supabase.from('students').select('id, name, email').order('id').range(f, t), errores),
    leer('student_dropouts', (f, t) => supabase.from('student_dropouts').select('id, student_id, student_name').order('id').range(f, t), errores),
    leer('student_profiles', (f, t) => supabase.from('student_profiles')
      .select('id, student_id, student_name').not('teacher_confirmed_level', 'is', null).order('id').range(f, t), errores),
    leer('ai_class_generations', (f, t) => supabase.from('ai_class_generations')
      .select('id, teacher_id, teacher_name, origin, created_at').gte('created_at', desdeTs).order('id').range(f, t), errores),
    leer('class_join_logs', (f, t) => supabase.from('class_join_logs')
      .select('id, teacher_id, teacher_name, student_name, scheduled_date, scheduled_time, source, duration_hours, transcript_deadline_at')
      .gte('scheduled_date', desde).order('id').range(f, t), errores),
    leer('class_records', (f, t) => supabase.from('class_records')
      .select('id, teacher_id, student_name, class_date, class_time, class_type, rescheduled_to')
      .gte('class_date', desde).order('id').range(f, t), errores),
    // Solo lo que puede cubrir una clase con plazo (desde el 22/09/2026), con un
    // día de margen. Nunca el texto: `has_transcript` basta.
    leer('class_analyses', (f, t) => supabase.from('class_analyses')
      .select('id, teacher_id, student_name, class_date, analyzed_at, has_transcript, join_log_id, validation_status')
      .gte('class_date', addDaysIso(desde > TRANSCRIPT_DEADLINE_START_DATE ? desde : TRANSCRIPT_DEADLINE_START_DATE, -1))
      .order('id').range(f, t), errores),
    leer('usage_events', (f, t) => supabase.from('usage_events')
      .select('id, event, teacher_id, ref_id, created_at').gte('created_at', desdeTs).order('id').range(f, t), errores),
    leer('scheduled_class_snapshots', (f, t) => supabase.from('scheduled_class_snapshots')
      .select('id, teacher_id, teacher_name, student_name, class_date, start_hour, duration_hours, is_recovery')
      .gte('class_date', desde).order('id').range(f, t), errores),
    leer('notifications', (f, t) => supabase.from('notifications')
      .select('id, target_user, created_at').eq('type', 'risk_alert').gte('created_at', desdeTs).order('id').range(f, t), errores),
  ]);

  const ignorar = PROFESORES_DE_PRUEBA;
  const profesores = teachers.filter(t => !ignorar.has(t.id));

  // ── Profesor actual de cada alumno ─────────────────────────────────────────
  const porAlumno = new Map<string, string>();
  const porNombre = new Map<string, string>();
  for (const a of asignaciones) {
    const tid = s(a.teacher_id);
    if (!tid) continue;
    if (sn(a.student_id)) porAlumno.set(s(a.student_id), tid);
    if (sn(a.student_name)) porNombre.set(nkName(s(a.student_name)), tid);
  }

  // ── Prueba de nivel: una fila por ALUMNO (la misma que la pestaña Tests) ────
  const seguimiento = construirSeguimiento({
    tokens: tokens as unknown as FormTokenRow[],
    sessions: sesiones as unknown as LevelTestInfo[],
    students: alumnos as unknown as StudentRow[],
    dropouts: bajas as unknown as DropoutRow[],
    now,
  });
  // Solo alumnos: el candidato que hizo la prueba por un enlace suelto, sin
  // formulario ni ficha, no es alumno de ningún profesor.
  //
  // La semana es la del PRIMER enlace: el follow-up genera enlaces nuevos a los
  // que no la hicieron, y con la fecha del último un alumno perseguido durante un
  // mes saltaría de semana en semana (y inflaría la última).
  const primerEnvio = new Map<string, string>();
  for (const t of tokens as unknown as FormTokenRow[]) {
    const k = studentKeyOf(t);
    const prev = primerEnvio.get(k);
    if (!prev || t.created_at < prev) primerEnvio.set(k, t.created_at);
  }
  const envios: EnvioPrueba[] = seguimiento
    .filter(e => e.token || e.studentId)
    .map(e => ({
      studentId: e.studentId, nombre: e.nombre, enviado: primerEnvio.get(e.clave) ?? e.enviado, completada: e.prueba,
      teacherIdEnvio: e.token?.teacher_id ?? null,
    }));
  const validados = { ids: new Set<string>(), nombres: new Set<string>() };
  for (const p of perfiles) {
    if (sn(p.student_id)) validados.ids.add(s(p.student_id));
    if (sn(p.student_name)) validados.nombres.add(nkName(s(p.student_name)));
  }

  // ── Clases ─────────────────────────────────────────────────────────────────
  const joinLogs = logsRaw.map(r => ({
    id: s(r.id), teacherId: s(r.teacher_id), teacherName: s(r.teacher_name), studentName: s(r.student_name),
    scheduledDate: s(r.scheduled_date), scheduledTime: s(r.scheduled_time),
    source: r.source === 'manual' ? 'manual' : 'click',
    durationHours: typeof r.duration_hours === 'number' ? r.duration_hours : undefined,
    transcriptDeadlineAt: sn(r.transcript_deadline_at) ?? undefined,
  })) as unknown as ClassJoinLog[];
  const records = recordsRaw.map(r => ({
    id: s(r.id), teacherId: s(r.teacher_id), studentName: s(r.student_name), classDate: s(r.class_date),
    classTime: sn(r.class_time) ?? undefined, classType: s(r.class_type) || 'normal',
    rescheduledTo: sn(r.rescheduled_to) ?? undefined,
  })) as unknown as ClassRecord[];
  const analyses = analysesRaw as unknown as ClassTranscriptRef[];

  const eventos = eventosRaw as unknown as Array<EventoUso & { event: string }>;
  const primeraSubida = new Map<string, string>();
  for (const e of eventos) {
    if (e.event !== 'transcript_first_upload' || !e.ref_id) continue;
    const prev = primeraSubida.get(e.ref_id);
    if (!prev || e.created_at < prev) primeraSubida.set(e.ref_id, e.created_at);
  }

  // ── Clases programadas: la foto de cada noche y, sin foto, la proyección ────
  const fotos: ClaseProgramada[] = fotosRaw.map(r => ({
    teacherId: s(r.teacher_id), teacherName: s(r.teacher_name), studentName: s(r.student_name),
    date: s(r.class_date).slice(0, 10), startHour: Number(r.start_hour),
    durationHours: Number(r.duration_hours) || 1, isRecovery: r.is_recovery === true,
  }));
  const fechasConFoto = new Set(fotos.map(f => f.date));
  const fechasSinFoto: string[] = [];
  for (let d = desde; d <= hoy; d = addDaysIso(d, 1)) if (!fechasConFoto.has(d)) fechasSinFoto.push(d);
  const periodos = periodosPorProfe(profesores.map(p => p.id), asignaciones, dropouts);
  const programadas = [...fotos, ...proyectarCalendario(profesores, fechasSinFoto, periodos)];

  const informe = construirInformeUso({
    hoy, now, semanas, profesores, ignorar,
    profesorActualPorAlumno: porAlumno, profesorActualPorNombre: porNombre,
    envios, validados,
    generaciones: generaciones as unknown as GeneracionIA[],
    joinLogs, records, analyses, primeraSubida,
    programadas, fechasConFoto,
    alertas: alertasRaw as unknown as AlertaRiesgo[],
    eventos,
  });

  const avisos: string[] = [];
  if (errores.includes('usage_events') || errores.includes('scheduled_class_snapshots')) {
    avisos.push('Falta correr supabase-usage-events.sql en Supabase: "Abrió la alerta" no se mide y "Entró con el link" usa solo la proyección del calendario.');
  }
  const otros = errores.filter(e => e !== 'usage_events' && e !== 'scheduled_class_snapshots');
  if (otros.length) avisos.push(`No se pudieron leer: ${otros.join(', ')}. Esas métricas pueden salir incompletas.`);
  return { ...informe, avisos };
}

/** Período de cada alumno por profesor (inicio de clases → baja), para no proyectar clases que no existieron. */
function periodosPorProfe(
  teacherIds: string[], asignaciones: Fila[], dropouts: Array<{ teacherId: string; studentName: string; droppedAt?: string }>,
): Map<string, Map<string, StudentPeriod>> {
  const rows = asignaciones.map(a => ({
    teacherId: s(a.teacher_id), studentName: s(a.student_name),
    startDate: sn(a.start_date) ?? undefined, createdAt: sn(a.created_at) ?? undefined,
  }));
  const out = new Map<string, Map<string, StudentPeriod>>();
  for (const id of teacherIds) out.set(id, periodIndex(rows, dropouts, id));
  return out;
}

/**
 * Clases programadas de UNA fecha según el calendario de ahora. Es lo que guarda
 * la foto diaria (cron daily-transcript-reminder).
 */
export async function clasesProgramadasDe(fecha: string): Promise<ClaseProgramada[]> {
  const errores: string[] = [];
  const [teachers, dropouts, asignaciones] = await Promise.all([
    dbGetTeachers(),
    dbGetStudentDropouts(),
    leer('assignments', (f, t) => supabase.from('assignments')
      .select('id, teacher_id, student_name, start_date, created_at').order('id').range(f, t), errores),
  ]);
  const profesores = teachers.filter(t => !PROFESORES_DE_PRUEBA.has(t.id));
  return proyectarCalendario(profesores, [fecha], periodosPorProfe(profesores.map(p => p.id), asignaciones, dropouts));
}
