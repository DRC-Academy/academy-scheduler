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
  // Email de presentación (abre el recorrido: es lo más urgente y donde más se falla)
  | 'presentation-email'
  | 'pres-copy'
  | 'pres-mark-sent'
  // Disponibilidad
  | 'calendar-grid'
  // Alumnos y fichas
  | 'students-list'
  | 'ficha-generate'
  | 'student-open'
  | 'ficha-tabs'
  // La clase
  | 'join-class'
  | 'give-class'
  | 'add-transcript'
  // Cierre
  | 'class-status';

/** Lado preferido del globo respecto del elemento (driver.js lo corrige solo si no entra). */
export type StepSide = 'top' | 'right' | 'bottom' | 'left';
export type StepAlign = 'start' | 'center' | 'end';

export interface OnboardingStep {
  id: OnboardingStepId;
  /** Título corto: el QUÉ. */
  title: string;
  /** El PORQUÉ, en una frase. Es lo que hace que el paso no se olvide. */
  why: string;
  /**
   * Pantalla donde vive el botón de este paso. El tour NAVEGA solo hasta ella
   * antes de resaltar: el profesor no tiene que saber en qué sección está cada
   * cosa, que era justo lo que se le pedía adivinar.
   */
  route: string;
  /**
   * 'prefix' para rutas dinámicas: la ficha de un alumno es
   * /mis-alumnos/<id> y el id depende de qué alumno sea, así que no se puede
   * comparar la ruta entera.
   */
  routeMatch?: 'exact' | 'prefix';
  /**
   * Destino a resolver del DOM en vez de fijo: `data-onboarding` de un enlace
   * cuyo href es la URL a la que ir. Lo usa la ficha, cuya URL solo se conoce
   * mirando el primer alumno de la lista.
   */
  routeFrom?: string;
  /** Nombre de la sección, para anunciar el salto ("Te llevo a Finanzas"). */
  routeLabel: string;
  /** Lado preferido del globo. Es una preferencia: si no entra, se recoloca. */
  side?: StepSide;
  align?: StepAlign;
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
  /**
   * Paso de ORIENTACIÓN: se enseña una sola vez y no vuelve a salir en las clases
   * siguientes de la formación. Sin esto, un profesor en su quinta clase se comía
   * otra vez "marca tu disponibilidad", que ya hizo el primer día.
   *
   * Los pasos del SOP (entrar, transcript, cierre) NO lo llevan: esos sí se
   * repiten en cada clase, que es justo para lo que sirve la formación.
   */
  once?: boolean;
  /** Se cumple con una acción real del profesor (no solo leyendo el paso). */
  actionable: boolean;
}

/** Rutas del profesor que recorre el tour. */
export const RUTA_CALENDARIO = '/teacher';
export const RUTA_AGENDA = '/clases';
export const RUTA_ALUMNOS = '/mis-alumnos';
export const RUTA_FICHA = '/mis-alumnos/';
export const RUTA_FINANZAS = '/mis-clases';

