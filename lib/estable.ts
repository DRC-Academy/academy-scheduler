// ── Identidad estable para lo que reparte un contexto ────────────────────────
//
// Un efecto que depende de una función o de un array del contexto se relanza
// cada vez que cambia su IDENTIDAD, aunque el contenido sea el mismo. Si ese
// efecto además provoca un render del proveedor (una carga que guarda estado),
// la función vuelve a nacer y el efecto vuelve a correr: bucle. Fue el
// incidente del 08/10/2026 (la ficha del alumno relanzando loadClassJoinLogs sin
// fin hasta saturar la base).
//
// Dos piezas, puras y sin React para poder probarlas:
//   · accionesEstables: funciones con la MISMA identidad toda la vida del
//     proveedor que llaman siempre a su última versión (la que ve el estado
//     actual). Un efecto con [loadClassJoinLogs] corre una vez y nada más.
//   · mismoContenido: para no reemplazar un array por otro igual en cada
//     recarga de 60 s.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Funciones = Record<string, (...args: any[]) => any>;

/**
 * Envoltorios de identidad fija sobre `ref.current`. Las claves se toman al
 * crearlos: el objeto de acciones tiene que tener siempre las mismas.
 */
export function accionesEstables<T extends Funciones>(ref: { readonly current: T }): T {
  const out = {} as T;
  for (const k of Object.keys(ref.current) as Array<keyof T>) {
    out[k] = ((...args: unknown[]) => ref.current[k](...args)) as T[keyof T];
  }
  return Object.freeze(out);
}

/**
 * true si `a` y `b` tienen el mismo contenido (datos planos de la base: lo que
 * se serializa a JSON). Mismo orden de claves porque vienen del mismo mapeo.
 */
export function mismoContenido(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** El anterior si el nuevo trae lo mismo: así la identidad solo cambia con el contenido. */
export function siCambio<T>(prev: T, next: T): T {
  return mismoContenido(prev, next) ? prev : next;
}
