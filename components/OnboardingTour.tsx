'use client';
// ── Recorrido guiado del profesor (product tour) ──────────────────────────────
//
// El overlay lo pinta driver.js: un único <svg> cuyo path lleva recortado el
// agujero del elemento del paso, y que ANIMA ese path al pasar al siguiente, con
// lo que el foco de luz se desliza en vez de saltar.
//
// El recorrido CRUZA PANTALLAS: los cuatro primeros pasos están en la agenda y el
// último en Finanzas. El tour navega solo, resalta un instante la pestaña de
// destino para que el profesor aprenda dónde está, y una flecha grande señala el
// botón que tiene que pulsar.
//
// Reparto de responsabilidades:
//   · lib/OnboardingContext — el estado, incluido el PASO ACTUAL. Vive allá y no
//     dentro de driver.js porque al cambiar de pantalla driver se destruye y su
//     índice interno se perdería.
//   · lib/tourConfig — la configuración de driver.js, pura y sin React.
//   · este archivo — orquestación: navegar, lanzar, apuntar.
import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useOnboarding } from '@/lib/OnboardingContext';
import { buildTourConfig, findAnchor, calcularFlecha, popoverBox, flechaSvg } from '@/lib/tourConfig';
import {
  ONBOARDING_STEPS, ONBOARDING_FINISHED_TITLE, ONBOARDING_FINISHED_BODY,
  formationLabel, RUTA_AGENDA,
} from '@/lib/onboarding';

import type { Pointer } from '@/lib/tourConfig';

