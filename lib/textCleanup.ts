// Limpieza de guiones en los textos generados por IA.
//
// La IA usa guiones largos (—) y medios (–) como conectores de frase todo el
// tiempo. No es natural en español y no encaja con el estilo de DRC. La defensa
// es doble:
//   1. NO_DASH_RULES → se inyecta en TODOS los system prompts (lib/anthropic.ts
//      lo añade automáticamente).
//   2. cleanAiText / cleanAiDeep → limpian la respuesta antes de guardarla. Se
//      aplican una sola vez, en askClaudeJson, así ningún endpoint se olvida.
//
// QUÉ NO SE ROMPE (hay tests en el propio archivo de checks del proyecto):
//   · Palabras compuestas: "warm-up", "role-play", "e-mail" → el guión NO lleva
//     espacios alrededor, y las reglas exigen espacio a los dos lados.
//   · Rangos numéricos y horarios: "16:00 - 17:00", "5 - 10 minutos" → se
//     protegen antes de limpiar y se restauran al final.
//   · Viñetas: "- item" al principio de línea → las reglas usan espacio
//     HORIZONTAL ([ \t]), nunca \s, así que un salto de línea no cuenta como
//     "espacio antes del guión".
//   · Saltos de línea y párrafos: solo se colapsan espacios horizontales; los
//     \n se respetan (máximo dos seguidos).
//   · Puntos suspensivos: se protegen para que la limpieza de puntos dobles no
//     los destroce.
//   · URLs y slugs ("https://a.com/mi-slug"): sin espacios alrededor del guión.

/** Bloque de estilo que se inyecta en todos los system prompts. */
export const NO_DASH_RULES = `REGLAS DE ESTILO OBLIGATORIAS:
- NO uses guiones largos (—) ni guiones medios (–) en ningún texto. Están completamente prohibidos.
- NO uses guiones (-) como conectores de frase ni para añadir información. En su lugar, usa punto y seguido, coma, dos puntos o paréntesis según corresponda.
- Ejemplo incorrecto: "Mejora la fluidez — sobre todo en speaking".
- Ejemplo correcto: "Mejora la fluidez, sobre todo en speaking" o "Mejora la fluidez. Sobre todo en speaking".
- Los guiones solo están permitidos dentro de palabras compuestas propias del idioma (por ejemplo "warm-up", "role-play") y en rangos numéricos u horarios.
- Escribe en un estilo natural y directo, como lo haría una persona escribiendo en español, sin recurrir a guiones para conectar ideas.
- Esta regla vale también para el contenido en inglés: nada de em dashes en el material del alumno.`;

// Marcador interno de los fragmentos protegidos. Es un carácter de control: no
// aparece nunca en un texto real y las reglas de espacios no lo tocan.
const MARK = '\u0000';

// Rangos numéricos/horarios: 16:00 - 17:00, 5 - 10, 2020 – 2021.
const NUMERIC_RANGE = /(\d)[ \t]*[-–—][ \t]*(\d)/g;
// Puntos suspensivos, en sus dos formas.
const ELLIPSIS = /\.{3}|…/g;

/**
 * Limpia guiones usados como conectores en un texto generado por IA.
 * Devuelve el texto tal cual si viene vacío o no es una cadena.
 */
export function cleanAiText(text: string): string {
  if (!text || typeof text !== 'string') return text;

  const kept: string[] = [];
  const keep = (s: string): string => `${MARK}${kept.push(s) - 1}${MARK}`;

  let out = text
    // ── Proteger lo que NO se toca ──
    .replace(NUMERIC_RANGE, (m) => keep(m))
    .replace(ELLIPSIS, (m) => keep(m))

    // ── Guión largo como conector: punto y seguido ──
    // El espacio es HORIZONTAL: así una viñeta "\n— item" no se pega a la línea
    // anterior. Se pone en mayúscula la letra siguiente, que ahora abre frase.
    .replace(/[ \t]+—[ \t]+([a-záéíóúüñ])?/g, (_m, c: string | undefined) =>
      c ? `. ${c.toUpperCase()}` : '. ')

    // ── Guión medio y guión normal como conectores: coma ──
    .replace(/[ \t]+–[ \t]+/g, ', ')
    .replace(/[ \t]+-[ \t]+/g, ', ')

    // ── Guiones largos/medios sueltos (pegados a palabra) ──
    // Se sustituyen por un espacio, NO se borran: borrarlos pegaría dos palabras
    // ("progresa—bien" → "progresabien").
    .replace(/[—–]/g, ' ')

    // ── Arreglar los artefactos que dejan las sustituciones ──
    .replace(/[ \t]{2,}/g, ' ')            // dobles espacios (sin tocar los \n)
    .replace(/[ \t]+([.,;:!?])/g, '$1')    // espacio antes de puntuación
    .replace(/\.{2,}/g, '.')               // "fluidez.. Sobre" → "fluidez. Sobre"
    .replace(/,{2,}/g, ',')
    .replace(/[,;:][ \t]*\./g, '.')        // "fluidez,. Sobre" → "fluidez. Sobre"
    .replace(/\.[ \t]*,/g, '.')
    .replace(/,[ \t]*;/g, ';')
    .replace(/\n{3,}/g, '\n\n')            // como mucho una línea en blanco
    .replace(/[ \t]+\n/g, '\n')            // espacios al final de línea
    .trim();

  // ── Restaurar lo protegido ──
  out = out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_m, i: string) => kept[Number(i)] ?? '');
  return out;
}

/**
 * Aplica cleanAiText a todas las cadenas de una estructura (objeto, array o
 * cadena suelta), sin tocar números, booleanos ni null.
 *
 * `skipKeys` deja fuera campos donde el texto no es prosa (identificadores,
 * enums, códigos). No hace falta para los esquemas actuales, pero evita
 * sorpresas si mañana un esquema devuelve un slug.
 */
export function cleanAiDeep<T>(value: T, skipKeys: readonly string[] = []): T {
  if (typeof value === 'string') return cleanAiText(value) as unknown as T;
  if (Array.isArray(value)) return value.map(v => cleanAiDeep(v, skipKeys)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = skipKeys.includes(k) ? v : cleanAiDeep(v, skipKeys);
    }
    return out as unknown as T;
  }
  return value;
}

/** ¿Este texto todavía tiene guiones usados como conector? (para el limpiador masivo) */
export function hasAiDashes(text: string | null | undefined): boolean {
  if (!text) return false;
  return cleanAiText(text) !== text;
}
