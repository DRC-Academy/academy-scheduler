// ── Configuración del product tour (driver.js) ────────────────────────────────
//
// Fábrica PURA de la config: no toca React ni el contexto, así que el componente
// real (components/OnboardingTour) y cualquier banco de pruebas construyen el
// MISMO tour. Sin esto, verificar el acabado visual obligaría a duplicar la
// config, que es justo la copia que se desincroniza y deja de probar nada.
//
// Se eligió driver.js (MIT, cero dependencias) frente a Shepherd.js e Intro.js,
// que son AGPL-3.0 y exigirían licencia comercial en una app propietaria servida
// por red. Ojo: `react-shepherd` es MIT pero arrastra `shepherd.js`, que no lo es.
import type { Config, DriveStep } from 'driver.js';
import { ONBOARDING_STEPS, formationLabel, type OnboardingStep, type OnboardingStepId } from '@/lib/onboarding';

/** Ruta donde viven los botones del SOP. El tour se lanza ahí. */
export const RUTA_CLASES = '/clases';

/**
 * Primer elemento VISIBLE con alguno de los `data-onboarding` del paso.
 *
 * Anclaje por identificador estable, nunca por posición. Un paso declara VARIAS
 * anclas y gana la primera que exista: el mismo hueco de la tarjeta muestra
 * "Ingresar a clase" o "Definir enlace" según el alumno tenga o no enlace de Meet.
 */
export function findAnchor(anchors: string[]): HTMLElement | undefined {
  for (const name of anchors) {
    const nodes = document.querySelectorAll<HTMLElement>(`[data-onboarding="${name}"]`);
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      // Tamaño 0 = oculto (display:none, o dentro de un menú cerrado). Resaltarlo
      // sería un agujero invisible en la esquina de la pantalla.
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return undefined;
}

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
  /**
   * Avance y retroceso. Los lleva React, NO driver.js: el recorrido cruza
   * pantallas y en cada salto driver se destruye y se reconstruye, con lo que su
   * índice interno se perdería. Acá solo se traduce el clic.
   */
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
  step: OnboardingStep,
  opts: TourOptions,
) {
  const auto = opts.mode === 'auto';
  const done = opts.done();
  popover.wrapper.classList.toggle('is-auto', auto);
  popover.wrapper.classList.toggle('is-done', done.has(step.id));

  // Aviso de cambio de pestaña. El profesor ve ADÓNDE lo lleva el paso siguiente
  // antes de que la pantalla cambie sola debajo suyo, que sin avisar desorienta.
  const siguiente = ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(step) + 1];
  if (siguiente && siguiente.route !== step.route) {
    const salto = document.createElement('div');
    salto.className = 'drc-tour-jump';
    salto.textContent = `Al continuar te llevo a ${siguiente.routeLabel}`;
    popover.footer.insertAdjacentElement('beforebegin', salto);
  }

  // "Dónde está": solo si el paso ancla algo y no se encontró el botón. Evita un
  // globo suelto en medio de la pantalla sin decir a qué se refería.
  if (step.anchors.length > 0 && !findAnchor(step.anchors)) {
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
  if (step.actionable && !done.has(step.id)) {
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

export function buildTourSteps(opts: TourOptions): DriveStep[] {
  return ONBOARDING_STEPS.map((s, i): DriveStep => ({
    // Función, no selector: se evalúa al llegar al paso y resuelve la lista de
    // anclas con su fallback. driver.js admite que no haya elemento (globo
    // centrado), aunque su tipo solo declare `() => Element`.
    element: s.anchors.length > 0
      ? (() => findAnchor(s.anchors)) as unknown as () => Element
      : undefined,
    // Un paso opcional sin su botón en pantalla se salta solo. Es el caso de la
    // presentación, que se envía una vez por alumno: sin esto un profesor trabaría
    // el recorrido en el paso 1 desde su segundo día.
    skipMissingElement: s.optional === true,
    // Margen para que la lista de clases termine de cargar antes de dar por
    // ausente el botón.
    waitForElement: s.anchors.length > 0 ? 1200 : 0,
    popover: {
      title: s.title,
      description: s.why,
      side: s.side ?? 'bottom',
      align: s.align ?? 'center',
      popoverClass: 'drc-tour',
      progressText: `Paso {{current}} de ${ONBOARDING_STEPS.length}`,
      showProgress: true,
      nextBtnText: i === ONBOARDING_STEPS.length - 1 ? 'Terminar' : 'Siguiente →',
      prevBtnText: '← Anterior',
      doneBtnText: 'Terminar',
      onPopoverRender: popover => decorarPopover(popover, s, opts),
      // Se intercepta el avance de driver.js: el puntero lo lleva React porque el
      // recorrido cambia de pantalla (ver TourOptions.onNext).
      onNextClick: () => (i === ONBOARDING_STEPS.length - 1 ? opts.onClose() : opts.onNext()),
      onPrevClick: () => opts.onPrev(),
    },
  }));
}

export function buildTourConfig(opts: TourOptions): Config {
  return {
    steps: buildTourSteps(opts),
    // El recorte del overlay se interpola entre pasos: el foco de luz se desliza
    // al siguiente botón en vez de saltar.
    animate: true,
    duration: 400,
    smoothScroll: true,
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
