// Testimoniales — qué alumnos entran y entre qué clases se busca el momento.
//
// Módulo PURO (sin red ni base): recibe las clases con nota de fluidez de un
// alumno y decide, con las reglas de lib/testimonialRules, si entra y en qué
// clases se buscan sus clips. Lo prueba lib/testimonials.test.ts.
//
// V4 (07/10/2026): ya no se mira la nota. Entra todo alumno con clases SUYAS
// suficientes y separadas en el tiempo; la mejora la tienen que enseñar los dos
// clips (lib/testimonialStore + lib/testimonialVerify). Lo que sí se exige aquí
// es que todas las clases sean del MISMO alumno: en la V3 salieron clips de otra
// persona porque la clase estaba guardada en el alumno equivocado ("Ana
// Aparicio" con clases de "Elena") o porque hablaba otro con su cuenta.

import { TESTIMONIAL_RULES, type TestimonialRules } from '@/lib/testimonialRules';
import { formatSeconds } from '@/lib/fluency';
import { normName } from '@/lib/retention';

/** Una clase del alumno con nota (fila de transcript_fluency_numbered). */
export interface FluencyClass {
  analysisId: string;
  classNumber: number | null;
  /** 'YYYY-MM-DD', fecha de la clase en España. */
  classDay: string;
  teacherId: string | null;
  score: number;
  fathomUrl: string | null;
  /** Etiqueta de Fathom del hablante que NO es el profe (transcript_fluency.student_speaker). */
  studentSpeaker: string | null;
}

export interface TestimonialCandidatePlan {
  /** Sus clases (las que son de verdad suyas), en orden cronológico. */
  own: FluencyClass[];
  /** Primeras clases que tienen alguna de las últimas a DIAS_MIN o más: aquí se busca el clip malo. */
  badOptions: FluencyClass[];
  /** Últimas clases que tienen alguna de las primeras a DIAS_MIN o más antes: aquí se busca el bueno. */
  goodOptions: FluencyClass[];
  /** Pareja provisional (la más antigua y la más reciente) hasta que se elijan los clips. */
  before: FluencyClass;
  after: FluencyClass;
}

const DAY_MS = 86_400_000;
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

const byDate = (a: FluencyClass, b: FluencyClass): number =>
  a.classDay.localeCompare(b.classDay) || a.analysisId.localeCompare(b.analysisId);

// ── ¿Es el mismo alumno? ─────────────────────────────────────────────────────

/** Etiqueta de hablante comparable: sin el email entre paréntesis; un email suelto vale por su parte local. */
export function speakerKey(label: string | null | undefined): string {
  const s = String(label ?? '')
    .replace(/\([^()]*@[^()]*\)/g, ' ')   // "Lily (lily@gmail.com)" → "Lily"
    .replace(/@\S+/g, ' ');               // "jvizcaino12@yahoo.es" → "jvizcaino12"
  return normName(s.replace(/[^\p{L}\p{N}\s]+/gu, ' '));
}

const NAME_STOPWORDS = new Set(['del', 'las', 'los']);

/**
 * ¿La etiqueta de Fathom lleva el nombre del alumno? Basta un nombre o apellido
 * (de 3 letras o más) en común: "Juan Francisco Zamorano" ↔ "Juan Fran Zamorano",
 * "Maximiliano Bilotti" ↔ "Max Bilotti". También un apodo que es el principio
 * del nombre: "Zule" ↔ "Zulena", "Cris" ↔ "Cristina". Un email suelto vale si
 * contiene un nombre de 4 letras o más: "jvizcaino12" ↔ "Jose Vizcaíno".
 */
export function speakerMatchesName(label: string | null | undefined, studentName: string | null | undefined): boolean {
  const key = speakerKey(label);
  if (!key) return false;
  const tokens = key.split(' ').filter(t => t.length >= 3);
  const glued = key.replace(/\s+/g, '');
  const names = normName(String(studentName ?? '').replace(/[^\p{L}\s]+/gu, ' '))
    .split(' ').filter(t => t.length >= 3 && !NAME_STOPWORDS.has(t));
  return names.some(n => tokens.some(t => n.startsWith(t)) || (n.length >= 4 && glued.includes(n)));
}

/** "Luis Méndez", "Defactos Agency": dos palabras de 3 letras o más = el nombre completo de alguien. */
const looksLikeFullName = (key: string): boolean =>
  key.split(' ').filter(t => /^\p{L}{3,}$/u.test(t)).length >= 2;

/**
 * Las clases que son de verdad del alumno, por la etiqueta del hablante:
 *   · las que llevan su nombre;
 *   · y las de la etiqueta que usa en MÁS de la mitad de sus clases aunque no
 *     lleve su nombre (cuentas tipo "re ms", "BLNNDNN", "Psique"), salvo que
 *     sea el nombre completo de otra persona ("Luis Méndez").
 * El resto son de otra persona: clase guardada en el alumno equivocado, o un
 * tercero con su cuenta. Una clase sin hablante del alumno nunca cuenta.
 */
