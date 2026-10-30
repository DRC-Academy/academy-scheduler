// Testimoniales — VARIAS PAREJAS POR ALUMNO para el verificador. Módulo PURO.
//
// El buscador V6 (lib/testimonialScoring.choosePair) elige UNA pareja por alumno;
// si el verificador la tira, el alumno se queda fuera aunque tenga cientos de
// combinaciones más. Aquí salen, por alumno, hasta `parejas_por_alumno` parejas
// ordenadas de mejor a peor con las MISMAS reglas que el buscador (mismo profe,
// semanas mínimas, el B más largo que el A, con grabación). Además (decisiones de
// Facundo, 30/10/2026):
//   · un momento con más de `momento_espanol_max` de palabras en español (texto
//     de Fathom) no se usa; con algo de español, sus parejas van al final;
//   · un mismo momento sale como mucho `momento_max_parejas` veces en la lista,
//     para que un mal ANTES no se lleve por delante todas las parejas del alumno.
// La tanda (lib/testimonialVerifier) las prueba en orden y salta de alumno al
// aprobar una.
//
// UN MOMENTO = una intervención del alumno en una GRABACIÓN de Fathom (momentKey),
// no un id de testimonial_segments: hay transcripts duplicados (la misma
// grabación subida en dos clases) y ventanas solapadas de la misma intervención.
// Por eso el tope por momento, los vetos y las combinaciones ya verificadas van
// por momentKey, y un A y un B de la misma grabación nunca forman pareja.

import { canBeA, canBeB, segDuration, daysBetween, blockingScore, fluencyScore, type Segment } from '@/lib/testimonialScoring';

