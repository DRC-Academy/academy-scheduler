'use client';
// ── Recorrido guiado del profesor (product tour) ──────────────────────────────
//
// El overlay lo pinta driver.js: un único <svg> cuyo path lleva recortado el
// agujero del elemento del paso, y que ANIMA ese path al pasar al siguiente, con
// lo que el foco de luz se desliza en vez de saltar. El globo se coloca solo y se
// recoloca cuando no entra, que es lo que lo hace sobrevivir en móvil.
//
// Este archivo es SOLO orquestación: cuándo se lanza, cuándo se cierra y cuándo
// avanza. La configuración del tour (pasos, anclajes, estilo del globo) vive en
// lib/tourConfig, aparte y sin React, para que el banco de pruebas visual arme
// exactamente el mismo tour en vez de una copia que se desincroniza.
//
// Reparto con lib/OnboardingContext: acá la NAVEGACIÓN, allá la LÓGICA (quién
// está en onboarding, qué se cumplió, la base). Driver es el único dueño del
// puntero del paso: no hay un índice espejo en React, que es lo que antes hacía
// que el paso se moviera solo hacia atrás al llegar una acción real.
import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useOnboarding } from '@/lib/OnboardingContext';
import { buildTourConfig, findAnchor, RUTA_CLASES } from '@/lib/tourConfig';
import {
  ONBOARDING_STEPS, ONBOARDING_FINISHED_TITLE, ONBOARDING_FINISHED_BODY, formationLabel,
} from '@/lib/onboarding';

export function OnboardingTour() {
  const {
    mode, done, notApplicable, firstPendingIndex, classesCompleted,
    close, skipAuto, markNotApplicable,
    finishedNotice, dismissFinished,
  } = useOnboarding();

  const pathname = usePathname();
  const router = useRouter();

  const driverRef = useRef<Driver | null>(null);
  /** Modo con el que se lanzó el tour vivo, para no relanzarlo en cada render. */
  const runningMode = useRef<'auto' | 'manual' | null>(null);
  // Espejos para los callbacks de driver.js. El tour se construye UNA vez al
  // lanzarse, así que sus closures se quedarían con el estado de ese instante: sin
  // los refs, el globo del paso 4 seguiría creyendo que no hay ningún paso
  // cumplido. Se sincronizan en un efecto, no en el cuerpo del render, que es
  // donde el compilador de React prohíbe escribirlos.
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

  // ── Lanzamiento ─────────────────────────────────────────────────────────────
  // El tour vive en /clases, que es donde están los botones del SOP. Si el
  // profesor pide el tutorial desde otra pantalla se lo lleva primero ahí: es
  // preferible a resaltar al aire o a enseñarle cinco globos centrados sin nada
  // alrededor que mirar.
  useEffect(() => {
    if (mode === 'off') { stop(); return; }
    if (pathname !== RUTA_CLASES) {
      if (mode === 'manual') router.push(RUTA_CLASES);
      stop();
      return;
    }
    if (runningMode.current === mode) return;

    stop();
    const d = driver(buildTourConfig({
      mode,
      done: () => doneRef.current,
      classesCompleted: () => classesRef.current,
      onSkip: () => { stop(); skipAuto(); },
      // driver.js delega el cierre: si no se destruye a mano, no se cierra.
      onClose: () => { stop(); close(); },
    }));
    driverRef.current = d;
    runningMode.current = mode;
    // El automático retoma donde el profesor lo dejó; el manual siempre desde el
    // principio, porque es un repaso completo.
    d.drive(mode === 'auto' ? firstPendingIndex : 0);
  // `firstPendingIndex` a propósito FUERA de las dependencias: solo decide el paso
  // de arranque. Incluirlo relanzaría el tour entero cada vez que se marca un paso.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pathname, stop, close, skipAuto, router]);

  // Desmontaje: sin esto el overlay quedaría pintado sobre la app.
  useEffect(() => stop, [stop]);

  // ── Avance al detectar la acción real ───────────────────────────────────────
  // El profesor pulsa el botón iluminado (driver.js lo deja pulsable), la pantalla
  // lo reporta al contexto y el tour avanza solo tras un instante, para que se vea
  // el check verde antes de moverse. "Siguiente" sigue estando para el que
  // prefiera leer de corrido.
  useEffect(() => {
    const d = driverRef.current;
    if (!d || mode !== 'auto' || !d.isActive()) return;
    const idx = d.getActiveIndex();
    if (idx === undefined) return;
    const actual = ONBOARDING_STEPS[idx];
    if (!actual) return;
    // Solo se avanza si el paso QUE SE ESTÁ VIENDO acaba de cumplirse. Si el
    // profesor cumplió otro (subió el transcript de una clase vieja estando en el
    // paso 2), el recorrido se queda donde está: lo que le falta sigue siendo eso.
    if (!done.has(actual.id) && !notApplicable.has(actual.id)) return;
    if (d.isLastStep()) return;
    const t = setTimeout(() => {
      if (driverRef.current?.isActive()) driverRef.current.moveNext();
    }, 550);
    return () => clearTimeout(t);
  }, [done, notApplicable, mode]);

  // ── Reposición ante cambios de la lista ─────────────────────────────────────
  // La agenda se repinta sola (recarga de datos cada 60 s, filtros, un transcript
  // guardado). Sin esto el recorte se quedaría sobre la posición vieja.
  useEffect(() => {
    if (mode === 'off') return;
    const t = setInterval(() => {
      const d = driverRef.current;
      if (d?.isActive()) d.refresh();
    }, 1000);
    return () => clearInterval(t);
  }, [mode]);

  // Paso opcional sin botón a la vista: se marca como no aplicable para que la
  // lógica no lo espere. driver.js ya lo salta visualmente con
  // `skipMissingElement`; esto es la contraparte en el contexto.
  useEffect(() => {
    if (mode !== 'auto' || pathname !== RUTA_CLASES) return;
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

  // ── Llamada a la formación desde otra pantalla ──────────────────────────────
  // Un profesor entra a la app en /teacher (el Calendario), no en /clases, así que
  // sin esto el tour automático no se lanzaría nunca: sus botones viven en la
  // agenda. Es un aviso discreto y no bloqueante, no un segundo overlay.
  if (mode === 'auto' && pathname !== RUTA_CLASES) {
    return createPortal(
      <button className="drc-tour-nudge" onClick={() => router.push(RUTA_CLASES)}>
        <span className="drc-tour-nudge-dot" aria-hidden />
        <span>
          <b>{formationLabel(classesCompleted)}</b>
          <span className="drc-tour-nudge-cta">Ver el tutorial en Mis clases →</span>
        </span>
      </button>,
      document.body,
    );
  }

  return null;
}
