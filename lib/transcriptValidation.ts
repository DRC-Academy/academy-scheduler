// CAPA 1 — Validación estructural del transcript (Bloque 1, detección de
// transcripciones falsas). Función PURA: no toca la base ni la red. Analiza SOLO
// el texto y devuelve una confianza 0-100 de que procede de una grabación real
// (Fathom) y no de un modelo generativo.
//
// Umbrales (relajados el 27/07/2026 — ver nota):
//   score >= 60           → válido, sin alerta
//   score 15-59           → válido, pero marcado para revisión del admin
//   score < 15            → señal máxima: se guarda igual y va a revisión
//
// NOTA IMPORTANTE — el validador NUNCA impide guardar la clase.
// Antes, un score < 35 cancelaba el guardado y el profesor perdía el registro.
// Transcripciones REALES de Fathom caen ahí sin ser falsas: sin marcas de tiempo
// (el profe copia solo el texto), clases cortas, o un pegado parcial. Ahora el
// score solo decide si la clase va directa a pagable (>= 60 y sin flags) o queda
// pendiente de validación del equipo. El caso < 15 se conserva como severidad
// máxima en el aviso al admin, no como bloqueo.
//
// La lógica es deliberadamente conservadora: los marcadores positivos son cosas
// que una IA rara vez reproduce (timestamps, muletillas, frases cortadas), y los
// negativos son marcas típicas de texto generado (markdown, prosa perfecta,
// lenguaje de resumen).

export interface ValidationResult {
  valid: boolean;
  score: number;        // 0-100, confianza de que es real
  flags: string[];      // señales sospechosas detectadas
  reason: string;
  /** Último timestamp detectado en minutos (para la coherencia de duración, capa 2). */
  lastTimestampMinutes: number | null;
  /** Nº de timestamps detectados (diagnóstico). */
  timestampCount: number;
}

const SCORE_BASE = 50;

// ── Señales compartidas con el aviso previo del modal ─────────────────────────
// El modal de "Añadir transcript" avisa al profesor ANTES de guardar cuando el
// texto tiene la pinta del RESUMEN de Fathom en vez de la transcripción. Para que
// ese aviso y esta validación no puedan discrepar, los dos umbrales viven acá y
// los usan las dos: si el modal usara sus propios números, avisaría de cosas que
// el validador acepta (o peor, callaría ante las que manda a revisión).

/** Marcas de tiempo tipo 0:00 / 12:34 / 1:05:22. */
export const TIMESTAMP_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

/** Palabras mínimas esperables para una clase de esa duración. */
export function minWordsFor(durationMinutes: number): number {
  return durationMinutes >= 60 ? 800 : durationMinutes >= 30 ? 400 : 200;
}

export interface QuickCheck {
  words: number;
  timestamps: number;
  minWords: number;
  tooShort: boolean;
  noTimestamps: boolean;
  /**
   * Las dos señales a la vez. En la práctica es la firma del resumen de Fathom:
   * un texto redactado, corto y sin marcas de tiempo. Es lo que llenó la cola de
   * revisión con clases que el profesor daba por entregadas.
   */
  looksLikeSummary: boolean;
}

/**
 * Comprobación BARATA del texto, para avisar mientras el profesor lo pega. No
 * decide nada: la validación de verdad (score + flags) corre en el servidor al
 * guardar. Acá solo se miran las dos señales que puede corregir en el momento.
 */
export function quickTranscriptCheck(
  transcript: string,
  opts: { durationMinutes?: number } = {},
): QuickCheck {
  const text = (transcript ?? '').trim();
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const timestamps = (text.match(TIMESTAMP_RE) ?? []).length;
  const minWords = minWordsFor(opts.durationMinutes ?? 60);
  const tooShort = words > 0 && words < minWords;
  const noTimestamps = words > 0 && timestamps === 0;
  return { words, timestamps, minWords, tooShort, noTimestamps, looksLikeSummary: tooShort && noTimestamps };
}

/** Por debajo de esto la señal es máxima (aviso severo al admin). NO bloquea. */
export const SCORE_SEVERE = 15;
/**
 * Score a partir del cual una clase limpia se APRUEBA SOLA, sin pasar por el
 * admin. Vive acá y no en transcriptVerdict.ts a propósito: este módulo es PURO
 * (sin un solo import), así que lo puede leer tanto el servidor como la pestaña
 * de Validación del admin, que es un componente cliente.
 *
 * Importarlo desde transcriptVerdict.ts arrastraba al navegador la cadena
 * transcriptVerdict → verifyTranscriptAI → anthropic → `new Anthropic(...)`,
 * y el SDK lanza al detectar un entorno de navegador: rompía la app entera
 * después del login (29/07/2026).
 */
export const SCORE_AUTO_APPROVE = 80;
/** A partir de acá la clase puede ir directa a pagable (si no hay flags). */
export const SCORE_CLEAN = 60;

