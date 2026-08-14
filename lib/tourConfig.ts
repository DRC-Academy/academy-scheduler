// ── Configuración del product tour (driver.js) ────────────────────────────────
//
// Fábrica PURA de la config: no toca React ni el contexto, así que el componente
// real (components/OnboardingTour) y cualquier banco de pruebas construyen el
// MISMO tour.
//
// driver.js aquí es un PINTOR, no un motor. Se le entrega el elemento YA
// RESUELTO y se le pide que lo resalte, paso a paso, con `highlight()`. No se le
// pasa la lista de pasos ni se usa su `drive()`.
//
// El motivo es el fallo que motivó la reescritura del 14/08/2026: con la lista
// completa, driver mantenía SU propio índice y, cuando un paso tenía
// `skipMissingElement` y su botón no estaba, saltaba solo y movía ese índice sin
// avisar a nadie. React seguía creyendo estar en el paso anterior, y la
// comprobación "si los índices difieren, mové el tour" pasaba a dar falso: el
// profesor pulsaba "Siguiente" y no se movía nada. Con `highlight()` driver no
// tiene índice que desincronizar — solo hay uno, el de React.
//
// Se eligió driver.js (MIT, cero dependencias) frente a Shepherd.js e Intro.js,
// que son AGPL-3.0 y exigirían licencia comercial en una app propietaria servida
// por red. Ojo: `react-shepherd` es MIT pero arrastra `shepherd.js`, que no lo es.
import type { Config, DriveStep } from 'driver.js';
import {
  ONBOARDING_STEPS, formationLabel, selectorsOf,
  type TourStep, type OnboardingStepId,
} from '@/lib/onboarding';
import { findAnchor } from '@/lib/tourEngine';

// ── Flecha señaladora ─────────────────────────────────────────────────────────

/** Lado del elemento donde se coloca la flecha, y hacia dónde apunta. */
export type PointerSide = 'left' | 'right' | 'top' | 'bottom';
export interface Pointer { side: PointerSide; x: number; y: number; }

/** Caja que ocupa la flecha con su etiqueta, para decidir si cabe. */
const FLECHA_W = 150;
const FLECHA_H = 32;

interface Caja { l: number; t: number; r: number; b: number; }
const seSolapan = (a: Caja, b: Caja) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

/**
 * Dónde poner la flecha: pegada al elemento, dentro del viewport y SIN quedar
 * debajo del globo.
 *
 * Lo último no es un detalle. El globo se coloca justo al lado del elemento, así
 * que el primer sitio "natural" para la flecha suele ser exactamente el que el
 * globo ya ocupa, y la flecha desaparecía detrás de él.
 */
export function calcularFlecha(r: DOMRect, popover: Caja | null): Pointer | null {
  const cy = r.top + r.height / 2;
  const cx = r.left + r.width / 2;
  const candidatos: Array<{ p: Pointer; caja: Caja }> = [
    {
      p: { side: 'left', x: r.left - 12, y: cy },
      caja: { l: r.left - 12 - FLECHA_W, t: cy - FLECHA_H / 2, r: r.left - 12, b: cy + FLECHA_H / 2 },
    },
    {
      p: { side: 'right', x: r.right + 12, y: cy },
      caja: { l: r.right + 12, t: cy - FLECHA_H / 2, r: r.right + 12 + FLECHA_W, b: cy + FLECHA_H / 2 },
    },
    {
      p: { side: 'top', x: cx, y: r.top - 12 },
      caja: { l: cx - FLECHA_W / 2, t: r.top - 12 - FLECHA_H * 2, r: cx + FLECHA_W / 2, b: r.top - 12 },
    },
    {
      // Debajo, apuntando hacia arriba. Es la que salva el móvil: ahí el globo
      // ocupa media pantalla por encima del botón y no queda hueco arriba.
      p: { side: 'bottom', x: cx, y: r.bottom + 12 },
      caja: { l: cx - FLECHA_W / 2, t: r.bottom + 12, r: cx + FLECHA_W / 2, b: r.bottom + 12 + FLECHA_H * 2 },
    },
  ];

  const cabe = (c: Caja) => c.l >= 4 && c.r <= window.innerWidth - 4 && c.t >= 4 && c.b <= window.innerHeight - 4;
  // Solo un sitio que quepa Y esté libre. Si no hay ninguno NO se dibuja: una
  // flecha aplastada contra el globo confunde más que la ausencia de flecha, y el
  // halo del elemento más el pico del globo ya señalan de sobra.
  return candidatos.find(c => cabe(c.caja) && !(popover && seSolapan(c.caja, popover)))?.p ?? null;
}

/** ¿La pantalla a la vista es la que pide el paso? */
export function enRutaDelPaso(step: TourStep, pathname: string): boolean {
  return step.routeMatch === 'prefix'
    ? pathname.startsWith(step.route)
    : pathname === step.route;
}

