// ── Onboarding del profesor: el SOP de una clase ──────────────────────────────
//
// FUENTE ÚNICA de los pasos. Las dos vías de acceso al tutorial leen esta lista,
// así que el profesor nuevo (modo automático) y el veterano que abre el botón
// "Tutorial" del header (modo manual) ven exactamente el mismo procedimiento.
// Cambiar un texto acá lo cambia en las dos.
//
// CONTRATO DECLARATIVO (reescrito el 14/08/2026 tras la auditoría). Cada paso
// declara qué necesita y qué hacer si no está, y el motor
// (lib/OnboardingContext) lo ejecuta SIEMPRE en el mismo orden:
//
//   1. `requires()`          ¿tiene sentido este paso con los datos de hoy?
//   2. ruta                  navegar y ESPERAR a que la ruta sea la pedida
//   3. `onEnter()`           abrir lo que haga falta (p. ej. el modal del email)
//   4. esperar el elemento   por MutationObserver, con tope de 3 s
//   5. si no aparece         aplicar `onMissing` y DEJAR CONSTANCIA (warn)
//   6. resaltar
//
// El motor resuelve el elemento y se lo entrega ya resuelto a driver.js, que
// queda reducido a "pintá este globo sobre este nodo". Antes driver resolvía el
// ancla por su cuenta y se saltaba pasos internamente sin avisar, con lo que su
// índice y el de React acababan desfasados y "Siguiente" no hacía nada.
//
// Módulo PURO salvo por lib/tourBridge, que es un registro de funciones sin
// estado de React: sin Supabase y sin componentes.
import type { Teacher } from '@/types';
import { tourBridge } from '@/lib/tourBridge';

/** Clases que dura la formación automática. */
export const ONBOARDING_TARGET_CLASSES = 5;

export type OnboardingStepId =
  | 'presentation-email' | 'pres-copy' | 'pres-mark-sent'
  | 'calendar-grid'
  | 'students-list' | 'ficha-generate' | 'student-open' | 'ficha-tabs'
  | 'join-class' | 'give-class' | 'add-transcript'
  | 'class-status';

export type StepSide = 'top' | 'right' | 'bottom' | 'left';
export type StepAlign = 'start' | 'center' | 'end';

/**
 * Qué hacer cuando el elemento del paso no aparece:
 *   'skip'   — saltarlo y seguir. Es lo correcto para todo lo que depende de los
 *              datos del profesor (no tiene alumnos, no tiene clases hoy…).
 *   'center' — mostrar el globo centrado, sin foco. SOLO para pasos cuyo
 *              elemento es estructural y debería existir siempre: si falta, es un
 *              fallo nuestro y el texto del paso sigue valiendo. Nunca es
 *              silencioso: el motor deja un warn con el id.
 */
export type OnMissing = 'skip' | 'center';

export interface TourStep {
  id: OnboardingStepId;
  /** Pantalla donde vive el paso. El tour navega solo hasta ella. */
  route: string;
  /** `data-onboarding` a resaltar. Vacío = paso informativo, globo centrado. */
  selector: string;
  title: string;
  /** El PORQUÉ, en una frase. Es lo que hace que el paso no se olvide. */
  body: string;
  onMissing: OnMissing;

  /**
   * Precondición de datos. Se evalúa ANTES de navegar, así que la pantalla dueña
   * del dato casi nunca está montada todavía: por eso el puente devuelve `true`
   * cuando no puede saberlo (ver lib/tourBridge). Esto es un filtro rápido, no el
   * juez: quien descarta de verdad es la espera del elemento.
   */
  requires?: () => boolean;
  /** Preparar la pantalla (abrir el modal). Se espera a que termine. */
  onEnter?: () => Promise<void>;
  /** Deshacer lo de `onEnter` al salir del paso hacia adelante. */
  onExit?: () => Promise<void>;

