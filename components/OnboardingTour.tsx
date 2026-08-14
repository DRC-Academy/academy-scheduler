'use client';
// ── Recorrido guiado del profesor: el PINTOR ──────────────────────────────────
//
// Este componente NO decide nada del recorrido. El motor (lib/OnboardingContext)
// resuelve el paso entero —ruta cargada, modal abierto, elemento existente y
// visible— y publica `{ step, anchor }`. Acá solo se pinta: se le pide a driver.js
// que resalte ESE elemento y se dibuja la flecha encima.
//
// Por eso driver.js recibe `highlight()` y nunca `drive()`: sin lista de pasos no
// tiene índice propio que desincronizar. Ese desfase era la causa de que
// "Siguiente" no hiciera nada en el bloque del email.
//
// Se monta una sola vez, en components/Providers (layout raíz), así que sobrevive
// a cualquier router.push. El motor lo apaga solo al salir del área del profesor.
import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { usePathname } from 'next/navigation';
import { useOnboarding } from '@/lib/OnboardingContext';
import {
  buildDriverConfig, buildHighlight, calcularFlecha, popoverBox, flechaSvg,
  validarAnclas, type Pointer,
} from '@/lib/tourConfig';
import { scrollAnchorIntoView } from '@/lib/tourEngine';
import {
  ONBOARDING_FINISHED_TITLE, ONBOARDING_FINISHED_BODY, formationLabel,
  ANCLA_MODAL_PRESENTACION,
} from '@/lib/onboarding';

/**
 * Guard de doble montaje. En desarrollo StrictMode monta, desmonta y vuelve a
 * montar; y un descuido futuro podría dejar dos <OnboardingTour /> en el árbol.
 * Dos instancias pintando el mismo overlay dejan uno huérfano al cerrar, que es
 * exactamente el "overlay pegado" que hay que evitar. Solo pinta la primera que
 * reclama el turno.
 */
let duenoDelTour: symbol | null = null;

/**
 * Barrido defensivo: deja el documento como si el tour nunca hubiera existido.
 *
 * `driver.destroy()` ya hace esto, pero se llama igual desde nuestro `stop()`
 * porque el fallo que se quiere imposibilitar es catastrófico y silencioso: si
 * `.driver-active` se queda en el <body>, la regla `.driver-active * {
 * pointer-events: none }` de driver.css deja la aplicación ENTERA sin responder
 * al ratón y no hay nada en pantalla que lo delate.
 */
function purgarRastroDelTour(): void {
  const b = document.body;
  b.classList.remove('driver-active', 'driver-fade', 'driver-simple', 'driver-no-scroll');
  b.style.removeProperty('--driver-animation-duration');
  // El scroll del <body>: driver solo lo bloquea con allowScroll:false (no es
  // nuestro caso), pero se restaura igual por si alguien cambia esa opción.
  b.style.removeProperty('overflow');
  document.getElementById('driver-dummy-element')?.remove();
  document.querySelectorAll('.driver-overlay, .driver-popover').forEach(el => el.remove());
  document.querySelectorAll('.driver-active-element').forEach(el => {
    el.classList.remove('driver-active-element', 'driver-no-interaction');
    el.removeAttribute('aria-haspopup');
    el.removeAttribute('aria-expanded');
    el.removeAttribute('aria-controls');
  });
  document.querySelectorAll('.driver-active-element-parent, .driver-active-element-parent-no-scroll')
    .forEach(el => el.classList.remove('driver-active-element-parent', 'driver-active-element-parent-no-scroll'));
  // Parpadeo de pestaña: se quita SIEMPRE, no solo por su temporizador.
  document.querySelectorAll('.is-tour-target').forEach(el => el.classList.remove('is-tour-target'));
}

