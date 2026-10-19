// ── Posibles ausencias del profesor: el chequeo contra la base (SOLO SERVIDOR) ─
//
// Lo llama /api/cron/ausencias cada 5 minutos (pg_cron de Supabase, ver
// supabase-teacher-absences.sql). Cada vuelta:
//   1. Lee, de UNA vez para todos los profesores: profesores, calendarios,
//      asignaciones, alumnos, bajas, y los ingresos / constancias / avisos de
//      hoy y ayer. Son 8 consultas pequeñas, sin transcripts ni tablas enteras
//      de historial.
//   2. Decide qué clases empezaron hace 30–90 minutos sin ingreso
//      (lib/teacherAbsences, la misma regla que "Mis clases").
//   3. Solo para esas pocas: pausa / suscripción inactiva / teléfono, con la
//      MISMA verificación que el botón "Ingresar a clase" (la ruta
//      /api/check-subscription, llamada en el mismo proceso, sin otra invocación).
//   4. Reserva la fila (id fijo por clase) y DESPUÉS avisa a Zapier: si dos
//      vueltas se pisan, la segunda choca con la clave primaria y no envía nada.
//   5. Marca "llegó tarde" las posibles ausencias cuyo profesor ya ingresó.
//
// RECUPERACIÓN AUTOMÁTICA (ABSENCE_RECOVERY_BETA_TEACHERS, hoy todos): en el paso 4,
// entre reservar la fila y avisar a Zapier, se crea la recuperación
// (lib/classRecoveryStore, createAbsenceRecovery) y su enlace viaja en
// `enlace_recuperacion`. Si el profesor ingresa después:
//   · antes de la MITAD de la clase → se anula la recuperación (la clase se dio);
//   · después → la recuperación sigue viva y la fila queda "para revisar" en el
//     admin: la clase original tiene ingreso y, con transcript, Finanzas la
//     pagaría (y gastaría cupo del alumno). Finanzas no se tocó: lo resuelve un
//     admin (ver AdminAbsence.revisar).
//
// SI UNA LECTURA FALLA, NO SE AVISA NADA. Sin los ingresos (o sin las
// cancelaciones) todas las clases parecerían ausencias, y el aviso le llega al
// ALUMNO por WhatsApp. Se corta la vuelta entera y la siguiente lo reintenta.
//
// Si WooCommerce no responde, la clase queda "no verificado" en el admin y NO se
// avisa a Zapier (decisión del 15/10/2026).
//
// Todo con el cliente ADMIN (service role): la tabla teacher_absence_alerts
// tiene RLS activado porque guarda teléfonos.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllPages, gridClassesOf, teacherStudentsFrom, teacherAssignmentsFrom } from '@/lib/db';
import { gridOccupancyOfTeacher, addDaysIso } from '@/lib/teacherClasses';
import { periodIndex } from '@/lib/studentPeriod';
import { isPausedStatus } from '@/lib/subscriptionAccess';
import { getSpainParts, spainWallClockToEpoch } from '@/lib/spainTime';
import { hourNum, hourText, nkName } from '@/lib/sessions';
import { GET as checkSubscriptionRoute } from '@/app/api/check-subscription/route';
import {
  findDueAbsences, findLateJoins, readDates, windowDates, inAbsenceWindow, buildAbsencePayload,
  normalizePhone, MAX_ZAPIER_ATTEMPTS, ABSENCE_AFTER_MINUTES, ABSENCE_WINDOW_END_MINUTES,
  type TeacherScheduleInput, type JoinLogLite, type ClassRecordLite, type AbsenceWebhookPayload, type DueAbsence,
} from '@/lib/teacherAbsences';
import { sendAbsenceToZapier, absenceWebhookUrl } from '@/lib/absenceWebhook';
import {
  createAbsenceRecovery, absenceRecoveryOptions, annulAbsenceRecovery, absenceRecoveryOfClass, type AbsenceAnnulOutcome,
} from '@/lib/classRecoveryStore';
import { recoveryLink } from '@/lib/classRecoveryEmails';
import { destinationFor } from '@/lib/emailNotifications';
import { isAbsenceRecoveryTeacher, joinedBeforeHalf } from '@/lib/teacherAbsences';
import type { Slot } from '@/lib/classRecoveries';
import type { Assignment, Grid, Student } from '@/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export const ABSENCES_TABLE = 'teacher_absence_alerts';

export type AbsenceStatus = 'posible_ausencia' | 'llego_tarde' | 'no_verificado' | 'descartada' | 'anulada';
export type ZapierStatus = 'pendiente' | 'enviado' | 'sin_webhook' | 'error' | 'no_enviado';

