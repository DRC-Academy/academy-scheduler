'use client';
// ── Motor del tutorial guiado del profesor ────────────────────────────────────
//
// Un solo recorrido (lib/onboarding.ONBOARDING_STEPS) con dos modos de entrada:
//
//   'auto'   Profesor NUEVO. Arranca solo durante sus primeras 5 clases, retoma
//            donde quedó y escribe su progreso en la base. Los pasos que hoy no
//            aplican se SALTAN: se le está pidiendo que haga cosas, y no se le
//            puede pedir que pulse un botón que no está.
//   'manual' Botón "Tutorial" del header. Cualquier profesor, las veces que
//            quiera, SIEMPRE desde el paso 1, y no escribe NADA en la base. Aquí
//            NO se salta ningún paso: es un repaso del procedimiento completo, y
//            lo que no se pueda anclar se muestra centrado con su "Dónde está".
//
// ── EL MOTOR ─────────────────────────────────────────────────────────────────
//
// `irAlPaso` es una función asíncrona que, para cada paso y en este orden:
//
//   1. evalúa `requires()`;
//   2. navega y ESPERA a que `usePathname()` sea la ruta pedida (tope 5 s);
//   3. ejecuta `onEnter()` (abrir el modal, por ejemplo);
//   4. espera al elemento con MutationObserver (tope 3 s);
//   5. si no aparece, aplica `onMissing` y DEJA CONSTANCIA con un warn;
//   6. solo entonces publica el paso, ya con su elemento resuelto.
//
// Ninguna de esas esperas es un `setTimeout` de N milisegundos: son esperas por
// condición con fecha límite (ver lib/tourEngine). El retardo fijo era la causa
// de los globos huérfanos — se apostaba a que la pantalla tardaba menos de 1,2 s
// y, cuando perdía, el paso se anclaba a un elemento fantasma.
//
// El paso se resuelve ENTERO antes de pintarse, así que driver.js recibe un
// elemento ya existente y visible. Es la razón de que no pueda haber un popover
// sin foco por accidente: si no hay elemento, o el paso se saltó (y quedó
// registrado en `skipped`) o se centró a propósito.
//
// GUARD DE REENTRADA: mientras una transición está en curso, `busyRef` descarta
// los clics repetidos en "Siguiente". Sin él, dos transiciones concurrentes se
// pisaban el elemento resuelto.
import {
  createContext, useContext, useState, useEffect, useCallback, useRef, useMemo,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import {
  ONBOARDING_STEPS, ONBOARDING_TARGET_CLASSES, ONBOARDING_SIGNATURE,
  ANCLA_MODAL_PRESENTACION, isAutoOnboarding, selectorsOf, indexAfterBlock,
  esRutaDeProfesor, type TourStep, type OnboardingStepId,
} from '@/lib/onboarding';
import { enRutaDelPaso, destinoDelPaso } from '@/lib/tourConfig';
import {
  waitFor, waitForElement, waitForElementOrGiveUp, waitForElementGone, ROUTE_TIMEOUT_MS,
} from '@/lib/tourEngine';
import { onPresentationModalClosed } from '@/lib/tourBridge';
import { dbStartOnboarding, dbSkipOnboarding, dbCompleteOnboardingClass } from '@/lib/onboardingStore';

export type OnboardingMode = 'off' | 'auto' | 'manual';
/** 'transitioning' = navegando o esperando el elemento; el tour no pinta nada. */
export type TourPhase = 'idle' | 'transitioning' | 'ready';

/** Lo que CAMBIA con cada paso. Solo lo consume el pintor (OnboardingTour). */
export interface OnboardingState {
  mode: OnboardingMode;
  phase: TourPhase;
  stepIndex: number;
  step: TourStep;
  totalSteps: number;
  /** Elemento YA resuelto del paso. null = globo centrado a propósito. */
  anchor: HTMLElement | null;
  done: Set<OnboardingStepId>;
  /** Pasos que el motor descartó, con el motivo. No son checks: son constancia. */
  skipped: Map<OnboardingStepId, string>;
  classesCompleted: number;
  available: boolean;
  finishedNotice: boolean;
}

/**
 * Lo que NO cambia nunca. Es el contexto que consumen las pantallas de la app
 * (MisClasesPanel, StudentCard, PresentationModal, NavBar): así el tutorial puede
 * avanzar sin provocar un solo render en la pantalla que está señalando.
 */
export interface OnboardingActions {
  openManual: () => void;
  /** Reanuda el automático en el paso guardado (cartel flotante). */
  resume: () => void;
  /** Vuelve a resolver el ancla del paso actual si el nodo se desconectó. */
  reanchor: () => void;
  close: () => void;
  skipAuto: () => void;
  dismissFinished: () => void;
  next: () => void;
  prev: () => void;
  reportAction: (id: OnboardingStepId) => void;
  reportClassCompleted: (classKey: string) => void;
}

const noop = () => {};

const OnboardingStateContext = createContext<OnboardingState>({
  mode: 'off', phase: 'idle', stepIndex: 0, step: ONBOARDING_STEPS[0],
  totalSteps: ONBOARDING_STEPS.length, anchor: null,
  done: new Set(), skipped: new Map(), classesCompleted: 0,
  available: false, finishedNotice: false,
});

const OnboardingActionsContext = createContext<OnboardingActions>({
  openManual: noop, resume: noop, reanchor: noop, close: noop, skipAuto: noop,
  dismissFinished: noop, next: noop, prev: noop,
  reportAction: noop, reportClassCompleted: noop,
});

/**
 * Acciones del tutorial. Es lo que usan las PANTALLAS para avisar de una acción
 * real del profesor. Nunca cambia de identidad, así que suscribirse no expone a
 * la pantalla a re-renderizarse cada vez que el tutorial avanza.
 */
export const useOnboardingActions = () => useContext(OnboardingActionsContext);

/** Estado + acciones. Solo para el pintor: re-renderiza en cada paso. */
export function useOnboarding(): OnboardingState & OnboardingActions {
  const estado = useContext(OnboardingStateContext);
  const acciones = useContext(OnboardingActionsContext);
  return { ...estado, ...acciones };
}

// ── Persistencia local ───────────────────────────────────────────────────────

/**
 * Índice del paso, en sessionStorage y con CLAVE VERSIONADA.
 *
 * Se guarda junto a la firma de la lista (nº de pasos + ids). Si mañana se añade
 * un paso, el índice guardado deja de significar lo mismo y se descarta en vez de
 * reanudar en un paso equivocado. La `_v2` del nombre marca el cambio de formato
 * respecto de la versión que no guardaba firma.
 */
const STEP_KEY = 'drc_tour_step_v2';

function readSavedIndex(): number | null {
  try {
    const raw = sessionStorage.getItem(STEP_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { sig?: string; index?: number };
    if (o?.sig !== ONBOARDING_SIGNATURE) return null;
    const i = Number(o.index);
    return Number.isInteger(i) && i >= 0 && i < ONBOARDING_STEPS.length ? i : null;
  } catch { return null; }
}

function writeSavedIndex(index: number): void {
  try { sessionStorage.setItem(STEP_KEY, JSON.stringify({ sig: ONBOARDING_SIGNATURE, index })); }
  catch { /* modo privado */ }
}

function clearSavedIndex(): void {
  try { sessionStorage.removeItem(STEP_KEY); } catch { /* modo privado */ }
}

/** Clases ya contadas, para que reemplazar un transcript no sume otra vez. */
function countedKey(teacherId: string) { return `drc_onboarding_counted_${teacherId}`; }

function readCounted(teacherId: string): Set<string> {
  try {
    const raw = localStorage.getItem(countedKey(teacherId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch { return new Set(); }
}

function writeCounted(teacherId: string, keys: Set<string>) {
  try { localStorage.setItem(countedKey(teacherId), JSON.stringify([...keys])); } catch { /* modo privado */ }
}

/**
 * Pasos de ORIENTACIÓN ya vistos (`once`). Aparte de las clases completadas
 * porque su vida es distinta: una clase se cuenta una vez, pero "ya sabe dónde
 * está el calendario" tiene que sobrevivir a los cinco ciclos de la formación.
 */
function onceKey(teacherId: string) { return `drc_onboarding_once_${teacherId}`; }

function readOnce(teacherId: string): Set<OnboardingStepId> {
  try {
    const raw = localStorage.getItem(onceKey(teacherId));
    const ids = raw ? (JSON.parse(raw) as string[]) : [];
    const validos = new Set(ONBOARDING_STEPS.filter(s => s.once).map(s => s.id as string));
    return new Set(ids.filter(id => validos.has(id)) as OnboardingStepId[]);
  } catch { return new Set(); }
}

function writeOnce(teacherId: string, ids: Set<OnboardingStepId>) {
  try { localStorage.setItem(onceKey(teacherId), JSON.stringify([...ids])); } catch { /* modo privado */ }
}

function soloOnce(done: Set<OnboardingStepId>): Set<OnboardingStepId> {
  return new Set(ONBOARDING_STEPS.filter(s => s.once && done.has(s.id)).map(s => s.id));
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { teachers } = useTeachers();
  const pathname = usePathname();
  const router = useRouter();

  const teacher = useMemo(
    () => (user?.role === 'teacher' ? teachers.find(t => t.id === user.teacherId) ?? null : null),
    [user, teachers],
  );

  const [mode, setMode] = useState<OnboardingMode>('off');
  const [phase, setPhase] = useState<TourPhase>('idle');
  const [stepIndex, setStepIndex] = useState(0);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [done, setDone] = useState<Set<OnboardingStepId>>(new Set());
  const [skipped, setSkipped] = useState<Map<OnboardingStepId, string>>(new Map());
  const [classesCompleted, setClassesCompleted] = useState(0);
  const [finishedNotice, setFinishedNotice] = useState(false);

  // Espejos de lectura síncrona: el motor corre dentro de una función asíncrona,
  // fuera del ciclo de render, y necesita el valor de AHORA.
  const modeRef = useRef<OnboardingMode>('off');
  const indexRef = useRef(0);
  const pathnameRef = useRef(pathname);
  const doneRef = useRef<Set<OnboardingStepId>>(new Set());
  const completedRef = useRef(0);
  const countedRef = useRef<Set<string>>(new Set());
  const autoEndedRef = useRef(false);
  const seededFor = useRef<string | null>(null);
  /** Espejo del profesor: permite que los callbacks no dependan de él (ver ACCIONES). */
  const teacherRef = useRef(teacher);
  /** Transición en curso: guard de reentrada contra el doble clic en "Siguiente". */
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // ── Espera de ruta ──────────────────────────────────────────────────────────
  // Los cambios de ruta llegan por React, no por el DOM, así que la espera se
  // suscribe a `usePathname` en vez de sondear `window.location`: el motor sigue
  // exactamente cuando el router terminó, ni un milisegundo fijo después.
  //
  // El espejo y el aviso van en el MISMO efecto para garantizar el orden: si
  // fueran dos, el que despierta a los que esperan podría correr antes que el que
  // actualiza `pathnameRef` y la comprobación leería la ruta anterior.
  const routeWaiters = useRef(new Set<() => void>());
  useEffect(() => { teacherRef.current = teacher; });
  useEffect(() => {
    pathnameRef.current = pathname;
    for (const w of [...routeWaiters.current]) w();
  }, [pathname]);

  const waitForRoute = useCallback((step: TourStep, signal: AbortSignal) => {
    return waitFor(
      () => (enRutaDelPaso(step, pathnameRef.current) ? true : null),
      recheck => {
        routeWaiters.current.add(recheck);
        return () => { routeWaiters.current.delete(recheck); };
      },
      { timeoutMs: ROUTE_TIMEOUT_MS, signal },
    ).then(v => v === true);
  }, []);

  const applyMode = useCallback((m: OnboardingMode) => {
    modeRef.current = m;
    setMode(m);
  }, []);

  const registrarSalto = useCallback((step: TourStep, motivo: string) => {
    console.warn(`[tour] paso "${step.id}" omitido: ${motivo}`);
    setSkipped(prev => {
      if (prev.get(step.id) === motivo) return prev;
      const next = new Map(prev);
      next.set(step.id, motivo);
      return next;
    });
  }, []);

  /** Apaga el recorrido sin decidir nada sobre la formación. */
  const detener = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setAnchor(null);
    setPhase('idle');
  }, []);

  // ── EL MOTOR ────────────────────────────────────────────────────────────────
  const irAlPaso = useCallback(async (target: number, dir: 1 | -1 = 1) => {
    if (modeRef.current === 'off') return;
    if (busyRef.current) return;                       // guard de reentrada
    busyRef.current = true;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase('transitioning');
    setAnchor(null);

    try {
      // Deshacer lo que montó el paso que se abandona (cerrar el modal), pero solo
      // si el destino sale de su bloque: moverse DENTRO del bloque del email no
      // puede cerrar el modal que ese mismo bloque necesita.
      const saliendo = ONBOARDING_STEPS[indexRef.current];
      const destinoPaso = ONBOARDING_STEPS[target];
      if (saliendo?.onExit && (!saliendo.block || destinoPaso?.block !== saliendo.block)) {
        await saliendo.onExit();
        await waitForElementGone([ANCLA_MODAL_PRESENTACION], { signal: ac.signal });
      }

      /**
       * Ruta en la que ya se agotó una espera de elemento durante ESTA transición.
       *
       * La primera espera de una pantalla tiene que ser generosa: puede estar
       * cargando sus datos. Pero si se agotó, esa pantalla YA está montada y
       * observada, así que para los pasos siguientes de la MISMA ruta preguntar
       * por su ancla es una consulta al DOM, no una espera. Sin esto, un profesor
       * sin alumnos se comía tres esperas completas seguidas (nueve segundos
       * mirando el globo anterior) para saltar tres pasos de la misma pantalla.
       *
       * Si el botón apareciera más tarde, el re-anclaje periódico lo recoge.
       */
      let rutaYaEsperada: string | null = null;
      const ESPERA_CORTA_MS = 250;

      let i = target;
      while (i >= 0 && i < ONBOARDING_STEPS.length) {
        if (ac.signal.aborted) return;
        const step = ONBOARDING_STEPS[i];
        /** false = se muestra el globo sin foco (decisión explícita, con warn). */
        let anclar = true;

        /**
         * Qué hacer si el paso no se puede anclar, SEGÚN LA VÍA.
         *
         * En automático se salta: al profesor nuevo se le está pidiendo que HAGA
         * cosas, y no se le puede pedir que pulse un botón que hoy no existe (la
         * presentación ya enviada, ninguna clase por delante).
         *
         * En manual NUNCA se salta. El botón "Tutorial" es un repaso del
         * procedimiento completo, y saltarse en silencio los tres pasos del email
         * porque justo hoy no hay ninguna presentación pendiente hacía que el
         * recorrido abriera en "Paso 4 de 12": el profesor ve que le faltan pasos
         * y parece que el tutorial está roto. Se muestran centrados, con la nota
         * "Dónde está" explicando en qué pantalla vive ese botón cuando aparece,
         * que es exactamente lo que un repaso tiene que enseñar.
         */
        const siNoSePuede = modeRef.current === 'manual' ? 'center' : step.onMissing;

        // 1. Precondición de datos.
        if (step.requires && !step.requires()) {
          if (siNoSePuede === 'skip') { registrarSalto(step, 'no se cumple requires()'); i += dir; continue; }
          registrarSalto(step, 'no se cumple requires(), se muestra centrado');
          anclar = false;
        }

        // 2. Ruta: navegar y ESPERAR a que el router la confirme.
        if (!enRutaDelPaso(step, pathnameRef.current)) {
          const destino = destinoDelPaso(step);
          if (!destino) {
            if (siNoSePuede === 'skip') { registrarSalto(step, 'no se pudo resolver su URL'); i += dir; continue; }
            registrarSalto(step, 'no se pudo resolver su URL, se muestra centrado');
            anclar = false;
          } else {
            router.push(destino);
            const llego = await waitForRoute(step, ac.signal);
            if (ac.signal.aborted) return;
            if (!llego) {
              if (siNoSePuede === 'skip') { registrarSalto(step, `la ruta ${destino} no cargó en ${ROUTE_TIMEOUT_MS} ms`); i += dir; continue; }
              registrarSalto(step, `la ruta ${destino} no cargó, se muestra centrado`);
              anclar = false;
            }
          }
        }

        // 3. Preparar la pantalla (abrir el modal).
        if (anclar && step.onEnter) {
          try { await step.onEnter(); }
          catch (e) { console.error(`[tour] onEnter de "${step.id}" falló:`, e); }
          if (ac.signal.aborted) return;
        }

        // 4. Esperar al elemento. Sin selector es un paso informativo: se centra
        //    a propósito y sin warn, porque no señala nada por diseño.
        const selectores = selectorsOf(step);
        let el: HTMLElement | null = null;
        if (anclar && selectores.length > 0) {
          const yaEsperada = rutaYaEsperada === step.route;
          const opciones = {
            signal: ac.signal,
            ...(yaEsperada ? { timeoutMs: ESPERA_CORTA_MS } : {}),
          };
          // Con `requires`, la espera se rinde en cuanto la pantalla ya montada
          // responde que no hay nada que resaltar. Sin esto, el paso que se muestra
          // centrado se comía los 3 s enteros de tope: `requires()` se evaluó antes
          // de navegar, cuando el puente todavía contestaba "no puedo saberlo".
          const requiere = step.requires;
          el = requiere
            ? await waitForElementOrGiveUp(selectores, () => !requiere(), opciones)
            : await waitForElement(selectores, opciones);
          if (ac.signal.aborted) return;
          // 5. No apareció: se aplica onMissing y queda constancia. Nunca en silencio.
          if (!el) {
            rutaYaEsperada = step.route;
            if (siNoSePuede === 'skip') {
              registrarSalto(step, `no apareció "${selectores.join('" ni "')}" en su pantalla`);
              i += dir;
              continue;
            }
            registrarSalto(step, `no apareció "${selectores.join('" ni "')}", se muestra centrado`);
          }
        }

        // 6. Publicar el paso, ya resuelto.
        indexRef.current = i;
        setStepIndex(i);
        setAnchor(el);
        setPhase('ready');
        writeSavedIndex(i);
        // El scroll NO se hace acá: driver.js scrollea por su cuenta dentro de
        // `highlight()` y pisaría el nuestro. `smoothScroll: false` solo lo vuelve
        // instantáneo, no lo desactiva, y para un elemento más alto que la ventana
        // alinea por arriba sin descontar la barra sticky — la parrilla del
        // calendario acababa con su borde superior tapado. Lo hace el pintor
        // DESPUÉS de resaltar (ver components/OnboardingTour).
        return;
      }

      // Se recorrió la lista entera sin encontrar un paso mostrable.
      if (dir === 1) {
        // Hacia adelante = se terminó el recorrido.
        setPhase('idle');
        cerrarRef.current();
      } else {
        // Hacia atrás desde el primero: quedarse donde estaba.
        setPhase('ready');
      }
    } finally {
      busyRef.current = false;
    }
  }, [router, waitForRoute, registrarSalto]);

  // `cerrar`, `reanchor` e `irAlPaso` se necesitan mutuamente; los refs rompen el
  // ciclo sin recrear los callbacks en cada render.
  const cerrarRef = useRef<() => void>(() => {});
  const irAlPasoRef = useRef(irAlPaso);
  useEffect(() => { irAlPasoRef.current = irAlPaso; });

  const close = useCallback(() => {
    detener();
    // No se relee `isAutoOnboarding(teacher)` a secas: la fila en memoria puede
    // traer todavía el contador viejo. Mandan el progreso local y el ref de "ya
    // terminó", que son los que están al día.
    const volverAlAuto = !autoEndedRef.current
      && teacherRef.current?.onboardingActive === true
      && completedRef.current < ONBOARDING_TARGET_CLASSES;
    applyMode(volverAlAuto ? 'auto' : 'off');
    if (!volverAlAuto) clearSavedIndex();
  }, [applyMode, detener]);
  useEffect(() => { cerrarRef.current = close; });

  const openManual = useCallback(() => {
    // Repaso completo: SIEMPRE desde el paso 1, y sin escribir nada en la base.
    indexRef.current = 0;
    setStepIndex(0);
    setSkipped(new Map());
    applyMode('manual');
    void irAlPasoRef.current(0, 1);
  }, [applyMode]);

  const skipAuto = useCallback(() => {
    autoEndedRef.current = true;
    detener();
    applyMode('off');
    clearSavedIndex();
    const t = teacherRef.current;
    if (t) dbSkipOnboarding(t.id);
  }, [applyMode, detener]);

  /** Reanuda el automático donde quedó, sin reiniciar nada. */
  const resume = useCallback(() => { void irAlPasoRef.current(indexRef.current, 1); }, []);

  /**
   * Vuelve a buscar el elemento del paso actual porque el que había se
   * DESCONECTÓ del documento.
   *
   * Pasa de verdad y a menudo: "Mis clases" recarga sus datos sola cada 60 s (y
   * al volver de un modal), React reemplaza el nodo del botón y el que teníamos
   * resuelto queda huérfano. driver.js seguía resaltando ese nodo huérfano —
   * `getBoundingClientRect()` de un nodo desconectado es todo ceros—, así que el
   * halo desaparecía y el paso se quedaba señalando la nada sin que nadie se
   * enterara. No es una transición: no cambia de paso ni toca la ruta.
   */
  const reanchor = useCallback(async () => {
    // El estado del tour se consulta a través de esta función, no comparando
    // `modeRef.current` a pelo. Motivo de tipos, no de estilo: el guard de entrada
    // estrecharía `modeRef.current` a "auto | manual" y TypeScript mantiene ese
    // estrechamiento a través del await, que es justo donde el valor SÍ puede haber
    // cambiado (el profesor cerró el tour mientras esperábamos). Dentro de una
    // función se lee su tipo real. Va declarada aquí dentro para que `reanchor`
    // conserve su lista de dependencias vacía: las acciones no pueden cambiar de
    // identidad nunca (ver la nota de los dos contextos, más abajo).
    const cerrado = () => modeRef.current === 'off';
    if (busyRef.current || cerrado()) return;
    const step = ONBOARDING_STEPS[indexRef.current];
    const selectores = selectorsOf(step);
    if (selectores.length === 0) return;

    const indice = indexRef.current;
    const el = await waitForElement(selectores, { timeoutMs: 1500 });

    // El re-anclaje NO es una transición y a propósito no toma `busyRef`, así que
    // durante esa espera pudo pasar de todo: el profesor cambió de pantalla desde
    // el menú, el motor avanzó de paso, se cerró el tour. Si el mundo ya no es el
    // de la entrada, lo que se resolvió aquí no vale y aplicarlo pisaría el estado
    // bueno con uno caducado.
    if (cerrado() || busyRef.current) return;
    if (indexRef.current !== indice) return;

    if (el) { setAnchor(prev => (prev === el ? prev : el)); return; }

    // Sin elemento y FUERA de la pantalla del paso: el profesor se fue por su
    // cuenta. Re-ejecutar el paso lo arrastraría de vuelta con un router.push que
    // no pidió (de resincronizar se encarga el efecto de la ruta). Se suelta el
    // ancla muerta para que driver deje de seguirla: con `anchor` a null el pintor
    // resalta el elemento fantasma centrado en vez de un rect de ceros en la
    // esquina.
    if (!enRutaDelPaso(step, pathnameRef.current)) { setAnchor(null); return; }

    // El botón ya no está en pantalla, no es que haya cambiado de nodo. Es el
    // caso real de "Mis clases": en el primer pintado, antes de que entre el
    // reloj, TODAS las clases figuran como futuras y muestran "Ingresar a
    // clase"; al llegar la hora real las de hoy pasan a "dadas" y ese botón
    // desaparece. Se vuelve a ejecutar el paso entero para que su `onMissing`
    // decida de nuevo — que para "Entra a la clase" significa saltarlo y
    // registrarlo, en vez de quedarse señalando un hueco.
    void irAlPasoRef.current(indexRef.current, 1);
  }, []);

  const dismissFinished = useCallback(() => setFinishedNotice(false), []);

  const next = useCallback(() => { void irAlPasoRef.current(indexRef.current + 1, 1); }, []);
  const prev = useCallback(() => { void irAlPasoRef.current(indexRef.current - 1, -1); }, []);

  // ── Siembra del progreso desde la fila del profesor ─────────────────────────
  useEffect(() => {
    if (!teacher) {
      seededFor.current = null;
      autoEndedRef.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      applyMode('off');
      return;
    }
    if (seededFor.current === teacher.id) return;
    seededFor.current = teacher.id;
    autoEndedRef.current = false;

    const completed = teacher.onboardingClassesCompleted ?? 0;
    completedRef.current = completed;
    setClassesCompleted(completed);
    const vistos = readOnce(teacher.id);
    doneRef.current = vistos;
    setDone(vistos);
    countedRef.current = readCounted(teacher.id);

    if (isAutoOnboarding(teacher)) {
      // La vía automática RETOMA donde quedó (sessionStorage versionado).
      const guardado = readSavedIndex() ?? 0;
      indexRef.current = guardado;
      setStepIndex(guardado);
      applyMode('auto');
      dbStartOnboarding(teacher.id);
    } else {
      applyMode('off');
    }
  }, [teacher, applyMode]);

  // ── Arranque del automático ─────────────────────────────────────────────────
  // Separado de la siembra: `irAlPaso` navega, y navegar dentro del efecto que
  // siembra el estado lo volvería a disparar.
  const autoLanzado = useRef(false);
  useEffect(() => {
    if (mode !== 'auto') { autoLanzado.current = false; return; }
    if (autoLanzado.current) return;
    autoLanzado.current = true;
    void irAlPaso(indexRef.current, 1);
  }, [mode, irAlPaso]);

  // ── Fuera del área del profesor: cerrar limpiamente ─────────────────────────
  useEffect(() => {
    if (mode === 'off') return;
    if (esRutaDeProfesor(pathname)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    detener();
    applyMode('off');
  }, [mode, pathname, detener, applyMode]);

  // ── Atrás/adelante del navegador ────────────────────────────────────────────
  // El motor navega y espera, así que durante una transición el desajuste es
  // normal y no se toca. Fuera de ella, si la ruta dejó de coincidir con el paso
  // es porque el profesor usó el historial: se RESINCRONIZA al primer paso de esa
  // pantalla en vez de empujarlo de vuelta, que es lo que hacía antes y dejaba el
  // botón atrás inservible.
  useEffect(() => {
    if (mode === 'off' || busyRef.current) return;
    if (!esRutaDeProfesor(pathname)) return;
    const actual = ONBOARDING_STEPS[indexRef.current];
    if (actual && enRutaDelPaso(actual, pathname)) return;

    const destino = ONBOARDING_STEPS.findIndex(s => enRutaDelPaso(s, pathname));
    if (destino === -1) { cerrarRef.current(); return; }
    void irAlPaso(destino, destino > indexRef.current ? 1 : -1);
  }, [mode, pathname, irAlPaso]);

  // ── El modal se cerró a mitad del bloque ────────────────────────────────────
  // Sin esto driver seguía resaltando un nodo ya desconectado, cuyo
  // getBoundingClientRect() devuelve ceros: el recorte del overlay colapsaba a un
  // punto en la esquina superior izquierda.
  useEffect(() => {
    return onPresentationModalClosed(() => {
      if (modeRef.current === 'off' || busyRef.current) return;
      const actual = ONBOARDING_STEPS[indexRef.current];
      if (actual?.block !== 'presentacion') return;
      void irAlPaso(indexAfterBlock(indexRef.current), 1);
    });
  }, [irAlPaso]);

  // ── Acciones reales del profesor ────────────────────────────────────────────

  /**
   * La pantalla avisa de que el profesor hizo la acción REAL de un paso: se marca
   * el check y, si era el paso a la vista, el recorrido avanza solo.
   *
   * Marca en los DOS modos (es información en pantalla, no un dato de negocio),
   * pero solo el automático deja rastro en localStorage/Supabase.
   */
  const reportAction = useCallback((id: OnboardingStepId) => {
    if (modeRef.current === 'off') return;
    if (doneRef.current.has(id)) return;
    const nextDone = new Set(doneRef.current).add(id);
    doneRef.current = nextDone;
    setDone(nextDone);
    const t = teacherRef.current;
    if (modeRef.current === 'auto' && t) writeOnce(t.id, soloOnce(nextDone));
    // Avanza SOLO si el paso cerrado es el que está a la vista: si cumplió otro
    // (subió el transcript de una clase vieja estando en el paso 2), lo que le
    // falta sigue siendo el paso 2.
    if (ONBOARDING_STEPS[indexRef.current]?.id === id) void irAlPasoRef.current(indexRef.current + 1, 1);
  }, []);

  /**
   * Se cerró el ciclo completo de UNA clase (ingreso registrado + transcript
   * subido). Es lo ÚNICO que incrementa `onboarding_classes_completed`: ni abrir
   * ni cerrar el tutorial lo tocan.
   */
  const reportClassCompleted = useCallback((classKey: string) => {
    const teacher = teacherRef.current;
    if (!teacher || modeRef.current !== 'auto') return;
    if (countedRef.current.has(classKey)) return;

    countedRef.current.add(classKey);
    writeCounted(teacher.id, countedRef.current);

    const expected = completedRef.current;
    completedRef.current = expected + 1;
    setClassesCompleted(expected + 1);

    dbCompleteOnboardingClass(teacher.id, expected).then(({ classesCompleted: saved, finished }) => {
      completedRef.current = saved;
      setClassesCompleted(saved);
      if (!finished) return;
      autoEndedRef.current = true;
      detener();
      applyMode('off');
      clearSavedIndex();
      setFinishedNotice(true);
    });
  }, [applyMode, detener]);

  // Desmontaje del provider: se corta cualquier espera viva.
  useEffect(() => () => { abortRef.current?.abort(); }, []);


  // ── DOS CONTEXTOS, y el motivo importa ──────────────────────────────────────
  //
  // Las ACCIONES son estables para siempre (todos sus callbacks tienen
  // dependencias vacías y leen el presente por refs). El ESTADO cambia en cada
  // paso. Están separados porque, si fueran uno solo, cada avance del tutorial
  // re-renderizaría TODA pantalla que use `reportAction` — y eso resultó ser
  // catastrófico, no solo ineficiente:
  //
  //   `ClassRow` está declarado DENTRO de MisClasesPanel, así que cada render del
  //   panel crea un tipo de componente nuevo y React desmonta y REMONTA todas las
  //   tarjetas, reemplazando sus nodos del DOM. El tour resolvía el botón,
  //   publicaba el ancla, el panel se re-renderizaba por ese mismo cambio de
  //   contexto, el nodo moría, el tour volvía a anclar… y así indefinidamente: el
  //   recorrido se quedaba clavado en el paso 10 sin que "Siguiente" hiciera nada.
  //
  // Con la separación, las pantallas solo consumen `useOnboardingActions()` (que
  // nunca cambia) y el estado se queda donde tiene que estar: en el pintor.
  //
  // NOTA para más adelante: sacar `ClassRow` fuera de `MisClasesPanel` sigue
  // siendo lo correcto —remontar 30 tarjetas en cada render es caro y tira
  // cualquier foco o scroll interno—, pero es un refactor aparte del tutorial.
  const acciones = useMemo<OnboardingActions>(() => ({
    openManual, resume, reanchor, close, skipAuto, dismissFinished, next, prev,
    reportAction, reportClassCompleted,
  }), [
    openManual, resume, reanchor, close, skipAuto, dismissFinished, next, prev,
    reportAction, reportClassCompleted,
  ]);

  const estado = useMemo<OnboardingState>(() => ({
    mode, phase, stepIndex,
    step: ONBOARDING_STEPS[stepIndex] ?? ONBOARDING_STEPS[0],
    totalSteps: ONBOARDING_STEPS.length,
    anchor, done, skipped, classesCompleted,
    available: !!teacher, finishedNotice,
  }), [mode, phase, stepIndex, anchor, done, skipped, classesCompleted, teacher, finishedNotice]);

  return (
    <OnboardingActionsContext.Provider value={acciones}>
      <OnboardingStateContext.Provider value={estado}>
        {children}
      </OnboardingStateContext.Provider>
    </OnboardingActionsContext.Provider>
  );
}
