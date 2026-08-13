'use client';
// ── Estado del tutorial guiado del profesor ───────────────────────────────────
//
// Un solo recorrido (lib/onboarding.ONBOARDING_STEPS) con dos modos de entrada:
//
//   'auto'   Profesor NUEVO. Arranca solo durante sus primeras 5 clases y avanza
//            cuando el profesor hace la acción de verdad (no cuando lee el paso).
//            Saltarlo o terminarlo lo apaga en la base.
//   'manual' Botón "Tutorial" del header. Lo puede abrir CUALQUIER profesor, las
//            veces que quiera, y no escribe nada: el profesor avanza a su ritmo
//            con los botones del pop-up y lo cierra cuando quiera.
//
// El estado del progreso se siembra UNA vez desde la fila del profesor y desde ahí
// vive acá. TeachersContext recarga la lista cada 60 s, y si releyéramos el
// contador en cada recarga el paso actual saltaría hacia atrás en mitad del
// recorrido cada vez que llega una respuesta con un instante de retraso.
//
// Por la misma razón el fin del automático (saltar o completar) se recuerda en un
// ref: la fila de `teachers` ya dice `onboarding_active = false`, pero la lista en
// memoria todavía no se enteró y sin el ref el tutorial reviviría al cerrar el
// recorrido manual.
import {
  createContext, useContext, useState, useEffect, useCallback, useRef, useMemo,
  type ReactNode,
} from 'react';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import {
  ONBOARDING_STEPS, ONBOARDING_TOTAL_STEPS, ONBOARDING_TARGET_CLASSES, isAutoOnboarding,
  type OnboardingStep, type OnboardingStepId,
} from '@/lib/onboarding';
import { dbStartOnboarding, dbSkipOnboarding, dbCompleteOnboardingClass } from '@/lib/onboardingStore';

export type OnboardingMode = 'off' | 'auto' | 'manual';

interface OnboardingApi {
  mode: OnboardingMode;
  /** Paso a la vista, o null si el recorrido está cerrado. */
  step: OnboardingStep | null;
  stepIndex: number;
  totalSteps: number;
  /** Pasos ya cumplidos (check verde en la lista). */
  done: Set<OnboardingStepId>;
  classesCompleted: number;
  /** Hay un profesor con sesión: es lo único que pide el botón del header. */
  available: boolean;
  /** Cartel de "¡Formación completada!" pendiente de leer. */
  finishedNotice: boolean;

  /** Botón "Tutorial" del header. */
  openManual: () => void;
  /** Cierra el recorrido manual sin tocar nada. */
  close: () => void;
  /** "Saltar tutorial": termina el automático (el botón del header sigue). */
  skipAuto: () => void;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;
  dismissFinished: () => void;

  /**
   * La pantalla avisa que el profesor hizo la acción REAL de un paso. En modo
   * automático marca el check y avanza solo; en manual no hace nada (ahí manda el
   * profesor) y con el tutorial cerrado se ignora.
   */
  reportAction: (id: OnboardingStepId) => void;
  /**
   * Este paso NO aplica ahora mismo (su botón no existe en ninguna clase a la
   * vista). Solo para pasos `optional`: la presentación se envía una vez por
   * alumno, así que a partir del segundo día ese botón ya no está y esperarlo
   * dejaría al profesor trabado en el paso 1 para siempre.
   *
   * No cuenta como cumplido: no marca check, solo deja de frenar el recorrido.
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
  mode: 'off', step: null, stepIndex: 0, totalSteps: ONBOARDING_TOTAL_STEPS,
  done: new Set(), classesCompleted: 0, available: false, finishedNotice: false,
  openManual: noop, close: noop, skipAuto: noop, next: noop, prev: noop, goTo: noop,
  dismissFinished: noop, reportAction: noop, markNotApplicable: noop, reportClassCompleted: noop,
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
  // Solo gobierna el modo MANUAL: en automático el paso a la vista se DERIVA de
  // los checks (ver `autoIndex`), que es lo que evita tener que moverlo a mano y
  // que se pelee consigo mismo cuando llega una acción real.
  const [stepIndex, setStepIndex] = useState(0);
  const [done, setDone] = useState<Set<OnboardingStepId>>(new Set());
  /** Pasos que ahora mismo no aplican. No son checks: solo no frenan el avance. */
  const [notApplicable, setNotApplicable] = useState<Set<OnboardingStepId>>(new Set());
  const [classesCompleted, setClassesCompleted] = useState(0);
  const [finishedNotice, setFinishedNotice] = useState(false);

