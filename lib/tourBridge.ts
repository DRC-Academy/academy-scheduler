// ── Puente entre el tutorial y las pantallas ─────────────────────────────────
//
// El motor del tour necesita PREGUNTAR por datos que solo saben las pantallas
// ("¿este profesor tiene alumnos?"). Este módulo es el registro donde cada
// pantalla deja esas capacidades mientras está montada. (Hasta sep/2026 también
// ACCIONABA: abría y cerraba el modal del email de presentación para su bloque
// de tres pasos. Se retiró con el email. Desde oct/2026 vuelve a accionar algo:
// la guía de penalizaciones abre y cierra el menú ⋯ de una clase.)
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
  /** ¿Hay alguna clase cuyo alumno aún no tiene el enlace definido? (lo sabe /clases) */
  hasLinkPending: () => boolean;
  /** ¿Hay alguna clase por delante en los días a la vista? (lo sabe /clases) */
  hasUpcomingClass: () => boolean;
  /** ¿Hay alguna clase ya dada esperando transcript? (lo sabe /clases) */
  hasClassNeedingTranscript: () => boolean;
  /** Abre el menú ⋯ de la primera clase por delante (lo sabe /clases). */
  openClassMenu: () => Promise<void>;
  /** Cierra cualquier menú ⋯ abierto. */
  closeClassMenu: () => Promise<void>;
}

const DEFAULTS: TourBridge = {
  hasStudents: () => true,
  hasLinkPending: () => true,
  hasUpcomingClass: () => true,
  hasClassNeedingTranscript: () => true,
  // Sin "Mis clases" montada no hay menú que abrir: el paso queda centrado.
  openClassMenu: async () => {},
  closeClassMenu: async () => {},
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

// ── ¿Qué recorrido hay en pantalla? ───────────────────────────────────────────
//
// Lo publica el motor (lib/OnboardingContext) y lo leen las pantallas con
// `useSyncExternalStore`, NO por el contexto de estado del tour: así una pantalla
// se re-renderiza solo al abrirse y cerrarse el recorrido, nunca en cada paso
// (ver "DOS CONTEXTOS" en el motor). Lo usan los pop-ups que taparían lo que el
// recorrido señala, para APLAZARSE (no se dan por vistos):
//   · "Transcripts con el plazo a punto de vencer" (Mis clases), con cualquiera;
//   · "Enlaces pendientes de definir", solo con la guía de penalizaciones: en el
//     tutorial se queda encima a propósito, porque definir el enlace es su paso 1.
export type OpenTour = 'onboarding' | 'penalizaciones' | null;

let recorridoAbierto: OpenTour = null;
const oyentes = new Set<() => void>();

export function setOpenTour(abierto: OpenTour): void {
  if (recorridoAbierto === abierto) return;
  recorridoAbierto = abierto;
  for (const f of [...oyentes]) f();
}

export function getOpenTour(): OpenTour {
  return recorridoAbierto;
}

export function subscribeOpenTour(f: () => void): () => void {
  oyentes.add(f);
  return () => { oyentes.delete(f); };
}
