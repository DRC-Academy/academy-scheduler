// Sugerencias de intervención sobre las alertas de riesgo de baja.
//
// SIN dependencias de servidor (solo lib/textCleanup, que es puro): lo importan
// tanto las rutas de API como los componentes cliente (ficha del alumno, panel
// de admin). La persistencia vive en lib/interventionStore.ts (solo servidor).
//
// Qué es cada cosa:
//   · InterventionSuggestion → lo que la IA propone al profesor cuando una clase
//     sale en amarillo/rojo. Se guarda en class_analyses.intervention_suggestion.
//   · ActiveIntervention → esa misma sugerencia copiada a la ficha del alumno
//     (student_profiles.active_intervention) como alerta ABIERTA, con los
//     metadatos de la clase que la originó.
//   · InterventionCheck → la evaluación de la clase SIGUIENTE: ¿hay señales de
//     que el profesor actuó? Alimenta intervention_audits (Bloque 2).

import { cleanAiText } from '@/lib/textCleanup';
import { isRiskCause, type RiskCause, type RiskSignal } from '@/lib/aiTypes';

// ── Detecciones con su acción emparejada ─────────────────────────────────────

/**
 * Una cosa observada en la clase y QUÉ HACER con ella. Van siempre en pareja: el
 * diagnóstico suelto ("el alumno depende del español") no le sirve de nada al
 * profesor si no viene con la acción ("haz los primeros cinco minutos solo en
 * inglés, con apoyo visual").
 *
 * Se generan en TODAS las clases, también en verde: el ritmo lento o la
 * dependencia del español son hallazgos pedagógicos, no señales de baja.
 */
export interface Detection {
  finding: string;
  action: string;
}

/** Tope duro. Más de tres deja de leerse y alarga el análisis sin aportar. */
export const MAX_DETECTIONS = 3;

export function normalizeDetections(raw: unknown): Detection[] {
  if (!Array.isArray(raw)) return [];
  const out: Detection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const finding = isNonEmpty(r.finding) ? cleanAiText(r.finding.trim()) : '';
    const action  = isNonEmpty(r.action)  ? cleanAiText(r.action.trim())  : '';
    // Sin las dos mitades no es una detección: un hallazgo sin acción es
    // exactamente el problema que este campo viene a resolver.
    if (!finding || !action) continue;
    out.push({ finding, action });
    if (out.length >= MAX_DETECTIONS) break;
  }
  return out;
}

/** Lee la columna jsonb `class_analyses.detections` (objeto o string JSON). */
export function asDetections(v: unknown): Detection[] {
  if (!v) return [];
  if (typeof v === 'string') {
    try { return normalizeDetections(JSON.parse(v)); } catch { return []; }
  }
  return normalizeDetections(v);
}

export type InterventionChannel = 'en_clase' | 'mensaje_previo' | 'escalar_soporte';
export type InterventionConfidence = 'alta' | 'media' | 'baja';

export interface InterventionSuggestion {
  /** Acción concreta y específica para el profesor (una sola). */
  action: string;
  /**
   * El protocolo de esa clase en 2 a 4 pasos accionables. Es lo que se le enseña
   * al profesor al pulsar "Ingresar a clase" y, por tanto, lo EXACTO contra lo
   * que se audita la clase siguiente.
   *
   * Puede venir vacío: las intervenciones creadas antes de que la IA generara
   * pasos solo tienen `action`, y en ese caso se muestra ese texto tal cual.
   */
  steps: string[];
  /** Hito cercano (clase 15/30) como excusa natural para reconectar. Puede ir vacío. */
  reconnectHook: string;
  /** El alumno dijo explícitamente que quiere dejarlo: lo gestiona soporte, no el profesor. */
  escalateToSupport: boolean;
  channel: InterventionChannel;
}