// Muletillas / marcas de habla natural (inglés + español).
const FILLERS = [
  'um', 'uh', 'you know', 'i mean', 'like,', 'eh', 'o sea',
  '¿sabes?', 'sabes?', 'bueno,', 'mmm',
];

// Autocorrecciones.
const SELF_CORRECTIONS = ['perdón', 'perdon', 'quería decir', 'queria decir', 'sorry, i mean', 'no, espera'];

// Frases de resumen generado (por TIPO — cada tipo detectado resta 15).
const SUMMARY_PHRASES = [
  'en resumen', 'en conclusión', 'en conclusion', 'a continuación', 'a continuacion',
  'in summary', 'overall', 'key points', 'objetivos:',
];

// Etiquetas legibles en español de cada flag (para el panel del admin).
export const FLAG_LABELS: Record<string, string> = {
  formato_markdown:        'Formato Markdown (encabezados/listas/negritas)',
  sin_timestamps:          'Sin marcas de tiempo',
  prosa_demasiado_limpia:  'Prosa demasiado limpia (frases largas y perfectas)',
  sin_habla_natural:       'Sin muletillas ni habla natural',
  lenguaje_de_resumen:     'Lenguaje de resumen generado',
  demasiado_corto:         'Demasiado corto para la duración de la clase',
  alternancia_artificial:  'Alternancia profesor/alumno artificialmente perfecta',
  sin_acceso_registrado:   'Sin acceso registrado por el botón "Ingresar a clase"',
  duracion_insuficiente:   'Duración insuficiente según las marcas de tiempo',
  registro_tardio:         'Registrado más de 7 días después de la clase',
  alta_similitud:          'Muy similar a otra transcripción reciente del profesor',
  ia_no_autentico:         'La IA la considera probablemente generada',
};

export function flagLabel(flag: string): string {
  return FLAG_LABELS[flag] ?? flag;
}

/**
 * Señales INFORMATIVAS: se calculan, se guardan y las ve el admin, pero NO
 * mandan la clase a revisión por sí solas ni le dicen nada al profesor.
 *
 * `alta_similitud` está acá desde julio de 2026. Compara por shingles contra las
 * últimas 5 transcripciones del profesor SIN mirar de qué alumno son, así que un
 * profe con varias clases del mismo nivel superaba el umbral del 35% de rutina y
 * la clase iba a "a revisar" sin motivo. Sigue viva porque es la única señal que
 * detecta un transcript reciclado de otra clase — pero como pista para el admin,
 * no como veredicto.
 */
export const INFO_ONLY_FLAGS = new Set<string>(['alta_similitud']);

/**
 * Señales que hablan de NUESTRO REGISTRO, no del transcript.
 *
 * `sin_acceso_registrado` no dice nada del texto: dice que no encontramos un
 * class_join_log que cuadre. Pasa constantemente cuando el profesor entra por el
 * enlace directo de Meet en vez de pulsar "Ingresar a clase", y también cuando la
 * clase se movió de día (la búsqueda tolera ±1 día). Lo mismo `registro_tardio`:
 * subir el transcript tarde no lo hace falso.
 *
 * Estas señales siguen viéndose en el panel y siguen mandando a revisión una
 * clase con estructura dudosa. Lo que ya NO hacen es retener una transcripción
 * impecable: ver la regla de auto-aprobación en decideTranscript().
 */
export const RECORD_ONLY_FLAGS = new Set<string>(['sin_acceso_registrado', 'registro_tardio']);

/** Señales que SÍ pesan en la decisión (todo lo que no sea informativo). */
export function decisiveFlags(flags: string[]): string[] {
  return flags.filter(f => !INFO_ONLY_FLAGS.has(f));
}

/**
 * Señales que cuestionan el CONTENIDO del transcript: que sea generado, corto,
 * sin habla natural… Es lo único que puede impedir que una transcripción con
 * estructura perfecta se apruebe sola.
 */
