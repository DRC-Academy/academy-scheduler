// Pestaña "Penalizaciones" del admin — lo que se MUESTRA, sin red ni base.
//
// Junta lo que ya existe: los eventos de multa (scoring_events), las
// cancelaciones (class_recoveries) y las posibles ausencias (para el día y la
// hora de la falta y las que quedaron "sin cobrar: revisar"). Arma:
//   · una fila por multa, con tipo, alumno, clase, estado y origen;
//   · el resumen por profesor del mes, con el cuadre contra Finanzas.
//
// EL CUADRE: "Finanzas resta" sale de scoringEventsForMonth + penaltySumOf, las
// MISMAS funciones que usa calculateTeacherFinance. Si el total de la pestaña no
// coincide, es porque hay otras multas en la base (las −5 € del sistema viejo,
// por ejemplo), nunca por una cuenta distinta.
//
// Lo prueba lib/penaltiesView.test.ts.

import type { ScoringEvent } from '@/types';
import {
  eventMonthOf, spainMonthOfInstant, absenceIdOfFaltaEvent, faltaEventId, isCountedLateCancellation,
  FALTA_EVENT_TYPE, FALTA_PENALTY_EUROS, type CountableRecovery,
} from '@/lib/teacherPenalties';
import { scoringEventsForMonth, penaltySumOf } from '@/lib/finance';
import { MONTHLY_WILDCARDS } from '@/lib/classRecoveries';

export const CANCEL_EVENT_TYPE = 'cancelacion_profesor_penalizacion';
const CANCEL_PREFIX = 'se_cancel_prof_';

export type PenaltyKind = 'falta' | 'cancelacion' | 'antigua';
export type PenaltyState = 'cobrada' | 'revertida' | 'revisar';
export type PenaltyOrigin = 'deteccion' | 'reclasificacion' | 'cancelacion' | 'antigua';

export const KIND_LABEL: Record<PenaltyKind, string> = {
  falta: 'Falta (no se presentó)',
  cancelacion: 'Cancelación con menos de 24 h',
  antigua: 'Multa antigua (sistema viejo)',
};
export const ORIGIN_LABEL: Record<PenaltyOrigin, string> = {
  deteccion: 'Detección automática',
  reclasificacion: 'Reclasificación del admin',
  cancelacion: 'Cancelación del profe',
  antigua: 'Sistema viejo',
};

/** Lo que hace falta de una fila de class_recoveries. */
export interface PenaltyRecovery extends CountableRecovery {
  originalHour: string;
  penaltyEventId: string | null;
}

/** Lo que hace falta de una posible ausencia (/api/admin/posibles-ausencias). */
export interface PenaltyAbsence {
  id: string; teacherId: string; teacherName: string; studentName: string;
  classDate: string; classHour: string; status: string;
  penaltyState: 'cobrada' | 'revertida' | 'revisar' | null;
  penaltyReason: string | null;
  penaltyEligible?: boolean;
  detectedAt: string;
}

export interface PenaltyRow {
  key: string;
  /** Evento de la multa. null en las "sin cobrar: revisar" (no hay evento). */
  eventId: string | null;
  /** Posible ausencia de la falta (si existe). */
  absenceId: string | null;
  teacherId: string;
  teacherName: string;
  kind: PenaltyKind;
  studentName: string;
  classDate: string | null;
  classHour: string | null;
  /** Cuándo se cobró (la falta) o cuándo se canceló (la cancelación). */
  at: string | null;
  /** Importe en euros, positivo. En las "revisar", lo que costaría. */
  euros: number;
  state: PenaltyState;
  revertedBy: string | null;
  revertedAt: string | null;
  revertReason: string | null;
  origin: PenaltyOrigin;
  /** Mes al que cuenta (eventMonthOf; en las "revisar", el de la clase). */
  month: string;
  /** Las "revisar" con clase anterior al inicio o de prueba no se pueden cobrar. */
  chargeable: boolean;
}

