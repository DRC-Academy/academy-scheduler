'use client';
// ── Estado del tutorial guiado del profesor ───────────────────────────────────
//
// Un solo recorrido (lib/onboarding.ONBOARDING_STEPS) con dos modos de entrada:
//
//   'auto'   Profesor NUEVO. Arranca solo durante sus primeras 5 clases y los
//            pasos se marcan cuando el profesor hace la acción de verdad, no
//            cuando la lee. Saltarlo o terminarlo lo apaga en la base.
//   'manual' Botón "Tutorial" del header. Lo puede abrir CUALQUIER profesor, las
//            veces que quiera, y no escribe nada.
//
// REPARTO DE RESPONSABILIDADES con components/OnboardingTour:
//   · Acá vive el ESTADO: quién está en onboarding, qué pasos se cumplieron, el
//     contador de clases, las escrituras a Supabase y el PASO ACTUAL.
//   · El Tour solo PINTA ese paso con driver.js y traduce los clics de
//     "Siguiente"/"Anterior" en llamadas a `goToStep`.
//
// El paso actual vive acá y no dentro de driver.js porque el recorrido CAMBIA DE
// PANTALLA (el último paso está en Finanzas): al navegar, driver.js se destruye
// y se reconstruye, así que su índice interno se perdería. Este provider cuelga
// del layout raíz y sobrevive a las navegaciones de cliente.
//
// Sigue habiendo UN solo dueño del puntero —este— para no repetir el fallo de
// tener dos, que hacía que el paso se moviera solo hacia atrás al llegar una
// acción real.
//
// El progreso se siembra UNA vez desde la fila del profesor. TeachersContext
// recarga la lista cada 60 s y releerlo en cada recarga pisaría lo que el profesor
// acaba de hacer con una respuesta de hace un instante.
import {
  createContext, useContext, useState, useEffect, useCallback, useRef, useMemo,
  type ReactNode,
} from 'react';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import {
  ONBOARDING_STEPS, ONBOARDING_TARGET_CLASSES, isAutoOnboarding,
  type OnboardingStep, type OnboardingStepId,
} from '@/lib/onboarding';
import { dbStartOnboarding, dbSkipOnboarding, dbCompleteOnboardingClass } from '@/lib/onboardingStore';

export type OnboardingMode = 'off' | 'auto' | 'manual';

interface OnboardingApi {
  mode: OnboardingMode;
  /** Pasos ya cumplidos por una acción real (check verde). */
  done: Set<OnboardingStepId>;
  /** Pasos que ahora no aplican. No son checks: solo no frenan el recorrido. */
  notApplicable: Set<OnboardingStepId>;
  /** Paso a la vista. Vive acá porque el recorrido cruza pantallas. */
  stepIndex: number;
  step: OnboardingStep;
  totalSteps: number;
  classesCompleted: number;
  /** Hay un profesor con sesión: es lo único que pide el botón del header. */
  available: boolean;
  /** Cartel de "¡Formación completada!" pendiente de leer. */
  finishedNotice: boolean;

  /** Botón "Tutorial" del header. */
  openManual: () => void;
  /** Cierra el recorrido sin decidir nada: el automático puede volver a salir. */
  close: () => void;
  /** "Saltar tutorial": termina el automático (el botón del header sigue). */
  skipAuto: () => void;
  dismissFinished: () => void;
  goToStep: (index: number) => void;
  next: () => void;
  prev: () => void;

  /**
   * La pantalla avisa que el profesor hizo la acción REAL de un paso. En modo
   * automático marca el check; en manual no hace nada (ahí manda el profesor).
   */
  reportAction: (id: OnboardingStepId) => void;
  /**
   * Este paso no aplica ahora (su botón no existe en ninguna clase a la vista).
   * Solo para pasos `optional`: la presentación se envía una vez por alumno, así
   * que desde el segundo día ese botón ya no está.
   */
  markNotApplicable: (id: OnboardingStepId) => void;
  /**
   * Se cerró el ciclo completo de UNA clase (ingreso registrado + transcript
   * subido). `classKey` identifica la clase para no contarla dos veces si el
   * profesor reemplaza el transcript.
   */
  reportClassCompleted: (classKey: string) => void;
}

const noop = () => {};
const OnboardingContext = createContext<OnboardingApi>({
  mode: 'off', done: new Set(), notApplicable: new Set(),
  stepIndex: 0, step: ONBOARDING_STEPS[0], totalSteps: ONBOARDING_STEPS.length,
  classesCompleted: 0, available: false, finishedNotice: false,
  openManual: noop, close: noop, skipAuto: noop, dismissFinished: noop,
  goToStep: noop, next: noop, prev: noop,
  reportAction: noop, markNotApplicable: noop, reportClassCompleted: noop,
});

