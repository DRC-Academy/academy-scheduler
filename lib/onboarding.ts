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
// Módulo PURO: sin Supabase y sin componentes. Solo depende de lib/tourBridge
// (registro de funciones sin estado de React) y de lib/textCleanup (limpieza de
// guiones, ver `copy` al final del archivo).
import type { Teacher } from '@/types';
import { tourBridge } from '@/lib/tourBridge';
import { cleanAiText } from '@/lib/textCleanup';

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
 *   'skip'   — saltarlo y seguir.
 *   'center' — mostrar el globo centrado, sin foco, con la nota "Dónde está" y,
 *              si el paso lo declara, su `bodyWhenMissing` y la maqueta del botón.
 *
 * 'center' es la opción por defecto para todo paso que ENSEÑA algo, aunque su
 * elemento dependa de los datos del profesor. 'skip' se reserva para pasos cuya
 * explicación no se sostiene sin el elemento delante. Un paso saltado es un paso
 * que el profesor nunca aprende, y la vía automática es precisamente la del
 * profesor nuevo: ahí saltarse el email de presentación porque hoy no hay ninguno
 * pendiente era dejar sin enseñar lo más urgente que tiene encima.
 *
 * Nunca es silencioso: el motor deja un warn con el id del paso.
 *
 * OJO — esto solo gobierna la vía AUTOMÁTICA. El botón "Tutorial" del header es
 * un repaso del procedimiento completo, así que ahí NADA se salta: todo lo que no
 * se pueda anclar se muestra centrado. Saltárselo hacía que el recorrido manual
 * abriera en "Paso 4 de 12" cuando el profesor no tenía presentaciones
 * pendientes, y eso se lee como que el tutorial está roto. Ver `irAlPaso`.
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
  /**
   * Texto alternativo para cuando el paso se muestra SIN foco (`onMissing:
   * 'center'` y el elemento no está). `body` le pide al profesor que pulse algo;
   * si ese algo no está en pantalla, la frase se lee como una orden imposible. Este
   * explica el mismo paso en tercera persona: qué es ese botón, cuándo aparece y
   * para qué sirve. Sin declararlo se usa `body`.
   */
  bodyWhenMissing?: string;
  /**
   * Maqueta del botón, para los pasos que quedan sin foco. Se dibuja dentro del
   * globo con el aspecto del botón real (ver `.drc-tour-mock` en globals.css), no
   * es una captura: una imagen envejece en cuanto alguien retoca el botón, y en
   * móvil se ve borrosa. No es pulsable.
   */
  mockButton?: { label: string };
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

