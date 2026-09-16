// ── Transcript de una clase: estado y PLAZO de 24 h ───────────────────────────
//
// FUENTE ÚNICA. Todo lo que quiera decir "esta clase tiene / no tiene / debe el
// transcript" pregunta acá: Mis clases, la ficha del alumno, Asistencias,
// Finanzas (calculateTeacherFinance), el dashboard del admin y el cron de
// avisos. Antes cada vista buscaba el transcript a su manera (fecha exacta, ±1
// día, por clic…) y la misma clase salía "subida" en una pantalla y "sin subir"
// en la de al lado.
//
// Son dos preguntas y las dos viven acá:
//   1. ¿CUÁL es el transcript de esta clase?  → findTranscriptFor
//   2. ¿En qué ESTADO está frente al plazo?   → getTranscriptStatus
//
// LA REGLA DE LAS 24 HORAS (desde el 22/09/2026, ver TRANSCRIPT_DEADLINE_START_DATE):
//   · El profesor tiene 24 h desde la hora de FIN de la clase programada (hora
//     de España) para subir el transcript.
//   · Pasado el plazo la clase está VENCIDA: no se valida ni se paga, aunque sí
//     consume cupo del alumno (la clase se dio). Solo el admin puede reabrirla.
//   · La falta sin aviso y la cancelación sobre la hora no llevan transcript:
//     para ellas el estado es 'no_aplica'.
//   · Una sesión de 2 h lleva UN transcript y el plazo corre desde el final de
//     la segunda hora.
//   · Las clases ANTERIORES a la fecha de corte no vencen nunca: quedan
//     'pendiente' sin plazo, exactamente como estaban.
//
// El estado 'vencido' se calcula AL VUELO comparando el instante actual con
// deadlineAt. No hay columna que lo diga ni cron que lo marque: el plan Hobby de
// Vercel solo permite crons diarios y un estado guardado llegaría siempre tarde.
// Lo único que se guarda es la reapertura del admin (class_join_logs.
// transcript_deadline_at), porque no se puede derivar de nada.
//
// Todo es puro y sin fecha implícita: `now` entra por parámetro. Así los tests
// fijan el reloj y una pantalla puede refrescar la cuenta regresiva sin recargar.

import { spainWallClockToEpoch } from '@/lib/spainTime';
import { hourNum, nkName } from '@/lib/sessions';
import { isStudentLostClass } from '@/lib/classTypes';
import type { ClassRecordType } from '@/types';

// ── Constantes ────────────────────────────────────────────────────────────────

/**
 * Desde qué fecha de CLASE aplica el plazo de 24 h. Las clases con fecha anterior
 * conservan el comportamiento de siempre: pendientes sin vencer nunca.
 */
export const TRANSCRIPT_DEADLINE_START_DATE = '2026-09-22';
/** Horas desde el FIN de la clase para subir el transcript. */
export const TRANSCRIPT_DEADLINE_HOURS = 24;
/** Por debajo de estas horas restantes la cuenta regresiva se pinta en amarillo y se avisa. */
export const TRANSCRIPT_WARN_HOURS = 6;
/** Horas que da una reapertura del admin, contadas desde el momento de reabrir. */
export const TRANSCRIPT_REOPEN_HOURS = 24;

/** Texto del banner fijo (Mis clases y pantalla de subir transcript). Español de España. */
export const TRANSCRIPT_DEADLINE_NOTICE =
  'Nuevo plazo: tienes 24 horas desde el final de cada clase para subir el transcript. '
  + 'Sin transcript, el alumno no puede generar su práctica de la clase y la clase no se valida para el pago.';

const HOUR_MS = 3_600_000;

// ── Fila de class_analyses ────────────────────────────────────────────────────

/**
 * Fila de class_analyses tal como llega de Supabase (snake_case), con los campos
 * MÍNIMOS que necesita el cálculo. Cualquier ClassAnalysisRow encaja
 * estructuralmente. (Vivía en lib/finance.ts; finance la re-exporta.)
 */