/**
 * A dónde navegar para este paso.
 *
 * Con `routeFrom`, la URL sale del href de un enlace que está en la pantalla
 * ACTUAL: la ficha de un alumno vive en /mis-alumnos/<id> y ese id solo se conoce
 * mirando la lista. Si el enlace no está (un profesor sin alumnos todavía) no hay
 * destino y el paso se salta.
 */
export function destinoDelPaso(step: TourStep): string | null {
  if (!step.routeFrom) return step.route;
  const link = findAnchor([step.routeFrom]) as HTMLAnchorElement | null;
  return link?.getAttribute('href') || null;
}

/** Caja del globo de driver.js, si está en pantalla. */
export function popoverBox(): Caja | null {
  const r = document.querySelector('.driver-popover')?.getBoundingClientRect();
  return r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null;
}

/**
 * Dibujo de la flecha según su orientación.
 *
 * Se usa un trazo DISTINTO para la vertical en vez de rotar el horizontal con
 * CSS: `rotate()` gira el pixelado pero NO la caja de maquetación, así que la
 * flecha rotada se salía de su hueco y se comía la etiqueta de al lado.
 */
export function flechaSvg(side: PointerSide): { viewBox: string; w: number; h: number; d: string } {
  if (side === 'top')    return { viewBox: '0 0 28 64', w: 28, h: 64, d: 'M14 2 V46 M4 34 L14 46 L24 34' };
  if (side === 'bottom') return { viewBox: '0 0 28 64', w: 28, h: 64, d: 'M14 62 V18 M4 30 L14 18 L24 30' };
  return { viewBox: '0 0 64 28', w: 64, h: 28, d: 'M2 14 H46 M34 4 L46 14 L34 24' };
}

export interface TourOptions {
  /** 'auto' añade el progreso de formación y el enlace "Saltar tutorial". */
  mode: 'auto' | 'manual';
  /** Pasos ya cumplidos por una acción real, para el check verde. */
  done: () => Set<OnboardingStepId>;
  /** Clases de formación completadas, para el "Clase 3 de 5". */
  classesCompleted: () => number;
  onNext: () => void;
  onPrev: () => void;
  /** "Saltar tutorial" (solo modo automático). */
  onSkip: () => void;
  /** Cierre por la X, Escape o "Terminar". */
  onClose: () => void;
}

/**
 * Decoración del globo. driver.js no tiene ranura para contenido propio, pero
 * entrega el DOM del popover, así que los añadidos DRC se inyectan acá y las dos
 * vías comparten un solo recorrido en vez de duplicar el componente.
 */
function decorarPopover(
  popover: { wrapper: HTMLElement; footer: HTMLElement; description: HTMLElement },
  step: TourStep,
  index: number,
  anclado: boolean,
  opts: TourOptions,
) {
  const auto = opts.mode === 'auto';
  const done = opts.done();
  popover.wrapper.classList.toggle('is-auto', auto);
  popover.wrapper.classList.toggle('is-done', done.has(step.id));
  // Marca el globo sin foco: lo lee el CSS para no fingir que señala algo.
  popover.wrapper.classList.toggle('is-centered', !anclado);

  // Aviso de cambio de pestaña. El profesor ve ADÓNDE lo lleva el paso siguiente
  // antes de que la pantalla cambie sola debajo suyo, que sin avisar desorienta.
  const siguiente = ONBOARDING_STEPS[index + 1];
  if (siguiente && siguiente.route !== step.route) {
    const salto = document.createElement('div');
    salto.className = 'drc-tour-jump';
    salto.textContent = `Al continuar te llevo a ${siguiente.routeLabel}`;
    popover.footer.insertAdjacentElement('beforebegin', salto);
  }

  // "Dónde está": solo cuando el paso quedó SIN foco. Evita un globo suelto en
  // medio de la pantalla sin decir a qué se refería.
  if (!anclado && step.selector) {
    const nota = document.createElement('div');
    nota.className = 'drc-tour-where';
    const etiqueta = document.createElement('b');
    etiqueta.textContent = 'Dónde está: ';
    nota.appendChild(etiqueta);
    // Nodo de texto, no innerHTML: el copy sale de nuestro diccionario, pero
    // concatenarlo en HTML es el atajo que un día recibe otra cosa.
    nota.appendChild(document.createTextNode(step.where));
    popover.description.insertAdjacentElement('afterend', nota);
  }

  if (!auto) return;

  const chip = document.createElement('div');
  chip.className = 'drc-tour-formacion';
  chip.textContent = formationLabel(opts.classesCompleted());
  popover.wrapper.insertAdjacentElement('afterbegin', chip);

  // Paso accionable pendiente: se le avisa de que el botón iluminado es pulsable
  // y que el paso se marca solo al hacerlo.
  if (step.actionable && anclado && !done.has(step.id)) {
    const aviso = document.createElement('div');
    aviso.className = 'drc-tour-hint';
    aviso.textContent = 'Podés pulsar el botón iluminado: el paso se marca solo.';
    popover.description.insertAdjacentElement('afterend', aviso);
  }

  // "Saltar tutorial": discreto y a la izquierda del pie, lejos de la navegación
  // para que no se pulse por inercia al ir dando a "Siguiente".
  const saltar = document.createElement('button');
  saltar.type = 'button';
  saltar.className = 'drc-tour-skip';
  saltar.textContent = 'Saltar tutorial';
  saltar.addEventListener('click', opts.onSkip);
  popover.footer.insertAdjacentElement('afterbegin', saltar);
}

