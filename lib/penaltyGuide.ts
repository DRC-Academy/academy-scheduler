// ── Guía del profesor: cancelaciones, recuperaciones y faltas ─────────────────
//
// FUENTE ÚNICA de todo lo que el profesor lee sobre el sistema de penalizaciones
// que arrancó el 22/10/2026: el panel inferior que la anuncia, los 9 pasos del
// recorrido y la sección del centro de ayuda (tabla de reglas + casos).
//
// El recorrido NO tiene motor propio: es una segunda lista de pasos para el
// mismo motor del tutorial (lib/OnboardingContext), con el mismo contrato
// `TourStep` (lib/onboarding). Siempre se abre en modo manual, así que nada se
// salta: lo que no esté en pantalla se muestra centrado con su maqueta.
//
// Las cifras (24 h, 2 comodines, 5 €, 10 €, minuto 30) se leen de las constantes
// de las reglas, nunca se escriben a mano: si un día cambian, la guía cambia
// con ellas.
//
// Módulo PURO salvo `tourBridge` (registro sin estado de React).
import type { TourStep } from '@/lib/onboarding';
import { tourBridge } from '@/lib/tourBridge';
import { cleanAiText } from '@/lib/textCleanup';
import {
  MONTHLY_WILDCARDS, PENALTY_EUROS, NO_SHOW_PENALTY_EUROS, LATE_NOTICE_MINUTES,
  PROPOSAL_WINDOW_DAYS,
} from '@/lib/classRecoveries';
import { ABSENCE_AFTER_MINUTES } from '@/lib/teacherAbsences';
import { getSpainParts } from '@/lib/spainTime';

/** Último día (hora de España, inclusive) en que sale el panel inferior. */
export const GUIDE_BANNER_UNTIL = '2026-11-01';

/**
 * Enlace al WhatsApp del equipo. Vacío = el texto dice "escríbenos por WhatsApp"
 * sin enlace. Con un enlace `https://wa.me/<número>` el centro de ayuda lo pinta
 * como botón.
 */
export const TEAM_WHATSAPP_URL = '';

const HORAS_AVISO = LATE_NOTICE_MINUTES / 60;
/** Espacio duro entre cifra y unidad ("24 h", "5 €"): en el móvil no se parten. */
const NB = ' ';

// ── Panel inferior ────────────────────────────────────────────────────────────

export const GUIDE_BANNER = {
  tag: 'Novedad',
  title: 'Cambió cómo se cancelan y recuperan las clases',
  body: 'Desde el 22 de octubre las faltas sin avisar tienen penalización. Te explicamos cómo funciona en 2 minutos.',
  start: 'Iniciar guía',
  later: 'Más tarde',
} as const;

/** Fecha de hoy en España, 'YYYY-MM-DD'. */
export function spainToday(now: Date = new Date()): string {
  return getSpainParts(now).dateStr;
}

export interface GuideBannerInput {
  role: string | null | undefined;
  /** Hoy en España ('YYYY-MM-DD'). */
  today: string;
  /** Cuándo terminó la guía (base o local). Con valor, el panel no sale nunca más. */
  completedAt: string | null | undefined;
  /** Día en que pulsó "Más tarde" o la X. Ese mismo día no vuelve a salir. */
  laterOn: string | null | undefined;
  /** Hay un recorrido abierto (esta guía o el tutorial). */
  tourOpen: boolean;
  /** Profesor nuevo con el tutorial automático en curso: no se le juntan los dos. */
  autoOnboarding: boolean;
}

/** ¿Se muestra el panel inferior? */
export function shouldShowGuideBanner(i: GuideBannerInput): boolean {
  if (i.role !== 'teacher') return false;
  if (i.today > GUIDE_BANNER_UNTIL) return false;
  if (i.completedAt) return false;
  if (i.laterOn === i.today) return false;
  if (i.tourOpen || i.autoOnboarding) return false;
  return true;
}

/** "Más tarde": se guarda el día, por profesor. Vuelve a salir al día siguiente. */
export function laterKey(teacherId: string): string {
  return `drc_guia_penal_mas_tarde_${teacherId}`;
}

// ── Recorrido ─────────────────────────────────────────────────────────────────