/** La sugerencia abierta en la ficha del alumno, con el contexto de su clase. */
export interface ActiveIntervention extends InterventionSuggestion {
  risk: RiskSignal;
  /**
   * Qué se detectó en la clase que abrió la alerta, en una o dos frases. Se
   * guarda AQUÍ, junto a la alerta, y no se va a buscar a class_analyses cuando
   * hace falta: el pop-up de "Ingresar a clase" tiene que poder decir "en la
   * última clase pasó X" sin una segunda consulta en mitad del flujo de acceso.
   */
  contextSummary?: string;
  /** Causa del riesgo. Es lo que hace que la acción encaje con lo que pasa. */
  cause?: RiskCause | null;
  /**
   * Por qué la alerta SIGUE abierta, a fecha de hoy. Se reescribe en cada clase
   * que la deja abierta (ver recordInterventionAudit).
   *
   * Sin esto, el profesor veía el motivo de la clase que la abrió, congelado
   * para siempre. Y la causa es justo lo que cambia la intervención: si la
   * ausencia era por vacaciones no hay nada que reenganchar, y si es
   * desmotivación real, sí.
   */
  stillOpenReason?: string;
  /** Cuándo se actualizó `stillOpenReason` por última vez. */
  refreshedAt?: string | null;
  /** Clase que originó la alerta. Evita auditar dos veces la misma clase (reintentos). */
  classAnalysisId?: string | null;
  classNumber?: number | null;
  createdAt?: string;
  /**
   * Cuándo se le enseñó este protocolo al profesor (el pop-up de "Ingresar a
   * clase"). Viaja dentro del objeto que se guarda en intervention_audits, así
   * que el admin puede ver si el profesor llegó a leerlo antes de juzgar.
   */
  shownAt?: string | null;
}

export interface InterventionCheck {
  signsOfIntervention: boolean;
  evidence: string;
  confidence: InterventionConfidence;
  /**
   * Por qué la alerta sigue abierta SEGÚN ESTA CLASE, y con qué causa. Es la
   * reevaluación: la alerta deja de ser una foto de la clase que la abrió.
   * Puede venir vacío en auditorías de análisis anteriores a este campo.
   */
  stillOpenReason?: string;
  cause?: RiskCause | null;
}

/** Fila de intervention_audits (snake_case = columnas reales). */
export interface InterventionAuditRow {
  id: string;
  student_id: string | null;
  student_name: string | null;
  teacher_id: string | null;
  teacher_name: string | null;
  alert_signal: string | null;
  intervention_suggested: InterventionSuggestion | string | null;
  signs_of_intervention: boolean | null;
  evidence: string | null;
  confidence: string | null;
  class_analysis_id: string | null;
  created_at: string | null;
}

const CHANNELS: InterventionChannel[] = ['en_clase', 'mensaje_previo', 'escalar_soporte'];
const CONFIDENCES: InterventionConfidence[] = ['alta', 'media', 'baja'];

export const CHANNEL_LABEL: Record<InterventionChannel, string> = {
  en_clase:        'En la próxima clase',
  mensaje_previo:  'Mensaje antes de la clase',
  escalar_soporte: 'Escalar a soporte',
};

/** Recordatorio fijo: la intervención tiene que parecer natural, nunca reactiva. */
export const NATURAL_REMINDER =
  'Recuerda: no menciones al alumno que se detectó un problema. La intervención debe ser natural.';

/** Lo que NO hay que hacer. Se muestra en los tres sitios (notificación, email y ficha). */
export const AVOID_ITEMS = [
  'No ignores la alerta y sigas exactamente igual.',
  'No contactes al alumno diciendo que detectaste que algo no va bien.',
  'No presiones al alumno para que se quede si ya expresó que quiere irse.',
  'No prometas cosas que no puedas cumplir solo para evitar la baja.',
];

export const AVOID_TITLE = 'Ver qué evitar';

/**
 * Aviso para el alumno que está en amarillo o rojo pero todavía no tiene
 * protocolo generado (la IA no ha llegado a proponer uno).
 *
 * Un aviso genérico NO se audita después: no habría contra qué comparar, y por
 * eso nunca puede contar como alerta no atendida.
 */
export const GENERIC_RISK_BRIEFING =
  'Este alumno muestra señales de riesgo. Estos pasos valen para cualquier caso: úsalos tal cual.';

// ── Protocolo de respaldo: el pop-up NUNCA se queda sin qué hacer ────────────
//
// Existe porque el 06/08/2026 se comprobó que 24 de las 26 alertas abiertas no
// tenían ni un paso: son anteriores a que la IA generara protocolo, y el pop-up
// caía al texto de `action`, que en los casos escalados decía "escala el caso al
// equipo de soporte". El profesor abría el aviso, leía que no hiciera nada y
// entraba a la clase igual que si no hubiera alerta.
//
// Estos pasos son de verdad ejecutables y no dependen de la IA. No sustituyen a
// un protocolo específico cuando lo hay: solo cubren el hueco.