export function OnboardingTour() {
  const {
    mode, step, stepIndex, done, notApplicable, classesCompleted,
    close, skipAuto, next, prev, markNotApplicable,
    finishedNotice, dismissFinished,
  } = useOnboarding();

  const pathname = usePathname();
  const router = useRouter();

  const driverRef = useRef<Driver | null>(null);
  /** Modo con el que se lanzó el tour vivo, para no reconstruirlo en cada render. */
  const runningMode = useRef<'auto' | 'manual' | null>(null);
  const [pointer, setPointer] = useState<Pointer | null>(null);

  // Espejos para los callbacks de driver.js, que se registran al construir el tour
  // y se quedarían con el estado de ese instante.
  const doneRef = useRef(done);
  const naRef = useRef(notApplicable);
  const modeRef = useRef(mode);
  const classesRef = useRef(classesCompleted);
  useEffect(() => {
    doneRef.current = done;
    naRef.current = notApplicable;
    modeRef.current = mode;
    classesRef.current = classesCompleted;
  });

  const stop = useCallback(() => {
    driverRef.current?.destroy();
    driverRef.current = null;
    runningMode.current = null;
  }, []);

  const enRuta = mode !== 'off' && pathname === step.route;

  // ── Cambio de pestaña ───────────────────────────────────────────────────────
  // El paso manda: si su pantalla no es la que está a la vista, el tour navega. El
  // profesor no tiene que saber en qué sección vive cada botón, que era justo lo
  // que se le pedía adivinar.
  useEffect(() => {
    if (mode === 'off') return;
    if (pathname === step.route) return;
    router.push(step.route);
  }, [mode, pathname, step.route, router]);

  // ── Lanzamiento y avance ────────────────────────────────────────────────────
  useEffect(() => {
    if (mode === 'off') { stop(); return; }
    if (!enRuta) return;   // el efecto de arriba ya está navegando

    if (runningMode.current !== mode) {
      stop();
      driverRef.current = driver(buildTourConfig({
        mode,
        done: () => doneRef.current,
        classesCompleted: () => classesRef.current,
        onNext: next,
        onPrev: prev,
        onSkip: () => { stop(); skipAuto(); },
        // driver.js delega el cierre: si no se destruye a mano, no se cierra.
        onClose: () => { stop(); close(); },
      }));
      runningMode.current = mode;
      driverRef.current.drive(stepIndex);
      return;
    }
    // Ya estaba corriendo: solo se mueve al paso que manda React.
    if (driverRef.current?.getActiveIndex() !== stepIndex) {
      driverRef.current?.drive(stepIndex);
    }
  }, [mode, enRuta, stepIndex, stop, next, prev, close, skipAuto]);

  // Desmontaje: sin esto el overlay quedaría pintado sobre la app.
  useEffect(() => stop, [stop]);

  // ── Resaltado de la pestaña recién abierta ──────────────────────────────────
  // Un parpadeo corto sobre el enlace del header por el que se acaba de entrar,
  // para que el profesor asocie la pantalla con su pestaña y sepa volver.
  useEffect(() => {
    if (mode === 'off' || !enRuta) return;
    const link = document.querySelector<HTMLElement>(`[data-onboarding="nav:${step.route}"]`);
    if (!link) return;
    link.classList.add('is-tour-target');
    const t = setTimeout(() => link.classList.remove('is-tour-target'), 2200);
    return () => { clearTimeout(t); link.classList.remove('is-tour-target'); };
  }, [mode, enRuta, step.route]);

  // ── Flecha señaladora ───────────────────────────────────────────────────────
  // Se mide en cada frame porque el elemento se mueve por debajo del overlay sin
  // emitir evento: filtros de la lista, recarga de datos a los 60 s, el scroll
  // suave de driver.js. Solo corre con el tour abierto.
  // Sin `setPointer(null)` en el cuerpo del efecto: cuando el tour no está activo
  // la medición simplemente no se usa (`flecha`, más abajo), así que no hace falta
  // borrarla de forma síncrona. La única escritura ocurre dentro del rAF, que es
  // la suscripción a la geometría del DOM.
  const midiendo = mode !== 'off' && enRuta && step.anchors.length > 0;
  useEffect(() => {
    if (!midiendo) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      const el = findAnchor(step.anchors);
      if (!el) {
        if (last !== '') { last = ''; setPointer(null); }
      } else {
        const p = calcularFlecha(el.getBoundingClientRect(), popoverBox());
        const key = p ? `${p.side}_${Math.round(p.x)}_${Math.round(p.y)}` : '';
        if (key !== last) { last = key; setPointer(p); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [midiendo, step.id, step.anchors]);

  /** Flecha efectiva: la medida, solo mientras el paso la necesita. */
  const flecha = midiendo ? pointer : null;

  // ── Reposición ante cambios de la lista ─────────────────────────────────────
  useEffect(() => {
    if (mode === 'off' || !enRuta) return;
    const t = setInterval(() => {
      const d = driverRef.current;
      if (d?.isActive()) d.refresh();
    }, 1000);
    return () => clearInterval(t);
  }, [mode, enRuta]);

  // Paso opcional sin botón a la vista: se marca como no aplicable para que la
  // lógica no lo espere. driver.js ya lo salta con `skipMissingElement`; esto es
  // la contraparte en el contexto.
  useEffect(() => {
    if (mode !== 'auto' || pathname !== RUTA_AGENDA) return;
    const t = setTimeout(() => {
      for (const s of ONBOARDING_STEPS) {
        if (!s.optional || doneRef.current.has(s.id) || naRef.current.has(s.id)) continue;
        if (!findAnchor(s.anchors)) markNotApplicable(s.id);
      }
    }, 2500);
    return () => clearTimeout(t);
  }, [mode, pathname, markNotApplicable, done, notApplicable]);

  if (typeof document === 'undefined') return null;

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

  // ── Aviso de que el tour está cambiando de pantalla ─────────────────────────
  if (mode !== 'off' && !enRuta) {
    return createPortal(
      <div className="drc-tour-jumping" role="status">
        <span className="drc-spinner" />
        Abriendo {step.routeLabel}…
      </div>,
      document.body,
    );
  }

  // ── Llamada a la formación desde otra pantalla ──────────────────────────────
  // Un profesor entra a la app en /teacher (el Calendario), así que sin esto el
  // tour automático no se lanzaría nunca. Discreto y no bloqueante.
  if (mode === 'auto' && pathname !== step.route) {
    return createPortal(
      <button className="drc-tour-nudge" onClick={() => router.push(step.route)}>
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
  if (!flecha) return null;
  const svg = flechaSvg(flecha.side);

  return createPortal(
    <div
      className={`drc-tour-pointer is-${flecha.side}`}
      style={{ left: flecha.x, top: flecha.y }}
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
