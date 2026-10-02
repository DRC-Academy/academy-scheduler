// "No puedo dar esta clase" — lo que se ESCRIBE. SOLO SERVIDOR.
//
// Las reglas viven en lib/classRecoveries.ts (puro, con tests); aquí se aplican:
//   · cancelar  → constancia de la clase + filas de recuperación + multa según
//                 comodines + email al alumno + aviso al admin;
//   · confirmar → celda "En recuperación" + constancia 'recuperacion', en un
//                 solo paso y deshaciendo si algo falla;
//   · anular    → libera reservas y quita la recuperación futura.
//
// TODO el cálculo de antelación y comodines se hace aquí, con la hora del
// servidor. El navegador solo muestra lo que devuelve la vista previa.
//
// NO llama a dbApplyFaltaSideEffects: esa función pone −5 € a TODA cancelación
// 'cancelada_por_profesor', y aquí la multa la decide la regla de comodines
// (evento 'cancelacion_profesor_penalizacion', id fijo se_cancel_prof_<grupo>).
// Llamarla cobraría dos veces.
//
// RESERVAS: las fechas propuestas NO se escriben en el calendario. Viven en la
// fila (teacher_proposals) mientras está 'esperando_alumno'; el calendario las
// pinta encima y las comprobaciones de huecos las respetan. Solo la fecha
// ELEGIDA se escribe en el calendario, como una recuperación de siempre: así la
// agenda, "Ingresar", el transcript, el pago y el cupo funcionan sin cambios.

import 'server-only';

import { supabase } from '@/lib/supabase';
import { dbReadTeacherGrid, dbApplyGridChanges, dbAddScoringEvent, type CalendarActor } from '@/lib/db';
import type { GridChanges } from '@/lib/gridPatch';
import { baseCellOf, isPuntualState } from '@/lib/cells';
import { dayNameFromIso, mondayIsoOfIso } from '@/lib/teacherClasses';
import { hourNum, hourText, nkName } from '@/lib/sessions';
import { normEmail } from '@/lib/email';
import {
  isRecoveryBetaTeacher, noticeMinutes, isLateNotice, wildcardOutcome, validateTeacherProposals,
  teacherProposalDays, teacherSlotProblems,
  spainMonthOf, spainDateOf, slotHours, normalizeHour, proposalsExpired, claseDe, cuandoEs, fechaLarga, statusAfterNone,
  BLOCKING_STATUSES, MONTHLY_WILDCARDS, PENALTY_START_DATE, NO_SHOW_PENALTY_EUROS, PENALTY_EUROS,
  nightlyAction, reclassPenalty, slotStartMs, MAX_ROUNDS,
  type Slot, type RecoveryStatus, type PriorCancellation, type WildcardOutcome, type OccupiedCheck, type RecoveryOrigin,
} from '@/lib/classRecoveries';
import {
  buildCancellationEmail, buildConfirmedEmail, buildReproposalEmail, sendStudentEmail,
} from '@/lib/classRecoveryEmails';
import { fetchTeacher, sendRecoveryChosenEmail, sendRecoveryStudentProposedEmail } from '@/lib/emailNotifications';
import type { Cell, Grid } from '@/types';

type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

const ACTOR: CalendarActor = { role: 'sistema', name: 'Recuperaciones', origin: 'sistema' };

