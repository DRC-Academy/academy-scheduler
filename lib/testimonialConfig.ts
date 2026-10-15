// Testimoniales V6 — TODOS los umbrales y pesos de la detección por código.
//
// Un solo sitio para calibrar. Lo usa lib/testimonialScoring (módulo puro).
// Cambiar un valor aquí y volver a emparejar (`npm run testimonios -- --emparejar`)
// no necesita IA ni volver a leer los transcripts, salvo lo marcado "(extracción)",
// que pide reprocesar los transcripts (`--procesar ... --rehacer`).

// ── Distancia entre clips ────────────────────────────────────────────────────

/** Semanas mínimas entre la clase del clip A ("antes") y la del B ("después").
 *  Bajo a propósito (oct/2026): solo hay transcripts desde el 13/07/2026. Subirlo
 *  cuando haya más historial. Entre las parejas válidas gana la de MÁS semanas. */
export const MIN_SEMANAS_ENTRE_CLIPS = 4;

// ── Duración (extracción) ────────────────────────────────────────────────────
// Fathom solo da el minuto en que EMPIEZA cada intervención, y los alumnos hablan
// en intervenciones largas (de 1 a 3 minutos es normal). Por eso un clip es un
// RECORTE de frases seguidas dentro de una intervención: su segundo de inicio y
// de fin se estiman repartiendo la duración de la intervención por palabras
// (exacto solo si el recorte empieza o acaba con la intervención).

/** Segundos mínimos del clip A. */
export const MIN_DURACION_A_SEG = 5;
/** Segundos máximos del clip A: se recorta lo justo alrededor del bloqueo. */
export const MAX_DURACION_A_SEG = 15;
/** Segundos mínimos del clip B. Además el B tiene que durar MÁS que el A. */
export const MIN_DURACION_B_SEG = 8;
/** Segundos máximos del clip B: se alarga dentro de su intervención hasta aquí
 *  (o hasta que la intervención acabe), para que sea lo más largo posible. */
export const MAX_DURACION_B_SEG = 30;
/** Palabras mínimas de un clip. */
export const MIN_PALABRAS_CLIP = 6;
/** Recortes que se guardan por clase y por tipo (los mejores, sin solaparse). */
export const MAX_RECORTES_POR_CLASE = 6;

// ── Velocidad (palabras por minuto) ──────────────────────────────────────────
// No es un filtro: suma puntos. Se mide por INTERVENCIÓN (dentro de ella no hay
// tiempos) y se compara con el PROMEDIO del alumno (todas sus intervenciones de 5+
// palabras y hasta 120 s en sus clases válidas). Ojo: la duración de una
// intervención incluye el silencio hasta que habla el profe.

/** Referencia de la puntuación: el A que va a FACTOR_VELOCIDAD_A × su promedio
 *  (75 %) suma 1 punto de lentitud; al 50 % suma 2; al 25 %, 3. Simétrico para el
 *  B: al 125 % de su promedio suma 1 punto de rapidez; al 150 %, 2… */
export const FACTOR_VELOCIDAD_A = 0.75;
/** Peso de cada punto de lentitud del A y tope de esos puntos. */
export const PESO_LENTITUD_A = 1;
export const MAX_PUNTOS_LENTITUD_A = 3;
/** Peso de cada punto de rapidez del B y tope de esos puntos. */
export const PESO_RAPIDEZ_B = 1;
export const MAX_PUNTOS_RAPIDEZ_B = 3;
/** Segundos mínimos de habla del alumno para fiarse de su promedio. Con menos,
 *  la velocidad no suma ni resta. */
export const MIN_SEGUNDOS_PROMEDIO = 60;

// ── Puntuación de bloqueo (clip A) ───────────────────────────────────────────

/** "um", "uh", "ehh", "mm", "hmm", "em", "emm", "amm" (y alargadas: "ummm"). */
export const PESO_MULETILLA = 1;
/** "ah" y "eh" pesan menos: también son interjecciones. Si van seguidas de "ok",
 *  "yes", "right", "I see"… ("ah, ok") no cuentan nada. */
export const PESO_AH_EH = 0.5;
/** La misma palabra dos veces seguidas ("during during", "I, I, I" = 2). */
export const PESO_REPETICION = 1;
/** "how do you say", "I don't know how to say", "what's the word", "cómo se dice"… */
export const PESO_BUSQUEDA_PALABRA = 2;
/** Palabra suelta en español dentro de una intervención en inglés ("rencoroso, como…"). */
export const PESO_PALABRA_ESPANOL = 1;
/** Tope de palabras en español que puntúan en una intervención. */
export const MAX_PALABRAS_ESPANOL = 3;
/** Para ser A hace falta al menos este bloqueo SIN contar la lentitud: una frase
 *  limpia y completa no es un bloqueo por lenta que vaya. */
export const MIN_BLOQUEO_LINGUISTICO_A = 1;

// ── Clip B ("después") ───────────────────────────────────────────────────────

/** Bloqueo lingüístico máximo que admite un B (muletillas + repeticiones +
 *  palabras en español; cualquier búsqueda de palabra lo descarta). */
export const MAX_BLOQUEO_B = 1;
/** Descartar como B un recorte largo (50+ palabras) sin ninguna duda, por si es
 *  una lectura o algo preparado. Fathom deja pocas muletillas (≈5 cada 1.000
 *  palabras), así que esto tira también mucho B bueno: las lecturas ya las
 *  detecta la pista del profe ("read", "listen"…). */
export const DESCARTAR_B_SIN_DUDAS = false;
/** Signos "?" que admite un B. Con 1 se admite una pregunta que el alumno se hace
 *  a sí mismo ("What do I need? A subway card…"); 2 o más suele ser un enunciado
 *  de ejercicio leído en voz alta ("Can you describe a photo? What are they wearing?"). */
export const MAX_PREGUNTAS_B = 1;
/** El B tiene que estar en primera persona (I, my, me, we, our…): el testimonio
 *  es el alumno hablando de sí mismo, no leyendo un texto ajeno. Desactivado: 2 de
 *  las 8 "Sirve" (oct/2026) hablan en general ("you have solar…"). */
export const B_EN_PRIMERA_PERSONA = false;