  /**
   * Anclas alternativas, en orden de preferencia tras `selector`. El mismo hueco
   * de la tarjeta muestra "Ingresar a clase" o "Definir enlace" según el alumno
   * tenga o no enlace de Meet, y son el mismo paso del procedimiento.
   */
  fallbackSelectors?: string[];
  /** 'prefix' para rutas dinámicas: la ficha vive en /mis-alumnos/<id>. */
  routeMatch?: 'exact' | 'prefix';
  /** La URL se lee del href de este `data-onboarding` (ficha del alumno). */
  routeFrom?: string;
  /** Nombre de la sección, para anunciar el salto ("Te llevo a Finanzas"). */
  routeLabel: string;
  side?: StepSide;
  align?: StepAlign;
  /** Dónde encontrarlo. Se muestra cuando el paso queda centrado. */
  where: string;
  /**
   * Pasos que forman una unidad. Si el bloque se rompe a mitad (el profesor
   * cierra el modal), el tour salta al primer paso POSTERIOR al bloque entero en
   * vez de quedarse resaltando un nodo que ya no está en el documento.
   */
  block?: 'presentacion';
  /**
   * El ancla se repite por fila (una por tarjeta de clase o de alumno). Se resalta
   * la PRIMERA visible, que es la que el profesor tiene delante. Sirve para que la
   * validación de anclas no denuncie como duplicado lo que es una lista.
   */
  multiple?: boolean;
  /** Paso de ORIENTACIÓN: se enseña una vez y no vuelve en las clases siguientes. */
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

/**
 * Área del profesor. Fuera de estas rutas el tour se cierra solo: el recorrido no
 * tiene ningún paso ahí y dejarlo abierto sobre, por ejemplo, el panel de admin
 * sería un overlay pegado sobre una pantalla que no le corresponde.
 */
export const RUTAS_PROFESOR = [RUTA_CALENDARIO, RUTA_AGENDA, RUTA_ALUMNOS, RUTA_FINANZAS, '/asistencias'];

export function esRutaDeProfesor(pathname: string): boolean {
  return RUTAS_PROFESOR.some(r => pathname === r || pathname.startsWith(r + '/'));
}

/** Ancla del contenedor del modal: sirve para saber si su contenido ya montó. */
export const ANCLA_MODAL_PRESENTACION = 'pres-modal';

export const ONBOARDING_STEPS: TourStep[] = [
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
    multiple: true,
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    selector: 'presentation-email',
    title: 'Abre el email de presentación',
    body: 'Es tu primer contacto con un alumno nuevo y se manda una sola vez, dentro de las primeras 24 horas. Pasada esa ventana cuenta como retraso en tu seguimiento. Este botón te prepara el correo entero: texto, enlace de Meet y formulario inicial.',
    where: 'En "Mis clases", debajo del botón principal de la tarjeta. Solo aparece la primera vez con cada alumno.',
    // Se envía UNA vez por alumno: desde el segundo día el botón ya no está y
    // esperarlo dejaría al profesor trabado en el primer paso.
    requires: () => tourBridge().hasPresentationPending(),
    onMissing: 'skip',
    side: 'left',
    align: 'center',
    actionable: true,
  },
  {
    id: 'pres-copy',
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    selector: 'pres-copy',
    title: 'Revisa el enlace de Meet y copia el email',
    body: 'Pega arriba tu enlace de Meet: queda guardado para ese alumno y es el que usará "Ingresar a clase" siempre. Luego "Copiar email" se lleva destinatario, asunto y cuerpo al portapapeles de una vez. Puedes editar el texto antes.',
    where: 'Dentro del modal "Email de presentación", el botón verde con borde "📋 Copiar email".',
    block: 'presentacion',
    // El tour ABRE el modal: antes lo daba por abierto y, si el profesor no había
    // pulsado el botón del paso anterior, estos dos pasos describían botones que
    // no estaban en la pantalla.
    requires: () => tourBridge().hasPresentationPending(),
    onEnter: async () => { tourBridge().openPresentationModal(); },
    onMissing: 'skip',
    side: 'top',
    align: 'center',
    actionable: true,
  },
  {
    id: 'pres-mark-sent',
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    selector: 'pres-mark-sent',
    title: 'Envíalo desde TU Gmail y vuelve a marcarlo',
    body: 'La plataforma NO envía el correo: lo escribe por ti. Abre tu Gmail, crea un mensaje nuevo, pega (Ctrl+V) y envíalo desde tu propia cuenta, que es la que el alumno debe ver. Cuando lo hayas enviado de verdad, vuelve aquí y pulsa "Marcar como enviado": copiarlo no lo marca solo, y hasta que no lo marques el aviso te sigue corriendo.',
    where: 'Dentro del modal "Email de presentación", el botón verde grande "✅ Marcar como enviado".',
    block: 'presentacion',
    requires: () => tourBridge().hasPresentationPending(),
    onEnter: async () => { tourBridge().openPresentationModal(); },
    // Cierra el modal al pasar de largo: el paso siguiente vive en la pantalla de
    // abajo y el modal la taparía entera.
    onExit: async () => { tourBridge().closePresentationModal(); },
    onMissing: 'skip',
    side: 'top',
    align: 'center',
    actionable: true,
  },