export type PenaltyGuideStepId =
  | 'pg-welcome' | 'pg-join' | 'pg-menu' | 'pg-no-puedo' | 'pg-acordado'
  | 'pg-alumno-cambia' | 'pg-recuperaciones' | 'pg-falta' | 'pg-cierre';

/** Anclas que la guía añade a "Mis clases" (components/MisClasesPanel). */
export const ANCLA_MENU_CLASE = 'class-menu';
export const ANCLA_MENU_NO_PUEDO = 'menu-no-puedo';
export const ANCLA_MENU_ALUMNO = 'menu-alumno-cambia';

const RUTA = '/clases';
const ETIQUETA = 'Mis clases';

const abrirMenu = () => tourBridge().openClassMenu();
const cerrarMenu = () => tourBridge().closeClassMenu();

const PASOS: TourStep[] = [
  {
    id: 'pg-welcome',
    route: RUTA, routeLabel: ETIQUETA, selector: '',
    title: 'Cancelaciones, recuperaciones y faltas',
    body: 'Te mostramos cómo cancelar, recuperar y evitar penalizaciones.',
    where: '',
    onMissing: 'center',
    actionable: false,
  },
  {
    id: 'pg-join',
    multiple: true,
    route: RUTA, routeLabel: ETIQUETA,
    selector: 'join-class',
    // Fuera de la ventana de ingreso el mismo hueco muestra el botón apagado
    // ("Disponible desde las 13:45"): es el mismo botón, se señala igual.
    fallbackSelectors: ['join-slot'],
    title: 'Entra siempre con «Ingresar a clase»',
    body: `Entra SIEMPRE con este botón. Es lo que registra que diste la clase. Si a los ${ABSENCE_AFTER_MINUTES} minutos no lo pulsaste, se registra como falta.`,
    bodyWhenMissing: `Ahora no tienes ninguna clase por delante, así que el botón no está en pantalla. Entra SIEMPRE con él: es lo que registra que diste la clase. Si a los ${ABSENCE_AFTER_MINUTES} minutos no lo pulsaste, se registra como falta.`,
    mockButton: { label: 'Ingresar a clase' },
    where: 'En "Mis clases", el botón verde de la tarjeta de cada clase. Se activa 15 minutos antes.',
    requires: () => tourBridge().hasUpcomingClass(),
    onMissing: 'center',
    side: 'left', align: 'center',
    actionable: false,
  },
  {
    id: 'pg-menu',
    multiple: true,
    route: RUTA, routeLabel: ETIQUETA,
    selector: ANCLA_MENU_CLASE,
    title: 'El menú de cada clase',
    body: 'Aquí están las opciones para cada clase.',
    bodyWhenMissing: 'Cada clase que tienes por delante lleva un botón ⋯ en su tarjeta. Ahí están las opciones para cada clase.',
    mockButton: { label: '⋯' },
    where: 'En "Mis clases", el botón ⋯ junto a «Ingresar a clase».',
    requires: () => tourBridge().hasUpcomingClass(),
    onMissing: 'center',
    side: 'left', align: 'center',
    actionable: false,
  },
  {
    id: 'pg-no-puedo',
    route: RUTA, routeLabel: ETIQUETA,
    selector: ANCLA_MENU_NO_PUEDO,
    title: '«No puedo dar esta clase»',
    body: `Si no puedes darla, propones 2 fechas de los próximos ${PROPOSAL_WINDOW_DAYS} días y el alumno elige una desde su plataforma (le avisamos por email). Con más de ${HORAS_AVISO}${NB}h: sin coste. Con menos de ${HORAS_AVISO}${NB}h: ${MONTHLY_WILDCARDS} gratis al mes; desde la ${MONTHLY_WILDCARDS + 1}.ª, ${PENALTY_EUROS}${NB}€.`,
    mockButton: { label: 'No puedo dar esta clase' },
    where: 'En "Mis clases", dentro del menú ⋯ de una clase que todavía no se dio.',
    requires: () => tourBridge().hasUpcomingClass(),
    onEnter: abrirMenu,
    onExit: cerrarMenu,
    onMissing: 'center',
    side: 'left', align: 'center',
    actionable: false,
  },
  {
    // Explicado, sin abrir el modal de verdad: abrirlo pide la vista previa al
    // servidor y deja al profesor a un clic de cancelar una clase real.
    id: 'pg-acordado',
    route: RUTA, routeLabel: ETIQUETA, selector: '',
    title: '«Ya lo acordé con el alumno»',
    body: 'Si ya hablaste otra fecha con el alumno, abre «No puedo dar esta clase», marca esta opción y pon esa fecha. El coste es el mismo que al cancelar.',
    mockButton: { label: 'Ya lo acordé con el alumno' },
    where: '',
    onMissing: 'center',
    actionable: false,
  },
  {
    id: 'pg-alumno-cambia',
    route: RUTA, routeLabel: ETIQUETA,
    selector: ANCLA_MENU_ALUMNO,
    title: '«El alumno pidió cambiarla»',
    body: 'Si el cambio lo pide el alumno, usa esta opción. No tiene coste para ti. También sirve cuando el alumno avisa sobre la hora.',
    mockButton: { label: 'El alumno pidió cambiarla' },
    where: 'En "Mis clases", dentro del menú ⋯ de cada clase.',
    requires: () => tourBridge().hasUpcomingClass(),
    onEnter: abrirMenu,
    onExit: cerrarMenu,
    onMissing: 'center',
    side: 'left', align: 'center',
    actionable: false,
  },
  {
    id: 'pg-recuperaciones',
    multiple: true,
    route: RUTA, routeLabel: ETIQUETA,
    selector: 'recovery-response',
    // Sin ninguna respuesta pendiente, la campanita: es por donde llega el aviso.
    fallbackSelectors: ['notification-bell'],
    title: 'Cuando el alumno no puede en tus fechas',
    body: 'Si el alumno no puede en tus fechas, te propone otras. Te avisamos aquí: acepta una o propón 2 nuevas.',
    bodyWhenMissing: 'Si el alumno no puede en tus fechas, te propone otras. Te avisamos con la campanita y con una tarjeta arriba de tus clases: acepta una o propón 2 nuevas.',
    mockButton: { label: 'Proponer otras 2 fechas' },
    where: 'La campanita de arriba y, cuando haya una respuesta, una tarjeta encima de tus clases.',
    onMissing: 'center',
    side: 'bottom', align: 'center',
    actionable: false,
  },
  {
    id: 'pg-falta',
    route: RUTA, routeLabel: ETIQUETA, selector: '',
    title: 'Falta sin avisar',
    body: `Si no cancelas y no entras a la clase, se aplica una penalización de ${NO_SHOW_PENALTY_EUROS}${NB}€ automáticamente y el alumno recibe opciones para recuperarla.`,
    where: '',
    onMissing: 'center',
    actionable: false,
  },
  {
    id: 'pg-cierre',
    route: RUTA, routeLabel: ETIQUETA, selector: '',
    title: '¿Dudas?',
    body: '¿Dudas o una penalización que crees que es un error? Escríbenos por WhatsApp. Tienes esta guía siempre en el centro de ayuda (el botón «?» de arriba).',
    where: '',
    doneLabel: 'Entendido',
    onMissing: 'center',
    actionable: false,
  },
];