/** 'alumno X, fecha 2026-10-23 18:00' → { alumno, fecha, hora } (notas de las multas). */
function parseNote(note: string | null | undefined): { student: string | null; date: string | null; hour: string | null } {
  const m = /alumno (.+?), fecha (\d{4}-\d{2}-\d{2})(?: (\d{1,2}:\d{2}))?/.exec(note ?? '');
  return { student: m?.[1] ?? null, date: m?.[2] ?? null, hour: m?.[3] ?? null };
}

/**
 * Motivo de una reversión: el compensatorio con id fijo `<multa>_rev` (sistema
 * único) o, para las revertidas desde el "Revertir" viejo de Finanzas, el
 * compensatorio del mismo profesor creado a la vez (±2 min de reverted_at).
 */
function revertReasonOf(e: ScoringEvent, all: readonly ScoringEvent[]): string | null {
  const comps = all.filter(c => c.eventType === 'penalizacion_revertida' && c.teacherId === e.teacherId);
  const t = Date.parse(e.revertedAt ?? '');
  const comp = comps.find(c => c.id === `${e.id}_rev`)
    ?? (Number.isFinite(t) ? comps.find(c => Math.abs(Date.parse(c.createdAt) - t) < 120_000) : undefined);
  if (!comp) return null;
  const m = /Motivo: ([\s\S]*)$/.exec(comp.note ?? '');
  return (m?.[1] ?? comp.note ?? '').trim() || null;
}

export function buildPenaltyRows(args: {
  events: readonly ScoringEvent[];
  recoveries: readonly PenaltyRecovery[];
  absences: readonly PenaltyAbsence[];
  teacherName: (id: string) => string;
}): PenaltyRow[] {
  const rows: PenaltyRow[] = [];
  const absById = new Map(args.absences.map(a => [a.id, a]));
  const recByGroup = new Map<string, PenaltyRecovery>();
  for (const r of args.recoveries) if (!recByGroup.has(r.groupId)) recByGroup.set(r.groupId, r);
  const eventIds = new Set(args.events.map(e => e.id));

  for (const e of args.events) {
    if (e.eventType === 'penalizacion_revertida') continue;
    const nueva = e.eventType === FALTA_EVENT_TYPE || e.eventType === CANCEL_EVENT_TYPE;
    if (!nueva && !((e.euros ?? 0) < 0)) continue;   // antiguas: solo las que restaban dinero

    const base = {
      key: e.id, eventId: e.id, teacherId: e.teacherId,
      teacherName: args.teacherName(e.teacherId) || e.teacherName,
      euros: Math.abs(e.euros ?? 0),
      state: (e.reverted ? 'revertida' : 'cobrada') as PenaltyState,
      revertedBy: e.reverted ? e.revertedBy ?? null : null,
      revertedAt: e.reverted ? e.revertedAt ?? null : null,
      revertReason: e.reverted ? revertReasonOf(e, args.events) : null,
      month: eventMonthOf(e),
      chargeable: false,
    };
    const nota = parseNote(e.note);

    if (e.eventType === FALTA_EVENT_TYPE) {
      const absenceId = absenceIdOfFaltaEvent(e.id);
      const abs = absenceId ? absById.get(absenceId) : undefined;
      rows.push({
        ...base, kind: 'falta', absenceId,
        studentName: abs?.studentName ?? e.studentRef ?? nota.student ?? '—',
        classDate: abs?.classDate ?? nota.date, classHour: abs?.classHour ?? nota.hour,
        at: e.createdAt,
        origin: /reclasificada/i.test(e.note ?? '') ? 'reclasificacion' : 'deteccion',
      });
    } else if (e.eventType === CANCEL_EVENT_TYPE) {
      const rec = e.id.startsWith(CANCEL_PREFIX) ? recByGroup.get(e.id.slice(CANCEL_PREFIX.length)) : undefined;
      rows.push({
        ...base, kind: 'cancelacion', absenceId: null,
        studentName: rec?.studentName ?? e.studentRef ?? nota.student ?? '—',
        classDate: rec?.originalDate ?? nota.date, classHour: rec?.originalHour ?? null,
        at: rec?.cancelledAt ?? e.createdAt,
        origin: rec?.origin === 'admin_reclasificacion' ? 'reclasificacion' : 'cancelacion',
      });
    } else {
      rows.push({
        ...base, kind: 'antigua', absenceId: null,
        studentName: e.studentRef ?? nota.student ?? '—',
        classDate: nota.date, classHour: nota.hour, at: e.createdAt, origin: 'antigua',
      });
    }
  }

  // Faltas sin cobrar: el profesor había intentado cancelar con la app vieja.
  for (const a of args.absences) {
    if (a.penaltyState !== 'revisar' || a.status === 'anulada') continue;
    if (eventIds.has(faltaEventId(a.id))) continue;   // ya se cobró después
    rows.push({
      key: `revisar_${a.id}`, eventId: null, absenceId: a.id,
      teacherId: a.teacherId, teacherName: args.teacherName(a.teacherId) || a.teacherName,
      kind: 'falta', studentName: a.studentName, classDate: a.classDate, classHour: a.classHour,
      at: a.detectedAt, euros: FALTA_PENALTY_EUROS, state: 'revisar',
      revertedBy: null, revertedAt: null, revertReason: a.penaltyReason,
      origin: 'deteccion', month: a.classDate.slice(0, 7), chargeable: a.penaltyEligible !== false,
    });
  }

  return rows.sort((x, y) => (y.at ?? '').localeCompare(x.at ?? ''));
}