export function OnboardingTour() {
  const {
    mode, phase, step, stepIndex, anchor, done, classesCompleted,
    close, skipAuto, next, prev, resume, reanchor,
    finishedNotice, dismissFinished,
  } = useOnboarding();

  const pathname = usePathname();
  const driverRef = useRef<Driver | null>(null);
  const [pointer, setPointer] = useState<Pointer | null>(null);

  // ── Turno de pintado (guard de doble montaje) ───────────────────────────────
  const miTurno = useRef<symbol>(Symbol('tour'));
  const [activo, setActivo] = useState(false);
  useEffect(() => {
    const yo = miTurno.current;
    if (duenoDelTour === null) duenoDelTour = yo;
    setActivo(duenoDelTour === yo);
    return () => { if (duenoDelTour === yo) duenoDelTour = null; };
  }, []);

  // Espejos para los callbacks de driver.js, que se registran al construir el
  // tour y se quedarían con el estado de ese instante.
  const doneRef = useRef(done);
  const modeRef = useRef(mode);
  const classesRef = useRef(classesCompleted);
  useEffect(() => {
    doneRef.current = done;
    modeRef.current = mode;
    classesRef.current = classesCompleted;
  });

  const stop = useCallback(() => {
    try { driverRef.current?.destroy(); } catch { /* ya estaba destruido */ }
    driverRef.current = null;
    purgarRastroDelTour();
  }, []);

  // ── Instancia de driver.js ──────────────────────────────────────────────────
  useEffect(() => {
    if (!activo) return;
    if (mode === 'off') { stop(); return; }
    if (driverRef.current) return;

    driverRef.current = driver(buildDriverConfig({
      mode: mode === 'auto' ? 'auto' : 'manual',
      done: () => doneRef.current,
      classesCompleted: () => classesRef.current,
      onNext: next,
      onPrev: prev,
      onSkip: () => { stop(); skipAuto(); },
      // driver.js delega el cierre: si no se destruye a mano, no se cierra. Cubre
      // la X, Escape y "Terminar".
      onClose: () => { stop(); close(); },
    }));
    if (process.env.NODE_ENV !== 'production') validarAnclas(pathname);
  }, [activo, mode, stop, next, prev, close, skipAuto, pathname]);

  // Desmontaje: sin esto el overlay quedaría pintado sobre la app.
  useEffect(() => stop, [stop]);

  // ── Pintar el paso ya resuelto ──────────────────────────────────────────────
  useEffect(() => {
    if (!activo || mode === 'off' || phase !== 'ready') return;
    const d = driverRef.current;
    if (!d) return;
    // El ancla pudo morir entre que el motor la resolvió y este efecto corre: en
    // "Mis clases" los botones cambian en cuanto entra el reloj. Resaltar un nodo
    // desconectado deja el recorte en 0×0 en la esquina, así que se pide una nueva
    // y este efecto vuelve a entrar con ella.
    if (anchor && !anchor.isConnected) { reanchor(); return; }
    d.highlight(buildHighlight(step, stepIndex, anchor, {
      mode: mode === 'auto' ? 'auto' : 'manual',
      done: () => doneRef.current,
      classesCompleted: () => classesRef.current,
      onNext: next,
      onPrev: prev,
      onSkip: () => { stop(); skipAuto(); },
      onClose: () => { stop(); close(); },
    }));
    // DESPUÉS de driver, nunca antes. driver.js scrollea por su cuenta dentro de
    // `highlight()`: `smoothScroll: false` solo lo hace instantáneo, no lo apaga.
    // Y para un elemento más alto que la ventana alinea por arriba sin descontar
    // la barra sticky, así que la parrilla del calendario quedaba con su borde
    // superior bajo el header. Este segundo scroll lo corrige.
    if (anchor) scrollAnchorIntoView(anchor);
  }, [activo, mode, phase, step, stepIndex, anchor, next, prev, close, skipAuto, stop, reanchor]);

  // ── Parpadeo de la pestaña de destino ───────────────────────────────────────
  // Un parpadeo corto sobre el enlace del header por el que se acaba de entrar,
  // para que el profesor asocie la pantalla con su pestaña y sepa volver. Se
  // limpia por su temporizador, por el cleanup del efecto Y por `purgarRastro`.
  useEffect(() => {
    if (!activo || mode === 'off' || phase !== 'ready') return;
    const link = document.querySelector<HTMLElement>(`[data-onboarding="nav:${step.route}"]`);
    if (!link) return;
    link.classList.add('is-tour-target');
    const t = window.setTimeout(() => link.classList.remove('is-tour-target'), 2200);
    return () => { window.clearTimeout(t); link.classList.remove('is-tour-target'); };
  }, [activo, mode, phase, step.route]);

  // ── Liberación del atrapa-foco de driver.js dentro del modal ────────────────
  // driver.js secuestra el Tab (`preventDefault()` incondicional) y lo reparte
  // solo entre su globo y el elemento resaltado. Dentro del modal del email eso
  // deja el formulario entero fuera del alcance del teclado. Se corta el evento
  // en fase de captura ANTES de que llegue a su listener de window, pero solo
  // cuando el foco está dentro del modal: fuera, el atrapa-foco sigue siendo el
  // comportamiento correcto.
  useEffect(() => {
    if (!activo || mode === 'off') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const dentro = (e.target as HTMLElement | null)?.closest?.(`[data-onboarding="${ANCLA_MODAL_PRESENTACION}"]`);
      if (dentro) e.stopPropagation();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [activo, mode]);

  // ── Flecha señaladora ───────────────────────────────────────────────────────
  // Se mide en cada frame porque el elemento se mueve por debajo del overlay sin
  // emitir evento: filtros de la lista, recarga de datos a los 60 s, el scroll.
  const midiendo = activo && mode !== 'off' && phase === 'ready' && !!anchor;
  useEffect(() => {
    if (!midiendo || !anchor) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      // Si el nodo se desconectó (el modal se cerró), no se mide: su rect sería
      // todo ceros y la flecha se iría a la esquina superior izquierda.
      if (!anchor.isConnected) {
        if (last !== '') { last = ''; setPointer(null); }
      } else {
        const p = calcularFlecha(anchor.getBoundingClientRect(), popoverBox());
        const key = p ? `${p.side}_${Math.round(p.x)}_${Math.round(p.y)}` : '';
        if (key !== last) { last = key; setPointer(p); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [midiendo, anchor]);

  // ── Reposición y re-anclaje ante cambios de la lista ────────────────────────
  //
  // Dos cosas distintas: `refresh()` recoloca el recorte sobre el MISMO nodo, y
  // `reanchor()` busca uno nuevo cuando el que había se desconectó del documento.
  // Hace falta lo segundo porque "Mis clases" recarga sus datos sola y React
  // reemplaza el nodo del botón: driver se quedaba resaltando el huérfano, cuyo
  // rect es todo ceros, y el halo desaparecía sin que nada lo delatara.
  useEffect(() => {
    if (!activo || mode === 'off' || phase !== 'ready') return;
    const t = window.setInterval(() => {
      if (anchor && !anchor.isConnected) { reanchor(); return; }
      const d = driverRef.current;
      if (d?.isActive()) d.refresh();
    }, 1000);
    return () => window.clearInterval(t);
  }, [activo, mode, phase, anchor, reanchor]);

  if (typeof document === 'undefined' || !activo) return null;

  // ── Cartel de formación completada ──────────────────────────────────────────
  if (finishedNotice) {
    return createPortal(
      <div className="drc-tour-done-backdrop" onClick={e => { if (e.target === e.currentTarget) dismissFinished(); }}>
        <div className="drc-tour-done-card" role="dialog" aria-label={ONBOARDING_FINISHED_TITLE}>
          <div className="drc-tour-done-emoji" aria-hidden>🎓</div>
          <div className="drc-tour-done-title">{ONBOARDING_FINISHED_TITLE}</div>
          <div className="drc-tour-done-body">{ONBOARDING_FINISHED_BODY}</div>
          <button className="drc-tour-done-btn" onClick={dismissFinished} autoFocus>Entendido</button>
        </div>
      </div>,
      document.body,
    );
  }

  // ── El motor está resolviendo el paso ───────────────────────────────────────
  if (mode !== 'off' && phase === 'transitioning') {
    return createPortal(
      <div className="drc-tour-jumping" role="status">
        <span className="drc-spinner" />
        Abriendo {step.routeLabel}…
      </div>,
      document.body,
    );
  }

  // ── Llamada a la formación cuando el tour está en reposo ────────────────────
  // Se muestra por FASE, no comparando rutas: el criterio de ruta duplicado hacía
  // que en la ficha del alumno (que casa por prefijo) saliera este cartel en vez
  // de la flecha, y encima sin poder pulsarse.
  if (mode === 'auto' && phase === 'idle') {
    return createPortal(
      <button className="drc-tour-nudge" onClick={resume}>
        <span className="drc-tour-nudge-dot" aria-hidden />
        <span>
          <b>{formationLabel(classesCompleted)}</b>
          <span className="drc-tour-nudge-cta">Ver el tutorial →</span>
        </span>
      </button>,
      document.body,
    );
  }

  // ── Flecha grande sobre el elemento del paso ────────────────────────────────
  if (!midiendo || !pointer) return null;
  const svg = flechaSvg(pointer.side);

  return createPortal(
    <div
      className={`drc-tour-pointer is-${pointer.side}`}
      style={{ left: pointer.x, top: pointer.y }}
      aria-hidden
    >
      <svg viewBox={svg.viewBox} width={svg.w} height={svg.h}>
        {/* Asta + punta en un solo trazo: se lee como flecha incluso a 60 px. */}
        <path d={svg.d} fill="none" stroke="#1E9E3A" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="drc-tour-pointer-label">
        {step.actionable ? 'Pulsá acá' : 'Mirá acá'}
      </span>
    </div>,
    document.body,
  );
}