const copy = (s: string): string => cleanAiText(s);

export const PENALTY_GUIDE_STEPS: TourStep[] = PASOS.map(s => ({
  ...s,
  title: copy(s.title),
  body: copy(s.body),
  where: copy(s.where),
  ...(s.bodyWhenMissing ? { bodyWhenMissing: copy(s.bodyWhenMissing) } : {}),
}));

// ── Centro de ayuda ───────────────────────────────────────────────────────────

export const GUIDE_HELP_TITLE = 'Cancelaciones, recuperaciones y faltas';

export const GUIDE_RULES: { head: [string, string]; rows: Array<[string, string]> } = {
  head: ['Situación', 'Qué pasa'],
  rows: [
    [`Cancelas con más de ${HORAS_AVISO}${NB}h`, 'Sin coste.'],
    [`Cancelas con menos de ${HORAS_AVISO}${NB}h`, `${MONTHLY_WILDCARDS} gratis al mes. Desde la ${MONTHLY_WILDCARDS + 1}.ª, ${PENALTY_EUROS}${NB}€.`],
    ['Falta sin avisar (no cancelas y no entras)', `${NO_SHOW_PENALTY_EUROS}${NB}€ automáticos. El alumno recibe opciones para recuperarla.`],
  ],
};

export interface GuideCase { id: string; situation: string; action: string; }