/** Error con código HTTP, para que las rutas respondan sin adivinar. */
export class RecoveryError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const isMissingTable = (e: { code?: string } | null | undefined) => e?.code === '42P01' || e?.code === 'PGRST205';
const nuevoId = (pref: string) => `${pref}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ── Lecturas ──────────────────────────────────────────────────────────────────

export interface RecoveryRow {
  id: string; groupId: string; part: number; parts: number;
  assignmentId: string | null; teacherId: string; teacherName: string | null;
  studentId: string | null; studentName: string; studentEmail: string | null;
  originalDate: string; originalHour: string; hours: number;
  cancelRecordId: string | null; reason: string | null;
  cancelledAt: string; noticeMinutes: number; late: boolean;
  usedWildcard: boolean; penaltyEuros: number; wouldHavePenalty: boolean;
  agreedDirectly: boolean; round: number;
  teacherProposals: Slot[]; studentProposals: Array<{ date: string; hour: string }>; studentNote: string | null;
  chosenDate: string | null; chosenHour: string | null; chosenBy: string | null;
  recoveryRecordId: string | null; status: RecoveryStatus; statusChangedAt: string;
  cancelMonth: string; penaltyEventId: string | null; createdAt: string;
  /** Bloque B (supabase-class-recoveries-b.sql). Sin correr el SQL: 'profesor' y nulls. */
  origin: RecoveryOrigin;
  annulledAt: string | null; annulledBy: string | null; annulReason: string | null;
}

export function mapRecovery(r: Row): RecoveryRow {
  return {
    id: r.id, groupId: r.group_id, part: r.part, parts: r.parts,
    assignmentId: r.assignment_id ?? null, teacherId: r.teacher_id, teacherName: r.teacher_name ?? null,
    studentId: r.student_id ?? null, studentName: r.student_name, studentEmail: r.student_email ?? null,
    originalDate: String(r.original_date).slice(0, 10), originalHour: r.original_hour, hours: r.hours,
    cancelRecordId: r.cancel_record_id ?? null, reason: r.reason ?? null,
    cancelledAt: r.cancelled_at, noticeMinutes: r.notice_minutes, late: !!r.late,
    usedWildcard: !!r.used_wildcard, penaltyEuros: Number(r.penalty_euros ?? 0), wouldHavePenalty: !!r.would_have_penalty,
    agreedDirectly: !!r.agreed_directly, round: r.round ?? 1,
    teacherProposals: (r.teacher_proposals ?? []) as Slot[],
    studentProposals: (r.student_proposals ?? []) as Array<{ date: string; hour: string }>,
    studentNote: r.student_note ?? null,
    chosenDate: r.chosen_date ? String(r.chosen_date).slice(0, 10) : null, chosenHour: r.chosen_hour ?? null,
    chosenBy: r.chosen_by ?? null, recoveryRecordId: r.recovery_record_id ?? null,
    status: r.status, statusChangedAt: r.status_changed_at,
    cancelMonth: r.cancel_month ?? spainMonthOf(r.cancelled_at), penaltyEventId: r.penalty_event_id ?? null,
    createdAt: r.created_at,
    origin: r.origin === 'admin_reclasificacion' ? 'admin_reclasificacion' : 'profesor',
    annulledAt: r.annulled_at ?? null, annulledBy: r.annulled_by ?? null, annulReason: r.annul_reason ?? null,
  };
}

export async function getRecovery(id: string): Promise<RecoveryRow | null> {
  const { data, error } = await supabase.from('class_recoveries').select('*').eq('id', id).maybeSingle();
  if (isMissingTable(error)) throw new RecoveryError(503, 'no_configurado', 'Falta correr supabase-class-recoveries.sql.');
  if (error) throw new RecoveryError(500, 'error', error.message);
  return data ? mapRecovery(data) : null;
}

/**
 * Cancelaciones del profesor (una fila por trozo), para los comodines. Las
 * reclasificaciones del admin no entran: llevan multa fija y no gastan comodín.
 * `select('*')` a propósito: funciona con o sin la columna `origin` del bloque B.
 */
async function priorCancellationsOf(teacherId: string): Promise<PriorCancellation[]> {
  const { data, error } = await supabase.from('class_recoveries').select('*').eq('teacher_id', teacherId);
  if (isMissingTable(error)) throw new RecoveryError(503, 'no_configurado', 'Falta correr supabase-class-recoveries.sql.');
  if (error) throw new RecoveryError(500, 'error', error.message);
  return (data ?? [])
    .filter((r: Row) => r.origin !== 'admin_reclasificacion')
    .map((r: Row) => ({ groupId: r.group_id, cancelledAt: r.cancelled_at, late: !!r.late, status: r.status }));
}

/** Reservas vivas del profesor: propuestas en 'esperando_alumno' que no vencieron. */
export async function reservationsOf(teacherId: string, nowMs = Date.now()): Promise<Array<{ date: string; hour: string; studentName: string; groupId: string }>> {
  const { data, error } = await supabase.from('class_recoveries')
    .select('group_id, student_name, teacher_proposals, status').eq('teacher_id', teacherId).eq('status', 'esperando_alumno');
  if (error) return [];
  const out: Array<{ date: string; hour: string; studentName: string; groupId: string }> = [];
  for (const r of data ?? []) {
    const props = (r.teacher_proposals ?? []) as Slot[];
    if (proposalsExpired(props, nowMs)) continue;
    for (const s of props) for (const h of slotHours(s)) out.push({ ...h, studentName: r.student_name, groupId: r.group_id });
  }
  return out;
}

// ── El calendario ─────────────────────────────────────────────────────────────

/** La casilla tal como se ve la semana de `dateIso` (una marca de otra semana no cuenta). */
function cellOn(grid: Grid, dateIso: string, hour: string): Cell | null {
  const cell = grid[`${dayNameFromIso(dateIso)}_${hour}`];
  if (!cell) return null;
  if (isPuntualState(cell.state) && cell.weekDate && cell.weekDate !== mondayIsoOfIso(dateIso)) return baseCellOf(cell);
  return cell;
}

/** Comprobación de hueco libre: calendario + reservas de otras recuperaciones. */
function occupiedChecker(grid: Grid, reservations: Array<{ date: string; hour: string; studentName: string; groupId: string }>, excludeGroup?: string): OccupiedCheck {
  return (date, hour) => {
    const c = cellOn(grid, date, hour);
    if (c?.state === 'ocupado') return `El ${fechaLarga(date)} a las ${hour} tienes clase con ${c.student ?? 'otro alumno'}.`;
    if (c?.state === 'bloqueado') return `El ${fechaLarga(date)} a las ${hour} ya hay una recuperación${c.student ? ` de ${c.student}` : ''}.`;
    const r = reservations.find(x => x.date === date && x.hour === hour && x.groupId !== excludeGroup);
    if (r) return `El ${fechaLarga(date)} a las ${hour} está reservado para ${r.studentName}.`;
    return null;
  };
}

/**
 * Horas seguidas de la clase del alumno ese día desde `hour` (2 en una sesión de
 * 2 h). 0 si el calendario no la tiene esa semana.
 */
function sessionHoursOf(grid: Grid, dateIso: string, hour: string, studentName: string): number {
  let n = 0;
  for (let h = hourNum(hour); h < 24 && n < 4; h++) {
    const c = cellOn(grid, dateIso, hourText(h));
    const who = c?.state === 'ocupado' ? c.student : c?.state === 'bloqueado' ? c.student : undefined;
    if (!who || nkName(who) !== nkName(studentName)) break;
    n++;
  }
  return n;
}

// ── Contexto de la clase ──────────────────────────────────────────────────────

interface ClassContext {
  assignment: Row;
  teacherName: string;
  studentName: string;
  studentId: string | null;
  studentEmail: string | null;
  ccEmail: string | null;
  grid: Grid;
  date: string;
  hour: string;
  sessionHours: number;
  nowMs: number;
  notice: number;
  late: boolean;
}

async function loadClassContext(input: { teacherId: string; assignmentId: string; date: string; hour: string }): Promise<ClassContext> {
  if (!isRecoveryBetaTeacher(input.teacherId)) {
    throw new RecoveryError(403, 'no_beta', 'Esta función todavía no está disponible para tu cuenta.');
  }
  const hour = normalizeHour(input.hour);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') || !hour) throw new RecoveryError(422, 'datos_invalidos', 'Fecha u hora no válidas.');

  const { data: a } = await supabase.from('assignments')
    .select('id, teacher_id, student_id, student_name, student_email, status, slots').eq('id', input.assignmentId).maybeSingle();
  if (!a || a.teacher_id !== input.teacherId) throw new RecoveryError(404, 'no_encontrada', 'No encontramos esa clase entre las tuyas.');
  if (a.status === 'inactive') throw new RecoveryError(409, 'alumno_inactivo', 'Ese alumno ya no tiene clases contigo.');

  const [{ data: t }, { data: s }, grid] = await Promise.all([
    supabase.from('teachers').select('name').eq('id', input.teacherId).maybeSingle(),
    a.student_id ? supabase.from('students').select('email').eq('id', a.student_id).maybeSingle() : Promise.resolve({ data: null }),
    dbReadTeacherGrid(input.teacherId),
  ]);
  // El alumno entra al LMS con students.email; la asignación (a veces un padre) va en copia.
  const principal = normEmail((s as Row | null)?.email) || normEmail(a.student_email) || null;
  const otro = normEmail(a.student_email);
  const ccEmail = otro && otro !== principal ? otro : null;

  let sessionHours = sessionHoursOf(grid, input.date, hour, a.student_name);
  if (sessionHours === 0) {
    // Calendario sin la clase esa semana: vale el horario de la ficha.
    const day = dayNameFromIso(input.date);
    const enFicha = (a.slots ?? []).some((x: Row) => x.day === day && normalizeHour(x.hour) === hour);
    if (!enFicha) throw new RecoveryError(422, 'clase_inexistente', 'Esa clase no está en tu calendario.');
    sessionHours = 1;
  }

  const nowMs = Date.now();
  const notice = noticeMinutes({ date: input.date, hour }, nowMs);
  if (notice <= 0) {
    throw new RecoveryError(409, 'ya_empezo', 'Esta clase ya empezó: no se puede cancelar.');
  }

  return {
    assignment: a, teacherName: (t as Row | null)?.name ?? '', studentName: a.student_name,
    studentId: a.student_id ?? null, studentEmail: principal, ccEmail,
    grid, date: input.date, hour, sessionHours, nowMs, notice, late: isLateNotice(notice),
  };
}

/** ¿La clase ya está cancelada o movida? (constancias del profesor o del cambio). */
async function existingCancellation(teacherId: string, studentName: string, date: string, hour: string): Promise<string | null> {
  const { data } = await supabase.from('class_records')
    .select('id, class_type, class_time, student_name, reverted_at')
    .eq('teacher_id', teacherId).eq('class_date', date)
    .in('class_type', ['cancelada_por_profesor', 'cancelada_con_preaviso', 'reprogramada', 'cancelacion_hora', 'falta_con_aviso']);
  const hit = (data ?? []).find((r: Row) => !r.reverted_at && nkName(r.student_name) === nkName(studentName)
    && (!r.class_time || normalizeHour(r.class_time) === hour));
  if (hit) return hit.class_type === 'reprogramada' ? 'Esta clase ya se movió a otro día.' : 'Esta clase ya está cancelada.';
  const { data: rec } = await supabase.from('class_recoveries')
    .select('id, student_name, original_hour, status').eq('teacher_id', teacherId).eq('original_date', date)
    .in('status', BLOCKING_STATUSES as string[]);
  if ((rec ?? []).some((r: Row) => nkName(r.student_name) === nkName(studentName) && r.original_hour === hour)) {
    return 'Esta clase ya está cancelada.';
  }
  return null;
}

// ── Vista previa (lo que ve el profe antes de confirmar) ─────────────────────

export interface CancellationPreview {
  noticeMinutes: number;
  late: boolean;
  sessionHours: number;
  canSplit: boolean;
  wildcard: WildcardOutcome;
  wildcardsTotal: number;
  penaltyStartDate: string;
  penaltyEuros: number;
  noShowPenaltyEuros: number;
  alreadyCancelled: string | null;
  /** Problemas de las fechas que mandó el navegador (por trozo y por fecha). */
  proposalProblems?: Array<{ general: string[]; perSlot: string[][] }>;
  reservations: Array<{ date: string; hour: string; studentName: string }>;
  /**
   * Días que se pueden proponer (desde mañana, 7 días, sin domingos) con las
   * horas de inicio que pasarían la validación ahora mismo, dentro del rango
   * visible del calendario del profesor. Solo para pintar el modal: al enviar,
   * el servidor vuelve a validar todo.
   */
  freeSlots: Array<{ date: string; hours: string[] }>;
}

export interface CancelInput {
  teacherId: string;
  assignmentId: string;
  date: string;
  hour: string;
  reason?: string;
  agreedDirectly?: boolean;
  /** Sesión de 2 h recuperada en dos días: dos trozos de 1 h. */
  split?: boolean;
  /** Una lista por trozo: [[a, b]] normal, [[a, b], [c, d]] partida, [[a]] acordada. */
  proposals?: Array<Array<{ date: string; hour: string }>>;
}

function partsOf(ctx: ClassContext, input: CancelInput): { parts: number; hoursPerPart: number } {
  const split = !!input.split && ctx.sessionHours === 2;
  return { parts: split ? 2 : 1, hoursPerPart: split ? 1 : ctx.sessionHours };
}

function validateAll(ctx: ClassContext, input: CancelInput, reservations: Awaited<ReturnType<typeof reservationsOf>>) {
  const { parts, hoursPerPart } = partsOf(ctx, input);
  const occupied = occupiedChecker(ctx.grid, reservations);
  const lists = (input.proposals ?? []).slice(0, parts);
  const out = Array.from({ length: parts }, (_, i) => {
    const slots: Slot[] = (lists[i] ?? []).map(s => ({ date: s.date, hour: normalizeHour(s.hour) ?? s.hour, hours: hoursPerPart }));
    return validateTeacherProposals(slots, {
      agreedDirectly: !!input.agreedDirectly, nowMs: ctx.nowMs, occupied,
      original: { date: ctx.date, hour: ctx.hour },
    });
  });
  // Los dos trozos de una sesión partida no pueden proponer la misma hora.
  if (parts === 2) {
    const keys = (input.proposals ?? []).flat().map(s => `${s.date}|${normalizeHour(s.hour)}`);
    if (new Set(keys).size !== keys.length) out[1].general.push('Las dos horas no pueden coincidir con las fechas de la otra hora.');
  }
  return { parts, hoursPerPart, results: out, ok: out.every(r => r.ok && r.general.length === 0) };
}

export async function previewCancellation(input: CancelInput): Promise<CancellationPreview> {
  const ctx = await loadClassContext(input);
  const [prior, reservations, already] = await Promise.all([
    priorCancellationsOf(input.teacherId),
    reservationsOf(input.teacherId, ctx.nowMs),
    existingCancellation(input.teacherId, ctx.studentName, ctx.date, ctx.hour),
  ]);
  const wildcard = wildcardOutcome({ prior, cancelledAt: new Date(ctx.nowMs).toISOString(), late: ctx.late });
  const v = input.proposals ? validateAll(ctx, input, reservations) : null;
  const freeSlots = await freeSlotsFor(ctx, input, reservations);
  return {
    noticeMinutes: ctx.notice, late: ctx.late, sessionHours: ctx.sessionHours, canSplit: ctx.sessionHours === 2,
    wildcard, wildcardsTotal: MONTHLY_WILDCARDS, penaltyStartDate: PENALTY_START_DATE,
    penaltyEuros: PENALTY_EUROS, noShowPenaltyEuros: NO_SHOW_PENALTY_EUROS,
    alreadyCancelled: already,
    proposalProblems: v?.results.map(r => ({ general: r.general, perSlot: r.perSlot })),
    reservations: reservations.map(({ date, hour, studentName }) => ({ date, hour, studentName })),
    freeSlots,
  };
}

/**
 * Horas libres para el modal, con la MISMA comprobación que valida al enviar
 * (teacherSlotProblems + occupiedChecker). Solo las horas del rango visible del
 * calendario (como visibleHours en VisualCalendar): sin esto, las 04:00 saldrían
 * libres porque para la base están vacías. Una clase de 2 h junta necesita las
 * dos horas libres y dentro del rango.
 */
async function freeSlotsFor(
  ctx: ClassContext, input: CancelInput, reservations: Awaited<ReturnType<typeof reservationsOf>>,
): Promise<Array<{ date: string; hours: string[] }>> {
  const { hoursPerPart } = partsOf(ctx, input);
  return freeSlotsOn(input.teacherId, ctx.grid, ctx.nowMs, hoursPerPart, occupiedChecker(ctx.grid, reservations), { date: ctx.date, hour: ctx.hour });
}

/** Días posibles (desde mañana, 7 días, sin domingos) con sus horas de inicio libres. */
async function freeSlotsOn(
  teacherId: string, grid: Grid, nowMs: number, hoursPerPart: number,
  occupied: OccupiedCheck, original: { date: string; hour: string },
): Promise<Array<{ date: string; hours: string[] }>> {
  const { data: t, error } = await supabase.from('teachers')
    .select('calendar_start_hour, calendar_end_hour').eq('id', teacherId).maybeSingle();
  const row = (error ? null : t) as Row | null;
  let from = Math.max(0, Math.min(23, Number(row?.calendar_start_hour ?? 9)));
  let to = Math.max(from, Math.min(23, Number(row?.calendar_end_hour ?? 22)));
  for (const [key, cell] of Object.entries(grid)) {
    if (!cell || cell.state === 'no_work') continue;
    const h = parseInt(key.split('_')[1] ?? '', 10);
    if (!Number.isFinite(h) || h < 0 || h > 23) continue;
    if (h < from) from = h;
    if (h > to) to = h;
  }
  return teacherProposalDays(nowMs).map(date => ({
    date,
    hours: Array.from({ length: to - from + 1 }, (_, i) => from + i)
      .filter(h => h + hoursPerPart - 1 <= to)
      .map(h => hourText(h))
      .filter(hour => teacherSlotProblems({ date, hour, hours: hoursPerPart }, { nowMs, occupied, original }).length === 0),
  }));
}

// ── Cancelar ──────────────────────────────────────────────────────────────────

export interface CancelResult {
  groupId: string;
  recoveryIds: string[];
  status: RecoveryStatus;
  late: boolean;
  wildcard: WildcardOutcome;
  emailSent: boolean;
}

export async function cancelClass(input: CancelInput): Promise<CancelResult> {
  const ctx = await loadClassContext(input);
  const already = await existingCancellation(input.teacherId, ctx.studentName, ctx.date, ctx.hour);
  if (already) throw new RecoveryError(409, 'ya_cancelada', already);

  const reservations = await reservationsOf(input.teacherId, ctx.nowMs);
  const v = validateAll(ctx, input, reservations);
  if (!v.ok) {
    const first = v.results.flatMap(r => [...r.general, ...r.perSlot.flat()])[0];
    throw new RecoveryError(422, 'datos_invalidos', first ?? 'Revisa las fechas propuestas.');
  }

  const groupId = nuevoId('grp');
  const cancelledAt = new Date(ctx.nowMs).toISOString();
  const reason = (input.reason ?? '').trim().slice(0, 500) || null;

  // 1) La constancia de la clase cancelada: hace que Finanzas NO la pague, que
  //    no gaste cupo y que sea recuperable. Directa, SIN dbApplyFaltaSideEffects.
  const cancelRecordId = nuevoId('cr');
  const { error: crErr } = await supabase.from('class_records').insert({
    id: cancelRecordId, teacher_id: input.teacherId, teacher_name: ctx.teacherName,
    student_name: ctx.studentName, class_date: ctx.date, class_time: ctx.hour,
    screenshot_url: '', class_type: ctx.late ? 'cancelada_por_profesor' : 'cancelada_con_preaviso',
    comment: `No puedo dar esta clase${reason ? ` — ${reason}` : ''}`,
    lost_hours: ctx.sessionHours, created_at: cancelledAt,
  });
  if (crErr?.code === '23505') throw new RecoveryError(409, 'ya_cancelada', 'Esta clase ya está cancelada.');
  if (crErr) throw new RecoveryError(500, 'error', `No se pudo registrar la cancelación: ${crErr.message}`);

  // 2) Una fila por trozo.
  const preliminar = wildcardOutcome({ prior: await priorCancellationsOf(input.teacherId), cancelledAt, late: ctx.late });
  const rows = Array.from({ length: v.parts }, (_, i) => ({
    id: nuevoId('rec'), group_id: groupId, part: i + 1, parts: v.parts,
    assignment_id: ctx.assignment.id, teacher_id: input.teacherId, teacher_name: ctx.teacherName,
    student_id: ctx.studentId, student_name: ctx.studentName, student_email: ctx.studentEmail,
    original_date: ctx.date, original_hour: ctx.hour, hours: v.hoursPerPart,
    cancel_record_id: cancelRecordId, reason,
    cancelled_at: cancelledAt, cancel_month: spainMonthOf(cancelledAt),
    notice_minutes: ctx.notice, late: ctx.late,
    used_wildcard: preliminar.usedWildcard, penalty_euros: 0, would_have_penalty: false,
    agreed_directly: !!input.agreedDirectly, round: 1,
    teacher_proposals: (input.proposals?.[i] ?? []).map(s => ({ date: s.date, hour: normalizeHour(s.hour), hours: v.hoursPerPart })),
    status: 'esperando_alumno', status_changed_at: cancelledAt, created_at: cancelledAt, updated_at: cancelledAt,
  }));
  const { error: insErr } = await supabase.from('class_recoveries').insert(rows);
  if (insErr) {
    await supabase.from('class_records').delete().eq('id', cancelRecordId);
    if (isMissingTable(insErr)) throw new RecoveryError(503, 'no_configurado', 'Falta correr supabase-class-recoveries.sql.');
    if (insErr.code === '23505') throw new RecoveryError(409, 'ya_cancelada', 'Esta clase ya está cancelada.');
    throw new RecoveryError(500, 'error', `No se pudo guardar la recuperación: ${insErr.message}`);
  }
  const ids = rows.map(r => r.id);

  // 3) "Ya lo acordé": se confirma en el acto. Si falla, se deshace todo.
  if (input.agreedDirectly) {
    try {
      for (const id of ids) await confirmRecovery(id, { index: 0, by: 'acordada', notify: false });
    } catch (err) {
      for (const id of ids) await annulRecovery(id, { by: 'sistema', reason: 'Fallo al confirmar la fecha acordada' }).catch(() => {});
      await supabase.from('class_recoveries').delete().eq('group_id', groupId);
      await supabase.from('class_records').delete().eq('id', cancelRecordId);
      throw err;
    }
  }

  // 4) Comodines con la cancelación YA guardada: su posición sale del orden, así
  //    dos cancelaciones casi simultáneas no se quedan las dos con el último.
  const wildcard = wildcardOutcome({ prior: await priorCancellationsOf(input.teacherId), groupId, cancelledAt, late: ctx.late });
  let penaltyEventId: string | null = null;
  if (wildcard.chargeNow) {
    penaltyEventId = `se_cancel_prof_${groupId}`;
    try {
      await dbAddScoringEvent({
        teacherId: input.teacherId, teacherName: ctx.teacherName,
        eventType: 'cancelacion_profesor_penalizacion', points: 0, euros: -PENALTY_EUROS,
        note: `Cancelación sin antelación — alumno ${ctx.studentName}, fecha ${ctx.date} (${wildcard.position}.ª del mes)`,
        createdBy: 'sistema', studentRef: ctx.studentName,
      }, { id: penaltyEventId });
    } catch (err) {
      // 23505: ya estaba (reintento). Cualquier otro error se registra: la
      // cancelación está hecha y la multa se puede aplicar a mano.
      if ((err as { code?: string }).code !== '23505') console.error('[recuperaciones] No se pudo crear la multa:', err);
    }
  }
  await supabase.from('class_recoveries').update({
    used_wildcard: wildcard.usedWildcard, penalty_euros: wildcard.penaltyEuros,
    would_have_penalty: wildcard.wouldHavePenalty, penalty_event_id: penaltyEventId, updated_at: new Date().toISOString(),
  }).eq('group_id', groupId);
  // Aviso al admin al llegar a 4 sin antelación en el mes (el flujo viejo lo
  // hacía dbApplyFaltaSideEffects, que aquí no se llama).
  if (ctx.late) await notifyMonthlyLimit(input.teacherId, ctx.teacherName, spainMonthOf(cancelledAt));

  // 5) Email al alumno (best-effort).
  let emailSent = false;
  if (ctx.studentEmail) {
    const { subject, html } = buildCancellationEmail({
      studentName: ctx.studentName, teacherName: ctx.teacherName,
      original: { date: ctx.date, hour: ctx.hour }, todayIso: spainDateOf(ctx.nowMs),
      parts: rows.map(r => ({ recoveryId: r.id, proposals: r.teacher_proposals as Slot[] })),
      agreed: !!input.agreedDirectly,
    });
    emailSent = await sendStudentEmail('recuperacion_cancelacion', ctx.studentEmail, subject, html, ctx.ccEmail, `recuperacion_cancelacion_${groupId}`);
    if (emailSent) await supabase.from('class_recoveries').update({ student_email_sent_at: new Date().toISOString() }).eq('group_id', groupId);
  }

  // 6) Aviso al admin (id fijo: un reintento no lo duplica).
  const coste = !ctx.late ? 'con antelación, sin coste'
    : wildcard.chargeNow ? `sin antelación, ${wildcard.position}.ª del mes: −${PENALTY_EUROS} €`
    : wildcard.wouldHavePenalty ? `sin antelación, ${wildcard.position}.ª del mes (habría costado ${PENALTY_EUROS} €)`
    : `sin antelación, comodín ${wildcard.position} de ${MONTHLY_WILDCARDS}`;
  await supabase.from('notifications').upsert({
    id: `notif_cancel_${groupId}`, target_user: null, target_role: 'admin',
    title: `${ctx.late ? '🔴 ' : ''}Clase cancelada · ${ctx.teacherName}`,
    body: `${ctx.studentName} · ${claseDe(ctx.date, spainDateOf(ctx.nowMs)).replace(/^la clase /, '')} ${ctx.hour} · ${coste}.` +
      (input.agreedDirectly ? ' Recuperación ya acordada con el alumno.' : ' El alumno elegirá la recuperación.') +
      (reason ? `\nMotivo: ${reason}` : ''),
    type: ctx.late ? 'clase_cancelada_incidencia' : 'clase_cancelada_preaviso',
    read_by: [], created_at: new Date().toISOString(), created_by: 'sistema',
  }, { onConflict: 'id', ignoreDuplicates: true });

  return {
    groupId, recoveryIds: ids, status: input.agreedDirectly ? 'confirmada' : 'esperando_alumno',
    late: ctx.late, wildcard, emailSent,
  };
}

// ── Confirmar ─────────────────────────────────────────────────────────────────

/**
 * El alumno (o "Ya lo acordé") elige una de las fechas del PROFESOR.
 * Idempotente: repetir la misma elección devuelve la recuperación tal cual.
 */
export async function confirmRecovery(id: string, opts: { index: number; by: 'alumno' | 'profesor' | 'acordada'; notify?: boolean }): Promise<RecoveryRow> {
  const rec = await getRecovery(id);
  if (!rec) throw new RecoveryError(404, 'no_encontrada', 'No encontramos esa recuperación.');
  const slot = rec.teacherProposals[opts.index];
  if (!slot) throw new RecoveryError(422, 'datos_invalidos', 'Esa opción no existe.');
  return confirmSlot(rec, slot, { from: 'esperando_alumno', by: opts.by, notify: opts.notify });
}

/**
 * El PROFESOR acepta uno de los horarios que propuso el alumno ("Ninguna me
 * viene bien"). Mismo paso que cuando elige el alumno: celda + constancia, todo
 * o nada, comprobando que el hueco sigue libre.
 */
export async function acceptStudentProposal(id: string, teacherId: string, index: number): Promise<RecoveryRow> {
  const rec = await getRecovery(id);
  if (!rec || rec.teacherId !== teacherId) throw new RecoveryError(404, 'no_encontrada', 'No encontramos esa recuperación.');
  if (!isRecoveryBetaTeacher(teacherId)) throw new RecoveryError(403, 'no_beta', 'Esta función todavía no está disponible para tu cuenta.');
  const p = rec.studentProposals[index];
  if (!p) throw new RecoveryError(422, 'datos_invalidos', 'Ese horario no existe.');
  const slot: Slot = { date: p.date, hour: normalizeHour(p.hour) ?? p.hour, hours: rec.hours };
  return confirmSlot(rec, slot, { from: 'alumno_propuso', by: 'profesor' });
}

/**
 * Fija la fecha de un trozo: celda "En recuperación" + constancia 'recuperacion'.
 * Todo o nada: si el calendario choca, no se cambia nada; si la constancia
 * falla, se deshace la celda.
 *
 * La constancia lleva recovery_for_date y la celda recoveryFor: Finanzas la
 * cuenta como recuperación, que se paga si se da pero NO gasta cupo del alumno
 * (lib/finance.ts descuenta billingUnits − recoveryUnits).
 */
async function confirmSlot(
  rec: RecoveryRow, slot: Slot,
  opts: { from: 'esperando_alumno' | 'alumno_propuso'; by: 'alumno' | 'profesor' | 'acordada'; notify?: boolean },
): Promise<RecoveryRow> {
  const id = rec.id;
  const chosenHour = normalizeHour(slot.hour);
  if (!chosenHour) throw new RecoveryError(422, 'datos_invalidos', 'Hora no válida.');
  if (rec.status === 'confirmada' || rec.status === 'recuperada') {
    if (rec.chosenDate === slot.date && rec.chosenHour === chosenHour) return rec;
    throw new RecoveryError(409, 'estado_cambiado', 'La recuperación ya tiene fecha.');
  }
  if (rec.status !== opts.from) throw new RecoveryError(409, 'estado_cambiado', 'Esta recuperación ya no admite elegir fecha.');

  const nowMs = Date.now();
  if (proposalsExpired([slot], nowMs)) {
    throw new RecoveryError(409, 'hueco_no_disponible', 'Esa fecha ya pasó.');
  }

  const grid = await dbReadTeacherGrid(rec.teacherId);
  const reservations = await reservationsOf(rec.teacherId, nowMs);
  const occupied = occupiedChecker(grid, reservations, rec.groupId);
  for (const h of slotHours(slot)) {
    const why = occupied(h.date, h.hour);
    if (why) throw new RecoveryError(409, 'hueco_no_disponible', why);
  }

  // 1) Reclamar la fila (solo una petición puede salir del estado de partida).
  const now = new Date().toISOString();
  const { data: claimed } = await supabase.from('class_recoveries').update({
    status: 'confirmada', chosen_date: slot.date, chosen_hour: chosenHour, chosen_by: opts.by,
    status_changed_at: now, updated_at: now,
  }).eq('id', id).eq('status', opts.from).select('id');
  if (!claimed?.length) {
    const again = await getRecovery(id);
    if (again && again.chosenDate === slot.date && again.chosenHour === chosenHour) return again;
    throw new RecoveryError(409, 'estado_cambiado', 'La recuperación cambió mientras tanto.');
  }
  const undoClaim = () => supabase.from('class_recoveries').update({
    status: opts.from, chosen_date: null, chosen_hour: null, chosen_by: null, updated_at: new Date().toISOString(),
  }).eq('id', id);

  // 2) El calendario: una celda "En recuperación" por hora, comparando contra lo leído.
  const changes: GridChanges = {};
  for (const h of slotHours(slot)) {
    const key = `${dayNameFromIso(h.date)}_${h.hour}`;
    const current = grid[key] ?? null;
    const base = current ? baseCellOf(current) : null;
    const next: Cell = {
      state: 'bloqueado', student: rec.studentName, weekDate: mondayIsoOfIso(h.date),
      baseState: base?.state ?? 'libre',
      ...(base?.student ? { baseStudent: base.student } : {}),
      recoveryFor: rec.originalDate,
      recoveryNote: 'Clase que el profesor no pudo dar',
    };
    changes[key] = { expected: current, next };
  }
  let applied: string[] = [];
  try {
    const r = await dbApplyGridChanges(rec.teacherId, changes, ACTOR);
    applied = r.applied;
    if (r.conflicts.length > 0) {
      // Algo cambió en el calendario entre la lectura y la escritura: se deshace lo aplicado.
      await revertGrid(rec.teacherId, changes, applied);
      await undoClaim();
      throw new RecoveryError(409, 'hueco_no_disponible', 'Ese hueco del calendario acaba de cambiar. Vuelve a intentarlo.');
    }
  } catch (err) {
    if (err instanceof RecoveryError) throw err;
    await undoClaim();
    throw new RecoveryError(500, 'error', `No se pudo guardar el calendario: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) La constancia de la recuperación (lo que paga; no gasta cupo del alumno).
  const recordId = nuevoId('cr');
  const { error: recErr } = await supabase.from('class_records').insert({
    id: recordId, teacher_id: rec.teacherId, teacher_name: rec.teacherName, student_name: rec.studentName,
    class_date: slot.date, class_time: chosenHour, screenshot_url: '', class_type: 'recuperacion',
    comment: `Recuperación de clase del ${rec.originalDate} — No puedo dar esta clase`,
    recovery_for_date: rec.originalDate, created_at: new Date().toISOString(),
  });
  if (recErr) {
    await revertGrid(rec.teacherId, changes, applied);
    await undoClaim();
    throw new RecoveryError(500, 'error', `No se pudo registrar la recuperación: ${recErr.message}`);
  }
  await supabase.from('class_recoveries').update({ recovery_record_id: recordId, updated_at: new Date().toISOString() }).eq('id', id);

  const done = (await getRecovery(id))!;
  if (opts.notify !== false && opts.by !== 'acordada') await notifyConfirmed(done);
  return done;
}