export interface ClassTranscriptRef {
  /**
   * id de la fila. El cálculo no lo usa, pero sí la pantalla de solicitudes de
   * revisión: cuando una clase ya tiene transcript, la solicitud se engancha a
   * ESE análisis en vez de pedirle al profesor que lo vuelva a pegar.
   */
  id?: string | null;
  teacher_id?: string | null;
  student_name: string;
  class_date?: string | null;
  /** Fecha/hora de SUBIDA (persistTranscript la pone a `now()` al guardar). */
  analyzed_at?: string | null;
  /**
   * ¿Hay transcripción? Columna GENERADA por Postgres desde el texto
   * (supabase-has-transcript.sql). Es lo que piden los listados: el cálculo solo
   * necesita saber si existe, y el texto pesa 30 KB de media por fila.
   * `undefined` = la migración no se corrió y la consulta cayó al texto.
   */
  has_transcript?: boolean | null;
  /**
   * El TEXTO. Solo lo trae la lectura explícita del admin en Validación. En los
   * listados llega siempre `undefined`: ver transcriptHasText().
   */
  transcript?: string | null;
  /** Ingreso al que pertenece este transcript. Cuando viene, manda sobre la fecha. */
  join_log_id?: string | null;
  /** Validación (Bloque 1): 'review'/'rejected' NO valen como segundo factor. */
  validation_status?: string | null;
}

/**
 * ¿Esta fila tiene transcripción?
 *
 * Prefiere `has_transcript` (la columna generada) y solo mira el texto si esa
 * columna no vino — que es el caso mientras la migración no esté corrida. El
 * orden importa: `has_transcript` es la verdad calculada por Postgres desde el
 * propio texto, así que cuando está presente no hace falta nada más.
 */
export function transcriptHasText(t: ClassTranscriptRef): boolean {
  if (typeof t.has_transcript === 'boolean') return t.has_transcript;
  return !!t.transcript && t.transcript.trim().length > 0;
}

/** Fecha efectiva de un análisis: class_date y, si falta, el día de analyzed_at. */
export function analysisDateOf(t: ClassTranscriptRef): string {
  return (t.class_date || (t.analyzed_at ?? '').slice(0, 10) || '');
}

// ── Estado del transcript (sin mirar el plazo) ────────────────────────────────

/**
 * Estado de la transcripción de una clase.
 *
 *   'none'     → no hay texto: el profesor tiene que subirlo.
 *   'review'   → subido y guardado, esperando al equipo. NO es acción suya.
 *   'rejected' → el equipo lo rechazó: hay que subir el correcto.
 *   'ok'       → verifica la clase (segundo factor). Legacy sin columna → 'ok'.
 */
export type TranscriptState = 'none' | 'review' | 'rejected' | 'ok';

export function transcriptStateOf(t: ClassTranscriptRef | undefined | null): TranscriptState {
  if (!t || !transcriptHasText(t)) return 'none';
  if (t.validation_status === 'rejected') return 'rejected';
  if (t.validation_status === 'review') return 'review';
  return 'ok';
}

/** ¿El profesor tiene algo que hacer con este transcript? */
export function transcriptNeedsTeacher(state: TranscriptState): boolean {
  return state === 'none' || state === 'rejected';
}

/** Etiqueta y color del estado. Misma fuente para todas las pantallas. */
export function transcriptStateBadge(state: TranscriptState):
  { label: string; color: string; bg: string; dot: string } {
  switch (state) {
    case 'ok':       return { label: 'Transcript subido', color: '#1f7a3d', bg: '#eaf5ec', dot: '#16a34a' };
    case 'review':   return { label: 'En revisión del equipo', color: '#3b5b9e', bg: '#eef1f8', dot: '#2563eb' };
    case 'rejected': return { label: 'Transcript rechazado', color: '#b91c1c', bg: 'rgba(239,68,68,0.10)', dot: '#dc2626' };
    default:         return { label: 'Falta el transcript', color: '#9a6516', bg: '#fdf3e7', dot: '#e0912f' };
  }
}

// ── 1) ¿Cuál es el transcript de esta clase? ─────────────────────────────────

