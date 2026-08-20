// Detección de intentos de ESCRITURA no válidos, ANTES de llamar a la IA.
//
// Por qué existe: desde que la escritura se ancló a escala MCER absoluta
// (ver lib/evaluateWriting), un texto de relleno como "a a a a" ya no recibe 0.
// Recibe un A1 legítimo, porque en escala absoluta "esto demuestra un nivel
// mínimo" es literalmente cierto. El sistema pasó de rechazar la basura a
// puntuarla. Este filtro la rechaza otra vez, y de paso no gasta tokens: corre
// antes de la llamada a Haiku, no después.
//
// Este módulo es PURO: sin red, sin base, sin fecha. Todo lo que decide sale del
// texto que recibe. Sus tests viven en attemptValidity.test.ts.
//
// El filtro es la primera de DOS barreras. La segunda es `is_valid_attempt`, que
// la propia IA devuelve para el galimatías con forma de texto que este filtro no
// puede ver (frases bien puntuadas y variadas pero sin sentido, o texto copiado
// de la consigna). Ver lib/evaluateWriting.

export type InvalidReason =
  // ── Filtro determinista (este archivo) ──
  | 'low_diversity'     // palabras distintas / totales < 0,3
  | 'few_distinct'      // menos de 15 palabras distintas
  | 'no_sentence_end'   // ni un solo . ! ? …
  | 'word_dominance'    // una sola palabra supone más del 40% del texto
  // ── Segunda barrera y caída de la IA (los escribe answer/route) ──
  | 'ai_invalid'        // pasó el filtro, pero la IA lo marcó no válido
  | 'ai_unavailable';   // la IA no respondió. NO es culpa del alumno.

// Umbrales. Son la especificación, no una heurística que se pueda ajustar sola:
// si un texto A1 legítimo cae en el filtro, el que está mal es el umbral y se
// discute, no se toca a escondidas. El test lo vigila.
export const MIN_DIVERSITY_RATIO = 0.3;
export const MIN_DISTINCT_WORDS = 15;
export const MAX_WORD_SHARE = 0.4;

const SENTENCE_END = /[.!?…]/;

// Cualquier cosa que no sea letra, dígito o apóstrofo separa palabras. Unicode,
// para no partir en dos las palabras acentuadas si el alumno mezcla idiomas.
const WORD_SEPARATOR = /[^\p{L}\p{N}']+/u;

export interface AttemptStats {
  totalWords: number;
  distinctWords: number;
  diversityRatio: number;   // distintas / totales (0 si no hay palabras)
  topWord: string | null;   // la palabra más repetida
  topWordShare: number;     // qué fracción del texto ocupa esa palabra (0-1)
  hasSentenceEnd: boolean;
}

export interface AttemptValidity {
  valid: boolean;
  reason: InvalidReason | null;
  stats: AttemptStats;
}

// Palabras normalizadas: minúsculas y sin puntuación, para que "Hello," y
// "hello" cuenten como la misma. Los apóstrofos se conservan ("don't" es una
// palabra, no dos).
export function tokenizeWords(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(WORD_SEPARATOR)
    .filter(w => w.length > 0);
}

export function analyzeAttempt(text: string): AttemptStats {
  const words = tokenizeWords(text);
  const totalWords = words.length;

  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);

  let topWord: string | null = null;
  let topCount = 0;
  for (const [w, c] of counts) {
    if (c > topCount) { topWord = w; topCount = c; }
  }

  return {
    totalWords,
    distinctWords: counts.size,
    diversityRatio: totalWords > 0 ? counts.size / totalWords : 0,
    topWord,
    topWordShare: totalWords > 0 ? topCount / totalWords : 0,
    hasSentenceEnd: SENTENCE_END.test(text || ''),
  };
}

/**
 * ¿Es un intento de escritura real? No válido si se cumple CUALQUIERA de las
 * cuatro reglas. Se evalúan en el orden de la especificación y gana la primera:
 * `reason` es el motivo principal, no la lista entera.
 *
 * OJO con lo que esta función NO hace: no juzga el nivel ni la calidad. Un texto
 * A1 flojo, corto y lleno de errores es VÁLIDO — su nivel bajo ya lo refleja la
 * nota. Aquí solo se descarta lo que ni siquiera es un intento.
 */
export function checkWritingAttempt(text: string): AttemptValidity {
  const stats = analyzeAttempt(text);
  const fail = (reason: InvalidReason): AttemptValidity => ({ valid: false, reason, stats });

  // Sin palabras no hay nada que medir (el ratio sería 0/0). El endpoint ya
  // rechaza el texto vacío antes de llegar aquí; esto es por completitud.
  if (stats.totalWords === 0) return fail('few_distinct');

  if (stats.diversityRatio < MIN_DIVERSITY_RATIO) return fail('low_diversity');
  if (stats.distinctWords < MIN_DISTINCT_WORDS) return fail('few_distinct');
  if (!stats.hasSentenceEnd) return fail('no_sentence_end');
  if (stats.topWordShare > MAX_WORD_SHARE) return fail('word_dominance');

  return { valid: true, reason: null, stats };
}

// Texto para el PROFESOR (ficha del alumno y detalle del admin). Al alumno se le
// muestra siempre el mismo mensaje neutro, sea cual sea el motivo: si viera cuál
// regla saltó, aprendería a esquivarla.
export const INVALID_REASON_LABEL: Record<InvalidReason, string> = {
  low_diversity:   'Texto muy repetitivo (pocas palabras distintas sobre el total)',
  few_distinct:    'Vocabulario insuficiente (menos de 15 palabras distintas)',
  no_sentence_end: 'Sin ningún signo de puntuación de cierre de frase',
  word_dominance:  'Una sola palabra ocupa más del 40% del texto',
  ai_invalid:      'La IA lo marcó como galimatías o fuera de consigna',
  ai_unavailable:  'La IA no estaba disponible: la escritura quedó sin evaluar',
};
