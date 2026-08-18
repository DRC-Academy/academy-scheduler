// ── Primitivas de espera del tutorial guiado ──────────────────────────────────
//
// REGLA DE ORO DE ESTE MÓDULO: nunca se sincroniza con un `setTimeout` de N
// milisegundos. Un retardo fijo es una apuesta sobre lo que tarda la red, y el
// tutorial la perdía sistemáticamente: si la lista de clases tardaba más de lo
// apostado, el paso se anclaba a un elemento fantasma y el globo quedaba
// flotando en el centro sin señalar nada.
//
// Acá solo hay esperas POR CONDICIÓN con fecha límite:
//   · `waitFor` — resuelve en cuanto la condición se cumple; el timeout es un
//     tope de seguridad, no el mecanismo de sincronización. Si vence, devuelve
//     null y el motor decide (saltar o centrar), nunca sigue a ciegas.
//   · `waitForElement` — lo anterior aplicado al DOM, con MutationObserver.
//
// Módulo PURO: sin React, sin driver.js. Se puede probar en un banco aparte.

/** Milisegundos de tope para que aparezca un elemento tras montar su pantalla. */
export const ELEMENT_TIMEOUT_MS = 3000;
/** Milisegundos de tope para que el router complete un cambio de ruta. */
export const ROUTE_TIMEOUT_MS = 5000;

export interface WaitOptions {
  timeoutMs?: number;
  /** Corta la espera desde fuera (cambio de paso, cierre del tour, desmontaje). */
  signal?: AbortSignal;
}

/**
 * Espera a que `probe` devuelva algo distinto de null/undefined.
 *
 * `subscribe` conecta la reevaluación a la fuente real del cambio (mutaciones
 * del DOM, un cambio de ruta). Sin él la espera sería un sondeo, que es la misma
 * apuesta que el retardo fijo pero repetida.
 */
export function waitFor<T>(
  probe: () => T | null | undefined,
  subscribe: (recheck: () => void) => () => void,
  { timeoutMs = ELEMENT_TIMEOUT_MS, signal }: WaitOptions = {},
): Promise<T | null> {
  const immediate = probe();
  if (immediate != null) return Promise.resolve(immediate);
  if (signal?.aborted) return Promise.resolve(null);

  return new Promise<T | null>(resolve => {
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };

    const recheck = () => {
      const v = probe();
      if (v != null) finish(v);
    };
    const onAbort = () => finish(null);

    const timer = window.setTimeout(() => finish(null), timeoutMs);
    const unsubscribe = subscribe(recheck);
    signal?.addEventListener('abort', onAbort, { once: true });

    // La condición pudo cumplirse entre el primer `probe` y la suscripción.
    recheck();
  });
}

/** Suscripción a CUALQUIER cambio del DOM. Es lo que hace que la espera termine
 *  en el instante en que React pinta el botón, y no un retardo después. */
function subscribeToDom(recheck: () => void): () => void {
  const obs = new MutationObserver(recheck);
  obs.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-onboarding', 'class', 'style', 'hidden'],
  });
  return () => obs.disconnect();
}

/** ¿Está pintado de verdad? Un nodo de 0×0 (o dentro de algo cerrado) no se puede
 *  señalar: resaltarlo sería un agujero invisible en una esquina. */
export function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Primer elemento VISIBLE con alguno de los `data-onboarding` dados, en orden de
 *  preferencia. El mismo hueco de la tarjeta muestra "Ingresar a clase" o
 *  "Definir enlace" según el alumno tenga o no enlace de Meet: por eso hay lista
 *  y no un único selector. */
export function findAnchor(selectors: string[]): HTMLElement | null {
  for (const name of selectors) {
    const nodes = document.querySelectorAll<HTMLElement>(`[data-onboarding="${name}"]`);
    for (const el of nodes) if (isVisible(el)) return el;
  }
  return null;
}

/** Espera a que aparezca (y sea visible) alguno de los anclajes. null si vence. */
export function waitForElement(selectors: string[], opts: WaitOptions = {}): Promise<HTMLElement | null> {
  return waitFor(() => findAnchor(selectors), subscribeToDom, { timeoutMs: ELEMENT_TIMEOUT_MS, ...opts });
}