export const ONBOARDING_STEPS: OnboardingStep[] = [
  // ── 1-3. El email de presentación ───────────────────────────────────────────
  // ABRE el recorrido por decisión expresa: es lo más urgente que tiene encima un
  // profesor nuevo (la ventana son 24 horas desde que le asignan al alumno) y lo
  // que más se hace a medias.
  //
  // Son tres pasos para lo que en la app es un solo botón, también a propósito: el
  // envío NO ocurre dentro de la plataforma (se copia y se manda desde el Gmail
  // del profesor), y ese salto es donde la gente da por enviado un correo que solo
  // copió.
  {
    id: 'presentation-email',
    title: 'Abre el email de presentación',
    why: 'Es tu primer contacto con un alumno nuevo y se manda una sola vez, dentro de las primeras 24 horas. Pasada esa ventana cuenta como retraso en tu seguimiento. Este botón te prepara el correo entero: texto, enlace de Meet y formulario inicial.',
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    anchors: ['presentation-email'],
    where: 'En "Mis clases", debajo del botón principal de la tarjeta. Solo aparece la primera vez con cada alumno.',
    side: 'left',
    align: 'center',
    optional: true,
    actionable: true,
  },
  {
    id: 'pres-copy',
    title: 'Revisa el enlace de Meet y copia el email',
    why: 'Pega arriba tu enlace de Meet: queda guardado para ese alumno y es el que usará "Ingresar a clase" siempre. Luego "Copiar email" se lleva destinatario, asunto y cuerpo al portapapeles de una vez. Puedes editar el texto antes.',
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    anchors: ['pres-copy'],
    where: 'Dentro del modal "Email de presentación", el botón verde con borde "📋 Copiar email".',
    side: 'top',
    align: 'center',
    actionable: true,
  },
  {
    id: 'pres-mark-sent',
    title: 'Envíalo desde TU Gmail y vuelve a marcarlo',
    why: 'La plataforma NO envía el correo: lo escribe por ti. Abre tu Gmail, crea un mensaje nuevo, pega (Ctrl+V) y envíalo desde tu propia cuenta, que es la que el alumno debe ver. Cuando lo hayas enviado de verdad, vuelve aquí y pulsa "Marcar como enviado": copiarlo no lo marca solo, y hasta que no lo marques el aviso te sigue corriendo.',
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    anchors: ['pres-mark-sent'],
    where: 'Dentro del modal "Email de presentación", el botón verde grande "✅ Marcar como enviado".',
    side: 'top',
    align: 'center',
    actionable: true,
  },

  // ── 4. Disponibilidad ───────────────────────────────────────────────────────
  // Después del email, no antes: es la condición para que te SIGAN llegando
  // alumnos, pero el que ya tiene asignado no espera a que ordene su calendario.
  {
    id: 'calendar-grid',
    once: true,
    title: 'Marca tu disponibilidad',
    why: 'Cada celda verde es una hora en la que la academia puede asignarte un alumno. Se guarda sola al hacer clic. Si no marcas nada, no te llegan alumnos nuevos.',
    route: RUTA_CALENDARIO,
    routeLabel: 'Calendario',
    anchors: ['calendar-grid'],
    where: 'En "Calendario", pestaña "Mi calendario": la parrilla de la semana.',
    side: 'bottom',
    align: 'start',
    actionable: false,
  },

  // ── 5-8. Alumnos y fichas ───────────────────────────────────────────────────
  {
    id: 'students-list',
    once: true,
    title: 'Aquí viven tus alumnos',
    why: 'Todos tus alumnos activos, con su nivel y el estado de su ficha. El filtro "Sin ficha" te aísla los que aún no tienen: son los que te falta preparar.',
    route: RUTA_ALUMNOS,
    routeLabel: 'Alumnos',
    anchors: ['students-list'],
    where: 'En la sección "Alumnos" del menú.',
    side: 'bottom',
    align: 'start',
    actionable: false,
  },
  {
    id: 'ficha-generate',
    once: true,
    title: 'Genera la ficha del alumno',
    why: 'La ficha la escribe la IA a partir del formulario inicial que rellenó el alumno: quién es, por qué estudia inglés, su nivel y qué le funciona. Es lo que te permite entrar a la primera clase sabiendo con quién hablas.',
    route: RUTA_ALUMNOS,
    routeLabel: 'Alumnos',
    anchors: ['ficha-generate'],
    where: 'En la tarjeta de un alumno sin ficha, el botón "Generar ficha".',
    side: 'bottom',
    align: 'center',
    optional: true,
    actionable: true,
  },
  {
    id: 'student-open',
    once: true,
    title: 'Abre la ficha completa',
    why: 'Cada alumno tiene su ficha propia. Es donde vas a preparar cada clase y donde queda todo lo que la IA aprende de sus transcripciones.',
    route: RUTA_ALUMNOS,
    routeLabel: 'Alumnos',
    anchors: ['student-open'],
    where: 'En la tarjeta de cualquier alumno, el enlace "Ver ficha →".',
    side: 'top',
    align: 'center',
    // Sin alumnos asignados todavía no hay ninguna ficha que abrir.
    optional: true,
    actionable: true,
  },
  {
    id: 'ficha-tabs',
    once: true,
    title: 'Las tres pestañas de la ficha',
    why: '"Perfil" es quién es el alumno y qué le motiva. "Seguimiento" recoge lo que la IA saca de cada transcripción que subes, incluidas las señales de riesgo de baja. "Próxima clase" te propone un plan concreto para la clase que viene: es por donde conviene empezar a preparar.',
    route: RUTA_FICHA,
    routeMatch: 'prefix',
    // La URL depende del alumno, así que se lee del enlace "Ver ficha →" del paso
    // anterior en vez de estar escrita a mano.
    routeFrom: 'student-open',
    routeLabel: 'la ficha del alumno',
    anchors: ['ficha-tabs'],
    where: 'Dentro de la ficha de un alumno, la fila de pestañas bajo su nombre.',
    side: 'bottom',
    align: 'start',
    optional: true,
    actionable: false,
  },

  // ── 9-11. La clase ──────────────────────────────────────────────────────────
  {
    id: 'join-class',
    title: 'Entra a la clase',
    why: 'Este botón registra tu acceso, y ese registro es el primero de los dos factores que hacen que la clase se te pague. No se puede cargar después: entrar al Meet por fuera deja la clase sin registro.',
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    anchors: ['join-class', 'set-link'],
    where: 'En "Mis clases", el botón verde de la tarjeta. Si al alumno le falta el enlace de Meet, dirá "Definir enlace": definilo una vez y queda guardado.',
    side: 'left',
    align: 'center',
    actionable: true,
  },
  {
    id: 'give-class',
    title: 'Da tu clase con normalidad',
    why: 'Durante la clase no hay nada que tocar acá. Si el alumno está en riesgo de baja, antes de abrir el Meet verás un aviso con el protocolo de esa clase: el alumno no lo ve, es solo para vos.',
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    anchors: [],
    where: 'En Google Meet, fuera de la plataforma.',
    actionable: false,
  },
  {
    id: 'add-transcript',
    title: 'Sube el transcript',
    why: 'Es el segundo factor: hasta que no lo subas, la clase figura como "pendiente de transcript" y no suma a tu total a cobrar. Copiá de Fathom la pestaña Transcript completa, no el Summary.',
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    anchors: ['add-transcript'],
    where: 'En "Mis clases", en la tarjeta de una clase ya dada. Si no la ves, usá el filtro "Sin transcript".',
    side: 'left',
    align: 'center',
    actionable: true,
  },
  // ── 12. Cierre ──────────────────────────────────────────────────────────────
  {
    // El sitio donde se comprueba que la clase "ya cuenta" es el resumen de pago,
    // no la agenda. El tour cambia de sección solo para enseñárselo.
    id: 'class-status',
    title: 'Comprueba que la clase ya cuenta',
    why: 'Con el acceso registrado y el transcript subido, la clase pasa a "pagable" y se suma a tu total. Acá lo ves con importes: lo que ya está cerrado y lo que sigue pendiente de transcript.',
    route: RUTA_FINANZAS,
    routeLabel: 'Finanzas',
    // El resumen de Finanzas primero; la etiqueta de la agenda queda de respaldo
    // por si la navegación no llegó a completarse.
    anchors: ['payment-summary', 'class-status'],
    where: 'En "Finanzas", la tarjeta "Total a cobrar" con el desglose del mes.',
    side: 'bottom',
    align: 'start',
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
