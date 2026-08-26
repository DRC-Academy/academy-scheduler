// Derivación de la bandeja de validación (pestaña "Validación" del admin).
//
// Todo lo que se puede calcular sin React vive acá: motivo, filtrado, orden,
// agrupado y los "datos de la clase" del desplegable. El componente solo pinta.
//
// De dónde sale cada dato (importa, porque el diseño pide campos que la base no
// siempre tiene y aquí se ve exactamente qué es real):
//
//   · score               → class_analyses.transcript_validation_score
//   · texto de la alerta  → FLAG_LABELS del flag dominante (LITERAL, sin reescribir)
//   · motivo              → se deduce del flag dominante (ver MOTIVO_OF)
//   · duración contratada → validation_details.durationExpectedMin. Solo se conoce
//                           al registrar la clase; en las filas anteriores a
//                           supabase-validation-details.sql NO existe y se
//                           muestra "sin dato" en vez de suponer 60.
//   · duración registrada → validation_details.durationRecordedMin y, si falta,
//                           el último timestamp del propio transcript (derivable).
//   · marcas de tiempo    → validation_details.timestampCount y, si falta, se
//                           cuentan sobre el transcript.
//   · acceso por botón    → validation_details.hasAccess / class_analyses.join_log_id
//                           y, si faltan, el flag 'sin_acceso_registrado'.
//   · alumno confirmó     → NO EXISTE en el sistema. No hay ninguna confirmación
//                           del alumno en ninguna tabla, así que se muestra
//                           siempre "sin registro". Ver nota en classDataOf().

import type { FlaggedTranscript } from '@/lib/db';
// La misma normalización de la bandeja de riesgo: la búsqueda de las dos
// pestañas tiene que tratar "Sebastián" y "sebastian" igual.
import { fold } from '@/lib/riskInbox';
import {
  FLAG_LABELS, TIMESTAMP_RE, flagLabel, SCORE_SEVERE, SCORE_AUTO_APPROVE,
} from '@/lib/transcriptValidation';

// ── Motivo ───────────────────────────────────────────────────────────────────
export type Motivo = 'duracion' | 'resumen' | 'acceso' | 'otras';

export interface MotivoStyle {
  /** Texto del chip. */
  chip: string;
  /** Título del grupo: el texto de la alerta más representativa del motivo. */
  titulo: string;
  bg: string; bd: string; fg: string; accent: string;
  /** Una o dos frases que explican qué significa, en el desplegable. */
  explicacion: string;
}

export const MOTIVO: Record<Motivo, MotivoStyle> = {
  acceso: {
    chip: 'Acceso',
    titulo: FLAG_LABELS.sin_acceso_registrado,
    bg: '#fdf5e4', bd: '#eddfb6', fg: '#8a5f0a', accent: '#e0a92b',
    explicacion:
      'El score valora el contenido de la clase; esta alerta solo dice que no hay registro de entrada ' +
      'por el botón. Suele pasar cuando el profesor entra desde el enlace directo.',
  },
  resumen: {
    chip: 'Resumen',
    titulo: FLAG_LABELS.lenguaje_de_resumen,
    bg: '#eef2f6', bd: '#d8e1e9', fg: '#46586a', accent: '#8ba0b3',
    explicacion:
      'El resumen de la clase tiene marcadores de texto generado. No implica que la clase no se haya ' +
      'dado: revisa el detalle antes de decidir.',
  },
  duracion: {
    chip: 'Duración',
    titulo: 'Duración por debajo de lo esperado',
    bg: '#fdeeec', bd: '#f3cfca', fg: '#a52b23', accent: '#cf3a30',
    explicacion:
      'Las marcas de tiempo no cubren la duración contratada de la clase. Es el motivo con más ' +
      'rechazos históricos.',
  },
  // Cuarto grupo, fuera del diseño: la validación produce doce señales y el
  // diseño solo nombra tres. Meter "registro tardío" o "muy similar a otra clase"
  // dentro de "Resumen" sería mentir sobre el motivo, así que caen acá con estilo
  // neutro. Como los grupos vacíos no se pintan, solo aparece si de verdad hay
  // alguna. También recoge las clases mandadas a revisión por score bajo sin
  // ninguna señal concreta.
  otras: {
    chip: 'Otras',
    titulo: 'Otras señales de la validación',
    bg: '#f2f4f1', bd: '#e6e9e4', fg: '#5c6a62', accent: '#9aa79f',
    explicacion:
      'La clase quedó marcada por una señal que no encaja en los tres motivos habituales, o por un ' +
      'score bajo sin ninguna señal concreta. El texto de la alerta dice cuál.',
  },
};

/**
 * Motivo de cada señal. El orden del array manda cuando una clase trae varias:
 * gana el motivo MÁS comprometido, no el más frecuente.
 *
 * Por qué duración va primero: es el motivo con más rechazos históricos, y el
 * grupo de "Acceso" es el que se aprueba en lote. Si una clase corta que además
 * no registró acceso cayera en "Acceso", un "Aprobar las 4" la daría por buena
 * sin que nadie hubiera mirado su duración.
 */