export interface AbsenceReportItem {
  id: string;
  profesor: string;
  alumno: string;
  fecha: string;
  hora: string;
  estado: AbsenceStatus;
  motivo: string | null;
  zapier: ZapierStatus | 'se_enviaria' | 'no_se_enviaria';
  zapierError?: string;
  /** Solo en ensayo: lo que recibiría Zapier. */
  payload?: AbsenceWebhookPayload;
  /**
   * Recuperación automática (ABSENCE_RECOVERY_BETA_TEACHERS). En ensayo, las opciones que
   * se ofrecerían; de verdad, la recuperación creada o por qué no.
   */
  recuperacion?: { id?: string; opciones?: Slot[]; emailAlumno?: boolean; error?: string };
}

export interface AbsenceCheckReport {
  ensayo: boolean;
  ahoraEspana: string;
  ventana: string;
  webhookConfigurado: boolean;
  clasesEnVentana: number;
  nuevas: AbsenceReportItem[];
  llegoTarde: Array<{ id: string; ingreso: string; mitad: 'antes' | 'despues'; recuperacion?: AbsenceAnnulOutcome | 'sigue_viva' | 'error' }>;
  reintentos: AbsenceReportItem[];
  errores: string[];
}

// ── Lecturas ──────────────────────────────────────────────────────────────────

class MissingTableError extends Error {}

function isMissingTable(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table/i.test(e.message ?? ''));
}