/** Alumno en ROJO. Contención: que la clase le siente bien, pase lo que pase. */
export const FALLBACK_STEPS_ROJO: string[] = [
  'Recíbelo con normalidad y arranca con algo que ya domine, para que los primeros minutos le salgan bien.',
  'Si lo notas tenso o acelerado, baja el ritmo: proponle una pausa, hablad más despacio y quítale carga a la clase.',
  'En algún momento natural pregúntale cómo lleva el inglés últimamente, y escucha sin justificarte ni rebatirle.',
  'Cierra recordándole algo concreto que ha mejorado desde que empezó.',
];

/** Alumno en AMARILLO. Reenganche: que salga con ganas de volver. */
export const FALLBACK_STEPS_AMARILLO: string[] = [
  'Empieza preguntándole qué tal le está yendo con el inglés fuera de clase.',
  'Ajusta la clase a lo que te diga: si lo ves espeso, cambia a algo más corto y hablado.',
  'Dale una victoria clara a mitad de clase, algo que le salga bien y lo note.',
  'Cierra acordando con él qué vais a trabajar la próxima vez.',
];

export function fallbackSteps(risk: RiskSignal): string[] {
  return risk === 'rojo' ? FALLBACK_STEPS_ROJO : FALLBACK_STEPS_AMARILLO;
}

/**
 * Un paso solo sirve si el profesor puede EJECUTARLO. Se descartan los que:
 *   · delegan en otro equipo ("deja que soporte active el protocolo"), y
 *   · solo dicen lo que NO hay que hacer ("no intentes retenerlo tú solo").
 *
 * No son inventados: son los pasos reales que la IA generó para los dos únicos
 * casos escalados que llegaron a tener protocolo. Dos de tres eran así, y con
 * ellos el pop-up quedaba igual de vacío que sin pasos.
 *
 * Lo que NO hay que hacer sigue estando, en su sitio: la lista "qué evitar".
 */
const DELEGA = /\b(soporte|equipo de soporte|protocolo de bajas|escala(r|le)?\b|deriva(r)?\b)/i;
const SOLO_NEGATIVO = /^\s*(no|nunca|evita|jam[áa]s)\b/i;

export function usableSteps(steps: readonly string[] | undefined | null): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.filter(s => {
    const t = (s ?? '').trim();
    if (!t) return false;
    if (SOLO_NEGATIVO.test(t)) return false;
    if (DELEGA.test(t)) return false;
    return true;
  });
}

/**
 * Mínimo para que una lista de pasos sea un PROTOCOLO y no un apunte suelto.
 *
 * Con uno solo no alcanza, y no es teórico: la alerta escalada real de la base
 * tenía tres pasos y el filtro dejaba uno, "mantén un tono cercano y natural
 * durante la sesión". Eso es una actitud, no algo que el profesor pueda hacer, y
 * abrir el pop-up con esa única línea es casi tan inútil como abrirlo vacío.
 */
const MIN_STEPS = 2;

/**
 * ¿La acción repite lo que ya dice el contexto? Entonces no es una instrucción,
 * es el diagnóstico otra vez, y bajo el título "En esta clase:" se lee fatal.
 *
 * Caso real: la alerta escalada tenía action "El alumno ha mencionado que se
 * plantea dejar las clases" y contexto "El alumno ha mencionado que se plantea
 * dejar las clases y ha cancelado sesiones recientes". El pop-up abría el
 * protocolo repitiendo el problema en vez de decir qué hacer.
 */