const MOTIVO_OF: Array<[Motivo, string[]]> = [
  ['duracion', ['demasiado_corto', 'duracion_insuficiente']],
  ['resumen',  ['lenguaje_de_resumen', 'formato_markdown', 'prosa_demasiado_limpia',
                'sin_habla_natural', 'sin_timestamps', 'alternancia_artificial', 'ia_no_autentico']],
  ['acceso',   ['sin_acceso_registrado']],
];

/** Los cuatro grupos, en el orden en que se pintan. */
export const MOTIVO_ORDER: Motivo[] = ['acceso', 'resumen', 'duracion', 'otras'];

/** Flag dominante de la clase: el primero del motivo que gana. null si no hay. */
export function dominantFlag(flags: string[]): string | null {
  for (const [, own] of MOTIVO_OF) {
    const hit = own.find(f => flags.includes(f));
    if (hit) return hit;
  }
  return flags[0] ?? null;
}

export function motivoOf(flags: string[]): Motivo {
  for (const [motivo, own] of MOTIVO_OF) {
    if (own.some(f => flags.includes(f))) return motivo;
  }
  return 'otras';
}

/**
 * Texto EXACTO de la alerta, tal cual lo define FLAG_LABELS. Es lo que va en la
 * fila y en el desplegable: dentro del grupo "Duración" conviven "Demasiado
 * corto para la duración de la clase" y "Duración insuficiente según las marcas
 * de tiempo", y el admin necesita saber cuál de las dos saltó.
 */
export function alertTextOf(flags: string[]): string {
  const f = dominantFlag(flags);
  return f
    ? flagLabel(f)
    : 'Sin señales concretas: el score quedó por debajo del umbral de validación';
}

// ── Fila de la bandeja ───────────────────────────────────────────────────────
export interface ValRow {
  id: string;
  studentName: string;
  teacherId: string | null;
  teacherName: string;
  /** Fecha de la clase (o, si no la hay, la del análisis). */
  date: string | null;
  score: number | null;
  motivo: Motivo;
  alertText: string;
  flags: string[];
  status: string;
  reviewedBy: string | null;
  /**
   * La clase está aprobada ('ok', contando para el pago) y la verificación
   * tardía encontró algo DESPUÉS de guardarla. No se despaga sola —eso dejó de
   * ocurrir—, pero entra en la cola para que alguien la mire.
   */
  lateFinding: boolean;
  /** La fila original: el desplegable necesita transcript y detalles. */
  src: FlaggedTranscript;
}

export function toRow(r: FlaggedTranscript, teacherName: string): ValRow {
  return {
    id: r.id,
    studentName: r.studentName,
    teacherId: r.teacherId,
    teacherName,
    date: r.classDate ?? r.analyzedAt,
    score: r.score,
    motivo: motivoOf(r.flags),
    alertText: alertTextOf(r.flags),
    flags: r.flags,
    status: r.validationStatus,
    reviewedBy: r.reviewedBy,
    lateFinding: r.lateFinding,
    src: r,
  };
}

/** Las "muy dudosas" no son un estado aparte: son las pendientes de score < 15. */
export const esMuyDudosa = (r: { status: string; score: number | null }): boolean =>
  r.status === 'review' && r.score != null && r.score < SCORE_SEVERE;

// ── Filtros ──────────────────────────────────────────────────────────────────
export interface Filters { q: string; prof: string }

export function isFiltering(f: Filters): boolean {
  return f.q.trim() !== '' || f.prof !== 'todos';
}

export function matches(r: ValRow, f: Filters): boolean {
  const q = fold(f.q);
  if (q && !fold(`${r.studentName} ${r.teacherName}`).includes(q)) return false;
  if (f.prof !== 'todos' && r.teacherId !== f.prof) return false;
  return true;
}

// ── Orden ────────────────────────────────────────────────────────────────────
export type SortKey = 'score' | 'fecha' | 'prof';

const ts = (iso: string | null): number => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).getTime() || 0 : 0);

/**
 * Por defecto, score más bajo arriba: lo más dudoso primero. Los empates se
 * rompen siempre igual (fecha y luego nombre) para que el orden sea estable y
 * las filas no bailen al aprobar una.
 *
 * Las clases sin score van al final del orden por score: un null no es un cero.
 */
export function sortRows(rows: ValRow[], sort: SortKey): ValRow[] {
  const out = [...rows];
  out.sort((a, b) => {
    if (sort === 'score') {
      const x = a.score ?? Infinity, y = b.score ?? Infinity;
      if (x !== y) return x - y;
    }
    if (sort === 'fecha' && ts(b.date) !== ts(a.date)) return ts(b.date) - ts(a.date);
    if (sort === 'prof') {
      const c = a.teacherName.localeCompare(b.teacherName, 'es');
      if (c !== 0) return c;
    }
    return ts(b.date) - ts(a.date) || a.studentName.localeCompare(b.studentName, 'es');
  });
  return out;
}