/**
 * El paso que se le pasa a `driver.highlight()`.
 *
 * `element` viene ya resuelto por el motor. `undefined` = globo centrado, y es
 * una decisión explícita del motor (paso informativo o `onMissing: 'center'`),
 * nunca el resultado de que driver no encontrara algo por su cuenta.
 *
 * OJO con `progressText`: en la ruta de `highlight()` driver NO sustituye
 * `{{current}}`/`{{total}}` (eso solo ocurre en `drive()`), así que el texto va
 * ya formado.
 */
export function buildHighlight(
  step: TourStep,
  index: number,
  element: HTMLElement | null,
  opts: TourOptions,
): DriveStep {
  const total = ONBOARDING_STEPS.length;
  const ultimo = index === total - 1;
  return {
    element: element ?? undefined,
    popover: {
      title: step.title,
      description: step.body,
      side: step.side ?? 'bottom',
      align: step.align ?? 'center',
      popoverClass: 'drc-tour',
      showProgress: true,
      progressText: `Paso ${index + 1} de ${total}`,
      showButtons: ['next', 'previous', 'close'],
      disableButtons: index === 0 ? ['previous'] : [],
      nextBtnText: ultimo ? 'Terminar' : 'Siguiente →',
      prevBtnText: '← Anterior',
      doneBtnText: 'Terminar',
      onPopoverRender: popover => decorarPopover(popover, step, index, !!element, opts),
      // El puntero lo lleva React: acá solo se traduce el clic.
      onNextClick: () => (ultimo ? opts.onClose() : opts.onNext()),
      onPrevClick: () => opts.onPrev(),
      onCloseClick: () => opts.onClose(),
    },
  };
}

export function buildDriverConfig(opts: TourOptions): Config {
  return {
    // Sin `steps`: el recorrido lo lleva el motor (ver cabecera).
    animate: false,
    duration: 400,
    // El scroll lo hace el motor con `scrollAnchorIntoView`, que descuenta la
    // barra superior sticky. El de driver no la conoce y en móvil dejaba el
    // elemento medio tapado.
    smoothScroll: false,
    overlayColor: '#0f1410',
    overlayOpacity: 0.68,
    stagePadding: 8,
    stageRadius: 12,
    popoverOffset: 12,
    allowClose: true,
    allowKeyboardControl: true,
    // Un clic fuera NO cierra: se sale con la X, con "Terminar" o con "Saltar".
    // Cerrarlo sin querer al pulsar cualquier parte de la pantalla es la forma más
    // rápida de que nadie lo termine.
    overlayClickBehavior: () => {},
    showButtons: ['next', 'previous', 'close'],
    showProgress: true,
    onDestroyStarted: opts.onClose,
  };
}

// ── Validación de anclas (solo desarrollo) ───────────────────────────────────

/**
 * Recorre los selectores declarados y avisa de los que no están donde deberían.
 *
 * Solo puede mirar el documento ACTUAL, así que informa por separado de los pasos
 * de esta ruta (donde la ausencia es un dato) y de los de otras (donde es lo
 * esperable).
 *
 * También caza DUPLICADOS, pero solo en los pasos que NO están marcados
 * `multiple`: dos nodos con el mismo `data-onboarding` hacen que el resaltado
 * dependa del orden del DOM. En una lista eso es lo esperado y correcto (hay un
 * botón "Añadir transcript" por clase pendiente); en un elemento único es un
 * error de marcado que haría saltar el foco de un sitio a otro sin motivo.
 */
export function validarAnclas(pathname: string): void {
  if (process.env.NODE_ENV === 'production') return;

  const faltanAqui: string[] = [];
  const duplicados: string[] = [];

  for (const step of ONBOARDING_STEPS) {
    for (const sel of selectorsOf(step)) {
      const nodos = document.querySelectorAll(`[data-onboarding="${sel}"]`);
      if (nodos.length > 1 && !step.multiple) duplicados.push(`${step.id} → "${sel}" (${nodos.length} nodos)`);
      if (nodos.length === 0 && enRutaDelPaso(step, pathname)) faltanAqui.push(`${step.id} → "${sel}"`);
    }
  }

  if (faltanAqui.length) {
    console.warn(
      `[tour] Anclas declaradas que NO están en el DOM de ${pathname}:\n  · ${faltanAqui.join('\n  · ')}\n` +
      '  (puede ser legítimo: el botón depende de los datos del profesor)',
    );
  }
  if (duplicados.length) {
    console.error(`[tour] data-onboarding DUPLICADO (el resaltado dependerá del orden del DOM):\n  · ${duplicados.join('\n  · ')}`);
  }
}