/** Vuelve a poner lo que había en las casillas aplicadas. Best-effort. */
async function revertGrid(teacherId: string, changes: GridChanges, applied: string[]): Promise<void> {
  if (applied.length === 0) return;
  const inverse: GridChanges = {};
  for (const k of applied) inverse[k] = { expected: changes[k].next, next: changes[k].expected };
  try { await dbApplyGridChanges(teacherId, inverse, ACTOR); }
  catch (err) { console.error('[recuperaciones] No se pudo deshacer el calendario:', err); }
}

/** Campanita del profesor con id fijo (un reintento no la duplica). Best-effort. */
async function teacherBell(id: string, teacherId: string, title: string, body: string, type: string): Promise<void> {
  try {
    await supabase.from('notifications').upsert({
      id, target_user: teacherId, target_role: null,
      title, body, type, read_by: [], created_at: new Date().toISOString(), created_by: 'sistema',
    }, { onConflict: 'id', ignoreDuplicates: true });
  } catch (err) {
    console.error('[recuperaciones] Campanita fallida:', err);
  }
}

/** Aviso al admin con id fijo. Best-effort. */
async function adminBell(id: string, title: string, body: string, type: string): Promise<void> {
  try {
    await supabase.from('notifications').upsert({
      id, target_user: null, target_role: 'admin',
      title, body, type, read_by: [], created_at: new Date().toISOString(), created_by: 'sistema',
    }, { onConflict: 'id', ignoreDuplicates: true });
  } catch (err) {
    console.error('[recuperaciones] Aviso al admin fallido:', err);
  }
}