/** Grupos NO vacíos, en el orden de MOTIVO_ORDER. Se calcula sobre lo filtrado. */
export function groupByMotivo(rows: ValRow[]): Array<{ motivo: Motivo; rows: ValRow[] }> {
  return MOTIVO_ORDER
    .map(motivo => ({ motivo, rows: rows.filter(r => r.motivo === motivo) }))
    .filter(g => g.rows.length > 0);
}

// ── Score ────────────────────────────────────────────────────────────────────
export { SCORE_SEVERE, SCORE_AUTO_APPROVE };

/** Verde ≥ 80 · ámbar 15-79 · rojo < 15. Los umbrales son los de la validación. */
export function scoreColor(score: number | null): string {
  if (score == null) return '#9aa79f';
  if (score >= SCORE_AUTO_APPROVE) return '#157f3d';
  return score >= SCORE_SEVERE ? '#a97410' : '#b8332a';
}

// ── Datos de la clase (desplegable) ──────────────────────────────────────────
export interface DataPair { k: string; v: string; muted?: boolean }

const SIN_DATO = 'sin dato';

/** Minutos → "47 min" / "1 h 12 min". */
function minutesLabel(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return SIN_DATO;
  const total = Math.round(min);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Último timestamp del transcript, en minutos. null si no hay ninguno. */
export function lastTimestampMinutes(transcript: string): number | null {
  const matched = (transcript ?? '').match(TIMESTAMP_RE);
  if (!matched) return null;
  let best: number | null = null;
  for (const t of matched) {
    const parts = t.split(':').map(n => parseInt(n, 10));
    if (parts.some(n => Number.isNaN(n))) continue;
    const min = parts.length === 3 ? parts[0] * 60 + parts[1] + parts[2] / 60
      : parts.length === 2 ? parts[0] + parts[1] / 60
      : null;
    if (min != null && (best == null || min > best)) best = min;
  }
  return best;
}

export function timestampCount(transcript: string): number {
  return ((transcript ?? '').match(TIMESTAMP_RE) ?? []).length;
}

/** Señales que hablan del texto en sí (lo que el diseño llama "Resumen"). */
const RESUMEN_FLAGS = MOTIVO_OF[1][1];

/**
 * Los seis pares del desplegable. Ningún valor se inventa: lo que la base no
 * guarda sale como "sin dato" / "sin registro", en gris.
 *
 * `validation_details` es la fuente buena (la escribe el guardado, con la
 * duración contratada incluida). Las filas anteriores a esa migración caen al
 * transcript, que sí permite recalcular marcas de tiempo y duración registrada
 * porque son función pura del texto.
 *
 * "Alumno confirmó" no tiene fuente NINGUNA: el sistema no pide confirmación al
 * alumno en ningún punto del flujo. Se deja el par porque el diseño lo pide y su
 * ausencia también informa, pero no se rellena con nada.
 */
export function classDataOf(r: FlaggedTranscript): DataPair[] {
  const d = r.details;

  const recorded = d?.durationRecordedMin ?? lastTimestampMinutes(r.transcript);
  const stamps = d?.timestampCount ?? timestampCount(r.transcript);

  // El acceso se sabe por tres vías, de más a menos fiable: el detalle guardado,
  // el enlace directo al class_join_log y, de último, la ausencia del flag.
  const access = d?.hasAccess ?? (r.joinLogId ? true : !r.flags.includes('sin_acceso_registrado'));

  const resumenHits = r.flags.filter(f => RESUMEN_FLAGS.includes(f));

  return [
    { k: 'Duración registrada', v: minutesLabel(recorded), muted: recorded == null },
    { k: 'Duración contratada', v: minutesLabel(d?.durationExpectedMin), muted: d?.durationExpectedMin == null },
    { k: 'Marcas de tiempo',    v: stamps === 0 ? 'ninguna' : String(stamps), muted: stamps === 0 },
    { k: 'Acceso por botón',    v: access ? 'sí' : 'no', muted: !access },
    {
      k: 'Resumen',
      v: resumenHits.length === 0 ? 'sin señales' : resumenHits.map(flagLabel).join(' · '),
      muted: resumenHits.length === 0,
    },
    { k: 'Alumno confirmó', v: 'sin registro', muted: true },
  ];
}

// ── Etiquetas ────────────────────────────────────────────────────────────────
export function formatRowDate(iso: string | null): string {
  if (!iso) return 'sin fecha';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return isNaN(d.getTime())
    ? 'sin fecha'
    : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** "Clase de Ana aprobada." · "4 clases aprobadas." */
export function toastFor(decision: 'approved' | 'rejected', names: string[]): string {
  const verb = decision === 'approved' ? 'aprobada' : 'rechazada';
  if (names.length === 1) return `Clase de ${names[0]} ${verb}.`;
  return `${names.length} clases ${verb}s.`;
}
