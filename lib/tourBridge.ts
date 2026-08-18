// ── Puente entre el tutorial y las pantallas ─────────────────────────────────
//
// El motor del tour necesita hacer dos cosas que solo saben hacer las pantallas:
// PREGUNTAR por datos ("¿este profesor tiene alumnos?") y ACCIONAR ("abrí el
// modal del email"). Este módulo es el registro donde cada pantalla deja esas
// capacidades mientras está montada.
//
// Es un singleton de módulo y NO un contexto de React a propósito: el motor lo
// consulta dentro de una función asíncrona, fuera del ciclo de render, y pasarlo
// por contexto obligaría a re-renderizar el árbol entero cada vez que una tarjeta
// cambia de estado.
//
// SEMÁNTICA DE LAS PREGUNTAS — importa: cuando la pantalla dueña de un dato NO
// está montada, la pregunta devuelve `true` ("no puedo descartarlo todavía"), no
// `false`. El motor evalúa `requires()` ANTES de navegar, así que en ese momento
// la pantalla de destino casi nunca está montada: si el desconocimiento contara
// como "no", el tutorial se saltaría solo la mitad de los pasos sin haber mirado.
// Quien descarta de verdad es la espera del elemento, ya en la pantalla correcta.

export interface TourBridge {
  /** ¿El profesor tiene algún alumno? (lo sabe /mis-alumnos) */
  hasStudents: () => boolean;
  /** ¿Hay alguna clase con la presentación pendiente? (lo sabe /clases) */
  hasPresentationPending: () => boolean;
  /** ¿Hay alguna clase por delante en los días a la vista? (lo sabe /clases) */
  hasUpcomingClass: () => boolean;
  /** ¿Hay alguna clase ya dada esperando transcript? (lo sabe /clases) */
  hasClassNeedingTranscript: () => boolean;
  /** Abre el modal del email de presentación. false = no había ninguno que abrir. */
  openPresentationModal: () => boolean;
  /** Cierra el modal si está abierto. */
  closePresentationModal: () => void;
  /** ¿El modal está abierto ahora mismo? */
  isPresentationModalOpen: () => boolean;
}

const DEFAULTS: TourBridge = {
  hasStudents: () => true,
  hasPresentationPending: () => true,
  hasUpcomingClass: () => true,
  hasClassNeedingTranscript: () => true,
  openPresentationModal: () => false,
  closePresentationModal: () => {},
  isPresentationModalOpen: () => false,
};

let current: TourBridge = { ...DEFAULTS };

/**
 * Registra capacidades. Devuelve la baja, para llamarla al desmontar.
 *
 * El desmontaje solo revierte las claves que este registro puso: dos pantallas
 * montadas a la vez (una navegación en curso) no se pisan la baja entre sí.
 */
function restaurar<K extends keyof TourBridge>(k: K, valor: TourBridge[K]): void {
  current[k] = valor;
}

export function registerTourBridge(part: Partial<TourBridge>): () => void {
  const claves = Object.keys(part) as Array<keyof TourBridge>;
  const previo: Partial<TourBridge> = {};
  for (const k of claves) restaurarEn(previo, k, current[k]);
  current = { ...current, ...part };

  return () => {
    for (const k of claves) {
      // Solo se revierte si sigue siendo LA función de este registro: si otra
      // pantalla la reemplazó mientras tanto, la suya es la buena.
      if (current[k] === part[k]) restaurar(k, previo[k] ?? DEFAULTS[k]);
    }
  };
}

function restaurarEn<K extends keyof TourBridge>(dest: Partial<TourBridge>, k: K, valor: TourBridge[K]): void {
  dest[k] = valor;
}

export function tourBridge(): TourBridge {
  return current;
}

// ── Aviso de "el modal se cerró" ─────────────────────────────────────────────
//
// Si el profesor cierra el modal a mitad del bloque de tres pasos, el tour tiene
// que enterarse en ese instante. Sin esto driver.js seguiría resaltando un nodo
// ya desconectado del documento, cuyo `getBoundingClientRect()` devuelve todo
// ceros: el recorte del overlay colapsaba a un punto en la esquina superior
// izquierda y el globo lo seguía hasta allí.

type Listener = () => void;
const modalClosedListeners = new Set<Listener>();

export function onPresentationModalClosed(fn: Listener): () => void {
  modalClosedListeners.add(fn);
  return () => { modalClosedListeners.delete(fn); };
}

export function emitPresentationModalClosed(): void {
  for (const fn of [...modalClosedListeners]) {
    try { fn(); } catch { /* un oyente roto no puede tumbar el cierre del modal */ }
  }
}
