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
import type { RiskSignal } from '@/lib/aiTypes';

export type InterventionChannel = 'en_clase' | 'mensaje_previo' | 'escalar_soporte';
export type InterventionConfidence = 'alta' | 'media' | 'baja';

export interface InterventionSuggestion {
  /** Acción concreta y específica para el profesor (una sola). */
  action: string;
  /** Hito cercano (clase 15/30) como excusa natural para reconectar. Puede ir vacío. */
  reconnectHook: string;
  /** El alumno dijo explícitamente que quiere dejarlo: lo gestiona soporte, no el profesor. */
  escalateToSupport: boolean;
  channel: InterventionChannel;
}

/** La sugerencia abierta en la ficha del alumno, con el contexto de su clase. */
export interface ActiveIntervention extends InterventionSuggestion {
  risk: RiskSignal;
  /** Clase que originó la alerta. Evita auditar dos veces la misma clase (reintentos). */
  classAnalysisId?: string | null;
  classNumber?: number | null;
  createdAt?: string;
}

export interface InterventionCheck {
  signsOfIntervention: boolean;
  evidence: string;
  confidence: InterventionConfidence;
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
    reconnectHook: isNonEmpty(r.reconnectHook) ? cleanAiText(r.reconnectHook.trim()) : '',
    escalateToSupport: escalate,
    channel,
  };
}

/** Igual que normalizeSuggestion pero para la evaluación de la clase siguiente. */
export function normalizeCheck(raw: unknown): InterventionCheck | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.signsOfIntervention !== 'boolean') return null;
  return {
    signsOfIntervention: r.signsOfIntervention,
    evidence: isNonEmpty(r.evidence) ? cleanAiText(r.evidence.trim()) : '',
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
    classAnalysisId: typeof r.classAnalysisId === 'string' ? r.classAnalysisId : null,
    classNumber: typeof r.classNumber === 'number' ? r.classNumber : null,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : undefined,
  };
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
  s: InterventionSuggestion, studentName: string,
): { title: string; body: string } {
  if (s.escalateToSupport) {
    return {
      title: `Escalar a soporte — ${studentName}`,
      body: [
        s.action,
        s.reconnectHook,
        'Contacta al equipo de soporte para activar el protocolo de gestión de bajas. No intentes retener al alumno tú solo.',
        NATURAL_REMINDER,
      ].filter(Boolean).join('\n\n'),
    };
  }
  return {
    title: `Seguimiento recomendado — ${studentName}`,
    body: [s.action, s.reconnectHook, NATURAL_REMINDER].filter(Boolean).join('\n\n'),
  };
}