/**
 * Quedó confirmada (eligió el alumno o aceptó el profesor): campanita al
 * profesor, email al profesor si eligió el alumno, y confirmación al alumno.
 */
async function notifyConfirmed(rec: RecoveryRow): Promise<void> {
  const chosen = { date: rec.chosenDate!, hour: rec.chosenHour! };
  const porAlumno = rec.chosenBy === 'alumno';
  const title = porAlumno ? `${rec.studentName} eligió la recuperación` : `Recuperación confirmada con ${rec.studentName}`;
  const body = porAlumno
    ? `${rec.studentName} eligió recuperar la clase del ${fechaLarga(rec.originalDate)} ${cuandoEs(chosen)}. Ya la tienes en tu calendario.`
    : `Aceptaste el horario de ${rec.studentName}: la clase del ${fechaLarga(rec.originalDate)} se recupera ${cuandoEs(chosen)}. Ya la tienes en tu calendario y le avisamos por email.`;
  try {
    await teacherBell(`notif_rec_elegida_${rec.id}`, rec.teacherId, title, body, 'recuperacion_elegida');
    // El email al profesor solo cuando eligió el alumno: si aceptó él, ya lo sabe.
    if (porAlumno) {
      const teacher = await fetchTeacher(rec.teacherId);
      if (teacher) await sendRecoveryChosenEmail(teacher, { studentName: rec.studentName, title, body });
    }
    if (rec.studentEmail) {
      const { subject, html } = buildConfirmedEmail({
        studentName: rec.studentName, teacherName: rec.teacherName ?? '', original: { date: rec.originalDate, hour: rec.originalHour }, chosen,
      });
      await sendStudentEmail('recuperacion_confirmada', rec.studentEmail, subject, html, null, `recuperacion_confirmada_${rec.id}`);
    }
  } catch (err) {
    console.error('[recuperaciones] Aviso de confirmación fallido:', err);
  }
}

