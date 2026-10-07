// Testimoniales V5 — quién es el ALUMNO en un transcript, decidido por CÓDIGO.
//
// Módulo PURO (sin red ni base). Lo prueba lib/testimonialSpeaker.test.ts.
//
// Por qué (07/10/2026): con la V4 seguían saliendo clips de otra persona. La
// auditoría de las 95 parejas de "Por revisar" dio dos causas:
//   1. el emparejamiento de nombres era demasiado tolerante: bastaba UN nombre o
//      apellido en común ("Beatriz Martinez Garcia" ↔ "Bruno18 Casella
//      Martinez", "Joaquin Becerra" ↔ "sonia becerra", "Guillem Albert" ↔
//      "Francesc Albert");
//   2. se aceptaba como alumno el alias que más se repetía aunque no se pareciera
//      a su nombre ("Giselle G.G.", "Y", "MJ GC", "BLNNDNN"), y etiquetas que son
//      un email.
// Ahora la regla es estricta y, si no se puede decidir con seguridad, el
// transcript queda FUERA de los testimoniales (mejor perder un alumno que
// enseñar a otro):
//   · exactamente 2 hablantes;
//   · el profe es el ÚNICO que lleva "(email)" (así lo pone Fathom al organizador);
//   · el alumno es el otro, SIN email, y su etiqueta cuadra con el nombre del
//     alumno de la plataforma (nameMatchesStrict).

import { normName } from '@/lib/retention';
import { toSeconds, type Turn } from '@/lib/fluency';

export type LabelExclusion =
  | 'sin_formato_hablantes'   // no hay turnos "m:ss - Nombre" (p. ej. el resumen de Fathom pegado)
  | 'mas_de_dos_hablantes'
  | 'un_solo_hablante'
  | 'profe_sin_email'         // ningún hablante lleva email: no se sabe quién es el profe
  | 'dos_con_email'           // los dos llevan email
  | 'alumno_con_email'        // la etiqueta del alumno es (o contiene) un email
  | 'sin_nombre_alumno'       // la clase no tiene alumno de la plataforma
  | 'nombre_no_cuadra';       // la etiqueta no es el nombre del alumno de la plataforma

export const EXCLUSION_LABEL: Record<LabelExclusion, string> = {
  sin_formato_hablantes: 'Sin hablantes (no es un transcript de Fathom)',
  mas_de_dos_hablantes: 'Más de 2 personas',
  un_solo_hablante: 'Un solo hablante',
  profe_sin_email: 'Dos hablantes sin email (no se sabe quién es el profe)',
  dos_con_email: 'Los dos hablantes con email',
  alumno_con_email: 'El alumno aparece como un email',
  sin_nombre_alumno: 'La clase no tiene alumno',
  nombre_no_cuadra: 'El nombre en Fathom no es el del alumno',
};

export type LabelResult =
  | { ok: true; studentLabel: string; teacherLabel: string }
  | { ok: false; reason: LabelExclusion; speakers: string[] };

const EMAIL_IN_PARENS = /\([^()\s]+@[^()\s]+\)/;
const NAME_STOPWORDS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'guest', 'unverified']);

