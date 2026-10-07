// Testimoniales V5 — comprobación de los momentos y emparejamiento, POR CÓDIGO.
//
// Módulo PURO (sin red ni base). Lo prueba lib/testimonialPairs.test.ts.
//
//   · validateMoment: la cita que devolvió la IA tiene que estar dentro de una
//     intervención con la etiqueta del alumno; si no, se rechaza. También se
//     rechaza lo que huele a lectura, audio o repetición (lib/fluency
//     readingCue) y el momento bueno que no contesta al profe.
//   · bestPairs: una pareja = mismo alumno + MISMO PROFE + un momento malo de una
//     clase y uno muy bueno de OTRA. Se elige la combinación más fuerte (el más
//     malo con el más bueno), primero las que van en orden (la mala antes que la
//     buena); si solo hay al revés, sale marcada como "Orden inverso". Sin
//     requisito de nota media ni de semanas mínimas.

import {
  locateExcerpt, excerptStartSeconds, excerptEndSeconds, excerptWordCount, readingCue, withFathomTimestamp,
  type Turn,
} from '@/lib/fluency';
import type { StudentIntervention } from '@/lib/testimonialSpeaker';

export type MomentKind = 'malo' | 'bueno';

/** Un momento comprobado, tal como se guarda en testimonial_moments. */
export interface Moment {
  id: string;
  analysisId: string;
  studentGroup: string;
  teacherId: string | null;
  /** 'YYYY-MM-DD', fecha de la clase en España. */
  classDay: string;
  studentLabel: string;
  kind: MomentKind;
  start: number;
  end: number;
  excerpt: string;
  /** 1-10: lo malo que es el malo / lo bueno que es el bueno. */
  score: number;
  why: string;
  fathomUrl: string | null;
}

/** Duración del clip, en segundos. */
export const MOMENT_MIN_SECONDS = 5;
export const MOMENT_MAX_SECONDS = 15;
/** Palabras de la cita (como cuenta locateExcerpt). */
export const MOMENT_MIN_WORDS = 6;

/** Lo que devuelve la IA para un momento (lib/testimonialMoments). */
export interface MomentCandidate {
  tipo: MomentKind;
  intervencion: number;
  cita: string;
  puntuacion: number;
  porque: string;
}

/** Contexto de la clase para comprobar un momento. */
export interface MomentClassContext {
  analysisId: string;
  studentGroup: string;
  teacherId: string | null;
  classDay: string;
  studentLabel: string;
  fathomUrl: string | null;
  turns: Turn[];
  interventions: StudentIntervention[];
}

/** El momento comprobado, o por qué no vale. `id` lo pone quien lo guarda. */
export function validateMoment(ctx: MomentClassContext, ai: MomentCandidate): { error: string } | { moment: Omit<Moment, 'id'> } {
  const cita = String(ai.cita ?? '').trim();
  const short = `"${cita.slice(0, 60)}"`;
  if (ai.tipo !== 'malo' && ai.tipo !== 'bueno') return { error: `${short}: tipo desconocido.` };
  const words = excerptWordCount(cita);
  if (words < MOMENT_MIN_WORDS) return { error: `${short}: cita demasiado corta.` };

  // SOLO las intervenciones del alumno: la cita tiene que estar dentro de una.
  // Primero la que dijo la IA; si se equivocó de número, cualquier otra del alumno.
  const own = ctx.interventions.find(x => x.n === ai.intervencion);
  const order = own ? [own, ...ctx.interventions.filter(x => x !== own)] : ctx.interventions;
  let hit: { iv: StudentIntervention; wordsBefore: number; turnWords: number } | null = null;
  for (const iv of order) {
    const turn = ctx.turns[iv.turnIndex];
    if (!turn || turn.speaker !== ctx.studentLabel) continue;
    const loc = locateExcerpt([turn], cita);
    if (loc) { hit = { iv, wordsBefore: loc.wordsBefore, turnWords: loc.turnWords }; break; }
  }
  if (!hit) return { error: `${short}: no está dentro de ninguna intervención del alumno.` };

  const loc = { turnIndex: hit.iv.turnIndex, wordsBefore: hit.wordsBefore, turnWords: hit.turnWords };
  const cue = readingCue(ctx.turns, loc.turnIndex);
  if (cue) return { error: `${short}: ${cue}.` };
  if (ai.tipo === 'bueno' && !hit.iv.teacherBefore) {
    return { error: `${short}: el momento bueno no contesta al profe (no hay una frase del profe justo antes).` };
  }

  const start = excerptStartSeconds(ctx.turns, loc);
  if (start == null) return { error: `${short}: la intervención no tiene minuto.` };
  const rawEnd = excerptEndSeconds(ctx.turns, loc, words, start);
  const end = Math.min(start + MOMENT_MAX_SECONDS, Math.max(start + MOMENT_MIN_SECONDS, rawEnd));
  const score = Math.min(10, Math.max(1, Math.round(Number(ai.puntuacion) || 0)));

  return {
    moment: {
      analysisId: ctx.analysisId, studentGroup: ctx.studentGroup, teacherId: ctx.teacherId,
      classDay: ctx.classDay, studentLabel: ctx.studentLabel,
      kind: ai.tipo, start, end, excerpt: cita, score, why: String(ai.porque ?? '').trim(),
      // El enlace ya abre la grabación en el segundo de inicio.
      fathomUrl: withFathomTimestamp(ctx.fathomUrl, start),
    },
  };
}

