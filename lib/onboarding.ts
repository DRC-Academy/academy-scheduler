// ── Onboarding del profesor: el SOP de una clase ──────────────────────────────
//
// FUENTE ÚNICA de los pasos. Las dos vías de acceso al tutorial leen esta lista,
// así que el profesor nuevo (modo automático) y el veterano que abre el botón
// "Tutorial" del header (modo manual) ven exactamente el mismo procedimiento.
// Cambiar un texto acá lo cambia en las dos.
//
// Módulo PURO: sin React y sin Supabase. Las escrituras están en
// lib/onboardingStore.ts y el estado del recorrido en lib/OnboardingContext.tsx.
import type { Teacher } from '@/types';

/** Clases que dura la formación automática. */
export const ONBOARDING_TARGET_CLASSES = 5;

export type OnboardingStepId =
  | 'presentation-email'
  | 'join-class'
  | 'give-class'
  | 'add-transcript'
  | 'class-status';

export interface OnboardingStep {
  id: OnboardingStepId;
  /** Título corto: el QUÉ. */
  title: string;
  /** El PORQUÉ, en una frase. Es lo que hace que el paso no se olvide. */
  why: string;
  /**
   * Valores de `data-onboarding` a resaltar, en orden de preferencia: se ilumina
   * el PRIMERO que exista en pantalla. La lista existe porque un mismo hueco de
   * la tarjeta cambia de botón según el estado de la clase (sin enlace de Meet
   * todavía dice "Definir enlace", no "Ingresar a clase").
   *
   * Vacío = paso informativo, sin nada que resaltar.
   */
  anchors: string[];
  /** Dónde encontrarlo. Se muestra cuando el botón no está en esta pantalla. */
  where: string;
  /**
   * Un paso opcional no frena el recorrido automático si su botón no existe: la
   * presentación se envía UNA vez por alumno, así que a partir del segundo día
   * ese botón ya no está y esperarlo dejaría al profesor trabado en el paso 1.
   */
  optional?: boolean;
  /** Se cumple con una acción real del profesor (no solo leyendo el paso). */
  actionable: boolean;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'presentation-email',
    title: 'Envía el email de presentación',
    why: 'Es el primer contacto con un alumno nuevo y se envía una sola vez, dentro de las primeras 24 horas. Si se pasa esa ventana, cuenta como retraso en tu seguimiento.',
    anchors: ['presentation-email'],
    where: 'En "Mis clases", debajo del botón principal de la tarjeta del alumno. Solo aparece la primera vez con cada alumno.',
    optional: true,
    actionable: true,
  },
  {
    id: 'join-class',
    title: 'Entra a la clase',
    why: 'Este botón es lo que registra tu acceso, y ese registro es el primer factor de los dos que hacen que la clase se te pague. No se puede cargar después: entrar al Meet por fuera deja la clase sin registro.',
    anchors: ['join-class', 'set-link'],
    where: 'En "Mis clases", el botón verde de la tarjeta. Si el alumno todavía no tiene enlace de Meet, el botón dirá "Definir enlace": definilo una vez y ya queda guardado para siempre.',
    actionable: true,
  },
  {
    id: 'give-class',
    title: 'Da tu clase con normalidad',
    why: 'Durante la clase no hay nada que tocar en la plataforma. Si el alumno está en riesgo de baja, antes de abrir el Meet vas a ver un aviso con el protocolo de esa clase: el alumno no lo ve, es solo para vos.',
    anchors: [],
    where: 'En Google Meet, fuera de la plataforma.',
    actionable: false,
  },
  {
    id: 'add-transcript',
    title: 'Sube el transcript',
    why: 'Es el segundo factor: hasta que no lo subas, la clase figura como "pendiente de transcript" y no suma a tu total a cobrar. Copiá de Fathom la pestaña Transcript completa, no el Summary.',
    anchors: ['add-transcript'],
    where: 'En "Mis clases", en la tarjeta de una clase ya dada. Si no la ves, usá el filtro "Sin transcript".',
    actionable: true,
  },
  {
    id: 'class-status',
    title: 'Comprueba que la clase quedó registrada',
    why: 'Con el acceso registrado y el transcript subido, la clase queda cerrada y cuenta para tu pago. El estado de cada tarjeta te lo dice de un vistazo, y el detalle con importes está en Finanzas.',
    anchors: ['class-status'],
    where: 'En "Mis clases", la etiqueta de estado de la tarjeta de una clase ya dada.',
    actionable: false,
  },
];

export const ONBOARDING_TOTAL_STEPS = ONBOARDING_STEPS.length;

export function stepById(id: OnboardingStepId): OnboardingStep | undefined {
  return ONBOARDING_STEPS.find(s => s.id === id);
}

export function stepIndexOf(id: OnboardingStepId): number {
  return ONBOARDING_STEPS.findIndex(s => s.id === id);
}

/**
 * ¿A este profesor le corresponde el tutorial AUTOMÁTICO?
 *
 * Los dos requisitos son los del SQL: la bandera encendida y menos de 5 clases de
 * formación completadas. Saltar el tutorial apaga la bandera, así que sale por la
 * misma puerta que terminarlo.
 *
 * OJO: el botón "Tutorial" del header NO usa esta función. Está siempre
 * disponible, para cualquier profesor y las veces que quiera.
 */
export function isAutoOnboarding(teacher: Teacher | null | undefined): boolean {
  if (!teacher) return false;
  if (teacher.onboardingActive !== true) return false;
  return (teacher.onboardingClassesCompleted ?? 0) < ONBOARDING_TARGET_CLASSES;
}

/** "Clase 3 de 5 de tu formación". El número que se muestra es el que está EN CURSO. */
export function formationLabel(classesCompleted: number): string {
  const current = Math.min(classesCompleted + 1, ONBOARDING_TARGET_CLASSES);
  return `Clase ${current} de ${ONBOARDING_TARGET_CLASSES} de tu formación`;
}

export const ONBOARDING_FINISHED_TITLE = '¡Formación completada!';
export const ONBOARDING_FINISHED_BODY =
  'Ya diste tus primeras 5 clases con el proceso completo. Puedes repasar el tutorial cuando quieras desde el botón Tutorial del menú.';