const MITAD_2H = 60;

export const GUIDE_CASES: GuideCase[] = [
  {
    id: 'alumno-no-viene',
    situation: 'El alumno avisa que no viene',
    action: 'En el menú ⋯ de la clase, «El alumno pidió cambiarla». No tiene coste para ti.',
  },
  {
    id: 'alumno-sobre-la-hora',
    situation: 'El alumno avisa sobre la hora',
    action: '⋯ → «El alumno pidió cambiarla» → «El alumno avisó sobre la hora». La clase se pierde (no se recupera) y se te paga, hasta 2 por alumno al mes.',
  },
  {
    id: 'alumno-no-aparece',
    situation: 'El alumno no aparece',
    action: 'Entra con «Ingresar a clase» y espéralo. Después, en su tarjeta, pulsa «Añadir transcript» y elige «Falta del alumno sin aviso». Se te paga sin transcript, hasta 2 por alumno al mes (junto con los avisos sobre la hora).',
  },
  {
    id: 'alumno-otro-dia',
    situation: 'El alumno quiere cambiar una clase a otro día',
    action: '⋯ → «El alumno pidió cambiarla» y pon la nueva fecha.',
  },
  {
    id: 'horario-fijo',
    situation: 'El alumno quiere cambiar su horario fijo',
    action: 'Lo cambia el alumno desde su plataforma, en el cambio de horario. Si no puede, escríbenos por WhatsApp y lo hacemos nosotros. No lo cambies tú en el calendario.',
  },
  {
    id: 'no-puedes',
    situation: 'No puedes dar una clase',
    action: `⋯ → «No puedo dar esta clase». Con más de ${HORAS_AVISO}${NB}h, sin coste. Con menos, usa un comodín (${MONTHLY_WILDCARDS} al mes) o cuesta ${PENALTY_EUROS}${NB}€.`,
  },
  {
    id: 'ya-acordado',
    situation: 'Ya acordaste otra fecha por WhatsApp',
    action: '«No puedo dar esta clase» → pestaña «Ya lo acordé con el alumno» y pon esa fecha. El coste es el mismo que al cancelar.',
  },
  {
    id: 'emergencia',
    situation: 'Una emergencia a último momento',
    action: `Cancela igual con «No puedo dar esta clase», aunque sea tarde. Usa un comodín o cuesta ${PENALTY_EUROS}${NB}€, nunca los ${NO_SHOW_PENALTY_EUROS}${NB}€ de la falta.`,
  },
  {
    id: 'llegas-tarde',
    situation: 'Vas a llegar tarde',
    action: `Entra igual y pulsa «Ingresar a clase» en cuanto puedas. Si entras antes del minuto ${ABSENCE_AFTER_MINUTES}, no pasa nada. Después se registra la falta: en una clase de 2${NB}h se anula sola si entras antes del minuto ${MITAD_2H}; en una de 1${NB}h no se anula sola, así que escríbenos por WhatsApp y la revisamos.`,
  },
  {
    id: 'olvidaste-ingresar',
    situation: 'Diste la clase pero olvidaste pulsar «Ingresar a clase»',
    action: 'Ve a «Revisiones», declara la clase como «Clase normal» y pega el transcript. Escríbenos también por WhatsApp para revisar la penalización.',
  },
  {
    id: 'problema-tecnico',
    situation: 'Un problema técnico (internet, luz, Meet)',
    action: 'Escríbenos por WhatsApp lo antes posible, mejor antes de la clase.',
  },
  {
    id: 'recuperacion',
    situation: 'Es una clase de recuperación y no puedes darla',
    action: 'Escríbenos por WhatsApp. En las recuperaciones no aparece «No puedo dar esta clase».',
  },
  {
    id: 'alumno-fantasma',
    situation: 'En tu calendario hay un alumno que ya no tiene clase contigo',
    action: 'Avísanos por WhatsApp para quitarlo. Así no se registra una falta por una clase que ya no existe.',
  },
  {
    id: 'reclamar',
    situation: 'Crees que una penalización es un error',
    action: 'Escríbenos por WhatsApp con el alumno, la fecha y qué pasó. La revisamos y, si corresponde, te devolvemos el importe.',
  },
].map(c => ({ ...c, situation: copy(c.situation), action: copy(c.action) }));
