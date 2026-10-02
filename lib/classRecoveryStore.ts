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
  spainMonthOf, spainDateOf, slotHours, normalizeHour, proposalsExpired, claseDe, cuandoEs, fechaLarga, statusAfterNone,
  BLOCKING_STATUSES, MONTHLY_WILDCARDS, PENALTY_START_DATE, NO_SHOW_PENALTY_EUROS, PENALTY_EUROS,
  type Slot, type RecoveryStatus, type PriorCancellation, type WildcardOutcome, type OccupiedCheck,
} from '@/lib/classRecoveries';
import {
  buildCancellationEmail, buildConfirmedEmail, sendStudentEmail,
} from '@/lib/classRecoveryEmails';
import { fetchTeacher, sendRecoveryChosenEmail } from '@/lib/emailNotifications';
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
  };
}

export async function getRecovery(id: string): Promise<RecoveryRow | null> {
  const { data, error } = await supabase.from('class_recoveries').select('*').eq('id', id).maybeSingle();
  if (isMissingTable(error)) throw new RecoveryError(503, 'no_configurado', 'Falta correr supabase-class-recoveries.sql.');
  if (error) throw new RecoveryError(500, 'error', error.message);
  return data ? mapRecovery(data) : null;
}

/** Cancelaciones del profesor (una fila por trozo), para los comodines. */
async function priorCancellationsOf(teacherId: string): Promise<PriorCancellation[]> {
  const { data, error } = await supabase.from('class_recoveries')
    .select('group_id, cancelled_at, late, status').eq('teacher_id', teacherId);
  if (isMissingTable(error)) throw new RecoveryError(503, 'no_configurado', 'Falta correr supabase-class-recoveries.sql.');
  if (error) throw new RecoveryError(500, 'error', error.message);
  return (data ?? []).map((r: Row) => ({ groupId: r.group_id, cancelledAt: r.cancelled_at, late: !!r.late, status: r.status }));
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
  return {
    noticeMinutes: ctx.notice, late: ctx.late, sessionHours: ctx.sessionHours, canSplit: ctx.sessionHours === 2,
    wildcard, wildcardsTotal: MONTHLY_WILDCARDS, penaltyStartDate: PENALTY_START_DATE,
    penaltyEuros: PENALTY_EUROS, noShowPenaltyEuros: NO_SHOW_PENALTY_EUROS,
    alreadyCancelled: already,
    proposalProblems: v?.results.map(r => ({ general: r.general, perSlot: r.perSlot })),
    reservations: reservations.map(({ date, hour, studentName }) => ({ date, hour, studentName })),
  };
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
 * Fija la fecha de un trozo: celda "En recuperación" + constancia 'recuperacion'.
 * Idempotente: repetir la misma elección devuelve la recuperación tal cual.
 * Todo o nada: si el calendario choca, no se cambia nada; si la constancia
 * falla, se deshace la celda.
 */
export async function confirmRecovery(id: string, opts: { index: number; by: 'alumno' | 'profesor' | 'acordada'; notify?: boolean }): Promise<RecoveryRow> {
  const rec = await getRecovery(id);
  if (!rec) throw new RecoveryError(404, 'no_encontrada', 'No encontramos esa recuperación.');
  const slot = rec.teacherProposals[opts.index];
  if (!slot) throw new RecoveryError(422, 'datos_invalidos', 'Esa opción no existe.');

  if (rec.status === 'confirmada' || rec.status === 'recuperada') {
    if (rec.chosenDate === slot.date && rec.chosenHour === normalizeHour(slot.hour)) return rec;
    throw new RecoveryError(409, 'estado_cambiado', 'La recuperación ya tiene fecha.');
  }
  if (rec.status !== 'esperando_alumno') throw new RecoveryError(409, 'estado_cambiado', 'Esta recuperación ya no admite elegir fecha.');

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

  // 1) Reclamar la fila (solo una petición puede pasar de 'esperando_alumno').
  const chosenHour = normalizeHour(slot.hour)!;
  const now = new Date().toISOString();
  const { data: claimed } = await supabase.from('class_recoveries').update({
    status: 'confirmada', chosen_date: slot.date, chosen_hour: chosenHour, chosen_by: opts.by,
    status_changed_at: now, updated_at: now,
  }).eq('id', id).eq('status', 'esperando_alumno').select('id');
  if (!claimed?.length) {
    const again = await getRecovery(id);
    if (again && again.chosenDate === slot.date && again.chosenHour === chosenHour) return again;
    throw new RecoveryError(409, 'estado_cambiado', 'La recuperación cambió mientras tanto.');
  }
  const undoClaim = () => supabase.from('class_recoveries').update({
    status: 'esperando_alumno', chosen_date: null, chosen_hour: null, chosen_by: null, updated_at: new Date().toISOString(),
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

  // 3) La constancia de la recuperación (lo que paga y exime del cupo).
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
  if (opts.notify !== false && opts.by === 'alumno') await notifyChosen(done);
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

/** El alumno eligió: campanita + email al profe y confirmación al alumno. */
async function notifyChosen(rec: RecoveryRow): Promise<void> {
  const chosen = { date: rec.chosenDate!, hour: rec.chosenHour! };
  const title = `${rec.studentName} eligió la recuperación`;
  const body = `${rec.studentName} eligió recuperar la clase del ${fechaLarga(rec.originalDate)} ${cuandoEs(chosen)}. Ya la tienes en tu calendario.`;
  try {
    await supabase.from('notifications').upsert({
      id: `notif_rec_elegida_${rec.id}`, target_user: rec.teacherId, target_role: null,
      title, body, type: 'recuperacion_elegida', read_by: [], created_at: new Date().toISOString(), created_by: 'sistema',
    }, { onConflict: 'id', ignoreDuplicates: true });
    const teacher = await fetchTeacher(rec.teacherId);
    if (teacher) await sendRecoveryChosenEmail(teacher, { studentName: rec.studentName, title, body });
    if (rec.studentEmail) {
      const { subject, html } = buildConfirmedEmail({
        studentName: rec.studentName, teacherName: rec.teacherName ?? '', original: { date: rec.originalDate, hour: rec.originalHour }, chosen,
      });
      await sendStudentEmail('recuperacion_confirmada', rec.studentEmail, subject, html, null, `recuperacion_confirmada_${rec.id}`);
    }
  } catch (err) {
    console.error('[recuperaciones] Aviso de elección fallido:', err);
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
  // El aviso al profesor (campanita + email con los horarios) llega en el bloque B.
  return (await getRecovery(id))!;
}

// ── Anular ────────────────────────────────────────────────────────────────────

/**
 * Anula un trozo: libera sus reservas (al salir de 'esperando_alumno' dejan de
 * contar solas) y, si estaba confirmado con fecha futura y sin ingreso, quita la
 * celda del calendario y la constancia de recuperación (no se paga).
 */
export async function annulRecovery(id: string, opts: { by: string; reason: string }): Promise<RecoveryRow | null> {
  const rec = await getRecovery(id);
  if (!rec || rec.status === 'anulada' || rec.status === 'recuperada') return rec;
  const now = new Date().toISOString();
  await supabase.from('class_recoveries').update({ status: 'anulada', status_changed_at: now, updated_at: now }).eq('id', id);

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

/** 'sin_acuerdo' perezoso: las propuestas vencieron sin respuesta. */
export async function expireIfDue(rec: RecoveryRow, nowMs = Date.now()): Promise<RecoveryRow> {
  if (rec.status !== 'esperando_alumno' || !proposalsExpired(rec.teacherProposals, nowMs)) return rec;
  const now = new Date().toISOString();
  await supabase.from('class_recoveries').update({ status: 'sin_acuerdo', status_changed_at: now, updated_at: now })
    .eq('id', rec.id).eq('status', 'esperando_alumno');
  return { ...rec, status: 'sin_acuerdo', statusChangedAt: now };
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