export interface FindTranscriptArgs {
  teacherId: string;
  studentName: string;
  /** Fecha de la clase, 'YYYY-MM-DD'. */
  dateIso: string;
  /**
   * Ingresos ("Ingresar a clase") de esa clase. Si el transcript trae
   * `join_log_id` a uno de ellos, es ÉSE: no se adivina nada más. Una sesión de
   * 2 h puede tener dos ingresos (uno por hora); se pasan los dos.
   */
  joinLogIds?: Array<string | null | undefined>;
  /**
   * Análisis que ya se asignaron a OTRA clase y no pueden reutilizarse (por id
   * o, si la fila no trae id, por referencia). Lo usan las vistas que recorren
   * varias clases del mismo alumno (la ficha, el dashboard), para que un
   * transcript sin vínculo no cubra dos clases. Se modifica: el elegido se
   * añade al conjunto.
   */
  exclude?: TranscriptExclusions;
}

/**
 * El transcript de una clase concreta. UNA sola regla de búsqueda, en este orden:
 *
 *   1. Vínculo explícito: `join_log_id` a uno de los ingresos de la clase.
 *   2. Misma fecha exacta (mismo profesor, mismo alumno). Un transcript de esa
 *      fecha que esté vinculado a OTRO ingreso no cuenta: es de otra sesión.
 *   3. SOLO para clases anteriores a la fecha de corte: ±1 día, y solo entre los
 *      transcripts sin vínculo. Es el respaldo que existía para lo añadido a
 *      mano; a partir del 22/09/2026 ya no hace falta (toda subida lleva
 *      `join_log_id` o la fecha exacta) y quitarlo evita que el transcript del
 *      lunes tape la clase del martes.
 *
 * Solo devuelve filas CON texto: una fila vacía no verifica nada.
 */
/** Conjunto de análisis ya usados: por id, o por referencia si la fila no trae id. */
export type TranscriptExclusions = Set<string | ClassTranscriptRef>;

export function findTranscriptFor(
  analyses: ClassTranscriptRef[], args: FindTranscriptArgs,
): ClassTranscriptRef | undefined {
  const name = nkName(args.studentName);
  const ids = new Set((args.joinLogIds ?? []).filter(Boolean) as string[]);
  const exclude = args.exclude;
  const keyOf = (t: ClassTranscriptRef): string | ClassTranscriptRef => t.id ?? t;

  const usable = (t: ClassTranscriptRef) =>
    (!t.teacher_id || t.teacher_id === args.teacherId) &&
    nkName(t.student_name) === name &&
    transcriptHasText(t) &&
    !exclude?.has(keyOf(t));

  const pick = (t: ClassTranscriptRef | undefined) => {
    if (t && exclude) exclude.add(keyOf(t));
    return t;
  };

  // 1) Vínculo explícito.
  if (ids.size > 0) {
    const linked = analyses.find(t => !!t.join_log_id && ids.has(t.join_log_id) && usable(t));
    if (linked) return pick(linked);
  }

  // 2) Fecha exacta. Con vínculo a otro ingreso, es de otra clase.
  const sameDay = analyses.find(t =>
    usable(t) && analysisDateOf(t) === args.dateIso &&
    (!t.join_log_id || ids.size === 0 || ids.has(t.join_log_id)));
  if (sameDay) return pick(sameDay);

  // 3) Respaldo ±1 día, solo para clases anteriores al plazo y sin vínculo.
  if (!subjectToDeadline(args.dateIso)) {
    const near = analyses.find(t =>
      usable(t) && !t.join_log_id && Math.abs(daysBetween(analysisDateOf(t), args.dateIso)) === 1);
    if (near) return pick(near);
  }
  return undefined;
}

// ── 2) ¿En qué estado está frente al plazo? ──────────────────────────────────

export type TranscriptStatus = 'subido' | 'pendiente' | 'vencido' | 'no_aplica';

export interface TranscriptStatusInput {
  /** Fecha de la clase (hora de España), 'YYYY-MM-DD'. */
  date: string;
  /** Hora de INICIO: 'HH:00' o número. Vacía/inválida → se asume que terminó a fin de día. */
  startHour: string | number | null | undefined;
  /** Duración de la sesión en horas (2 en un bloque de dos celdas contiguas). */
  durationHours: number;
  /** Tipo de la constancia, si la hay. La falta del alumno no lleva transcript. */
  classType?: ClassRecordType | string | null;
  /** El transcript de la clase (lo que devolvió findTranscriptFor), o nada. */
  transcript?: ClassTranscriptRef | null;
  /** Plazo reabierto por el admin (class_join_logs.transcript_deadline_at, ISO). */
  reopenedDeadlineAt?: string | null;
  /** Instante actual (epoch ms). */
  now: number;
}