// ── "Ninguna me viene bien" ──────────────────────────────────────────────────

export async function studentProposesOther(id: string, horarios: Array<{ date: string; hour: string }>, note: string | null): Promise<RecoveryRow> {
  const rec = await getRecovery(id);
  if (!rec) throw new RecoveryError(404, 'no_encontrada', 'No encontramos esa recuperación.');
  if (rec.status !== 'esperando_alumno') throw new RecoveryError(409, 'estado_cambiado', 'Esta recuperación ya no admite proponer horarios.');
  const next = statusAfterNone(rec.round);
  const now = new Date().toISOString();
  const { data } = await supabase.from('class_recoveries').update({
    status: next,
    student_proposals: horarios.map(h => ({ date: h.date, hour: normalizeHour(h.hour) })),
    student_note: (note ?? '').trim() || null,
    status_changed_at: now, updated_at: now,
  }).eq('id', id).eq('status', 'esperando_alumno').select('id');
  if (!data?.length) throw new RecoveryError(409, 'estado_cambiado', 'La recuperación cambió mientras tanto.');
  const done = (await getRecovery(id))!;
  if (next === 'alumno_propuso') await notifyStudentProposed(done);
  else await notifyNoAgreement(done, 'El alumno tampoco puede en las fechas de la segunda ronda.');
  return done;
}