  // ── 4. Disponibilidad ───────────────────────────────────────────────────────
  // Después del email, no antes: es la condición para que te SIGAN llegando
  // alumnos, pero el que ya tiene asignado no espera a que ordene su calendario.
  {
    id: 'calendar-grid',
    route: RUTA_CALENDARIO,
    routeLabel: 'Calendario',
    selector: 'calendar-grid',
    title: 'Marca tu disponibilidad',
    body: 'Cada celda verde es una hora en la que la academia puede asignarte un alumno. Se guarda sola al hacer clic. Si no marcas nada, no te llegan alumnos nuevos.',
    where: 'En "Calendario", pestaña "Mi calendario": la parrilla de la semana.',
    // Estructural: la parrilla se pinta siempre. Si faltara sería un fallo nuestro,
    // y el texto del paso sigue valiendo aunque no se pueda señalar.
    onMissing: 'center',
    once: true,
    side: 'bottom',
    align: 'start',
    actionable: false,
  },

  // ── 5-8. Alumnos y fichas ───────────────────────────────────────────────────
  {
    id: 'students-list',
    route: RUTA_ALUMNOS,
    routeLabel: 'Alumnos',
    selector: 'students-list',
    title: 'Aquí viven tus alumnos',
    body: 'Todos tus alumnos activos, con su nivel y el estado de su ficha. El filtro "Sin ficha" te aísla los que aún no tienen: son los que te falta preparar.',
    where: 'En la sección "Alumnos" del menú.',
    // Los chips se pintan siempre, también sin ningún alumno.
    onMissing: 'center',
    once: true,
    side: 'bottom',
    align: 'start',
    actionable: false,
  },
  {
    id: 'ficha-generate',
    multiple: true,
    route: RUTA_ALUMNOS,
    routeLabel: 'Alumnos',
    selector: 'ficha-generate',
    title: 'Genera la ficha del alumno',
    body: 'La ficha la escribe la IA a partir del formulario inicial que rellenó el alumno: quién es, por qué estudia inglés, su nivel y qué le funciona. Es lo que te permite entrar a la primera clase sabiendo con quién hablas.',
    where: 'En la tarjeta de un alumno sin ficha, el botón "Generar ficha".',
    requires: () => tourBridge().hasStudents(),
    onMissing: 'skip',
    once: true,
    side: 'bottom',
    align: 'center',
    actionable: true,
  },
  {
    id: 'student-open',
    multiple: true,
    route: RUTA_ALUMNOS,
    routeLabel: 'Alumnos',
    selector: 'student-open',
    title: 'Abre la ficha completa',
    body: 'Cada alumno tiene su ficha propia. Es donde vas a preparar cada clase y donde queda todo lo que la IA aprende de sus transcripciones.',
    where: 'En la tarjeta de cualquier alumno, el enlace "Ver ficha →".',
    requires: () => tourBridge().hasStudents(),
    onMissing: 'skip',
    once: true,
    side: 'top',
    align: 'center',
    actionable: true,
  },
  {
    id: 'ficha-tabs',
    route: RUTA_FICHA,
    routeMatch: 'prefix',
    // La URL depende del alumno, así que se lee del enlace "Ver ficha →" en vez de
    // estar escrita a mano. Sin alumnos no hay destino y el paso se salta.
    routeFrom: 'student-open',
    routeLabel: 'la ficha del alumno',
    selector: 'ficha-tabs',
    title: 'Las tres pestañas de la ficha',
    body: '"Perfil" es quién es el alumno y qué le motiva. "Seguimiento" recoge lo que la IA saca de cada transcripción que subes, incluidas las señales de riesgo de baja. "Próxima clase" te propone un plan concreto para la clase que viene: es por donde conviene empezar a preparar.',
    where: 'Dentro de la ficha de un alumno, la fila de pestañas bajo su nombre.',
    requires: () => tourBridge().hasStudents(),
    onMissing: 'skip',
    once: true,
    side: 'bottom',
    align: 'start',
    actionable: false,
  },