/** ¿Dos momentos de la misma clase se pisan? */
export const momentsOverlap = (a: Pick<Moment, 'analysisId' | 'start' | 'end'>, b: Pick<Moment, 'analysisId' | 'start' | 'end'>): boolean =>
  a.analysisId === b.analysisId && a.start < b.end && b.start < a.end;

/**
 * Los momentos que se guardan de una clase: hasta `perKind` de cada tipo, los de
 * más puntuación, sin dos que se pisen.
 */
export function keepBest<T extends Pick<Moment, 'analysisId' | 'kind' | 'score' | 'start' | 'end'>>(moments: T[], perKind: number): T[] {
  const out: T[] = [];
  for (const kind of ['malo', 'bueno'] as const) {
    const sorted = moments.filter(m => m.kind === kind).sort((a, b) => b.score - a.score || a.start - b.start);
    const chosen: T[] = [];
    for (const m of sorted) {
      if (chosen.length === perKind) break;
      if (chosen.some(c => momentsOverlap(c, m))) continue;
      chosen.push(m);
    }
    out.push(...chosen);
  }
  return out;
}

// ── Emparejamiento ───────────────────────────────────────────────────────────

export interface MomentPair {
  studentGroup: string;
  teacherId: string;
  malo: Moment;
  bueno: Moment;
  /** La clase del momento malo es POSTERIOR (o del mismo día) a la del bueno. */
  reverse: boolean;
}

const DAY_MS = 86_400_000;
const gapDays = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** >0 si `a` es mejor. Números: más es mejor; el id final: menos es mejor (solo desempata). */
function compareRank(a: Array<number | string>, b: Array<number | string>): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return typeof a[i] === 'number' ? (a[i] as number) - (b[i] as number) : (a[i] < b[i] ? 1 : -1);
  }
  return 0;
}

/** Clave de la pareja: alumno + profe. */
export const pairKey = (studentGroup: string, teacherId: string): string => `${studentGroup}|${teacherId}`;

/**
 * La mejor pareja de cada alumno con cada profe. Solo con profe conocido y con
 * el malo y el bueno en clases DISTINTAS. Entre las que van en orden (malo antes
 * que bueno), la de mayor suma de puntuaciones; a igualdad, la de más días entre
 * las dos clases. Si no hay ninguna en orden, la mejor al revés (reverse: true).
 */
export function bestPairs(moments: Moment[]): MomentPair[] {
  const groups = new Map<string, Moment[]>();
  for (const m of moments) {
    if (!m.teacherId) continue;
    const k = pairKey(m.studentGroup, m.teacherId);
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  const out: MomentPair[] = [];
  for (const list of groups.values()) {
    const malos = list.filter(m => m.kind === 'malo');
    const buenos = list.filter(m => m.kind === 'bueno');
    let best: { pair: MomentPair; rank: Array<number | string> } | null = null;
    for (const malo of malos) {
      for (const bueno of buenos) {
        if (malo.analysisId === bueno.analysisId) continue;
        const gap = gapDays(malo.classDay, bueno.classDay);
        const reverse = gap <= 0;
        // En orden primero; luego la suma; luego la distancia entre clases; luego por id (estable).
        const rank = [reverse ? 0 : 1, malo.score + bueno.score, Math.abs(gap), `${malo.id}|${bueno.id}`];
        if (!best || compareRank(rank, best.rank) > 0) {
          best = { pair: { studentGroup: malo.studentGroup, teacherId: malo.teacherId!, malo, bueno, reverse }, rank };
        }
      }
    }
    if (best) out.push(best.pair);
  }
  return out;
}