/** El alumno propuso horarios: campanita + email al profesor (ids fijos por ronda). */
async function notifyStudentProposed(rec: RecoveryRow): Promise<void> {
  const horarios = rec.studentProposals.map(cuandoEs).join(', ');
  const parte = rec.parts > 1 ? ` (${rec.part}.ª hora de la clase de 2 h)` : '';
  const title = `${rec.studentName} propone otros horarios`;
  const body = `${rec.studentName} no puede en las fechas que propusiste para recuperar la clase del ${fechaLarga(rec.originalDate)}${parte}. ` +
    `Te propone: ${horarios}.` + (rec.studentNote ? ` Nota: ${rec.studentNote}` : '');
  await teacherBell(`notif_rec_propuso_${rec.id}_r${rec.round}`, rec.teacherId, title, body, 'recuperacion_alumno_propuso');
  try {
    const teacher = await fetchTeacher(rec.teacherId);
    if (teacher) await sendRecoveryStudentProposedEmail(teacher, { title, body });
  } catch (err) {
    console.error('[recuperaciones] Email "el alumno propone" fallido:', err);
  }
}

/** Sin acuerdo: el alumno conserva la clase a su favor; avisan profe y admin. */
async function notifyNoAgreement(rec: RecoveryRow, why: string): Promise<void> {
  const body = `${rec.studentName} · clase del ${fechaLarga(rec.originalDate)} ${rec.originalHour}. ${why} ` +
    'La clase sigue a favor del alumno; el equipo coordinará la fecha.';
  await teacherBell(`notif_rec_sin_acuerdo_${rec.id}`, rec.teacherId, `Sin acuerdo con ${rec.studentName}`, body, 'recuperacion_sin_acuerdo');
  await adminBell(`notif_rec_sin_acuerdo_admin_${rec.id}`, `Recuperación sin acuerdo · ${rec.teacherName ?? ''}`, body, 'recuperacion_sin_acuerdo');
}

// ── El profesor propone otras 2 fechas (ronda 2) ─────────────────────────────

/** Días y horas libres para volver a proponer (mismo selector que el modal). */
export async function freeSlotsForRecovery(id: string, teacherId: string): Promise<{ recovery: RecoveryRow; freeSlots: Array<{ date: string; hours: string[] }> }> {
  const rec = await getRecovery(id);
  if (!rec || rec.teacherId !== teacherId) throw new RecoveryError(404, 'no_encontrada', 'No encontramos esa recuperación.');
  const nowMs = Date.now();
  const grid = await dbReadTeacherGrid(teacherId);
  const occupied = occupiedChecker(grid, await reservationsOf(teacherId, nowMs), rec.groupId);
  const freeSlots = await freeSlotsOn(teacherId, grid, nowMs, rec.hours, occupied, { date: rec.originalDate, hour: rec.originalHour });
  return { recovery: rec, freeSlots };
}

/**
 * El profesor no puede en ninguno de los horarios del alumno y propone 2 fechas
 * nuevas: ronda 2, vuelve a 'esperando_alumno' y el alumno recibe un email.
 * Mismas reglas que al cancelar (desde mañana, 7 días, sin domingos, libres).
 */
export async function teacherProposeAgain(id: string, teacherId: string, proposals: Array<{ date: string; hour: string }>): Promise<RecoveryRow> {
  const rec = await getRecovery(id);
  if (!rec || rec.teacherId !== teacherId) throw new RecoveryError(404, 'no_encontrada', 'No encontramos esa recuperación.');
  if (!isRecoveryBetaTeacher(teacherId)) throw new RecoveryError(403, 'no_beta', 'Esta función todavía no está disponible para tu cuenta.');
  if (rec.status !== 'alumno_propuso') throw new RecoveryError(409, 'estado_cambiado', 'Esta recuperación ya no espera tu respuesta.');
  if (rec.round >= MAX_ROUNDS) throw new RecoveryError(409, 'estado_cambiado', 'Ya no quedan más rondas para esta recuperación.');

  const nowMs = Date.now();
  const grid = await dbReadTeacherGrid(teacherId);
  const occupied = occupiedChecker(grid, await reservationsOf(teacherId, nowMs), rec.groupId);
  const slots: Slot[] = proposals.map(s => ({ date: s.date, hour: normalizeHour(s.hour) ?? s.hour, hours: rec.hours }));
  const v = validateTeacherProposals(slots, { agreedDirectly: false, nowMs, occupied, original: { date: rec.originalDate, hour: rec.originalHour } });
  if (!v.ok) {
    throw new RecoveryError(422, 'datos_invalidos', [...v.general, ...v.perSlot.flat()][0] ?? 'Revisa las fechas propuestas.');
  }

  const now = new Date().toISOString();
  const { data } = await supabase.from('class_recoveries').update({
    status: 'esperando_alumno', round: rec.round + 1, teacher_proposals: slots,
    status_changed_at: now, updated_at: now,
  }).eq('id', id).eq('status', 'alumno_propuso').select('id');
  if (!data?.length) throw new RecoveryError(409, 'estado_cambiado', 'La recuperación cambió mientras tanto.');
  const done = (await getRecovery(id))!;

  if (done.studentEmail) {
    const { subject, html } = buildReproposalEmail({
      studentName: done.studentName, teacherName: done.teacherName ?? '', recoveryId: done.id,
      original: { date: done.originalDate, hour: done.originalHour }, todayIso: spainDateOf(nowMs),
      proposals: slots, part: done.parts > 1 ? done.part : null,
    });
    const sent = await sendStudentEmail('recuperacion_reprop', done.studentEmail, subject, html, null, `recuperacion_reprop_${done.id}_r${done.round}`);
    if (sent) await supabase.from('class_recoveries').update({ student_email_sent_at: new Date().toISOString() }).eq('id', id);
  }
  return done;
}

// ── Anular ────────────────────────────────────────────────────────────────────

/**
 * Anula un trozo: libera sus reservas (al salir de 'esperando_alumno' dejan de
 * contar solas) y, si estaba confirmado con fecha futura y sin ingreso, quita la
 * celda del calendario y la constancia de recuperación (no se paga). Deja
 * escrito quién y por qué (columnas del bloque B; sin el SQL, solo el estado).
 */
export async function annulRecovery(id: string, opts: { by: string; reason: string }): Promise<RecoveryRow | null> {
  const rec = await getRecovery(id);
  if (!rec || rec.status === 'anulada' || rec.status === 'recuperada') return rec;
  const now = new Date().toISOString();
  const { error } = await supabase.from('class_recoveries').update({
    status: 'anulada', status_changed_at: now, updated_at: now,
    annulled_at: now, annulled_by: opts.by, annul_reason: opts.reason,
  }).eq('id', id);
  if (error) {
    // Sin supabase-class-recoveries-b.sql no existen las columnas del motivo.
    await supabase.from('class_recoveries').update({ status: 'anulada', status_changed_at: now, updated_at: now }).eq('id', id);
  }

  if (rec.status === 'confirmada' && rec.chosenDate && rec.chosenHour && rec.chosenDate >= spainDateOf(Date.now())) {
    const { data: logs } = await supabase.from('class_join_logs').select('id, student_name')
      .eq('teacher_id', rec.teacherId).eq('scheduled_date', rec.chosenDate);
    const dada = (logs ?? []).some((l: Row) => nkName(l.student_name) === nkName(rec.studentName));
    if (!dada) {
      try {
        const grid = await dbReadTeacherGrid(rec.teacherId);
        const changes: GridChanges = {};
        for (const h of slotHours({ date: rec.chosenDate, hour: rec.chosenHour, hours: rec.hours })) {
          const key = `${dayNameFromIso(h.date)}_${h.hour}`;
          const cur = grid[key];
          if (cur?.state === 'bloqueado' && cur.weekDate === mondayIsoOfIso(h.date) && nkName(cur.student) === nkName(rec.studentName)) {
            const base = baseCellOf(cur);
            changes[key] = { expected: cur, next: base.state === 'libre' && !base.student ? { state: 'libre' } : base };
          }
        }
        if (Object.keys(changes).length) await dbApplyGridChanges(rec.teacherId, changes, ACTOR);
      } catch (err) {
        console.error('[recuperaciones] No se pudo quitar la recuperación del calendario:', err);
      }
      if (rec.recoveryRecordId) await supabase.from('class_records').delete().eq('id', rec.recoveryRecordId);
    }
  }
  console.log(`[recuperaciones] ${id} anulada por ${opts.by}: ${opts.reason}`);
  return getRecovery(id);
}