export function contentFlags(flags: string[]): string[] {
  return flags.filter(f => !INFO_ONLY_FLAGS.has(f) && !RECORD_ONLY_FLAGS.has(f));
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

// Convierte "1:05:22" o "12:34" a minutos (número). Devuelve null si no parsea.
function tsToMinutes(ts: string): number | null {
  const parts = ts.split(':').map(n => parseInt(n, 10));
  if (parts.some(n => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
  if (parts.length === 2) return parts[0] + parts[1] / 60;
  return null;
}

export function validateTranscriptStructure(
  transcript: string,
  opts: { durationMinutes?: number } = {},
): ValidationResult {
  const text = (transcript ?? '').trim();
  const lower = text.toLowerCase();
  const lines = text.split(/\r?\n/);
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const durationMinutes = opts.durationMinutes ?? 60;

  let score = SCORE_BASE;
  const flags: string[] = [];

  // ── MARCADORES POSITIVOS ────────────────────────────────────────────────────

  // Timestamps tipo 0:00 / 12:34 / 1:05:22 (misma expresión que el aviso del modal).
  const tsMatches = text.match(TIMESTAMP_RE) ?? [];
  const timestampCount = tsMatches.length;
  if (timestampCount >= 10) score += 30;
  else if (timestampCount >= 3) score += 15;

  // Último timestamp en minutos (para la capa 2, coherencia de duración).
  let lastTimestampMinutes: number | null = null;
  for (const ts of tsMatches) {
    const m = tsToMinutes(ts);
    if (m != null && (lastTimestampMinutes == null || m > lastTimestampMinutes)) lastTimestampMinutes = m;
  }

  // Etiquetas de hablante repetidas: "Nombre:" al inicio de línea (mín. 15).
  const speakerLineRe = /^\s*([\p{Lu}][\p{L}.'-]*(?:\s[\p{L}.'-]+){0,3})\s*:/u;
  const speakers: string[] = [];
  for (const ln of lines) {
    const m = ln.match(speakerLineRe);
    if (m) speakers.push(m[1].trim().toLowerCase());
  }
  if (speakers.length >= 15) score += 20;

  // Muletillas / habla natural (total de apariciones).
  let fillerHits = 0;
  for (const f of FILLERS) {
    fillerHits += countMatches(lower, new RegExp(escapeRe(f), 'g'));
  }
  if (fillerHits >= 8) score += 20;

  // Frases incompletas / cortadas: línea que termina sin puntuación y la siguiente
  // continúa con minúscula.
  let cutPhrases = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i].trim();
    const nxt = lines[i + 1].trim();
    if (!cur || !nxt) continue;
    const endsNoPunct = !/[.!?…:]$/.test(cur);
    const nextLower = /^[a-záéíóúñ]/.test(nxt);
    if (endsNoPunct && nextLower) cutPhrases++;
  }
  if (cutPhrases >= 5) score += 15;

  // Autocorrecciones.
  const hasSelfCorrection = SELF_CORRECTIONS.some(s => lower.includes(s));
  if (hasSelfCorrection) score += 10;

  // ── MARCADORES NEGATIVOS ────────────────────────────────────────────────────

  // Estructura Markdown: encabezados (#), listas (-/*), **negrita**.
  const hasHeading = /^\s{0,3}#{1,6}\s/m.test(text);
  const hasBullets = (text.match(/^\s*[-*]\s+\S/gm) ?? []).length >= 3;
  const hasBold    = /\*\*[^*\n]+\*\*/.test(text);
  if (hasHeading || hasBullets || hasBold) {
    score -= 30;
    flags.push('formato_markdown');
  }

  // Ausencia total de timestamps.
  if (timestampCount === 0) {
    score -= 25;
    flags.push('sin_timestamps');
  }

  // Prosa demasiado limpia: media de longitud de frase > 25 palabras.
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.split(/\s+/).length >= 2);
  const avgSentenceWords = sentences.length
    ? sentences.reduce((s, x) => s + x.split(/\s+/).filter(Boolean).length, 0) / sentences.length
    : 0;
  if (avgSentenceWords > 25) {
    score -= 20;
    flags.push('prosa_demasiado_limpia');
  }

  // Ausencia total de muletillas.
  if (fillerHits === 0) {
    score -= 20;
    flags.push('sin_habla_natural');
  }

  // Lenguaje de resumen generado (−15 por cada TIPO detectado).
  const summaryTypes = SUMMARY_PHRASES.filter(p => lower.includes(p));
  if (summaryTypes.length > 0) {
    score -= 15 * summaryTypes.length;
    flags.push('lenguaje_de_resumen');
  }

  // Longitud insuficiente para la duración (mismo umbral que el aviso del modal).
  const minWords = minWordsFor(durationMinutes);
  if (wordCount < minWords) {
    score -= 25;
    flags.push('demasiado_corto');
  }

  // Alternancia perfecta profesor/alumno: si hay diálogo etiquetado (≥10 turnos)
  // con exactamente 2 hablantes y NUNCA dos turnos seguidos del mismo → artificial.
  const distinctSpeakers = new Set(speakers);
  if (speakers.length >= 10 && distinctSpeakers.size === 2) {
    let consecutiveSame = false;
    for (let i = 1; i < speakers.length; i++) {
      if (speakers[i] === speakers[i - 1]) { consecutiveSame = true; break; }
    }
    if (!consecutiveSame) {
      score -= 15;
      flags.push('alternancia_artificial');
    }
  }

  // ── Límites y veredicto ─────────────────────────────────────────────────────
  score = Math.max(0, Math.min(100, Math.round(score)));

  // `valid` = no necesita revisión. Nunca se usa para impedir el guardado.
  const valid = score >= SCORE_CLEAN;
  const reason =
    score >= SCORE_CLEAN ? 'La estructura del texto es coherente con una transcripción real de Fathom.'
    : score >= SCORE_SEVERE ? 'La estructura presenta señales dudosas; se marca para revisión del equipo.'
    : 'La estructura no se parece a una transcripción de Fathom; se marca para revisión del equipo.';

  return { valid, score, flags, reason, lastTimestampMinutes, timestampCount };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