async function leer(label: string, run: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string; code?: string } | null }>): Promise<Row[]> {
  const { rows, error } = await fetchAllPages<Row>(label, run);
  if (error) {
    if (label === ABSENCES_TABLE && isMissingTable(error)) {
      throw new MissingTableError('Falta correr supabase-teacher-absences.sql en Supabase.');
    }
    throw new Error(`No se pudo leer ${label}: ${error.message}`);
  }
  return rows;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strU = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function toAssignment(r: Row): Assignment {
  return {
    id: str(r.id), teacherId: str(r.teacher_id), teacherName: str(r.teacher_name), teacherEmail: str(r.teacher_email),
    studentId: str(r.student_id), studentName: str(r.student_name), studentEmail: str(r.student_email),
    studentLevel: str(r.student_level), slots: [], objetivo: '', plan: str(r.plan),
    weeklyHours: 0, availability: '', notes: '',
    startDate: strU(r.start_date), createdAt: str(r.created_at), status: strU(r.status),
  };
}

function toStudent(r: Row): Student {
  return {
    id: str(r.id), name: str(r.name), email: str(r.email), phone: strU(r.phone),
    level: str(r.level), plan: str(r.plan), createdAt: strU(r.created_at),
  } as Student;
}

interface Datos {
  teachers: TeacherScheduleInput[];
  students: Student[];
  joinLogs: JoinLogLite[];
  records: ClassRecordLite[];
  alerts: Row[];
  /** profe_email de Zapier por id de profesor (destinationFor: notification_email → email). */
  teacherEmails: Map<string, string>;
}

/**
 * `ensayo`: sin la tabla de avisos (SQL sin correr) se sigue como si estuviera
 * vacía, para poder ver qué se avisaría ANTES de encender el reloj. En una vuelta
 * real eso es un error: sin la tabla no hay anti-duplicado.
 */
async function cargarDatos(admin: SupabaseClient, fechas: string[], ensayo: boolean): Promise<Datos> {
  const leerAvisos = async (): Promise<Row[]> => {
    try {
      return await leer(ABSENCES_TABLE, (f, t) => admin.from(ABSENCES_TABLE).select('*').in('class_date', fechas).order('id').range(f, t));
    } catch (err) {
      if (ensayo && err instanceof MissingTableError) return [];
      throw err;
    }
  };
  const [teachersRaw, calendars, asgRaw, studentsRaw, dropoutsRaw, logsRaw, recordsRaw, alerts] = await Promise.all([
    leer('teachers', (f, t) => admin.from('teachers').select('*').order('id').range(f, t)),
    leer('teacher_calendars', (f, t) => admin.from('teacher_calendars').select('teacher_id, grid').order('teacher_id').range(f, t)),
    leer('assignments', (f, t) => admin.from('assignments')
      .select('id, teacher_id, teacher_name, teacher_email, student_id, student_name, student_email, student_level, plan, start_date, created_at, status')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(f, t)),
    leer('students', (f, t) => admin.from('students').select('id, name, email, phone, level, plan, created_at').order('id').range(f, t)),
    leer('student_dropouts', (f, t) => admin.from('student_dropouts').select('id, teacher_id, student_name, dropped_at').order('id').range(f, t)),
    leer('class_join_logs', (f, t) => admin.from('class_join_logs')
      .select('id, teacher_id, student_name, scheduled_date, scheduled_time, clicked_at').in('scheduled_date', fechas).order('id').range(f, t)),
    leer('class_records', (f, t) => admin.from('class_records')
      .select('id, teacher_id, student_name, class_date, class_time, class_type, rescheduled_to').in('class_date', fechas).order('id').range(f, t)),
    leerAvisos(),
  ]);

  const grids = new Map<string, Grid>(calendars.map(c => [str(c.teacher_id), (c.grid ?? {}) as Grid]));
  const students = studentsRaw.map(toStudent);
  const dropouts = dropoutsRaw.map(d => ({ teacherId: str(d.teacher_id), studentName: str(d.student_name), droppedAt: strU(d.dropped_at) }));

  // Ya vienen de la más reciente a la más vieja, que es lo que espera teacherStudentsFrom.
  const asgPorProfe = new Map<string, Assignment[]>();
  for (const a of asgRaw.map(toAssignment)) {
    const arr = asgPorProfe.get(a.teacherId);
    if (arr) arr.push(a); else asgPorProfe.set(a.teacherId, [a]);
  }

  const teachers: TeacherScheduleInput[] = [];
  const teacherEmails = new Map<string, string>();
  for (const t of teachersRaw) {
    if (t.archived_at) continue;
    const id = str(t.id);
    const grid = grids.get(id);
    if (!grid || Object.keys(grid).length === 0) continue;
    const prof = { id, name: str(t.name), email: str(t.email) };
    teacherEmails.set(id, destinationFor({ name: prof.name, email: prof.email, notificationEmail: str(t.notification_email) }));
    const assignments = teacherAssignmentsFrom(prof, teacherStudentsFrom(grid, asgPorProfe.get(id) ?? [], students));
    teachers.push({
      teacherId: id, teacherName: prof.name, assignments, grid,
      occupancy: gridOccupancyOfTeacher(gridClassesOf(grid)),
      periods: periodIndex(assignments, dropouts, id),
    });
  }

  return {
    teachers, students, alerts, teacherEmails,
    joinLogs: logsRaw.map(l => ({
      teacherId: str(l.teacher_id), studentName: str(l.student_name), scheduledDate: str(l.scheduled_date),
      scheduledTime: str(l.scheduled_time), clickedAt: str(l.clicked_at),
    })),
    records: recordsRaw.map(r => ({
      id: str(r.id), teacherId: str(r.teacher_id), studentName: str(r.student_name), classDate: str(r.class_date),
      classTime: strU(r.class_time), classType: strU(r.class_type) as ClassRecordLite['classType'], rescheduledTo: strU(r.rescheduled_to),
    })),
  };
}

// ── Suscripción y teléfono ────────────────────────────────────────────────────

interface Verificacion { active: boolean | null; status: string; phone: string | null }

/**
 * La misma verificación que el botón "Ingresar a clase": la ruta
 * /api/check-subscription (Oritalk y activación manual cuentan como activo), en
 * el mismo proceso. Ante cualquier fallo, `active: null` (= no verificado).
 */
async function verificarAlumno(email: string): Promise<Verificacion> {
  try {
    const res = await checkSubscriptionRoute(new Request(`http://gestion.local/api/check-subscription?email=${encodeURIComponent(email)}`));
    const j = (await res.json()) as Row;
    return {
      active: typeof j.active === 'boolean' ? j.active : null,
      status: typeof j.status === 'string' ? j.status : 'error',
      phone: typeof j.phone === 'string' ? j.phone : null,
    };
  } catch (err) {
    console.error('[ausencias] No se pudo verificar la suscripción:', err);
    return { active: null, status: 'error', phone: null };
  }
}

/**
 * Teléfono de facturación del último pedido de WooCommerce. Solo se usa cuando
 * ni la ficha ni la suscripción lo traen (p. ej. alumnos con activación manual).
 * Best-effort: '' ante cualquier fallo.
 */
async function telefonoDeFacturacion(email: string): Promise<string> {
  const base = process.env.WOOCOMMERCE_URL?.replace(/\/$/, '');
  const ck = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs = process.env.WOOCOMMERCE_CONSUMER_SECRET;
  if (!base || !ck || !cs) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = `${base}/wp-json/wc/v3/orders?search=${encodeURIComponent(email)}&per_page=1&orderby=date&order=desc` +
      `&consumer_key=${encodeURIComponent(ck)}&consumer_secret=${encodeURIComponent(cs)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
    if (!res.ok) return '';
    const arr = await res.json();
    const phone = Array.isArray(arr) ? arr[0]?.billing?.phone : null;
    return typeof phone === 'string' ? phone.trim() : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/** Ficha del alumno de una asignación: por email y, si no, por nombre (como components/JoinClass). */
function studentOf(a: Assignment, students: Student[]): Student | undefined {
  const byEmail = a.studentEmail?.trim().toLowerCase();
  return (byEmail ? students.find(s => s.email?.trim().toLowerCase() === byEmail) : undefined)
    ?? students.find(s => nkName(s.name) === nkName(a.studentName));
}

// ── Una clase nueva ───────────────────────────────────────────────────────────

async function clasificar(d: DueAbsence, students: Student[]): Promise<{
  estado: AbsenceStatus; motivo: string | null; subStatus: string | null;
  email: string; phone: string; studentId: string | null;
}> {
  const st = studentOf(d.assignment, students);
  const email = (st?.email || d.assignment.studentEmail || '').trim().toLowerCase();
  const studentId = st?.id || d.assignment.studentId || null;
  if (!email) {
    return { estado: 'no_verificado', motivo: 'El alumno no tiene email: no se pudo verificar la suscripción.', subStatus: null, email: '', phone: normalizePhone(st?.phone), studentId };
  }
  const v = await verificarAlumno(email);
  if (isPausedStatus(v.status)) {
    return { estado: 'descartada', motivo: 'Alumno en pausa.', subStatus: v.status, email, phone: '', studentId };
  }
  if (v.active === false) {
    return { estado: 'descartada', motivo: `Suscripción inactiva (${v.status}).`, subStatus: v.status, email, phone: '', studentId };
  }
  if (v.active === null) {
    return { estado: 'no_verificado', motivo: 'WooCommerce no respondió: no se avisó a Zapier.', subStatus: v.status, email, phone: normalizePhone(st?.phone), studentId };
  }
  const phone = normalizePhone(st?.phone) || normalizePhone(v.phone) || normalizePhone(await telefonoDeFacturacion(email));
  return { estado: 'posible_ausencia', motivo: null, subStatus: v.status, email, phone, studentId };
}

// ── El chequeo ────────────────────────────────────────────────────────────────

export async function runAbsenceCheck(admin: SupabaseClient, opts: { nowMs?: number; dry?: boolean } = {}): Promise<AbsenceCheckReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const dry = !!opts.dry;
  const p = getSpainParts(new Date(nowMs));
  const report: AbsenceCheckReport = {
    ensayo: dry,
    ahoraEspana: `${p.dateStr} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
    ventana: `clases que empezaron hace entre ${ABSENCE_AFTER_MINUTES} y ${ABSENCE_WINDOW_END_MINUTES} minutos (${windowDates(nowMs).join(' / ')})`,
    webhookConfigurado: !!absenceWebhookUrl(),
    clasesEnVentana: 0, nuevas: [], llegoTarde: [], reintentos: [], errores: [],
  };

  const datos = await cargarDatos(admin, readDates(nowMs), dry);
  const nowIso = new Date(nowMs).toISOString();

  // 1) Llegó tarde: posibles ausencias abiertas cuyo profesor ya pulsó "Ingresar".
  const abiertas = datos.alerts.filter(a => a.status === 'posible_ausencia' || a.status === 'no_verificado');
  const tarde = findLateJoins(abiertas.map(a => ({
    id: str(a.id), teacherId: str(a.teacher_id), studentName: str(a.student_name),
    classDate: str(a.class_date), classHour: str(a.class_hour), durationHours: Number(a.duration_hours) || 1,
  })), datos.joinLogs);
  for (const t of tarde) {
    const a = abiertas.find(x => str(x.id) === t.id)!;
    const clase = { classDate: str(a.class_date), classHour: str(a.class_hour), durationHours: Number(a.duration_hours) || 1 };
    const antes = joinedBeforeHalf(clase, t.clickedAt);
    const item: AbsenceCheckReport['llegoTarde'][number] = { id: t.id, ingreso: t.clickedAt, mitad: antes ? 'antes' : 'despues' };
    report.llegoTarde.push(item);
    if (dry) continue;
    const { data: marcada, error } = await admin.from(ABSENCES_TABLE).update({
      status: 'llego_tarde', late_joined_at: t.clickedAt || nowIso, updated_at: nowIso,
    }).eq('id', t.id).in('status', ['posible_ausencia', 'no_verificado']).select('id');
    if (error) { report.errores.push(`llegó tarde ${t.id}: ${error.message}`); continue; }
    if (!marcada?.length) continue;   // otra vuelta (o el admin) ya la cambió
    item.recuperacion = await recuperacionTrasLlegarTarde(admin, a, antes, t.clickedAt);
  }
  const yaTarde = new Set(tarde.map(t => t.id));

  // 2) Reintentos: Zapier falló (o la vuelta murió entre reservar y enviar) y la
  //    clase sigue dentro de la ventana. Nunca se reenvía lo que ya salió bien.
  for (const a of datos.alerts) {
    if (a.status !== 'posible_ausencia' || yaTarde.has(str(a.id))) continue;
    const pendienteVieja = a.zapier_status === 'pendiente' && nowMs - Date.parse(str(a.detected_at)) > 2 * 60_000;
    if (a.zapier_status !== 'error' && !pendienteVieja) continue;
    if ((Number(a.zapier_attempts) || 0) >= MAX_ZAPIER_ATTEMPTS) continue;
    const h = hourNum(str(a.class_hour));
    if (!inAbsenceWindow(spainWallClockToEpoch(str(a.class_date), h), nowMs)) continue;
    const item: AbsenceReportItem = {
      id: str(a.id), profesor: str(a.teacher_name), alumno: str(a.student_name), fecha: str(a.class_date),
      hora: str(a.class_hour), estado: 'posible_ausencia', motivo: 'reintento', zapier: 'se_enviaria',
    };
    if (!dry && a.payload) Object.assign(item, await enviar(admin, str(a.id), a.payload as AbsenceWebhookPayload, (Number(a.zapier_attempts) || 0) + 1));
    report.reintentos.push(item);
  }

  // 3) Clases nuevas de la ventana sin ingreso.
  const { due, inWindow } = findDueAbsences({
    teachers: datos.teachers, records: datos.records, joinLogs: datos.joinLogs, nowMs,
    known: new Set(datos.alerts.map(a => str(a.id))),
  });
  report.clasesEnVentana = inWindow;

  for (const d of due) {
    const c = await clasificar(d, datos.students);
    const teacherEmail = datos.teacherEmails.get(d.teacherId) ?? '';
    const payload = c.estado === 'posible_ausencia'
      ? buildAbsencePayload({ id: d.id, date: d.date, hour: d.hour, teacherName: d.teacherName, teacherEmail, studentName: d.studentName, studentEmail: c.email, phone: c.phone })
      : null;
    const item: AbsenceReportItem = {
      id: d.id, profesor: d.teacherName, alumno: d.studentName, fecha: d.date, hora: d.hour,
      estado: c.estado, motivo: c.motivo,
      zapier: payload ? (report.webhookConfigurado ? 'se_enviaria' : 'sin_webhook') : 'no_se_enviaria',
    };
    if (dry) {
      if (payload) item.payload = payload;
      if (payload && isAbsenceRecoveryTeacher(d.teacherId)) item.recuperacion = await opcionesDeEnsayo(d, nowMs);
      report.nuevas.push(item);
      continue;
    }

    // Reservar ANTES de enviar: la clave primaria es el anti-duplicado.
    const { error } = await admin.from(ABSENCES_TABLE).insert({
      id: d.id, teacher_id: d.teacherId, teacher_name: d.teacherName,
      student_id: c.studentId, student_name: d.studentName, student_email: c.email || null, student_phone: c.phone || null,
      class_date: d.date, class_hour: d.hour, duration_hours: d.durationHours, is_recovery: d.isRecovery,
      status: c.estado, status_reason: c.motivo, subscription_status: c.subStatus,
      detected_at: nowIso, zapier_status: payload ? 'pendiente' : 'no_enviado', zapier_attempts: 0,
      payload, created_at: nowIso, updated_at: nowIso,
    });
    if (error) {
      if (error.code !== '23505') report.errores.push(`${d.id}: ${error.message}`);
      continue;   // 23505: otra vuelta la reservó primero.
    }
    let aEnviar = payload;
    if (payload && isAbsenceRecoveryTeacher(d.teacherId)) {
      const r = await crearRecuperacion(admin, d, c, teacherEmail);
      item.recuperacion = r.info;
      if (r.link) aEnviar = { ...payload, enlace_recuperacion: r.link };
    }
    if (aEnviar) Object.assign(item, await enviar(admin, d.id, aEnviar, 1));
    else item.zapier = 'no_enviado';
    report.nuevas.push(item);
  }

  return report;
}