export const useOnboarding = () => useContext(OnboardingContext);

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
 * Pasos de ORIENTACIÓN ya vistos (`once`). Se guardan aparte de las clases
 * completadas porque su vida es distinta: una clase se cuenta una vez, pero
 * "ya sabe dónde está el calendario" tiene que sobrevivir a los cinco ciclos de
 * la formación y a cerrar sesión.
 *
 * En localStorage y no en la base a propósito: es una preferencia de comodidad,
 * no un dato de negocio, y perderla al cambiar de equipo solo significa que el
 * profesor ve un paso de más una vez.
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

/** Pasos `once` que ya están cumplidos dentro de un conjunto dado. */
function soloOnce(done: Set<OnboardingStepId>): Set<OnboardingStepId> {
  return new Set(ONBOARDING_STEPS.filter(s => s.once && done.has(s.id)).map(s => s.id));
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { teachers } = useTeachers();

  const teacher = useMemo(
    () => (user?.role === 'teacher' ? teachers.find(t => t.id === user.teacherId) ?? null : null),
    [user, teachers],
  );

  const [mode, setMode] = useState<OnboardingMode>('off');
  const [stepIndex, setStepIndex] = useState(0);
  const stepRef = useRef(0);
  const [done, setDone] = useState<Set<OnboardingStepId>>(new Set());
  const [notApplicable, setNotApplicable] = useState<Set<OnboardingStepId>>(new Set());
  const [classesCompleted, setClassesCompleted] = useState(0);
  const [finishedNotice, setFinishedNotice] = useState(false);

  // El progreso se siembra una sola vez por profesor (ver cabecera del archivo).
  const seededFor = useRef<string | null>(null);
  // Espejos de lectura síncrona: los callbacks necesitan el valor de AHORA sin
  // re-crearse. Leerlo dentro de un actualizador de estado no vale (React puede
  // llamarlo dos veces y duplicaría la escritura en la base).
  const modeRef = useRef<OnboardingMode>('off');
  const completedRef = useRef(0);
  const doneRef = useRef<Set<OnboardingStepId>>(new Set());
  const naRef = useRef<Set<OnboardingStepId>>(new Set());
  /** El automático ya terminó en esta sesión (saltado o completado). */
  const autoEndedRef = useRef(false);
  // Guarda contra el doble conteo antes incluso de que vuelva la escritura.
  const countedRef = useRef<Set<string>>(new Set());

  const applyMode = useCallback((m: OnboardingMode) => {
    modeRef.current = m;
    setMode(m);
  }, []);

  /**
   * Cierre de ciclo entre clases: se vacían los checks del SOP pero se CONSERVAN
   * los pasos de orientación (`once`). Sin eso, un profesor en su quinta clase
   * volvería a recibir "marca tu disponibilidad" y "aquí viven tus alumnos", que
   * ya vio el primer día.
   */
  const resetChecks = useCallback(() => {
    const conservados = soloOnce(doneRef.current);
    doneRef.current = conservados;
    naRef.current = new Set();
    setDone(conservados);
    setNotApplicable(new Set());
    stepRef.current = 0;
    setStepIndex(0);
  }, []);

  /** Primer paso ni cumplido ni descartado. Es por donde retoma el automático. */
  const firstPending = useCallback(() => {
    const i = ONBOARDING_STEPS.findIndex(s => !doneRef.current.has(s.id) && !naRef.current.has(s.id));
    return i === -1 ? ONBOARDING_STEPS.length - 1 : i;
  }, []);

  // Siembra del progreso desde la fila del profesor. Es una sincronización con un
  // sistema externo (la base), no algo derivable en render: lo que deja acá lo van
  // moviendo después las acciones del profesor.
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
    // Los pasos de orientación ya vistos arrancan cumplidos: el recorrido empieza
    // donde el profesor lo dejó, no desde cero cada vez que abre la app.
    const vistos = readOnce(teacher.id);
    doneRef.current = vistos;
    naRef.current = new Set();
    setDone(vistos);
    setNotApplicable(new Set());
    stepRef.current = 0;
    setStepIndex(0);
    countedRef.current = readCounted(teacher.id);

    if (isAutoOnboarding(teacher)) {
      applyMode('auto');
      dbStartOnboarding(teacher.id);
    } else {
      applyMode('off');
    }
  }, [teacher, applyMode, resetChecks]);

  const openManual = useCallback(() => {
    // El manual pisa al automático mientras está abierto: son el mismo recorrido
    // y dos overlays a la vez no tendría sentido. Al cerrarlo vuelve el automático.
    // Arranca desde el principio: es un repaso completo, no una continuación.
    stepRef.current = 0;
    setStepIndex(0);
    applyMode('manual');
  }, [applyMode]);

  const close = useCallback(() => {
    // No se relee `isAutoOnboarding(teacher)` a secas: la fila en memoria puede
    // traer todavía el contador viejo. Mandan el progreso local y el ref de "ya
    // terminó", que son los que están al día.
    const volverAlAuto = !autoEndedRef.current
      && teacher?.onboardingActive === true
      && completedRef.current < ONBOARDING_TARGET_CLASSES;
    applyMode(volverAlAuto ? 'auto' : 'off');
  }, [teacher, applyMode]);

  const skipAuto = useCallback(() => {
    autoEndedRef.current = true;
    applyMode('off');
    if (teacher) dbSkipOnboarding(teacher.id);
  }, [teacher, applyMode]);

  const dismissFinished = useCallback(() => setFinishedNotice(false), []);

  /**
   * Cierre del ciclo: con los 5 pasos cubiertos (cumplidos o descartados) los
   * checks se vacían y el recorrido queda listo para acompañar a la clase
   * siguiente, que es la razón de que la formación dure 5 clases.
   *
   * Se dispara acá y NO al contar la clase: el conteo ocurre al guardar el
   * transcript, o sea en el paso 4, y reiniciar ahí se llevaba por delante el
   * paso 5 antes de que el profesor llegara a verlo.
   */
  const cerrarCicloSiCompleto = useCallback((nextDone: Set<OnboardingStepId>, nextNa: Set<OnboardingStepId>) => {
    const completo = ONBOARDING_STEPS.every(s => nextDone.has(s.id) || nextNa.has(s.id));
    if (!completo) return false;
    resetChecks();
    return true;
  }, [resetChecks]);

  const goToStep = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, ONBOARDING_STEPS.length - 1));
    stepRef.current = clamped;
    setStepIndex(clamped);
  }, []);

  const next = useCallback(() => goToStep(stepRef.current + 1), [goToStep]);
  const prev = useCallback(() => goToStep(stepRef.current - 1), [goToStep]);

  /**
   * Avanza SOLO si el paso que se acaba de cerrar es el que el profesor está
   * viendo. Si cumplió otro (subió el transcript de una clase vieja estando en el
   * paso 2), el recorrido se queda donde está: lo que le falta sigue siendo eso.
   */
  const avanzarSiEraElActual = useCallback((id: OnboardingStepId) => {
    if (ONBOARDING_STEPS[stepRef.current]?.id !== id) return;
    const siguiente = firstPending();
    // Nunca hacia atrás: un paso anterior sin marcar no debe retroceder el tour.
    if (siguiente > stepRef.current) goToStep(siguiente);
    else goToStep(stepRef.current + 1);
  }, [firstPending, goToStep]);

  const reportAction = useCallback((id: OnboardingStepId) => {
    if (modeRef.current !== 'auto') return;
    if (doneRef.current.has(id)) return;
    const nextDone = new Set(doneRef.current).add(id);
    doneRef.current = nextDone;
    if (teacher) writeOnce(teacher.id, soloOnce(nextDone));
    if (cerrarCicloSiCompleto(nextDone, naRef.current)) return;
    setDone(nextDone);
    avanzarSiEraElActual(id);
  }, [cerrarCicloSiCompleto, avanzarSiEraElActual, teacher]);

  const markNotApplicable = useCallback((id: OnboardingStepId) => {
    if (modeRef.current !== 'auto') return;
    if (naRef.current.has(id)) return;
    const nextNa = new Set(naRef.current).add(id);
    naRef.current = nextNa;
    if (cerrarCicloSiCompleto(doneRef.current, nextNa)) return;
    setNotApplicable(nextNa);
    avanzarSiEraElActual(id);
  }, [cerrarCicloSiCompleto, avanzarSiEraElActual]);

  const reportClassCompleted = useCallback((classKey: string) => {
    if (!teacher || modeRef.current !== 'auto') return;
    if (countedRef.current.has(classKey)) return;

    countedRef.current.add(classKey);
    writeCounted(teacher.id, countedRef.current);

    // Los checks NO se tocan acá (ver cerrarCicloSiCompleto).
    const expected = completedRef.current;
    completedRef.current = expected + 1;
    setClassesCompleted(expected + 1);

    dbCompleteOnboardingClass(teacher.id, expected).then(({ classesCompleted: saved, finished }) => {
      completedRef.current = saved;
      setClassesCompleted(saved);
      if (!finished) return;
      autoEndedRef.current = true;
      applyMode('off');
      setFinishedNotice(true);
    });
  }, [teacher, applyMode]);

  const api = useMemo<OnboardingApi>(() => ({
    mode, done, notApplicable, classesCompleted,
    stepIndex,
    step: ONBOARDING_STEPS[stepIndex] ?? ONBOARDING_STEPS[0],
    totalSteps: ONBOARDING_STEPS.length,
    available: !!teacher, finishedNotice,
    openManual, close, skipAuto, dismissFinished, goToStep, next, prev,
    reportAction, markNotApplicable, reportClassCompleted,
  }), [
    mode, done, notApplicable, stepIndex, classesCompleted, teacher, finishedNotice,
    openManual, close, skipAuto, dismissFinished, goToStep, next, prev,
    reportAction, markNotApplicable, reportClassCompleted,
  ]);

  return <OnboardingContext.Provider value={api}>{children}</OnboardingContext.Provider>;
}