  // El progreso se siembra una sola vez por profesor (ver cabecera del archivo).
  const seededFor = useRef<string | null>(null);
  // Espejos de lectura síncrona: los callbacks los necesitan sin re-crearse, y
  // consultarlos NO puede hacerse dentro de un actualizador de estado (React
  // puede ejecutarlo dos veces y duplicaría la escritura en la base).
  const modeRef = useRef<OnboardingMode>('off');
  const completedRef = useRef(0);
  /** El automático ya terminó en esta sesión (saltado o completado). */
  const autoEndedRef = useRef(false);
  // Espejos de los checks: hacen falta para decidir el cierre del ciclo leyendo el
  // valor de AHORA. Dentro de un actualizador de estado no se puede (React puede
  // llamarlo dos veces) y en el closure del callback el valor llegaría viejo.
  const doneRef = useRef<Set<OnboardingStepId>>(new Set());
  const naRef = useRef<Set<OnboardingStepId>>(new Set());
  // Guarda contra el doble conteo antes incluso de que vuelva la escritura.
  const countedRef = useRef<Set<string>>(new Set());

  const applyMode = useCallback((m: OnboardingMode) => {
    modeRef.current = m;
    setMode(m);
  }, []);

  // Siembra del progreso desde la fila del profesor. Es una sincronización con un
  // sistema externo (la base), no un cálculo derivable en render: el estado que
  // deja acá lo van moviendo después las acciones del profesor, así que no puede
  // recalcularse en cada render.
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
    setDone(new Set());
    setNotApplicable(new Set());
    doneRef.current = new Set();
    naRef.current = new Set();
    setStepIndex(0);
    countedRef.current = readCounted(teacher.id);