const plano = (s: string) => (s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export function actionRepeatsContext(action: string, context?: string | null): boolean {
  const a = plano(action);
  const c = plano(context ?? '');
  if (!a || !c) return false;
  return c.includes(a) || a.includes(c);
}

/**
 * La acción que merece enseñarse encima de los pasos: solo si el profesor puede
 * hacer algo con ella y no está repitiendo el contexto.
 */
export function usableAction(action: string, context?: string | null): string {
  const a = (action ?? '').trim();
  if (!a) return '';
  if (usableSteps([a]).length === 0) return '';
  if (actionRepeatsContext(a, context)) return '';
  return a;
}

/**
 * El protocolo DEFINITIVO de una alerta: los pasos de la IA si son suficientes,
 * y si no el de respaldo. Fuente única del pop-up, la campanita, el email y la
 * ficha, para que los cuatro le digan al profesor exactamente lo mismo.
 */
export function protocolFor(
  steps: readonly string[] | undefined | null, risk: RiskSignal,
): { steps: string[]; isFallback: boolean } {
  const propios = usableSteps(steps);
  return propios.length >= MIN_STEPS
    ? { steps: propios, isFallback: false }
    : { steps: fallbackSteps(risk), isFallback: true };
}

/**
 * La única advertencia que se le da al profesor de un caso escalado, y va como
 * guardarraíl al lado del protocolo, no en lugar de él. Decirle "soporte se
 * encarga" lo dejaba sin nada que hacer durante una hora de clase.
 */
export const ESCALATED_GUARDRAIL =
  'Este alumno ya dijo que se plantea dejarlo, así que no le vendas la academia ni le pidas que se quede: '
  + 'eso lo empuja para el otro lado. Tu objetivo en esta clase es que se vaya a gusto.';

/** Máximo de pasos del protocolo. Más de cuatro deja de ser accionable. */
const MAX_STEPS = 4;

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Valida y limpia lo que devuelve la IA. Devuelve null si no hay una acción
 * utilizable: sin acción no hay sugerencia que mostrar.
 *
 * La limpieza de guiones ya la aplica askClaudeJson sobre toda la respuesta;
 * se repite aquí porque en el flujo "el profesor revisa el informe antes de
 * guardar" la sugerencia vuelve desde el cliente y podría llegar sin limpiar.
 */
export function normalizeSuggestion(raw: unknown): InterventionSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = isNonEmpty(r.action) ? cleanAiText(r.action.trim()) : '';
  if (!action) return null;

  const escalate = r.escalateToSupport === true;
  const channel = CHANNELS.includes(r.channel as InterventionChannel)
    ? (r.channel as InterventionChannel)
    : (escalate ? 'escalar_soporte' : 'en_clase');

  return {
    action,
    steps: normalizeSteps(r.steps),
    reconnectHook: isNonEmpty(r.reconnectHook) ? cleanAiText(r.reconnectHook.trim()) : '',
    escalateToSupport: escalate,
    channel,
  };
}

/**
 * Pasos del protocolo, limpios y acotados. Tolera que no vengan (las
 * intervenciones anteriores al campo `steps`) y que la IA se pase de la cuenta.
 */
function normalizeSteps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isNonEmpty)
    .map(s => cleanAiText(s.trim()))
    .filter(s => s.length > 0)
    .slice(0, MAX_STEPS);
}

/** Igual que normalizeSuggestion pero para la evaluación de la clase siguiente. */
export function normalizeCheck(raw: unknown): InterventionCheck | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.signsOfIntervention !== 'boolean') return null;
  return {
    signsOfIntervention: r.signsOfIntervention,
    evidence: isNonEmpty(r.evidence) ? cleanAiText(r.evidence.trim()) : '',
    stillOpenReason: isNonEmpty(r.stillOpenReason) ? cleanAiText(r.stillOpenReason.trim()) : '',
    cause: isRiskCause(r.cause) ? r.cause : null,
    // Ante la duda, la confianza más baja: una auditoría incierta NO cuenta.
    confidence: CONFIDENCES.includes(r.confidence as InterventionConfidence)
      ? (r.confidence as InterventionConfidence)
      : 'baja',
  };
}

