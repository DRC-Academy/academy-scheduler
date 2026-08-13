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

export interface TourOptions {
  /** 'auto' añade el progreso de formación y el enlace "Saltar tutorial". */
  mode: 'auto' | 'manual';
  /** Pasos ya cumplidos por una acción real, para el check verde. */
  done: () => Set<OnboardingStepId>;
  /** Clases de formación completadas, para el "Clase 3 de 5". */
  classesCompleted: () => number;
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
      nextBtnText: i === ONBOARDING_STEPS.length - 1 ? 'Terminar' : 'Siguiente',
      prevBtnText: 'Anterior',
      doneBtnText: 'Terminar',
      onPopoverRender: popover => decorarPopover(popover, s, opts),
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