const PASOS: TourStep[] = [
  // ── 1-3. El email de presentación ───────────────────────────────────────────
  // ABRE el recorrido por decisión expresa: es lo más urgente que tiene encima un
  // profesor nuevo (la ventana son 24 horas desde que le asignan al alumno) y lo
  // que más se hace a medias.
  //
  // Son tres pasos para lo que en la app es un solo botón, también a propósito: el
  // envío NO ocurre dentro de la plataforma (se copia y se manda desde el Gmail
  // del profesor), y ese salto es donde la gente da por enviado un correo que solo
  // copió.
  //
  // `onMissing: 'center'` (antes 'skip'). El botón solo existe mientras haya una
  // presentación pendiente, así que al profesor que ya las había enviado todas el
  // tour le saltaba los tres pasos en silencio. Y pasaba justo en la vía
  // automática, con el profesor nuevo, que es el único que nunca ha visto ese
  // botón. Ahora el paso se muestra SIEMPRE: con foco si el botón está, y centrado
  // con `bodyWhenMissing` más la maqueta del botón si no está.
  //
  // `requires()` SE MANTIENE. Con 'center' ya no descarta el paso: lo único que
  // hace es ahorrarse la espera de 3 s por un elemento que ya sabemos que no está
  // y mandar directo al globo centrado (paso 1 de `irAlPaso`).
  {
    id: 'presentation-email',
    multiple: true,
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    selector: 'presentation-email',
    title: 'Abre el email de presentación',
    body: 'Es tu primer contacto con el alumno y solo se manda una vez. Tienes 24 horas desde que te lo asignan. Si se pasa, cuenta como retraso en tu seguimiento. Este botón te deja el correo listo: texto, enlace de Meet y formulario inicial.',
    bodyWhenMissing: 'Ahora mismo no tienes ninguna presentación pendiente, así que el botón no está en pantalla. Cuando te asignen un alumno nuevo aparecerá aquí. Sirve para mandarle el email de bienvenida con su test de nivel, y se envía una sola vez por alumno, antes de la primera clase.',
    mockButton: { label: '✉️ Enviar presentación' },
    where: 'En "Mis clases", justo debajo del botón principal de la tarjeta. Aparece solo la primera vez con cada alumno.',
    requires: () => tourBridge().hasPresentationPending(),
    onMissing: 'center',
    side: 'left',
    align: 'center',
    actionable: true,
  },
  {
    id: 'pres-copy',
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    selector: 'pres-copy',
    title: 'Pega tu Meet y copia el email',
    body: 'Pega arriba tu enlace de Meet. Queda guardado para ese alumno y es el que abrirá "Ingresar a clase" de aquí en adelante. Luego pulsa "Copiar email": se lleva destinatario, asunto y cuerpo de una vez. Si quieres cambiar algo del texto, hazlo antes de copiar.',
    bodyWhenMissing: 'Este paso ocurre dentro de la ventana del email, que solo se abre cuando hay una presentación pendiente. Cuando la tengas: pega arriba tu enlace de Meet, que queda guardado para ese alumno, y pulsa "Copiar email" para llevarte destinatario, asunto y cuerpo de una vez.',
    mockButton: { label: '📋 Copiar email' },
    where: 'Dentro de la ventana "Email de presentación", el botón verde "📋 Copiar email".',
    block: 'presentacion',
    // El tour ABRE el modal: antes lo daba por abierto y, si el profesor no había
    // pulsado el botón del paso anterior, estos dos pasos describían botones que
    // no estaban en la pantalla.
    requires: () => tourBridge().hasPresentationPending(),
    onEnter: async () => { tourBridge().openPresentationModal(); },
    onMissing: 'center',
    side: 'top',
    align: 'center',
    actionable: true,
  },
  {
    id: 'pres-mark-sent',
    route: RUTA_AGENDA,
    routeLabel: 'Mis clases',
    selector: 'pres-mark-sent',
    title: 'Envíalo desde tu Gmail y márcalo',
    body: 'La plataforma no envía el correo, solo te lo escribe. Abre tu Gmail, crea un mensaje nuevo, pega con Ctrl+V y mándalo desde tu cuenta. El alumno tiene que ver tu nombre como remitente. Cuando lo hayas enviado de verdad, vuelve aquí y pulsa "Marcar como enviado". Copiarlo no lo marca, y hasta que no lo marques el aviso te sigue corriendo.',
    bodyWhenMissing: 'El último paso del email, para cuando tengas uno pendiente. La plataforma no lo envía, solo te lo escribe: lo mandas tú desde tu Gmail, porque el alumno tiene que ver tu nombre como remitente. Después vuelves aquí y pulsas "Marcar como enviado". Copiarlo no lo marca, y hasta que no lo marques el aviso te sigue corriendo.',
    mockButton: { label: '✅ Marcar como enviado' },
    where: 'Dentro de la ventana "Email de presentación", el botón verde grande "✅ Marcar como enviado".',
    block: 'presentacion',
    requires: () => tourBridge().hasPresentationPending(),
    onEnter: async () => { tourBridge().openPresentationModal(); },
    // Cierra el modal al pasar de largo: el paso siguiente vive en la pantalla de
    // abajo y el modal la taparía entera.
    onExit: async () => { tourBridge().closePresentationModal(); },
    onMissing: 'center',
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
    body: 'Cada celda verde es una hora en la que la academia puede darte un alumno. Haz clic y se guarda sola. Si no marcas nada, no te llegan alumnos nuevos.',
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
    title: 'Aquí están tus alumnos',
    body: 'Todos tus alumnos activos, con su nivel y el estado de su ficha. El filtro "Sin ficha" te deja solo los que te falta preparar.',
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
    body: 'La escribe la IA con el formulario que rellenó el alumno: quién es, por qué estudia inglés, su nivel y qué le funciona. Con eso entras a la primera clase sabiendo con quién hablas.',
    bodyWhenMissing: 'No tienes ningún alumno sin ficha, así que el botón no está en pantalla. Cuando lo tengas, la ficha la escribe la IA con el formulario que rellenó el alumno: quién es, por qué estudia inglés, su nivel y qué le funciona. Con eso entras a la primera clase sabiendo con quién hablas.',
    mockButton: { label: 'Generar ficha' },
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
    body: 'Cada alumno tiene la suya. Es donde preparas cada clase y donde se guarda todo lo que la IA aprende de sus transcripciones.',
    bodyWhenMissing: 'Cuando tengas alumnos, cada uno tendrá su ficha. Es donde preparas cada clase y donde se guarda todo lo que la IA aprende de sus transcripciones. Se entra desde el enlace "Ver ficha" de su tarjeta.',
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
    body: '"Perfil" es quién es el alumno y qué le motiva. "Seguimiento" recoge lo que la IA saca de cada transcript que subes, incluidas las señales de riesgo de baja. "Próxima clase" te propone un plan para la clase que viene. Empieza por ahí cuando prepares.',
    bodyWhenMissing: 'Dentro de la ficha de cada alumno hay tres pestañas. "Perfil" es quién es y qué le motiva. "Seguimiento" recoge lo que la IA saca de cada transcript que subes, incluidas las señales de riesgo de baja. "Próxima clase" te propone un plan para la clase que viene. Empieza por ahí cuando prepares.',
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
    title: 'Entra a la clase desde aquí',
    body: 'Pulsa "Ingresar a clase". Abre el Meet y registra tu acceso, que es el primero de los dos requisitos para que la clase se te pague. No se puede añadir después: si entras al Meet por tu cuenta, la clase queda sin registro.',
    bodyWhenMissing: 'No tienes ninguna clase por delante en los días que se están viendo, así que el botón no está en pantalla. Cuando la tengas, se entra siempre desde aquí: abre el Meet y registra tu acceso, que es el primero de los dos requisitos para que la clase se te pague. Entrar al Meet por tu cuenta deja la clase sin registro, y eso no se puede añadir después.',
    mockButton: { label: 'Ingresar a clase' },
    where: 'En "Mis clases", el botón verde de la tarjeta. Si al alumno le falta el enlace de Meet, pondrá "Definir enlace". Defínelo una vez y queda guardado.',
    // El botón solo existe si hay una clase por delante en el rango a la vista, y
    // un domingo no hay ninguna. Pero entrar a clase es uno de los dos requisitos
    // del cobro: saltárselo dejaba sin enseñar media regla de pago, así que se
    // explica igual. `requires` evita la espera inútil por el elemento.
    requires: () => tourBridge().hasUpcomingClass(),
    onMissing: 'center',
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
    body: 'Durante la clase no tienes que tocar nada aquí. Si el alumno está en riesgo de baja, verás un aviso con el protocolo de esa clase antes de abrir el Meet. El alumno no lo ve, es solo para ti.',
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
    body: 'Al terminar, sube el transcript. Es el segundo requisito: hasta que no lo subas, la clase queda "pendiente de transcript" y no suma a tu total a cobrar. Copia de Fathom la pestaña Transcript entera, no el Summary.',
    bodyWhenMissing: 'Estás al día: no tienes ninguna clase esperando transcript. Al terminar cada clase se sube desde su tarjeta. Es el segundo requisito: hasta que no lo subas, la clase queda "pendiente de transcript" y no suma a tu total a cobrar. Copia de Fathom la pestaña Transcript entera, no el Summary.',
    mockButton: { label: 'Añadir transcript' },
    where: 'En "Mis clases", en la tarjeta de una clase ya dada. Si no la ves, usa el filtro "Sin transcript".',
    // Requiere una clase YA DADA sin transcript, y el profesor al día no tiene
    // ninguna. Es el otro requisito del cobro: mismo motivo que "join-class" para
    // explicarlo aunque hoy no haya nada que resaltar.
    requires: () => tourBridge().hasClassNeedingTranscript(),
    onMissing: 'center',
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
    body: 'Con el acceso registrado y el transcript subido, la clase pasa a "pagable" y se suma a tu total. Aquí lo ves con importes: lo que ya está cerrado y lo que sigue pendiente.',
    where: 'En "Finanzas", la tarjeta "Total a cobrar" con el desglose del mes.',
    // Estructural: el resumen de Finanzas se pinta siempre.
    onMissing: 'center',
    side: 'bottom',
    align: 'start',
    actionable: false,
  },
];