/** Lee la columna jsonb (puede llegar como objeto o como string). */
export function asIntervention(v: unknown): ActiveIntervention | null {
  if (!v) return null;
  if (typeof v === 'string') {
    try { return asIntervention(JSON.parse(v)); } catch { return null; }
  }
  const base = normalizeSuggestion(v);
  if (!base) return null;
  const r = v as Record<string, unknown>;
  const risk = r.risk === 'rojo' ? 'rojo' : 'amarillo';
  return {
    ...base,
    risk,
    contextSummary: isNonEmpty(r.contextSummary) ? cleanAiText(r.contextSummary.trim()) : '',
    cause: isRiskCause(r.cause) ? r.cause : null,
    stillOpenReason: isNonEmpty(r.stillOpenReason) ? cleanAiText(r.stillOpenReason.trim()) : '',
    refreshedAt: typeof r.refreshedAt === 'string' ? r.refreshedAt : null,
    classAnalysisId: typeof r.classAnalysisId === 'string' ? r.classAnalysisId : null,
    classNumber: typeof r.classNumber === 'number' ? r.classNumber : null,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : undefined,
    shownAt: typeof r.shownAt === 'string' ? r.shownAt : null,
  };
}

/**
 * El motivo VIGENTE de una alerta: el actualizado si la alerta sobrevivió a
 * alguna clase posterior, y si no el de la clase que la abrió. FUENTE ÚNICA para
 * que el pop-up, la ficha y el panel del admin no puedan decir cosas distintas
 * sobre la misma alerta.
 */
export function currentReason(i: ActiveIntervention | null | undefined): string {
  if (!i) return '';
  return (i.stillOpenReason ?? '').trim() || (i.contextSummary ?? '').trim();
}

// ── El aviso que ve el profesor al entrar a clase ────────────────────────────

/**
 * Qué enseñarle al profesor al pulsar "Ingresar a clase". FUENTE ÚNICA: la usa
 * el pop-up y también decide si la clase siguiente se audita contra pasos
 * concretos, para que no puedan discrepar.
 *
 *   'protocolo' → hay intervención abierta: pasos numerados (o la acción suelta
 *                 si es una alerta anterior a los pasos). Se audita después.
 *   'generico'  → el alumno está en amarillo o rojo pero nadie ha generado un
 *                 protocolo. Se avisa, pero NO se audita: no hay pasos que
 *                 cumplir y no puede contar como alerta no atendida.
 *   null        → no hay nada que mostrar; el profesor entra directo.
 */
export interface RiskBriefing {
  kind: 'protocolo' | 'generico';
  studentName: string;
  risk: RiskSignal;
  /**
   * Pasos accionables. NUNCA viene vacío: si la alerta no trae un protocolo
   * utilizable se rellena con el de respaldo (ver fallbackSteps). El pop-up no
   * puede abrirse diciéndole al profesor que no haga nada.
   */
  steps: string[];
  /** true si los pasos son los de respaldo y no los que generó la IA. */
  usingFallbackSteps: boolean;
  /** Texto de la acción, para las alertas viejas sin pasos y para el genérico. */
  body: string;
  /**
   * Qué pasó en la clase anterior, en una o dos frases. Es lo primero que lee el
   * profesor: sin contexto, una lista de pasos es una orden sin motivo, y la
   * intervención se ejecuta peor. Vacío en el aviso genérico y en las alertas
   * anteriores a este campo.
   */
  previousContext: string;
  /** Causa del riesgo, para que el profesor sepa contra qué está actuando. */
  cause: RiskCause | null;
  /** Si la alerta viene de clases anteriores: por qué sigue abierta hoy. */
  stillOpenReason: string;
  reconnectHook: string;
  escalateToSupport: boolean;
  /** Ficha sobre la que escribir `intervention_shown_at`. */
  profileId: string | null;
  /** true si la clase siguiente puede auditarse contra este protocolo. */
  auditable: boolean;
}