/**
 * 'sin_acuerdo' perezoso: pasaron todas las fechas del profesor sin que el
 * alumno eligiera, o todos los horarios del alumno sin que el profesor
 * respondiera. Solo avisa quien hace el cambio (la actualización es condicional).
 */
export async function expireIfDue(rec: RecoveryRow, nowMs = Date.now()): Promise<RecoveryRow> {
  const vencida =
    (rec.status === 'esperando_alumno' && proposalsExpired(rec.teacherProposals, nowMs)) ||
    (rec.status === 'alumno_propuso' && proposalsExpired(rec.studentProposals.map(s => ({ ...s, hours: 1 })), nowMs));
  if (!vencida) return rec;
  const now = new Date().toISOString();
  const { data } = await supabase.from('class_recoveries').update({ status: 'sin_acuerdo', status_changed_at: now, updated_at: now })
    .eq('id', rec.id).eq('status', rec.status).select('id');
  const done: RecoveryRow = { ...rec, status: 'sin_acuerdo', statusChangedAt: now };
  if (data?.length) {
    await notifyNoAgreement(done, rec.status === 'esperando_alumno'
      ? 'Pasaron las fechas propuestas sin que el alumno eligiera.'
      : 'Pasaron los horarios que propuso el alumno sin respuesta del profesor.');
  }
  return done;
}

// ── Bajas del alumno ──────────────────────────────────────────────────────────

/** Estados que una baja anula (las 'recuperada' quedan: la clase se dio). */
const ANNUL_ON_DROPOUT: RecoveryStatus[] = ['esperando_alumno', 'alumno_propuso', 'confirmada', 'sin_acuerdo'];

/**
 * Baja o borrado del alumno: anula sus recuperaciones vivas (libera reservas y
 * quita del calendario las recuperaciones futuras sin ingreso). Por id, por
 * email, o por profesor + nombre si no hay otra cosa. Devuelve cuántas anuló.
 * Se llama ANTES del borrado: después ya no hay ficha con la que buscarlas.
 */
export async function annulStudentRecoveries(who: {
  studentIds?: string[]; studentEmail?: string | null; studentName?: string | null; teacherId?: string | null;
}, opts: { by: string; reason: string }): Promise<number> {
  const ids = (who.studentIds ?? []).filter(Boolean);
  const email = normEmail(who.studentEmail);
  const filtros = [
    ...ids.map(id => `student_id.eq.${id}`),
    ...(email ? [`student_email.eq.${email}`] : []),
  ];
  let rows: Row[] = [];
  if (filtros.length) {
    const { data, error } = await supabase.from('class_recoveries').select('*')
      .in('status', ANNUL_ON_DROPOUT).or(filtros.join(','));
    if (isMissingTable(error)) return 0;
    rows = data ?? [];
  } else if (who.teacherId && who.studentName) {
    const { data, error } = await supabase.from('class_recoveries').select('*')
      .in('status', ANNUL_ON_DROPOUT).eq('teacher_id', who.teacherId);
    if (isMissingTable(error)) return 0;
    rows = (data ?? []).filter((r: Row) => nkName(r.student_name) === nkName(who.studentName!));
  }
  let n = 0;
  for (const r of rows) {
    try {
      const out = await annulRecovery(r.id, opts);
      if (out?.status === 'anulada') n++;
    } catch (err) {
      console.error('[recuperaciones] No se pudo anular por baja:', r.id, err);
    }
  }
  return n;
}

// ── Chequeo nocturno (dentro del cron daily-transcript-reminder) ─────────────

export interface NightlyResult {
  revisadas: number;
  recuperadas: string[];
  sinAcuerdo: string[];
  anuladas: string[];
  errores: string[];
}

/**
 * Una vez por noche, sobre las recuperaciones vivas (ver nightlyAction):
 * recuperada si la clase se dio, sin_acuerdo si vencieron las fechas, anulada
 * si el alumno ya no está activo con ese profesor (desvinculación o cambio de
 * profesor: decisión C, no se anula en el momento porque mover a un alumno de
 * hora lo deja un instante sin casillas). `dry`: solo informa.
 */