/**
 * Los textos pasan por `cleanAiText`, igual que los del email de cancelación
 * (lib/emailNotifications). Hoy están escritos a mano y no llevan guiones de
 * conector, así que la limpieza no cambia ni un carácter: está puesta para el día
 * que alguien pegue aquí un texto salido de la IA, que es como se cuelan.
 */
const copy = (s: string): string => cleanAiText(s);

export const ONBOARDING_STEPS: TourStep[] = PASOS.map(s => ({
  ...s,
  title: copy(s.title),
  body: copy(s.body),
  where: copy(s.where),
  ...(s.bodyWhenMissing ? { bodyWhenMissing: copy(s.bodyWhenMissing) } : {}),
}));

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

/**
 * Qué hay que deshacer al pasar de `desde` a `hacia`. `null` = nada.
 *
 * La clave está en que, con `block`, lo que se monta es del BLOQUE y no del paso:
 * el modal del email lo abren LOS DOS pasos de dentro, con el mismo `onEnter`. El
 * desmontaje tiene que ser igual de del bloque, y antes no lo era: `onExit` solo
 * lo declaraba el ÚLTIMO paso, así que retroceder desde el PRIMERO de dentro
 * ("Pega tu Meet y copia el email") hacia el de fuera ("Abre el email de
 * presentación") no cerraba nada. El modal se quedaba abierto tapando justo el
 * botón que ese paso señala.
 *
 * Por eso al salir del bloque vale el `onExit` de cualquiera de sus pasos: así un
 * paso nuevo dentro del bloque no puede reintroducir el fallo por olvidarse de
 * declararlo.
 */
export function exitBetween(
  desde: TourStep | undefined,
  hacia: TourStep | undefined,
): (() => Promise<void>) | null {
  if (!desde) return null;
  // Moverse DENTRO del bloque no puede deshacer lo que ese mismo bloque necesita.
  if (desde.block && hacia?.block === desde.block) return null;
  if (desde.onExit) return desde.onExit;
  if (!desde.block) return null;
  return ONBOARDING_STEPS.find(s => s.block === desde.block && s.onExit)?.onExit ?? null;
}

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
  'Ya has dado tus primeras 5 clases con el proceso completo. Puedes repasar el tutorial cuando quieras desde el botón "Tutorial" del menú.';