export function buildRiskBriefing(args: {
  studentName: string;
  risk?: RiskSignal | null;
  intervention?: ActiveIntervention | null;
  profileId?: string | null;
  /**
   * Motivo guardado en la ficha (`student_profiles.risk_explanation`). Es el
   * respaldo de contexto para las alertas anteriores a `contextSummary` y para
   * el aviso genérico, que si no llegaría al profesor sin ningún porqué.
   */
  riskExplanation?: string | null;
}): RiskBriefing | null {
  const { studentName, intervention } = args;
  const profileId = args.profileId ?? null;
  const fallbackContext = (args.riskExplanation ?? '').trim();

  if (intervention) {
    // Pasos EJECUTABLES. Si la IA no dejó un protocolo utilizable (las alertas
    // anteriores al protocolo, o las que solo decían "no intentes retenerlo" y
    // "deja que soporte lo gestione"), entra el respaldo. El pop-up nunca puede
    // abrirse sin decirle al profesor qué hacer durante esa hora.
    const proto = protocolFor(intervention.steps, intervention.risk);
    const contextoAlerta = (intervention.contextSummary ?? '').trim() || fallbackContext;
    return {
      kind: 'protocolo',
      studentName,
      // La alerta manda sobre el color de la última clase: sigue abierta hasta
      // que alguien la cierre, aunque la última clase saliera verde.
      risk: intervention.risk,
      steps: proto.steps,
      usingFallbackSteps: proto.isFallback,
      // La acción solo se enseña si dice algo que el profesor pueda hacer y no
      // repite el contexto. Un "escala el caso a soporte", o el diagnóstico otra
      // vez, como cabecera del protocolo es no decirle nada.
      body: usableAction(intervention.action, contextoAlerta),
      // El contexto de la alerta y, si no lo tiene (alertas viejas), el motivo
      // que quedó en la ficha.
      previousContext: contextoAlerta,
      cause: intervention.cause ?? null,
      stillOpenReason: (intervention.stillOpenReason ?? '').trim(),
      reconnectHook: intervention.reconnectHook,
      escalateToSupport: intervention.escalateToSupport,
      profileId,
      auditable: true,
    };
  }

  if (args.risk === 'amarillo' || args.risk === 'rojo') {
    return {
      kind: 'generico',
      studentName,
      risk: args.risk,
      // Antes esto era un párrafo de buenas intenciones ("presta especial
      // atención a cómo se siente"). Ahora son pasos, porque un aviso que no se
      // puede ejecutar no cambia nada de lo que pasa en la clase.
      steps: fallbackSteps(args.risk),
      usingFallbackSteps: true,
      body: GENERIC_RISK_BRIEFING,
      previousContext: fallbackContext,
      cause: null,
      stillOpenReason: '',
      reconnectHook: '',
      escalateToSupport: false,
      profileId,
      auditable: false,
    };
  }

  return null;
}

/**
 * ¿Esta auditoría cuenta como "alerta no atendida"?
 *
 * Solo si la IA NO vio señales Y está razonablemente segura. Con confianza baja
 * el registro se guarda igual (el admin lo ve) pero no suma al contador: detectar
 * una intervención sutil leyendo un transcript es impreciso por naturaleza.
 */
export function countsAsUnattended(check: InterventionCheck): boolean {
  return !check.signsOfIntervention && check.confidence !== 'baja';
}

/**
 * Copy de la notificación al profesor (campanita y pestaña de avisos). El email
 * dice lo mismo con el maquetado de DRC: el profesor no debería leer dos
 * versiones distintas.
 *
 * La lista "qué evitar" NO va en el cuerpo: se pinta plegada en la interfaz
 * (ver el aviso de tipo 'risk_alert' en /teacher y la ficha del alumno).
 */
export function interventionCopy(
  s: InterventionSuggestion, studentName: string, context?: string,
  risk: RiskSignal = 'amarillo',
): { title: string; body: string } {
  // Los PASOS son el cuerpo del aviso, numerados, y con respaldo si la IA no dejó
  // ninguno utilizable. Antes esto mandaba `action` en una línea, que en los
  // casos escalados era "escala el caso a soporte": el profesor recibía un aviso
  // cuyo contenido era que no hiciera nada.
  const lista = protocolFor(s.steps, risk).steps;
  const pasos = `En esta clase:\n${lista.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
  const contexto = (context ?? '').trim() ? `En la última clase: ${context!.trim()}` : '';
  const accion = usableAction(s.action, context);

  return {
    title: s.escalateToSupport
      ? `Atención en la próxima clase — ${studentName}`
      : `Seguimiento recomendado — ${studentName}`,
    body: [
      contexto,
      accion,
      pasos,
      // Guardarraíl, no sustituto: el profesor sabe qué NO forzar, pero entra a
      // la clase con un protocolo que ejecutar.
      s.escalateToSupport ? ESCALATED_GUARDRAIL : '',
      s.reconnectHook,
      NATURAL_REMINDER,
    ].filter(Boolean).join('\n\n'),
  };
}
