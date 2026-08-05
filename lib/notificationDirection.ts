// Clasificación de las filas de `notifications` desde la perspectiva del ADMIN:
// ¿esto lo mandó el sistema hacia afuera, o es un aviso dirigido al admin?
//
// El criterio es el destinatario, que ya está en la fila y es excluyente en los
// 23 puntos de inserción del proyecto:
//
//   · target_role = 'admin'   → RECIBIDA  (aparece en la campanita del admin)
//   · target_user = <profeId> → ENVIADA   (salió hacia un profesor concreto)
//   · target_role = 'teacher' → ENVIADA   (circular a todo el equipo)
//
// Ninguna fila lleva los dos campos a la vez, así que cada aviso cae en UNA sola
// categoría. No hace falta deducir nada del `type`: el tipo solo sirve para
// ponerle una etiqueta legible al ítem.
//
// OJO con el caso de la clase cancelada: el mismo hecho manda un email al ALUMNO
// y crea un aviso al admin, pero es UNA sola fila con target_role='admin', así
// que cuenta como recibida y no se duplica. `alsoEmailedToStudent` lo marca en la
// UI para que se vea que además salió un correo.

export type NotificationDirection = 'sent' | 'received';

export function notificationDirection(n: {
  targetRole?: string;
  targetUser?: string;
}): NotificationDirection {
  return n.targetRole === 'admin' ? 'received' : 'sent';
}

export interface NotificationTypeInfo {
  /** Etiqueta corta y legible del tipo de aviso. */
  label: string;
  /** Emoji del ítem en la lista. */
  icon: string;
  /**
   * true si además del aviso in-app sale un email por Resend. No todos los
   * avisos al profesor llevan correo, así que no se puede dar por hecho.
   */
  email?: boolean;
  /** Solo para recibidas: el hecho que lo originó también mandó email al alumno. */
  alsoEmailedToStudent?: boolean;
}

// ── ENVIADAS ─────────────────────────────────────────────────────────────────
const SENT_TYPES: Record<string, NotificationTypeInfo> = {
  circular:                           { label: 'Circular del equipo',            icon: '📢', email: true },
  new_assignment:                     { label: 'Nuevo alumno asignado',          icon: '📚', email: true },
  new_student:                        { label: 'Nuevo alumno asignado',          icon: '📚', email: true },
  form_completed:                     { label: 'Formulario completado',          icon: '📝', email: true },
  risk_alert:                         { label: 'Intervención recomendada',       icon: '🧭', email: true },
  presentation_email_reminder:        { label: 'Recordatorio presentación · 4h', icon: '📧', email: true },
  presentation_email_warning_teacher: { label: 'Aviso presentación · 12h',       icon: '⚠️', email: true },
  presentation_email_overdue_teacher: { label: 'Presentación fuera de plazo',    icon: '🔴', email: true },
  one_time_access:                    { label: 'Acceso activado',                icon: '📅' },
  student_removed:                    { label: 'Alumno eliminado',               icon: '❌' },
  student_transferred:                { label: 'Alumno transferido',             icon: 'ℹ️' },
  transcript_rejected:                { label: 'Transcripción rechazada',        icon: '🚫' },
  level_test_completed:               { label: 'Test de nivel completado',       icon: '📝' },
  churn_risk:                         { label: 'Riesgo de baja',                 icon: '📉' },
  clase15:                            { label: 'Cerca de la clase 15',           icon: '🎬' },
  bono6m:                             { label: 'Bono de 6 meses',                icon: '🎁' },
  subscription_cancelled:             { label: 'Suscripción cancelada',          icon: '❌' },
};

// ── RECIBIDAS ────────────────────────────────────────────────────────────────
const RECEIVED_TYPES: Record<string, NotificationTypeInfo> = {
  churn_risk:                  { label: 'Riesgo de baja',                icon: '📉' },
  ai_risk_red:                 { label: 'Riesgo alto',                   icon: '🔴' },
  ai_risk_yellow:              { label: 'Señal de atención',             icon: '⚠️' },
  intervention_audit_admin:    { label: 'Alerta no atendida',            icon: '🔎' },
  churn_open_alert:            { label: 'Baja con alerta previa',        icon: '🔎' },
  transcript_blocked:          { label: 'Transcripción bloqueada',       icon: '🚫' },
  transcript_review:           { label: 'Transcripción a revisar',       icon: '⚠️' },
  clase_cancelada_incidencia:  { label: 'Clase cancelada · incidencia',  icon: '🔴', alsoEmailedToStudent: true },
  clase_cancelada_preaviso:    { label: 'Clase cancelada · con preaviso', icon: '📆', alsoEmailedToStudent: true },
  limite_faltas_admin:         { label: 'Límite de faltas',              icon: '🚫' },
  faltas_con_aviso_alerta:     { label: 'Faltas con aviso acumuladas',   icon: '📋' },
  presentation_email_warning:  { label: 'Presentación en riesgo · 12h',  icon: '⚠️', email: true },
  presentation_email_overdue:  { label: 'Presentación fuera de plazo',   icon: '🔴', email: true },
};

const FALLBACK: NotificationTypeInfo = { label: 'Aviso', icon: '📢' };

/** Info de presentación del tipo, resuelta según la dirección (hay tipos que
 *  existen en ambos lados con matices distintos, como `churn_risk`). */
export function notificationTypeInfo(
  type: string,
  direction: NotificationDirection,
): NotificationTypeInfo {
  const table = direction === 'received' ? RECEIVED_TYPES : SENT_TYPES;
  return table[type] ?? FALLBACK;
}