export async function runNightlyRecoveryCheck(opts: { dry?: boolean; nowMs?: number } = {}): Promise<NightlyResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const out: NightlyResult = { revisadas: 0, recuperadas: [], sinAcuerdo: [], anuladas: [], errores: [] };
  const { data, error } = await supabase.from('class_recoveries').select('*')
    .in('status', ['esperando_alumno', 'alumno_propuso', 'confirmada', 'sin_acuerdo']);
  if (isMissingTable(error)) return out;
  if (error) { out.errores.push(error.message); return out; }
  const rows = (data ?? []).map(mapRecovery);
  out.revisadas = rows.length;
  if (rows.length === 0) return out;

  // Asignaciones de esos alumnos (para saber si siguen activos con ese profesor).
  const asgIds = [...new Set(rows.map(r => r.assignmentId).filter(Boolean))] as string[];
  const teacherIds = [...new Set(rows.map(r => r.teacherId))];
  const [{ data: asgById }, { data: asgByTeacher }] = await Promise.all([
    asgIds.length ? supabase.from('assignments').select('id, teacher_id, student_name, status').in('id', asgIds) : Promise.resolve({ data: [] as Row[] }),
    supabase.from('assignments').select('id, teacher_id, student_name, status').in('teacher_id', teacherIds),
  ]);
  const activa = (r: RecoveryRow): boolean => {
    const a = (asgById ?? []).find((x: Row) => x.id === r.assignmentId);
    if (a) return a.teacher_id === r.teacherId && a.status !== 'inactive';
    // Sin la asignación original (borrada o recreada): por profesor + nombre.
    return (asgByTeacher ?? []).some((x: Row) => x.teacher_id === r.teacherId && x.status !== 'inactive' && nkName(x.student_name) === nkName(r.studentName));
  };

  // Ingresos a las recuperaciones confirmadas que ya empezaron.
  const fechas = [...new Set(rows.filter(r => r.status === 'confirmada' && r.chosenDate).map(r => r.chosenDate!))];
  const { data: logs } = fechas.length
    ? await supabase.from('class_join_logs').select('teacher_id, student_name, scheduled_date').in('scheduled_date', fechas)
    : { data: [] as Row[] };
  const dada = (r: RecoveryRow): boolean => (logs ?? []).some((l: Row) =>
    l.teacher_id === r.teacherId && l.scheduled_date === r.chosenDate && nkName(l.student_name) === nkName(r.studentName));

  for (const r of rows) {
    const action = nightlyAction(r, { nowMs, given: dada(r), assignmentActive: activa(r) });
    if (!action) continue;
    const etiqueta = `${r.id} (${r.teacherId} · ${r.studentName} · ${r.originalDate})`;
    if (opts.dry) {
      (action === 'recuperada' ? out.recuperadas : action === 'sin_acuerdo' ? out.sinAcuerdo : out.anuladas).push(etiqueta);
      continue;
    }
    try {
      if (action === 'recuperada') {
        const now = new Date().toISOString();
        await supabase.from('class_recoveries').update({ status: 'recuperada', status_changed_at: now, updated_at: now })
          .eq('id', r.id).eq('status', 'confirmada');
        out.recuperadas.push(etiqueta);
      } else if (action === 'sin_acuerdo') {
        await expireIfDue(r, nowMs);
        out.sinAcuerdo.push(etiqueta);
      } else {
        await annulRecovery(r.id, { by: 'sistema', reason: 'El alumno ya no está activo con este profesor (chequeo nocturno)' });
        out.anuladas.push(etiqueta);
      }
    } catch (err) {
      out.errores.push(`${etiqueta}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// ── Reclasificación del admin ─────────────────────────────────────────────────

/**
 * El admin aprobó una revisión como "cancelada por el profesor" (profesor beta):
 * la clase pasó sin que el profesor avisara. Se registra en class_recoveries
 * como 'sin_acuerdo' (el alumno conserva la clase y el equipo coordina la
 * fecha), SIN comodín, con la multa fija de 5 € contada en el mes de la CLASE
 * (antes de PENALTY_START_DATE solo se marca). La constancia en class_records la
 * crea quien llama (dbResolveReviewRequest), como siempre.
 *
 * Idempotente: si esa clase ya tiene una recuperación no anulada, no hace nada.
 * Lanza 503 'no_configurado' si falta supabase-class-recoveries-b.sql: el que
 * llama vuelve entonces a la multa de siempre.
 */
export async function reclassifyAsTeacherCancellation(input: {
  teacherId: string; studentName: string; classDate: string; classTime: string | null; cancelRecordId?: string | null;
}): Promise<{ created: boolean; groupId: string | null; penaltyEuros: number }> {
  if (!isRecoveryBetaTeacher(input.teacherId)) throw new RecoveryError(403, 'no_beta', 'Solo para profesores beta.');
  const hour = normalizeHour(input.classTime) ?? '00:00';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.classDate)) throw new RecoveryError(422, 'datos_invalidos', 'Fecha no válida.');

  const { data: ya } = await supabase.from('class_recoveries').select('id, group_id, student_name, original_hour, status')
    .eq('teacher_id', input.teacherId).eq('original_date', input.classDate).neq('status', 'anulada');
  const existente = (ya ?? []).find((r: Row) => nkName(r.student_name) === nkName(input.studentName) && (!input.classTime || r.original_hour === hour));
  if (existente) return { created: false, groupId: existente.group_id, penaltyEuros: 0 };

  const [{ data: t }, { data: asgs }] = await Promise.all([
    supabase.from('teachers').select('name').eq('id', input.teacherId).maybeSingle(),
    supabase.from('assignments').select('id, student_id, student_name, student_email, status').eq('teacher_id', input.teacherId),
  ]);
  const a = (asgs ?? []).filter((x: Row) => nkName(x.student_name) === nkName(input.studentName))
    .sort((x: Row, y: Row) => (x.status === 'inactive' ? 1 : 0) - (y.status === 'inactive' ? 1 : 0))[0] as Row | undefined;
  const { data: s } = a?.student_id ? await supabase.from('students').select('email').eq('id', a.student_id).maybeSingle() : { data: null };
  const teacherName = (t as Row | null)?.name ?? '';

  const multa = reclassPenalty(input.classDate);
  const groupId = nuevoId('grp');
  // La "cancelación" es la propia clase: su instante y su mes.
  const cancelledAt = new Date(slotStartMs(input.classDate, hour)).toISOString();
  const now = new Date().toISOString();
  const penaltyEventId = multa.chargeNow ? `se_cancel_prof_${groupId}` : null;
  const { error } = await supabase.from('class_recoveries').insert({
    id: nuevoId('rec'), group_id: groupId, part: 1, parts: 1,
    assignment_id: a?.id ?? null, teacher_id: input.teacherId, teacher_name: teacherName,
    student_id: a?.student_id ?? null, student_name: input.studentName,
    student_email: normEmail((s as Row | null)?.email) || normEmail(a?.student_email) || null,
    original_date: input.classDate, original_hour: hour, hours: 1,
    cancel_record_id: input.cancelRecordId ?? null, reason: 'Reclasificada por el admin desde una revisión',
    cancelled_at: cancelledAt, cancel_month: input.classDate.slice(0, 7),
    notice_minutes: 0, late: true, used_wildcard: false,
    penalty_euros: multa.penaltyEuros, would_have_penalty: multa.wouldHavePenalty, penalty_event_id: penaltyEventId,
    agreed_directly: false, round: 1, teacher_proposals: [],
    status: 'sin_acuerdo', status_changed_at: now, created_at: now, updated_at: now,
    origin: 'admin_reclasificacion',
  });
  if (error) {
    if (isMissingTable(error) || error.code === '42703' || error.code === 'PGRST204') {
      throw new RecoveryError(503, 'no_configurado', 'Falta correr supabase-class-recoveries-b.sql.');
    }
    throw new RecoveryError(500, 'error', `No se pudo registrar la cancelación: ${error.message}`);
  }

  if (penaltyEventId) {
    try {
      await dbAddScoringEvent({
        teacherId: input.teacherId, teacherName,
        eventType: 'cancelacion_profesor_penalizacion', points: 0, euros: -PENALTY_EUROS,
        note: `Cancelación sin aviso (reclasificada por el admin) — alumno ${input.studentName}, fecha ${input.classDate}`,
        createdBy: 'admin', studentRef: input.studentName,
      }, { id: penaltyEventId });
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') console.error('[recuperaciones] No se pudo crear la multa de la reclasificación:', err);
    }
  }
  await notifyMonthlyLimit(input.teacherId, teacherName, input.classDate.slice(0, 7));
  return { created: true, groupId, penaltyEuros: multa.penaltyEuros };
}

/**
 * Aviso al admin cuando un profesor llega a 4 cancelaciones sin antelación en
 * el mes: las de la tabla nueva (una por grupo) MÁS los eventos viejos de −5 €
 * de ese mes. Id fijo por profesor y mes: sale una sola vez.
 */
export async function notifyMonthlyLimit(teacherId: string, teacherName: string, month: string): Promise<void> {
  try {
    const [{ data: recs }, { data: evs }] = await Promise.all([
      supabase.from('class_recoveries').select('group_id, cancel_month, late, status').eq('teacher_id', teacherId).eq('cancel_month', month),
      supabase.from('scoring_events').select('created_at, reverted').eq('teacher_id', teacherId).eq('event_type', 'falta_sin_aviso_penalizacion'),
    ]);
    const nuevas = new Set((recs ?? []).filter((r: Row) => r.late && r.status !== 'anulada').map((r: Row) => r.group_id)).size;
    const viejas = (evs ?? []).filter((e: Row) => !e.reverted && e.created_at && spainMonthOf(e.created_at) === month).length;
    if (nuevas + viejas < 4) return;
    await adminBell(`notif_limite_cancel_${teacherId}_${month}`,
      `${teacherName} alcanzó ${nuevas + viejas} cancelaciones sin antelación`,
      `${teacherName} lleva ${nuevas + viejas} cancelaciones sin antelación en ${month}. Revisa la pestaña Recuperaciones.`,
      'limite_faltas_admin');
  } catch (err) {
    console.error('[recuperaciones] Aviso de límite mensual fallido:', err);
  }
}

// ── Pestaña del admin ─────────────────────────────────────────────────────────

/** Todas las filas (las más recientes primero), para la pestaña "Recuperaciones". */
export async function listRecoveriesForAdmin(): Promise<RecoveryRow[]> {
  const { data, error } = await supabase.from('class_recoveries').select('*').order('cancelled_at', { ascending: false }).limit(2000);
  if (isMissingTable(error)) throw new RecoveryError(503, 'no_configurado', 'Falta correr supabase-class-recoveries.sql.');
  if (error) throw new RecoveryError(500, 'error', error.message);
  return (data ?? []).map(mapRecovery);
}

/** Recuperaciones de un alumno (para el LMS): por id del alumno o por su email. */
export async function recoveriesOfStudent(studentId: string): Promise<RecoveryRow[]> {
  const { data: s } = await supabase.from('students').select('id, email').eq('id', studentId).maybeSingle();
  if (!s) return [];
  const email = normEmail(s.email);
  const { data, error } = await supabase.from('class_recoveries').select('*')
    .or(`student_id.eq.${studentId}${email ? `,student_email.eq.${email}` : ''}`)
    .order('original_date', { ascending: false });
  if (isMissingTable(error)) throw new RecoveryError(503, 'no_configurado', 'Falta correr supabase-class-recoveries.sql.');
  if (error) throw new RecoveryError(500, 'error', error.message);
  const rows = (data ?? []).map(mapRecovery);
  return Promise.all(rows.map(r => expireIfDue(r)));
}

/** ¿Esta recuperación es de este alumno? (id o email normalizado en las dos columnas). */
export async function belongsToStudent(rec: RecoveryRow, studentId: string): Promise<boolean> {
  if (rec.studentId && rec.studentId === studentId) return true;
  const { data: s } = await supabase.from('students').select('email').eq('id', studentId).maybeSingle();
  const email = normEmail(s?.email);
  return !!email && email === normEmail(rec.studentEmail);
}