/** La grabación de Fathom sin ?timestamp= ni mayúsculas: igual en las copias de un transcript. */
export const recordingKey = (url: string | null | undefined): string =>
  (url ?? '').trim().toLowerCase().split(/[?#]/)[0].replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');

/** Una intervención del alumno en una grabación (ventanas solapadas y copias incluidas). */
export const momentKey = (s: Pick<Segment, 'fathomUrl' | 'turnIndex'>): string => `${recordingKey(s.fathomUrl)}#${s.turnIndex}`;

/** momentKey desde el id del recorte (`${analysisId}:${turnIndex}:${kind}:${n}`) y la URL de su clip. */
export function momentKeyFromId(id: string | null | undefined, url: string | null | undefined): string | null {
  const parts = (id ?? '').split(':');
  const turn = Number(parts[parts.length - 3]);
  return parts.length >= 4 && Number.isInteger(turn) && url ? `${recordingKey(url)}#${turn}` : null;
}

export interface PlanOptions {
  /** Parejas como mucho por alumno. */
  max: number;
  /** Veces que un mismo momento puede salir en la lista de un alumno. */
  perMoment: number;
  /** Fracción de palabras en español a partir de la cual el momento no se usa. */
  spanishMax: number;
  /** Semanas mínimas entre la clase del A y la del B. */
  minWeeks: number;
  /** Momentos que no se pueden usar (vetados, de un "No sirve", enlace falso…). */
  blocked?: (s: Segment) => boolean;
  /** Combinaciones ya verificadas: no se repiten. */
  skipPair?: (a: Segment, b: Segment) => boolean;
}

export interface PlannedPair {
  a: Segment;
  b: Segment;
  aScore: number;
  bScore: number;
  gapDays: number;
  /** Alguno de los dos momentos tiene algo de español (va al final). */
  conEspanol: boolean;
}

/** Fracción de palabras en español del texto de Fathom del momento. */
export const spanishShare = (s: Pick<Segment, 'words' | 'spanishWords'>): number =>
  s.words > 0 ? s.spanishWords / s.words : 0;

/** >0 si `x` va antes que `y`. */
export function comparePlanned(x: PlannedPair, y: PlannedPair): number {
  return (Number(y.conEspanol) - Number(x.conEspanol))
    || (Math.floor(x.gapDays / 7) - Math.floor(y.gapDays / 7))
    || ((x.aScore + x.bScore) - (y.aScore + y.bScore))
    || (x.gapDays - y.gapDays)
    || (`${y.a.id}|${y.b.id}` < `${x.a.id}|${x.b.id}` ? -1 : 1);
}

/** Las parejas de UN alumno, de mejor a peor. */
export function planStudentPairs(segments: Segment[], avgWpm: number | null, o: PlanOptions): PlannedPair[] {
  const usable = (s: Segment) => !!s.fathomUrl && !!s.teacherId && spanishShare(s) <= o.spanishMax && !o.blocked?.(s);
  const As = segments.filter(s => canBeA(s) && usable(s));
  const Bs = segments.filter(s => canBeB(s) && usable(s));
  const minDays = o.minWeeks * 7;
  const all: PlannedPair[] = [];
  for (const a of As) {
    const aScore = blockingScore(a, avgWpm);
    for (const b of Bs) {
      if (a.teacherId !== b.teacherId || recordingKey(a.fathomUrl) === recordingKey(b.fathomUrl)) continue;
      const gapDays = daysBetween(a.classDay, b.classDay);
      if (gapDays < minDays || segDuration(b) <= segDuration(a)) continue;
      if (o.skipPair?.(a, b)) continue;
      all.push({ a, b, aScore, bScore: fluencyScore(b, avgWpm), gapDays, conEspanol: a.spanishWords > 0 || b.spanishWords > 0 });
    }
  }
  all.sort((x, y) => comparePlanned(y, x));

  const uses = new Map<string, number>(), seen = new Set<string>();
  const out: PlannedPair[] = [];
  for (const p of all) {
    if (out.length >= o.max) break;
    const ka = momentKey(p.a), kb = momentKey(p.b);
    // La misma combinación de momentos con otros ids (copias o ventanas solapadas): una vez.
    const par = `${ka}|${kb}`;
    if (seen.has(par)) continue;
    if ((uses.get(ka) ?? 0) >= o.perMoment || (uses.get(kb) ?? 0) >= o.perMoment) continue;
    seen.add(par);
    uses.set(ka, (uses.get(ka) ?? 0) + 1);
    uses.set(kb, (uses.get(kb) ?? 0) + 1);
    out.push(p);
  }
  return out;
}

// ── El plan de una tanda ─────────────────────────────────────────────────────

/** Una pareja del plan, en corto (se guarda en testimonial_verify_batches.plan). */
export interface PlanItem {
  /** student_group */
  g: string;
  /** Recortes (testimonial_segments.id), sus momentos (momentKey) y sus grabaciones (recordingKey). */
  a: string;
  b: string;
  ma: string;
  mb: string;
  ra: string;
  rb: string;
}

export const toPlanItem = (g: string, p: Pick<PlannedPair, 'a' | 'b'>): PlanItem => ({
  g, a: p.a.id, b: p.b.id, ma: momentKey(p.a), mb: momentKey(p.b), ra: recordingKey(p.a.fathomUrl), rb: recordingKey(p.b.fathomUrl),
});

/** Vetos vigentes: momentos (momentKey) y grabaciones (recordingKey) que ya no se usan. */
export interface Vetos { momentos: ReadonlySet<string>; grabaciones: ReadonlySet<string> }

/** ¿El recorte cae en un momento o una grabación vetados? */
export const isVetoed = (s: Pick<Segment, 'fathomUrl' | 'turnIndex'>, v: Vetos): boolean =>
  v.momentos.has(momentKey(s)) || v.grabaciones.has(recordingKey(s.fathomUrl));

/**
 * La siguiente pareja a verificar desde `cursor`: se salta las de alumnos que ya
 * tienen una aprobada en la tanda y las que usan un momento o una grabación vetados.
 * null = no queda ninguna.
 */
export function nextPlanItem(plan: PlanItem[], cursor: number, aprobados: ReadonlySet<string>, vetos: Vetos): { item: PlanItem; index: number } | null {
  for (let i = Math.max(0, cursor); i < plan.length; i++) {
    const p = plan[i];
    if (aprobados.has(p.g)) continue;
    if (vetos.momentos.has(p.ma) || vetos.momentos.has(p.mb) || vetos.grabaciones.has(p.ra) || vetos.grabaciones.has(p.rb)) continue;
    return { item: p, index: i };
  }
  return null;
}

/** Motivos del verificador que inutilizan el MOMENTO (no la pareja) para siempre. */
export const MOTIVOS_QUE_VETAN = ['espanol', 'habla_profe', 'leyendo', 'camara_apagada'] as const;