    if (isAutoOnboarding(teacher)) {
      applyMode('auto');
      dbStartOnboarding(teacher.id);
    } else {
      applyMode('off');
    }
  }, [teacher, applyMode]);

  const openManual = useCallback(() => {
    // El manual pisa al automático mientras está abierto: son el mismo recorrido y
    // dos overlays a la vez no tendría sentido. Al cerrarlo vuelve el automático.
    setStepIndex(0);
    applyMode('manual');
  }, [applyMode]);

  const close = useCallback(() => {
    setStepIndex(0);
    // No se relee `isAutoOnboarding(teacher)` a secas: la fila en memoria puede
    // traer todavía el contador viejo. Manda el progreso local + el ref de "ya
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

  const next = useCallback(() => {
    setStepIndex(i => Math.min(i + 1, ONBOARDING_TOTAL_STEPS - 1));
  }, []);

  const prev = useCallback(() => {
    setStepIndex(i => Math.max(i - 1, 0));
  }, []);

  const goTo = useCallback((index: number) => {
    setStepIndex(Math.max(0, Math.min(index, ONBOARDING_TOTAL_STEPS - 1)));
  }, []);

  const dismissFinished = useCallback(() => setFinishedNotice(false), []);

  /**
   * Cierre del ciclo: con los 5 pasos cubiertos (cumplidos o descartados) los
   * checks se vacían y el recorrido vuelve al paso 1 para acompañar a la clase
   * siguiente, que es la razón de que la formación dure 5 clases.
   *
   * El reinicio se dispara acá y NO al contar la clase: el conteo ocurre al
   * guardar el transcript, o sea en el paso 4, y reiniciar ahí se llevaba por
   * delante el paso 5 antes de que el profesor llegara a verlo.
   */
  const cerrarCicloSiCompleto = useCallback((nextDone: Set<OnboardingStepId>, nextNa: Set<OnboardingStepId>) => {
    const completo = ONBOARDING_STEPS.every(s => nextDone.has(s.id) || nextNa.has(s.id));
    if (!completo) return false;
    setDone(new Set());
    setNotApplicable(new Set());
    return true;
  }, []);

  const reportAction = useCallback((id: OnboardingStepId) => {
    if (modeRef.current !== 'auto') return;
    if (doneRef.current.has(id)) return;
    const nextDone = new Set(doneRef.current).add(id);
    doneRef.current = nextDone;
    if (cerrarCicloSiCompleto(nextDone, naRef.current)) {
      doneRef.current = new Set();
      naRef.current = new Set();
      return;
    }
    setDone(nextDone);
  }, [cerrarCicloSiCompleto]);

  const markNotApplicable = useCallback((id: OnboardingStepId) => {
    if (modeRef.current !== 'auto') return;
    if (naRef.current.has(id)) return;
    const nextNa = new Set(naRef.current).add(id);
    naRef.current = nextNa;
    if (cerrarCicloSiCompleto(doneRef.current, nextNa)) {
      doneRef.current = new Set();
      naRef.current = new Set();
      return;
    }
    setNotApplicable(nextNa);
  }, [cerrarCicloSiCompleto]);

  /**
   * Paso a la vista en modo AUTOMÁTICO: el primero ni cumplido ni descartado.
   *
   * Se DERIVA en vez de guardarse. Con un `stepIndex` propio habría dos cosas
   * moviendo el mismo puntero (la acción real del profesor y el botón "Entendido")
   * y se pisarían: al marcar un check, el recálculo devolvía el recorrido al paso
   * que el profesor acababa de pasar de largo.
   *
   * Sigue al profesor aunque se salte el orden: si sube el transcript de una clase
   * vieja antes de entrar a la de hoy, el paso 4 queda marcado y el recorrido se
   * planta en el 2, que es lo que le falta.
   */
  const autoIndex = useMemo(() => {
    const i = ONBOARDING_STEPS.findIndex(s => !done.has(s.id) && !notApplicable.has(s.id));
    return i === -1 ? ONBOARDING_TOTAL_STEPS - 1 : i;
  }, [done, notApplicable]);

  const effectiveIndex = mode === 'auto' ? autoIndex : stepIndex;

  const reportClassCompleted = useCallback((classKey: string) => {
    if (!teacher || modeRef.current !== 'auto') return;
    if (countedRef.current.has(classKey)) return;

    countedRef.current.add(classKey);
    writeCounted(teacher.id, countedRef.current);

    // Los checks NO se tocan acá: esto corre al guardar el transcript (paso 4) y
    // vaciarlos se llevaría por delante el paso 5, que es el que le enseña al
    // profesor que la clase quedó registrada. El ciclo lo cierra
    // `cerrarCicloSiCompleto` cuando el profesor da por leído ese último paso.
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
    mode,
    step: mode === 'off' ? null : ONBOARDING_STEPS[effectiveIndex] ?? null,
    stepIndex: effectiveIndex,
    totalSteps: ONBOARDING_TOTAL_STEPS,
    done,
    classesCompleted,
    available: !!teacher,
    finishedNotice,
    openManual, close, skipAuto, next, prev, goTo, dismissFinished,
    reportAction, markNotApplicable, reportClassCompleted,
  }), [
    mode, effectiveIndex, done, classesCompleted, teacher, finishedNotice,
    openManual, close, skipAuto, next, prev, goTo, dismissFinished,
    reportAction, markNotApplicable, reportClassCompleted,
  ]);

  return <OnboardingContext.Provider value={api}>{children}</OnboardingContext.Provider>;
}