export interface PenaltySummary {
  teacherId: string;
  teacherName: string;
  /** Faltas cobradas (sin revertir). */
  faltas: number;
  /** Cancelaciones tardías con multa cobrada (sin revertir). */
  cancelaciones: number;
  /** Comodines gastados en el mes (de MONTHLY_WILDCARDS). */
  comodines: number;
  /** Total en euros de las filas cobradas mostradas (positivo). */
  total: number;
  /** Lo que resta Finanzas ese mes (positivo): todas las multas vivas del mes. */
  finanzas: number;
  cuadra: boolean;
}

/**
 * Resumen por profesor de las filas YA filtradas (mes, profesor, tipo…), más los
 * comodines del mes y lo que resta Finanzas. Si `withOld` es false, el total no
 * lleva las multas antiguas y por eso puede no cuadrar: la pestaña lo dice.
 */
export function summarizePenalties(args: {
  rows: readonly PenaltyRow[];
  month: string;
  events: readonly ScoringEvent[];
  recoveries: readonly PenaltyRecovery[];
  teacherIds: ReadonlySet<string>;
  teacherName: (id: string) => string;
}): PenaltySummary[] {
  const ids = new Set<string>(args.rows.map(r => r.teacherId));
  const usadas = new Map<string, Set<string>>();
  for (const r of args.recoveries) {
    if (!args.teacherIds.has(r.teacherId) || !isCountedLateCancellation(r) || spainMonthOfInstant(r.cancelledAt) !== args.month) continue;
    (usadas.get(r.teacherId) ?? usadas.set(r.teacherId, new Set()).get(r.teacherId)!).add(r.groupId);
    ids.add(r.teacherId);
  }
  // También quien solo tiene multas que la pestaña no muestra (las antiguas):
  // si no, el descuadre con Finanzas quedaría escondido.
  for (const id of args.teacherIds) {
    if (penaltySumOf(scoringEventsForMonth(args.events, id, args.month)) < 0) ids.add(id);
  }
  return [...ids].filter(id => args.teacherIds.has(id)).map(teacherId => {
    const mias = args.rows.filter(r => r.teacherId === teacherId && r.state === 'cobrada');
    const total = mias.reduce((s, r) => s + r.euros, 0);
    const finanzas = -penaltySumOf(scoringEventsForMonth(args.events, teacherId, args.month));
    return {
      teacherId, teacherName: args.teacherName(teacherId),
      faltas: mias.filter(r => r.kind === 'falta').length,
      cancelaciones: mias.filter(r => r.kind === 'cancelacion').length,
      comodines: Math.min(MONTHLY_WILDCARDS, usadas.get(teacherId)?.size ?? 0),
      total, finanzas, cuadra: Math.abs(total - finanzas) < 0.005,
    };
  }).sort((a, b) => b.total - a.total || b.finanzas - a.finanzas || a.teacherName.localeCompare(b.teacherName, 'es'));
}