export interface TranscriptStatusResult {
  status: TranscriptStatus;
  /** Estado crudo del transcript, por si la pantalla distingue 'review' de 'ok'. */
  transcriptState: TranscriptState;
  /** ¿Esta clase está sujeta al plazo de 24 h? false = anterior a la fecha de corte o no aplica. */
  subjectToDeadline: boolean;
  /** Fin de la clase (epoch ms). null si la fecha no se pudo interpretar. */
  endsAt: number | null;
  /** Fecha límite (epoch ms). null = sin plazo. */
  deadlineAt: number | null;
  /** Horas que quedan (puede ser fraccionario). Negativo si ya venció; null sin plazo. */
  hoursLeft: number | null;
  /** true si el plazo lo fijó el admin a mano. */
  reopened: boolean;
  /** Menos de TRANSCRIPT_WARN_HOURS para vencer (y todavía pendiente). */
  urgent: boolean;
}

/** ¿La fecha de clase cae dentro de la regla de 24 h? */
export function subjectToDeadline(dateIso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateIso) && dateIso >= TRANSCRIPT_DEADLINE_START_DATE;
}

/**
 * Instante en que TERMINA la clase: inicio (hora de pared española) + duración.
 * Sin hora conocida se toma el final del día (00:00 del día siguiente), que es
 * el caso más favorable al profesor: nunca se vence una clase antes de tiempo
 * por no saber a qué hora fue.
 */
export function classEndEpoch(dateIso: string, startHour: string | number | null | undefined, durationHours: number): number {
  const h = hourNum(startHour);
  const dur = Number.isFinite(durationHours) && durationHours > 0 ? durationHours : 1;
  if (!Number.isFinite(h)) return spainWallClockToEpoch(dateIso, 24, 0);
  // 'HH:MM' → los minutos, si vienen (las horas de clase son en punto, pero
  // una solicitud corregida a mano podría no serlo).
  const minute = typeof startHour === 'string' ? parseInt(startHour.split(':')[1] ?? '0', 10) || 0 : 0;
  const start = spainWallClockToEpoch(dateIso, h, minute);
  return Number.isFinite(start) ? start + dur * HOUR_MS : NaN;
}

export function getTranscriptStatus(input: TranscriptStatusInput): TranscriptStatusResult {
  const transcriptState = transcriptStateOf(input.transcript);
  const base = {
    transcriptState, subjectToDeadline: false, endsAt: null, deadlineAt: null,
    hoursLeft: null, reopened: false, urgent: false,
  };

  // La falta del alumno no lleva transcript: no hay plazo que correr.
  if (isStudentLostClass(input.classType ?? undefined)) {
    return { ...base, status: 'no_aplica' };
  }

  // Subido y guardado (validado o en revisión): el profesor ya hizo su parte.
  // Un transcript RECHAZADO no cuenta: hay que subir el correcto, y el plazo
  // sigue corriendo (si venció, el admin puede reabrirlo al rechazar).
  if (transcriptState === 'ok' || transcriptState === 'review') {
    return { ...base, status: 'subido' };
  }

  // Sin plazo: clase anterior a la fecha de corte. Pendiente para siempre.
  if (!subjectToDeadline(input.date)) {
    return { ...base, status: 'pendiente' };
  }

  const endsAtRaw = classEndEpoch(input.date, input.startHour, input.durationHours);
  const endsAt = Number.isFinite(endsAtRaw) ? endsAtRaw : null;

  const reopenedMs = input.reopenedDeadlineAt ? new Date(input.reopenedDeadlineAt).getTime() : NaN;
  const reopened = Number.isFinite(reopenedMs);
  const deadlineAt = reopened
    ? reopenedMs
    : endsAt != null ? endsAt + TRANSCRIPT_DEADLINE_HOURS * HOUR_MS : null;

  // Fecha ilegible y sin reapertura: no se puede vencer lo que no se puede medir.
  if (deadlineAt == null) {
    return { ...base, status: 'pendiente', subjectToDeadline: true, endsAt };
  }

  const hoursLeft = (deadlineAt - input.now) / HOUR_MS;
  const status: TranscriptStatus = hoursLeft <= 0 ? 'vencido' : 'pendiente';
  return {
    status, transcriptState, subjectToDeadline: true, endsAt, deadlineAt, hoursLeft, reopened,
    urgent: status === 'pendiente' && hoursLeft < TRANSCRIPT_WARN_HOURS,
  };
}