/** Ensayo: las opciones que se ofrecerían, sin crear nada. */
async function opcionesDeEnsayo(d: DueAbsence, nowMs: number): Promise<NonNullable<AbsenceReportItem['recuperacion']>> {
  try {
    return { opciones: await absenceRecoveryOptions({ teacherId: d.teacherId, date: d.date, hour: d.hour, hours: d.durationHours, nowMs }) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Crea la recuperación de una posible ausencia nueva y deja su id y el enlace en
 * la fila (el payload guardado es el que usan los reintentos). Si falla, el aviso
 * a Zapier sale igual, con `enlace_recuperacion` vacío.
 */
async function crearRecuperacion(
  admin: SupabaseClient, d: DueAbsence, c: Awaited<ReturnType<typeof clasificar>>, teacherEmail: string,
): Promise<{ link: string | null; info: NonNullable<AbsenceReportItem['recuperacion']> }> {
  try {
    const r = await createAbsenceRecovery({
      teacherId: d.teacherId, teacherName: d.teacherName,
      assignmentId: d.assignment.id || null, studentId: c.studentId,
      studentName: d.studentName, studentEmail: c.email || null, studentPhone: c.phone || null,
      date: d.date, hour: d.hour, durationHours: d.durationHours,
    });
    const link = recoveryLink(r.recovery.id);
    const payload = buildAbsencePayload({
      id: d.id, date: d.date, hour: d.hour, teacherName: d.teacherName, teacherEmail, studentName: d.studentName,
      studentEmail: c.email, phone: c.phone, recoveryLink: link,
    });
    const now = new Date().toISOString();
    const { error } = await admin.from(ABSENCES_TABLE).update({ recovery_id: r.recovery.id, payload, updated_at: now }).eq('id', d.id);
    if (error) {
      // Sin la columna recovery_id (SQL sin correr): al menos el enlace en el payload.
      console.error(`[ausencias] No se pudo anotar la recuperación de ${d.id}:`, error.message);
      await admin.from(ABSENCES_TABLE).update({ payload, updated_at: now }).eq('id', d.id);
    }
    return { link, info: { id: r.recovery.id, opciones: r.recovery.teacherProposals, emailAlumno: r.studentEmailSent } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ausencias] No se pudo crear la recuperación de ${d.id}:`, msg);
    return { link: null, info: { error: msg } };
  }
}

/**
 * El profesor ingresó después del aviso. Antes de la mitad: la clase se dio y
 * se anula la recuperación. Después: la recuperación sigue viva y se avisa al
 * admin (una vez por clase) para que revise el pago de la clase original.
 */
async function recuperacionTrasLlegarTarde(admin: SupabaseClient, a: Row, antes: boolean, clickedAt: string): Promise<AbsenceAnnulOutcome | 'sigue_viva' | 'error'> {
  const clase = {
    recoveryId: strU(a.recovery_id) ?? null, teacherId: str(a.teacher_id), studentName: str(a.student_name),
    date: str(a.class_date), hour: str(a.class_hour),
  };
  try {
    if (antes) {
      const r = await annulAbsenceRecovery(clase, { by: 'sistema', reason: 'El profesor ingresó a la clase antes de la mitad' });
      return r.outcome;
    }
    const viva = await absenceRecoveryOfClass(clase);
    if (!viva || viva.status === 'recuperada') return 'sin_recuperacion';
    const ingreso = clickedAt
      ? new Date(clickedAt).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' })
      : 'una hora desconocida';
    await adminBell(admin, `notif_aus_tarde_${str(a.id)}`,
      `Revisar: ${str(a.teacher_name)} entró pasada la mitad de la clase`,
      `${str(a.teacher_name)} pulsó «Ingresar» a las ${ingreso} en la clase de las ${clase.hour} del ${clase.date} con ${clase.studentName}, ` +
      'después de la mitad. La recuperación del alumno sigue viva. Si sube el transcript, Finanzas pagará también la clase original: ' +
      'revísalo en Recuperaciones → Posibles ausencias.');
    return 'sigue_viva';
  } catch (err) {
    console.error(`[ausencias] Recuperación tras llegar tarde (${str(a.id)}):`, err);
    return 'error';
  }
}

/** Aviso al admin con id fijo (un reintento no lo duplica). Best-effort. */
async function adminBell(admin: SupabaseClient, id: string, title: string, body: string): Promise<void> {
  try {
    await admin.from('notifications').upsert({
      id, target_user: null, target_role: 'admin', title, body, type: 'ausencia_revisar',
      read_by: [], created_at: new Date().toISOString(), created_by: 'sistema',
    }, { onConflict: 'id', ignoreDuplicates: true });
  } catch (err) {
    console.error('[ausencias] Aviso al admin fallido:', err);
  }
}

/** Envía a Zapier y deja anotado el resultado en la fila. */
async function enviar(admin: SupabaseClient, id: string, payload: AbsenceWebhookPayload, intento: number): Promise<Pick<AbsenceReportItem, 'zapier' | 'zapierError'>> {
  const r = await sendAbsenceToZapier(payload);
  const now = new Date().toISOString();
  const zapier: ZapierStatus = r.status === 'sent' ? 'enviado' : r.status === 'skipped' ? 'sin_webhook' : 'error';
  const zapierError = r.status === 'error' ? r.reason : undefined;
  const { error } = await admin.from(ABSENCES_TABLE).update({
    zapier_status: zapier, zapier_attempts: intento, zapier_error: zapierError ?? null,
    zapier_sent_at: r.status === 'sent' ? now : null, updated_at: now,
  }).eq('id', id);
  if (error) console.error(`[ausencias] No se pudo anotar el envío de ${id}:`, error.message);
  if (zapierError) console.error(`[ausencias] Zapier falló para ${id}: ${zapierError}`);
  return { zapier, zapierError };
}

// ── Admin ─────────────────────────────────────────────────────────────────────

/** La recuperación automática de una posible ausencia, tal como la ve el admin. */
export interface AdminAbsenceRecovery {
  id: string;
  status: string;
  options: Array<{ date: string; hour: string }>;
  chosenDate: string | null;
  chosenHour: string | null;
}

/** Lo que ve el admin. Sin teléfono, email ni payload: no hacen falta para revisar. */
export interface AdminAbsence {
  id: string;
  teacherId: string;
  teacherName: string;
  studentName: string;
  classDate: string;
  classHour: string;
  durationHours: number;
  isRecovery: boolean;
  status: AbsenceStatus;
  statusReason: string | null;
  detectedAt: string;
  lateJoinedAt: string | null;
  zapierStatus: ZapierStatus;
  zapierSentAt: string | null;
  zapierError: string | null;
  recovery: AdminAbsenceRecovery | null;
  /** El profesor pulsó "Ingresar" pasada la mitad de la clase. */
  lateAfterHalf: boolean;
  /**
   * Para revisar: entró pasada la mitad y la recuperación sigue viva. La clase
   * original tiene ingreso, así que con transcript Finanzas la pagaría (y
   * gastaría cupo del alumno) además de la recuperación. Lo decide el admin:
   * anular la posible ausencia (se da por buena la clase) o dejarla.
   */
  revisar: boolean;
  annulledAt: string | null;
  annulledBy: string | null;
}

const RECUPERACION_VIVA = ['esperando_alumno', 'alumno_propuso', 'confirmada', 'sin_acuerdo'];

export async function listAbsencesForAdmin(admin: SupabaseClient, days = 30): Promise<AdminAbsence[]> {
  const desde = addDaysIso(getSpainParts(new Date()).dateStr, -days);
  // `*` para no depender de las columnas de supabase-recuperacion-por-falta.sql.
  const [{ data, error }, { data: recs }] = await Promise.all([
    admin.from(ABSENCES_TABLE).select('*')
      .gte('class_date', desde)
      .order('class_date', { ascending: false }).order('class_hour', { ascending: false })
      .limit(1000),
    admin.from('class_recoveries').select('*').gte('original_date', desde).limit(2000),
  ]);
  if (error) {
    if (isMissingTable(error)) throw new MissingTableError('Falta correr supabase-teacher-absences.sql en Supabase.');
    throw new Error(error.message);
  }
  const deAusencia = ((recs ?? []) as Row[]).filter(r => r.origin === 'ausencia');
  const recuperacionDe = (a: Row): Row | undefined => {
    const id = strU(a.recovery_id);
    if (id) {
      const porId = deAusencia.find(r => r.id === id);
      if (porId) return porId;
    }
    const clase = deAusencia.filter(r => r.teacher_id === a.teacher_id && String(r.original_date).slice(0, 10) === str(a.class_date)
      && r.original_hour === str(a.class_hour) && nkName(r.student_name) === nkName(str(a.student_name)));
    return clase.find(r => r.status !== 'anulada') ?? clase[0];
  };
  return (data ?? []).map((r: Row) => {
    const rec = recuperacionDe(r);
    const status = r.status as AbsenceStatus;
    const durationHours = Number(r.duration_hours) || 1;
    const lateAfterHalf = status === 'llego_tarde' && !!r.late_joined_at
      && !joinedBeforeHalf({ classDate: str(r.class_date), classHour: str(r.class_hour), durationHours }, r.late_joined_at);
    return {
      id: str(r.id), teacherId: str(r.teacher_id), teacherName: str(r.teacher_name), studentName: str(r.student_name),
      classDate: str(r.class_date), classHour: hourText(hourNum(str(r.class_hour))) || str(r.class_hour),
      durationHours, isRecovery: !!r.is_recovery,
      status, statusReason: r.status_reason ?? null,
      detectedAt: str(r.detected_at), lateJoinedAt: r.late_joined_at ?? null,
      zapierStatus: r.zapier_status as ZapierStatus, zapierSentAt: r.zapier_sent_at ?? null, zapierError: r.zapier_error ?? null,
      recovery: rec ? {
        id: str(rec.id), status: str(rec.status),
        options: ((rec.teacher_proposals ?? []) as Slot[]).map(o => ({ date: o.date, hour: o.hour })),
        chosenDate: rec.chosen_date ? String(rec.chosen_date).slice(0, 10) : null, chosenHour: rec.chosen_hour ?? null,
      } : null,
      lateAfterHalf,
      revisar: lateAfterHalf && !!rec && RECUPERACION_VIVA.includes(str(rec.status)),
      annulledAt: r.annulled_at ?? null, annulledBy: r.annulled_by ?? null,
    };
  });
}

/** Error con código HTTP para la ruta del admin. */
export class AbsenceAdminError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * El admin anula una posible ausencia (no fue tal: problema técnico, clase dada
 * por otro medio, o el profesor entró tarde y se da por buena). Pasa a 'anulada'
 * y se anula su recuperación (libera la fecha si ya la había elegido el alumno).
 * Si la recuperación ya se dio, no se puede deshacer: se avisa en la respuesta.
 */
export async function annulAbsence(
  admin: SupabaseClient, id: string, opts: { by: string; reason: string },
): Promise<{ status: 'anulada'; recuperacion: AbsenceAnnulOutcome | 'error'; aviso: string | null }> {
  const { data: a, error } = await admin.from(ABSENCES_TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw new AbsenceAdminError(500, error.message);
  if (!a) throw new AbsenceAdminError(404, 'No encontramos esa posible ausencia.');
  const now = new Date().toISOString();
  if (a.status !== 'anulada') {
    const motivo = `Anulada por ${opts.by}: ${opts.reason}`;
    const full = await admin.from(ABSENCES_TABLE).update({
      status: 'anulada', status_reason: motivo, annulled_at: now, annulled_by: opts.by, updated_at: now,
    }).eq('id', id);
    if (full.error) {
      const corto = await admin.from(ABSENCES_TABLE).update({ status: 'anulada', status_reason: motivo, updated_at: now }).eq('id', id);
      if (corto.error) {
        throw new AbsenceAdminError(corto.error.code === '23514' ? 503 : 500, corto.error.code === '23514'
          ? 'Falta correr supabase-recuperacion-por-falta.sql (el estado "anulada" todavía no existe).'
          : corto.error.message);
      }
    }
  }
  try {
    const r = await annulAbsenceRecovery({
      recoveryId: strU(a.recovery_id) ?? null, teacherId: str(a.teacher_id), studentName: str(a.student_name),
      date: str(a.class_date), hour: str(a.class_hour),
    }, { by: opts.by, reason: `Posible ausencia anulada: ${opts.reason}` });
    return {
      status: 'anulada', recuperacion: r.outcome,
      aviso: r.outcome === 'ya_recuperada'
        ? 'La recuperación ya se dio y no se puede deshacer: si la clase original también se paga, serían dos clases.'
        : null,
    };
  } catch (err) {
    console.error(`[ausencias] No se pudo anular la recuperación de ${id}:`, err);
    return { status: 'anulada', recuperacion: 'error', aviso: 'La ausencia quedó anulada, pero no se pudo anular su recuperación: anúlala a mano abajo.' };
  }
}

export function isMissingAbsencesTable(err: unknown): boolean {
  return err instanceof MissingTableError;
}