/**
 * ¿El ancla que ya teníamos SIGUE sirviendo para señalar?
 *
 * `isConnected` NO basta, y esto costó el bug del globo en la esquina. Un nodo
 * que sigue en el documento pero está oculto (un filtro de la lista, un
 * contenedor plegado, `display:none`) devuelve un rect de ceros. driver.js lo usa
 * TAL CUAL: `D()` recorta el overlay con ese rect y reposiciona el globo con él,
 * así que los dos se van a (0,0), la esquina superior izquierda. El tamaño es lo
 * único que distingue ese caso, y `isVisible` es justo lo que mira.
 *
 * Es la MISMA condición con la que `findAnchor` eligió el nodo: si dejó de
 * cumplirla, ese nodo ya no habría sido elegido y hay que buscar otro.
 */
export function anchorSigueValida(el: HTMLElement | null): boolean {
  return !!el && el.isConnected && isVisible(el);
}

/**
 * Espera al ancla, pero SE RINDE ANTES si `renuncia()` pasa a ser cierto.
 *
 * Evita el spinner de 3 s cuando no había nada que resaltar. `requires()` se
 * evalúa antes de navegar, con la pantalla dueña del dato aún sin montar, y el
 * puente responde entonces "no puedo saberlo" (true). Al montarse sí sabe, y ese
 * cambio llega con las mismas mutaciones del DOM que ya se están observando: en
 * cuanto responde que no hay nada, se deja de esperar.
 *
 * El tope de tiempo sigue existiendo para el caso en que nadie conteste.
 */
export function waitForElementOrGiveUp(
  selectors: string[],
  renuncia: () => boolean,
  opts: WaitOptions = {},
): Promise<HTMLElement | null> {
  return waitFor<{ el: HTMLElement | null }>(
    () => {
      const el = findAnchor(selectors);
      if (el) return { el };
      return renuncia() ? { el: null } : null;
    },
    subscribeToDom,
    { timeoutMs: ELEMENT_TIMEOUT_MS, ...opts },
  ).then(r => r?.el ?? null);
}

/** Espera a que DESAPAREZCA todo anclaje de la lista. Se usa al cerrar el modal:
 *  seguir al paso siguiente con el modal aún en el DOM lo resaltaría al vuelo. */
export function waitForElementGone(selectors: string[], opts: WaitOptions = {}): Promise<boolean> {
  return waitFor(
    () => (findAnchor(selectors) ? null : true),
    subscribeToDom,
    { timeoutMs: ELEMENT_TIMEOUT_MS, ...opts },
  ).then(v => v === true);
}

// ── Altura del encabezado fijo ───────────────────────────────────────────────

/** Alto real de la barra superior sticky, para que el scroll no deje el elemento
 *  debajo de ella. Se mide, no se escribe a mano: la barra cambia de alto entre
 *  móvil y escritorio. */
export function stickyHeaderHeight(): number {
  const nav = document.querySelector<HTMLElement>('.tnav');
  if (!nav) return 0;
  const pos = getComputedStyle(nav).position;
  if (pos !== 'sticky' && pos !== 'fixed') return 0;
  return nav.getBoundingClientRect().height;
}

/**
 * Deja el elemento centrado en la parte útil de la ventana.
 *
 * No se usa `scrollIntoView({block:'center'})` a secas: cuando el elemento es más
 * alto que el viewport (la parrilla del calendario en un móvil) el navegador cae
 * a alinear por arriba y la cabecera sticky se le come el borde superior. Acá el
 * destino se calcula descontando esa cabecera, así que el elemento entra entero
 * en el hueco visible o, si no cabe, entra por su borde superior JUSTO debajo de
 * la barra.
 */
export function scrollAnchorIntoView(el: HTMLElement): void {
  const header = stickyHeaderHeight();
  const r = el.getBoundingClientRect();
  const usableTop = header + 8;
  const usableH = window.innerHeight - usableTop - 8;
  if (usableH <= 0) return;

  const cabe = r.height <= usableH;
  // Si cabe se centra en el hueco; si no, su borde superior queda bajo la barra.
  const objetivoY = cabe ? usableTop + (usableH - r.height) / 2 : usableTop;
  const delta = r.top - objetivoY;
  if (Math.abs(delta) < 2) return;

  window.scrollBy({ top: delta, behavior: 'smooth' });
}