  // ── 9-11. La clase ──────────────────────────────────────────────────────────
  {
    id: 'join-class',
    multiple: true,
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    selector: 'join-class',
    // Mismo paso del procedimiento: es el botón que ocupa ese hueco cuando al
    // alumno todavía le falta el enlace de Meet.
    fallbackSelectors: ['set-link'],
    title: 'Entra a la clase',
    body: 'Este botón registra tu acceso, y ese registro es el primero de los dos factores que hacen que la clase se te pague. No se puede cargar después: entrar al Meet por fuera deja la clase sin registro.',
    where: 'En "Mis clases", el botón verde de la tarjeta. Si al alumno le falta el enlace de Meet, dirá "Definir enlace": definilo una vez y queda guardado.',
    // Requiere una clase futura en el rango a la vista. Un domingo no hay ninguna.
    onMissing: 'skip',
    side: 'left',
    align: 'center',
    actionable: true,
  },
  {
    id: 'give-class',
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    selector: '',
    title: 'Da tu clase con normalidad',
    body: 'Durante la clase no hay nada que tocar acá. Si el alumno está en riesgo de baja, antes de abrir el Meet verás un aviso con el protocolo de esa clase: el alumno no lo ve, es solo para vos.',
    where: 'En Google Meet, fuera de la plataforma.',
    // Informativo por naturaleza: no señala nada porque no ocurre en la app.
    onMissing: 'center',
    actionable: false,
  },
  {
    id: 'add-transcript',
    multiple: true,
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    selector: 'add-transcript',
    title: 'Sube el transcript',
    body: 'Es el segundo factor: hasta que no lo subas, la clase figura como "pendiente de transcript" y no suma a tu total a cobrar. Copiá de Fathom la pestaña Transcript completa, no el Summary.',
    where: 'En "Mis clases", en la tarjeta de una clase ya dada. Si no la ves, usá el filtro "Sin transcript".',
    // Requiere una clase YA DADA sin transcript. Si el profesor está al día, no hay.
    onMissing: 'skip',
    side: 'left',
    align: 'center',
    actionable: true,
  },

  // ── 12. Cierre ──────────────────────────────────────────────────────────────
  {
    id: 'class-status',
    route: RUTA_FINANZAS,
    routeLabel: 'Finanzas',
    selector: 'payment-summary',
    title: 'Comprueba que la clase ya cuenta',
    body: 'Con el acceso registrado y el transcript subido, la clase pasa a "pagable" y se suma a tu total. Acá lo ves con importes: lo que ya está cerrado y lo que sigue pendiente de transcript.',
    where: 'En "Finanzas", la tarjeta "Total a cobrar" con el desglose del mes.',
    // Estructural: el resumen de Finanzas se pinta siempre.
    onMissing: 'center',
    side: 'bottom',
    align: 'start',
    actionable: false,
  },
];

export const ONBOARDING_TOTAL_STEPS = ONBOARDING_STEPS.length;

/** Todas las anclas que un paso acepta, en orden de preferencia. */
export function selectorsOf(step: TourStep): string[] {
  if (!step.selector) return [];
  return [step.selector, ...(step.fallbackSelectors ?? [])];
}

/**
 * Firma de la lista de pasos. Se guarda junto al índice en sessionStorage: si
 * cambia el número de pasos o alguno de los ids, el índice guardado deja de
 * significar lo mismo y se descarta en vez de reanudar en un paso equivocado.
 */
export const ONBOARDING_SIGNATURE = `${ONBOARDING_STEPS.length}:${ONBOARDING_STEPS.map(s => s.id).join(',')}`;

export function stepIndexOf(id: OnboardingStepId): number {
  return ONBOARDING_STEPS.findIndex(s => s.id === id);
}

/** Primer índice DESPUÉS del bloque al que pertenece `index`. Si el paso no está
 *  en ningún bloque, el siguiente a secas. */
export function indexAfterBlock(index: number): number {
  const block = ONBOARDING_STEPS[index]?.block;
  if (!block) return index + 1;
  let i = index;
  while (i < ONBOARDING_STEPS.length && ONBOARDING_STEPS[i].block === block) i++;
  return i;
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