/**
 * Plazo reabierto por el admin para una clase, a partir de sus ingresos. Si la
 * sesión tiene dos ingresos (2 h) y el admin reabrió uno, vale el más lejano.
 */
export function reopenedDeadlineFor(
  joinLogs: Array<{ transcriptDeadlineAt?: string | null }>,
): string | null {
  let best: string | null = null;
  for (const l of joinLogs) {
    const v = l.transcriptDeadlineAt;
    if (!v) continue;
    if (!best || new Date(v).getTime() > new Date(best).getTime()) best = v;
  }
  return best;
}

// ── Textos y colores ─────────────────────────────────────────────────────────

/** "Quedan 14 h" · "Queda 1 h" · "Quedan 30 min". Vacío si no hay plazo. */
export function hoursLeftLabel(hoursLeft: number | null): string {
  if (hoursLeft == null) return '';
  if (hoursLeft <= 0) return 'Plazo vencido';
  if (hoursLeft < 1) {
    const min = Math.max(1, Math.round(hoursLeft * 60));
    return `${min === 1 ? 'Queda' : 'Quedan'} ${min} min`;
  }
  const h = Math.floor(hoursLeft);
  return `${h === 1 ? 'Queda' : 'Quedan'} ${h} h`;
}

/** "hasta el 23/09 a las 19:00" (hora de España). */
export function deadlineLabel(deadlineAt: number | null): string {
  if (deadlineAt == null) return '';
  const fmt = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(deadlineAt));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `hasta el ${get('day')}/${get('month')} a las ${get('hour')}:${get('minute')}`;
}

/** Fecha y hora de subida, corta: "23/09 19:12" (hora de España). */
export function uploadedAtLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const fmt = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(t));
  const get = (x: string) => parts.find(p => p.type === x)?.value ?? '';
  return `${get('day')}/${get('month')} ${get('hour')}:${get('minute')}`;
}

/** Etiqueta roja de la clase vencida. El mismo texto en las cuatro vistas. */
export const EXPIRED_LABEL = 'Vencida — no validada';

/**
 * Badge del estado FRENTE AL PLAZO, para las pantallas. Distinto de
 * transcriptStateBadge (que solo mira el texto) porque incluye la cuenta
 * regresiva y el vencido.
 */
export function transcriptDeadlineBadge(r: TranscriptStatusResult):
  { label: string; color: string; bg: string; dot: string; tone: 'ok' | 'review' | 'pending' | 'warn' | 'expired' | 'muted' } {
  switch (r.status) {
    case 'subido': {
      const b = transcriptStateBadge(r.transcriptState);
      return { ...b, tone: r.transcriptState === 'review' ? 'review' : 'ok' };
    }
    case 'vencido':
      return { label: EXPIRED_LABEL, color: '#b91c1c', bg: 'rgba(239,68,68,0.10)', dot: '#dc2626', tone: 'expired' };
    case 'no_aplica':
      return { label: 'Sin transcript (falta del alumno)', color: 'var(--text-muted)', bg: 'var(--bg-surface-3)', dot: '#a4a7a1', tone: 'muted' };
    default: {
      const base = transcriptStateBadge(r.transcriptState);   // 'Falta el transcript' / 'Transcript rechazado'
      if (r.hoursLeft == null) return { ...base, tone: 'pending' };
      const left = hoursLeftLabel(r.hoursLeft);
      return r.urgent
        ? { label: `${base.label} · ${left}`, color: '#8a6d00', bg: '#FFF4BF', dot: '#FFC400', tone: 'warn' }
        : { label: `${base.label} · ${left}`, color: base.color, bg: base.bg, dot: base.dot, tone: 'pending' };
    }
  }
}

// ── Utilidades ────────────────────────────────────────────────────────────────

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso.slice(0, 10) + 'T00:00:00Z').getTime();
  const b = new Date(bIso.slice(0, 10) + 'T00:00:00Z').getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86_400_000);
}
