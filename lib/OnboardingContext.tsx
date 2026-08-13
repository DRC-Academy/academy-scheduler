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
//   · Acá vive la LÓGICA: quién está en onboarding, qué pasos se cumplieron, el
//     contador de clases y las escrituras a Supabase.
//   · La NAVEGACIÓN del recorrido (qué paso se ve, avanzar, retroceder) la lleva
//     driver.js dentro del Tour. No se duplica acá: tener dos punteros sobre el
//     mismo recorrido es exactamente lo que hacía que el paso se moviera solo
//     hacia atrás cuando llegaba una acción real.
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
  type OnboardingStepId,
} from '@/lib/onboarding';
import { dbStartOnboarding, dbSkipOnboarding, dbCompleteOnboardingClass } from '@/lib/onboardingStore';

export type OnboardingMode = 'off' | 'auto' | 'manual';

interface OnboardingApi {
  mode: OnboardingMode;
  /** Pasos ya cumplidos por una acción real (check verde). */
  done: Set<OnboardingStepId>;
  /** Pasos que ahora no aplican. No son checks: solo no frenan el recorrido. */
  notApplicable: Set<OnboardingStepId>;
  /** Índice del primer paso ni cumplido ni descartado: por ahí arranca el automático. */
  firstPendingIndex: number;
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
  mode: 'off', done: new Set(), notApplicable: new Set(), firstPendingIndex: 0,
  classesCompleted: 0, available: false, finishedNotice: false,
  openManual: noop, close: noop, skipAuto: noop, dismissFinished: noop,
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

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { teachers } = useTeachers();

  const teacher = useMemo(
    () => (user?.role === 'teacher' ? teachers.find(t => t.id === user.teacherId) ?? null : null),
    [user, teachers],
  );

  const [mode, setMode] = useState<OnboardingMode>('off');
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

  const resetChecks = useCallback(() => {
    doneRef.current = new Set();
    naRef.current = new Set();
    setDone(new Set());
    setNotApplicable(new Set());
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
    resetChecks();
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

  const reportAction = useCallback((id: OnboardingStepId) => {
    if (modeRef.current !== 'auto') return;
    if (doneRef.current.has(id)) return;
    const nextDone = new Set(doneRef.current).add(id);
    doneRef.current = nextDone;
    if (cerrarCicloSiCompleto(nextDone, naRef.current)) return;
    setDone(nextDone);
  }, [cerrarCicloSiCompleto]);

  const markNotApplicable = useCallback((id: OnboardingStepId) => {
    if (modeRef.current !== 'auto') return;
    if (naRef.current.has(id)) return;
    const nextNa = new Set(naRef.current).add(id);
    naRef.current = nextNa;
    if (cerrarCicloSiCompleto(doneRef.current, nextNa)) return;
    setNotApplicable(nextNa);
  }, [cerrarCicloSiCompleto]);

  const firstPendingIndex = useMemo(() => {
    const i = ONBOARDING_STEPS.findIndex(s => !done.has(s.id) && !notApplicable.has(s.id));
    return i === -1 ? 0 : i;
  }, [done, notApplicable]);

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
    mode, done, notApplicable, firstPendingIndex, classesCompleted,
    available: !!teacher, finishedNotice,
    openManual, close, skipAuto, dismissFinished,
    reportAction, markNotApplicable, reportClassCompleted,
  }), [
    mode, done, notApplicable, firstPendingIndex, classesCompleted, teacher, finishedNotice,
    openManual, close, skipAuto, dismissFinished,
    reportAction, markNotApplicable, reportClassCompleted,
  ]);

  return <OnboardingContext.Provider value={api}>{children}</OnboardingContext.Provider>;
}