/** Palabras de un nombre: sin tildes, sin lo que va entre paréntesis ("(Guest)"), sin números. */
export function nameTokens(s: string | null | undefined): string[] {
  return normName(String(s ?? '').replace(/\([^()]*\)/g, ' '))
    .replace(/[^\p{L}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(t => t && !NAME_STOPWORDS.has(t));
}

/** "Max" ↔ "Maximiliano", "Patri" ↔ "Patricia": igual, o una empieza por la otra (3 letras o más). */
const sameName = (a: string, b: string): boolean =>
  a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

/**
 * ¿La etiqueta de Fathom es el nombre del alumno de la plataforma? Emparejamiento
 * tolerante pero estricto:
 *   · cada palabra completa (3+ letras) de la etiqueta se compara con las del
 *     nombre (igual, o abreviada: "Max" ↔ "Maximiliano");
 *   · las sueltas de 1-2 letras son iniciales y tienen que ser iniciales de su
 *     nombre ("Juan AM" ↔ "Juan Aparicio Martínez", "Saray g" ↔ "Saray García");
 *   · vale si TODAS las palabras completas cuadran (al menos una), o si cuadran
 *     dos o más y no sobran más de las que cuadran ("María Isabel García
 *     Vallina" ↔ "Isabel Vallina Garcia"; "José María Negrillo García Muñoz" ↔
 *     "José María Negrillo"; "Luz Lopez Lugilde" ↔ "Luz M. López Luigilde").
 * NO vale un solo nombre o apellido en común con otra palabra de sobra:
 * "Bruno Casella Martinez" ↔ "Beatriz Martinez Garcia", "sonia becerra" ↔
 * "Joaquin Becerra espinosa", "Alba Lopez" ↔ "Alba Coca".
 */
export function nameMatchesStrict(label: string | null | undefined, studentName: string | null | undefined): boolean {
  const labelTokens = nameTokens(label);
  const student = nameTokens(studentName);
  if (labelTokens.length === 0 || student.length === 0) return false;
  const full = labelTokens.filter(t => t.length >= 3);
  const initials = labelTokens.filter(t => t.length <= 2).flatMap(t => t.split(''));
  if (full.length === 0) return false;
  const matched = full.filter(t => student.some(s => sameName(t, s))).length;
  const extra = full.length - matched;
  const initialsOk = initials.every(ch => student.some(s => s.startsWith(ch)));
  if (!initialsOk || matched === 0) return false;
  return extra === 0 || (matched >= 2 && extra <= matched);
}

/** Etiqueta del alumno y del profe en un transcript, o por qué no se puede saber con seguridad. */
export function resolveStudentLabel(turns: Turn[], studentName: string | null | undefined): LabelResult {
  const speakers = [...new Set(turns.map(t => t.speaker))];
  const fail = (reason: LabelExclusion): LabelResult => ({ ok: false, reason, speakers });
  if (turns.length < 5) return fail('sin_formato_hablantes');
  if (speakers.length > 2) return fail('mas_de_dos_hablantes');
  if (speakers.length < 2) return fail('un_solo_hablante');
  const withEmail = speakers.filter(s => EMAIL_IN_PARENS.test(s));
  if (withEmail.length === 0) return fail('profe_sin_email');
  if (withEmail.length === 2) return fail('dos_con_email');
  const teacherLabel = withEmail[0];
  const studentLabel = speakers.find(s => s !== teacherLabel)!;
  if (/@/.test(studentLabel)) return fail('alumno_con_email');
  if (!nameTokens(studentName).length) return fail('sin_nombre_alumno');
  if (!nameMatchesStrict(studentLabel, studentName)) return fail('nombre_no_cuadra');
  return { ok: true, studentLabel, teacherLabel };
}

// ── Lo que ve la IA: SOLO las intervenciones del alumno ─────────────────────

/** Una intervención del alumno, con su número (el que la IA devuelve) y sus segundos. */
export interface StudentIntervention {
  /** 1, 2, 3… en orden. */
  n: number;
  /** Índice del turno en el transcript completo. */
  turnIndex: number;
  start: number;
  /** Inicio del turno siguiente (o el inicio + lo que dura leerlo, si es el último). */
  end: number;
  text: string;
  /** Última frase del profe justo antes, como contexto (null si el turno anterior no es del profe). */
  teacherBefore: string | null;
}

/** Última frase de un texto (para el contexto del profe), recortada. */
export function lastSentence(text: string, maxChars = 160): string {
  const parts = text.trim().split(/(?<=[.!?¿?])\s+/).filter(Boolean);
  const last = parts.at(-1) ?? text.trim();
  return last.length > maxChars ? `…${last.slice(-maxChars)}` : last;
}

export function studentInterventions(turns: Turn[], studentLabel: string): StudentIntervention[] {
  const out: StudentIntervention[] = [];
  turns.forEach((t, i) => {
    if (t.speaker !== studentLabel) return;
    const start = toSeconds(t.at);
    if (start == null) return;
    const next = toSeconds(turns[i + 1]?.at);
    const words = t.text.split(/\s+/).filter(Boolean).length;
    const end = next != null && next > start ? next : start + Math.ceil(words / 2.5);
    const prev = turns[i - 1];
    out.push({
      n: out.length + 1, turnIndex: i, start, end, text: t.text,
      teacherBefore: prev && prev.speaker !== studentLabel ? lastSentence(prev.text) : null,
    });
  });
  return out;
}

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * El texto para la IA. Cada intervención del alumno va numerada y con su tiempo;
 * la frase del profe va antes, marcada como NO ELEGIBLE:
 *   [PROFE - SOLO CONTEXTO, NO ELEGIBLE] What did you do at the weekend?
 *   #12 [8:20–8:41] I went to the beach with my family…
 * Las intervenciones de menos de 4 palabras ("yes", "ok") se saltan: no dan
 * para un clip y gastan tokens.
 */
export function formatInterventionsForAi(list: StudentIntervention[]): string {
  return list
    .filter(x => x.text.split(/\s+/).filter(Boolean).length >= 4)
    .map(x => [
      x.teacherBefore ? `[PROFE - SOLO CONTEXTO, NO ELEGIBLE] ${x.teacherBefore}` : null,
      `#${x.n} [${mmss(x.start)}–${mmss(x.end)}] ${x.text}`,
    ].filter(Boolean).join('\n'))
    .join('\n');
}