export function ownClasses(classes: FluencyClass[], studentName: string | null | undefined): FluencyClass[] {
  const withSpeaker = classes.filter(c => speakerKey(c.studentSpeaker));
  const counts = new Map<string, number>();
  for (const c of withSpeaker) counts.set(speakerKey(c.studentSpeaker), (counts.get(speakerKey(c.studentSpeaker)) ?? 0) + 1);
  const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  const alias = n * 2 > withSpeaker.length && !looksLikeFullName(top) ? top : null;
  return withSpeaker.filter(c => speakerMatchesName(c.studentSpeaker, studentName) || speakerKey(c.studentSpeaker) === alias);
}

// ── ¿Entra? ──────────────────────────────────────────────────────────────────

/**
 * Sí si tiene CLASES_MIN clases suyas y alguna de las primeras está a DIAS_MIN o
 * más de alguna de las últimas. El clip malo se busca en sus primeras clases y el
 * bueno en las últimas, VENTANA como mucho de cada lado y sin solaparse.
 */
export function planCandidate(
  classes: FluencyClass[], studentName: string | null | undefined, rules: TestimonialRules = TESTIMONIAL_RULES,
): TestimonialCandidatePlan | null {
  const own = ownClasses(classes, studentName).sort(byDate);
  if (own.length < rules.CLASES_MIN) return null;
  const w = Math.min(rules.VENTANA, Math.floor(own.length / 2));
  const first = own.slice(0, w);
  const last = own.slice(-w);
  const badOptions = first.filter(b => last.some(g => daysBetween(b.classDay, g.classDay) >= rules.DIAS_MIN));
  if (badOptions.length === 0) return null;
  const goodOptions = last.filter(g => badOptions.some(b => daysBetween(b.classDay, g.classDay) >= rules.DIAS_MIN));
  return { own, badOptions, goodOptions, before: badOptions[0], after: goodOptions.at(-1)! };
}

// ── Clips (columna testimonial_candidates.clips, supabase-testimoniales-clips.sql) ──

/** Un clip corto del alumno, ya comprobado: la cita existe y es suya. */
export interface TestimonialClip {
  analysisId: string;
  /** 'YYYY-MM-DD', fecha de la clase en España. */
  classDate: string;
  teacherId: string | null;
  /** Segundos desde el inicio de la grabación. */
  start: number;
  end: number;
  excerpt: string;
  /** Por qué es un momento malo o bueno (una frase de la IA). */
  why: string;
  /** Grabación de Fathom abierta en `start` (?timestamp=), o null si la clase no la trae. */
  fathomUrl: string | null;
}

/** Desde la V4, un clip de cada lado (las parejas antiguas pueden traer hasta 3). */
export interface TestimonialClips {
  malos: TestimonialClip[];
  buenos: TestimonialClip[];
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "16 jul · 8:20 – 8:27" */
export function clipLabel(c: Pick<TestimonialClip, 'classDate' | 'start' | 'end'>): string {
  const [, m, d] = c.classDate.slice(0, 10).split('-').map(Number);
  const dia = m && d ? `${d} ${MESES[m - 1]}` : 'Sin fecha';
  return `${dia} · ${formatSeconds(c.start)} – ${formatSeconds(c.end)}`;
}

/** ¿Dos clips de la misma clase se pisan? (la IA a veces repite el mismo momento) */
export const clipsOverlap = (a: TestimonialClip, b: TestimonialClip): boolean =>
  a.analysisId === b.analysisId && a.start < b.end && b.start < a.end;

/** Un clip ya comprobado por lib/testimonialVerify: es el alumno, espontáneo, con su nivel (1-5). */
export interface VerifiedClip {
  clip: TestimonialClip;
  nivel: number;
}

/**
 * La pareja final: el primer clip malo y el primer bueno (en el orden de la IA,
 * del más claro al menos claro) con DIAS_MIN o más entre las dos clases y el
 * bueno al menos MEJORA_CLIP_MIN niveles por encima. null si no hay ninguna.
 */
export function pickPair(
  malos: VerifiedClip[], buenos: VerifiedClip[], rules: TestimonialRules = TESTIMONIAL_RULES,
): { malo: VerifiedClip; bueno: VerifiedClip } | null {
  for (const malo of malos) {
    for (const bueno of buenos) {
      if (daysBetween(malo.clip.classDate, bueno.clip.classDate) < rules.DIAS_MIN) continue;
      if (bueno.nivel - malo.nivel < rules.MEJORA_CLIP_MIN) continue;
      return { malo, bueno };
    }
  }
  return null;
}
