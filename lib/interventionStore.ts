// Persistencia de las intervenciones y de su auditoría. SOLO SERVIDOR.
//
// Separado de lib/interventions.ts (que es puro y lo importa también el cliente)
// y de lib/transcriptStore.ts (que se ocupa de class_analyses) para que quede
// claro qué toca la ficha del alumno y qué toca la clase.
//
// TODO es best-effort: si las columnas todavía no están migradas
// (supabase-interventions.sql), se avisa por consola y el análisis de la clase
// sigue su curso. Una alerta de riesgo nunca debe romper el registro de la clase.

import { supabase } from '@/lib/supabase';
import {
  asIntervention, countsAsUnattended, interventionCopy,
  type ActiveIntervention, type InterventionCheck, type InterventionSuggestion,
} from '@/lib/interventions';
import type { RiskSignal } from '@/lib/aiTypes';

const isMissingCol = (e: { code?: string } | null | undefined): boolean =>
  e?.code === 'PGRST204' || e?.code === '42703';

const MIGRATION_HINT = 'Corré supabase-interventions.sql.';

function warnMissing(label: string): void {
  console.warn(`[interventionStore] ${label}: faltan columnas de intervenciones. ${MIGRATION_HINT}`);
}

// ── Contexto: la alerta que el alumno ya traía abierta ───────────────────────

export interface InterventionContext {
  profileId: string | null;
  /** Intervención abierta ANTERIOR a esta clase (null si no hay o es de esta misma clase). */
  active: ActiveIntervention | null;
  unattended: number;
}

const EMPTY_CONTEXT: InterventionContext = { profileId: null, active: null, unattended: 0 };

/**
 * Lee la intervención abierta del alumno antes de analizar la clase nueva.
 *
 * `currentAnalysisId` evita auditar una clase contra su propia alerta: al
 * reintentar el análisis de una clase que YA generó la alerta, esa alerta no
 * cuenta como "de la clase anterior".
 */
export async function loadInterventionContext(args: {
  profileId?: string | null;
  studentId?: string | null;
  studentName: string;
  currentAnalysisId?: string | null;
}): Promise<InterventionContext> {
  const COLS = 'id, active_intervention, active_intervention_at, unattended_alerts';

  const read = async (cols: string) => {
    if (args.profileId) {
      return supabase.from('student_profiles').select(cols).eq('id', args.profileId).maybeSingle();
    }
    if (args.studentId) {
      const res = await supabase.from('student_profiles').select(cols)
        .eq('student_id', args.studentId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (res.data || res.error) return res;
    }
    return supabase.from('student_profiles').select(cols)
      .ilike('student_name', args.studentName.trim())
      .order('updated_at', { ascending: false }).limit(1).maybeSingle();
  };

  let res = await read(COLS);
  if (res.error && isMissingCol(res.error)) {
    warnMissing('loadInterventionContext');
    res = await read('id');
  }
  if (res.error) {
    console.error('[interventionStore] No se pudo leer la ficha:', res.error);
    return EMPTY_CONTEXT;
  }

  const row = (res.data ?? null) as Record<string, unknown> | null;
  if (!row) return EMPTY_CONTEXT;

  const active = asIntervention(row.active_intervention);
  const sameClass = !!(active?.classAnalysisId && active.classAnalysisId === args.currentAnalysisId);

  return {
    profileId:  String(row.id),
    active:     sameClass ? null : active,
    unattended: Number(row.unattended_alerts ?? 0) || 0,
  };
}

// ── Escrituras sobre la ficha ────────────────────────────────────────────────

async function updateProfile(label: string, profileId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('student_profiles').update(patch).eq('id', profileId);
  if (!error) return;
  if (isMissingCol(error)) warnMissing(label);
  else console.error(`[interventionStore] ${label} falló:`, error);
}

/** Abre (o reemplaza) la alerta pendiente de atender del alumno. */
export async function saveActiveIntervention(args: {
  profileId: string;
  suggestion: InterventionSuggestion;
  risk: RiskSignal;
  analysisId?: string | null;
  classNumber?: number | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const active: ActiveIntervention = {
    ...args.suggestion,
    risk:            args.risk,
    classAnalysisId: args.analysisId ?? null,
    classNumber:     args.classNumber ?? null,
    createdAt:       now,
  };
  await updateProfile('saveActiveIntervention', args.profileId, {
    active_intervention:    active,
    active_intervention_at: now,
    updated_at:             now,
  });
}

/** Cierra la alerta: el profesor intervino (o el admin lo confirmó a mano). */
export async function clearActiveIntervention(profileId: string, resetCounter = false): Promise<void> {
  await updateProfile('clearActiveIntervention', profileId, {
    active_intervention:    null,
    active_intervention_at: null,
    updated_at:             new Date().toISOString(),
    ...(resetCounter ? { unattended_alerts: 0 } : {}),
  });
}

// ── Auditoría (Bloque 2) ─────────────────────────────────────────────────────

export interface AuditOutcome {
  /** La auditoría contó como "no atendida" (sin señales y con confianza alta/media). */
  counted: boolean;
  /** Auditorías consecutivas sin señales de intervención, incluida ésta. */
  consecutive: number;
}

/**
 * Registra la evaluación de la clase siguiente y actualiza el estado de la
 * alerta. NO crea scoring_events ni notifica al profesor: esto es una señal
 * para el admin, que es quien decide.
 */
export async function recordInterventionAudit(args: {
  profileId: string | null;
  studentId?: string | null;
  studentName: string;
  teacherId?: string | null;
  teacherName?: string | null;
  previous: ActiveIntervention;
  check: InterventionCheck;
  analysisId: string;
  unattendedBefore: number;
}): Promise<AuditOutcome> {
  const counted = countsAsUnattended(args.check);

  // "Reintentar análisis" sobre una clase ya auditada: no se audita dos veces
  // (si no, el contador de alertas sin atender subiría solo por reintentar).
  const { data: yaAuditada } = await supabase.from('intervention_audits')
    .select('id').eq('class_analysis_id', args.analysisId).limit(1).maybeSingle();
  if (yaAuditada) {
    console.log(`[interventionStore] La clase ${args.analysisId} ya tenía auditoría: no se repite.`);
    return { counted: false, consecutive: 0 };
  }

  const { error } = await supabase.from('intervention_audits').insert({
    id:                     `iaud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    student_id:             args.studentId ?? null,
    student_name:           args.studentName,
    teacher_id:             args.teacherId ?? null,
    teacher_name:           args.teacherName ?? null,
    alert_signal:           args.previous.risk,
    intervention_suggested: args.previous,
    signs_of_intervention:  args.check.signsOfIntervention,
    evidence:               args.check.evidence,
    confidence:             args.check.confidence,
    class_analysis_id:      args.analysisId,
    created_at:             new Date().toISOString(),
  });
  if (error) {
    if (isMissingCol(error) || error.code === '42P01') warnMissing('recordInterventionAudit');
    else console.error('[interventionStore] No se pudo guardar la auditoría:', error);
  }

  if (args.profileId) {
    if (args.check.signsOfIntervention) {
      // Hubo señales: la alerta se cierra. Si la clase nueva vuelve a salir en
      // amarillo/rojo, se abrirá una intervención nueva justo después.
      await clearActiveIntervention(args.profileId);
    } else if (counted) {
      // Sin señales y con confianza suficiente: la alerta sigue abierta y el
      // contador sube. Es un dato para el admin, no una penalización.
      await updateProfile('unattended_alerts', args.profileId, {
        unattended_alerts: args.unattendedBefore + 1,
        updated_at:        new Date().toISOString(),
      });
    }
    // confidence 'baja' → se registra el audit pero no se toca nada más.
  }

  return { counted, consecutive: counted ? await consecutiveUnattended(args.studentId, args.studentName) : 0 };
}

/** Cuántas auditorías consecutivas (de la más reciente hacia atrás) no contaron señales. */
async function consecutiveUnattended(studentId: string | null | undefined, studentName: string): Promise<number> {
  const q = supabase.from('intervention_audits')
    .select('signs_of_intervention, confidence')
    .order('created_at', { ascending: false })
    .limit(10);
  const { data, error } = studentId
    ? await q.eq('student_id', studentId)
    : await q.ilike('student_name', studentName.trim());

  if (error || !data) return 1;

  let n = 0;
  for (const row of data as Array<{ signs_of_intervention: boolean | null; confidence: string | null }>) {
    const cuenta = row.signs_of_intervention === false && row.confidence !== 'baja';
    if (!cuenta) break;
    n++;
  }
  return Math.max(1, n);
}

// ── Notificaciones ───────────────────────────────────────────────────────────

async function insertNotification(notif: {
  prefix: string; targetUser?: string | null; targetRole?: string | null;
  title: string; body: string; type: string; createdBy: string;
}): Promise<void> {
  const { error } = await supabase.from('notifications').insert({
    id:          `notif_${notif.prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    target_user: notif.targetUser ?? null,
    target_role: notif.targetRole ?? null,
    title:       notif.title,
    body:        notif.body,
    type:        notif.type,
    read_by:     [],
    created_at:  new Date().toISOString(),
    created_by:  notif.createdBy,
  });
  if (error) console.error('[interventionStore] No se pudo crear la notificación:', error);
}

/** Campanita del PROFESOR: la sugerencia de intervención de su alumno. */
export async function notifyTeacherIntervention(args: {
  teacherId: string;
  studentName: string;
  suggestion: InterventionSuggestion;
}): Promise<void> {
  const { title, body } = interventionCopy(args.suggestion, args.studentName);
  await insertNotification({
    prefix: 'interv', targetUser: args.teacherId,
    title, body, type: 'risk_alert', createdBy: 'ia',
  });
}

/**
 * Aviso al ADMIN por alertas que parecen no atendidas. Nunca va al profesor y
 * nunca genera scoring: el texto insiste en que la decisión es humana.
 */
export async function notifyAdminUnattended(args: {
  studentName: string;
  teacherName?: string | null;
  classes: number;
}): Promise<void> {
  const teacher = args.teacherName?.trim() || 'sin asignar';
  await insertNotification({
    prefix: 'iaud', targetRole: 'admin',
    title: `Posible alerta de riesgo no atendida — ${args.studentName}`,
    body:
      `El alumno ${args.studentName} (profesor ${teacher}) ha tenido ${args.classes} clases con alerta de riesgo activa ` +
      'sin señales claras de intervención. Revisa el detalle antes de tomar cualquier medida. ' +
      'Una intervención sutil puede no reflejarse en el transcript.',
    type: 'intervention_audit_admin', createdBy: 'ia',
  });
}

// ── Baja con alerta de riesgo previa ─────────────────────────────────────────

/**
 * Se llama JUSTO ANTES de borrar al alumno. Si tenía una alerta abierta o
 * alertas sin atender, deja el marcador en el historial y avisa al admin.
 *
 * No penaliza a nadie: sirve para distinguir una baja donde no se intervino de
 * una baja inevitable.
 */
export async function flagChurnWithOpenAlert(args: {
  studentId?: string | null;
  studentName: string;
  teacherName?: string | null;
}): Promise<{ flagged: boolean; unattended: number }> {
  const ctx = await loadInterventionContext({
    studentId: args.studentId, studentName: args.studentName,
  });
  if (!ctx.active && ctx.unattended === 0) return { flagged: false, unattended: 0 };

  // `students` se borra a continuación, pero el marcador se deja igual: si la
  // baja se cancela a medias, el dato queda donde lo espera el esquema. El dato
  // DURADERO va en student_dropouts, que lo escribe dbDeleteStudent al registrar
  // la baja (allí es donde se insertan esas filas).
  if (args.studentId) {
    const { error } = await supabase.from('students')
      .update({ churned_with_open_alert: true }).eq('id', args.studentId);
    if (error && isMissingCol(error)) warnMissing('flagChurnWithOpenAlert (students)');
    else if (error) console.error('[interventionStore] No se pudo marcar el alumno:', error);
  }

  const teacher = args.teacherName?.trim() || 'sin asignar';
  const pendientes = Math.max(ctx.unattended, ctx.active ? 1 : 0);
  await insertNotification({
    prefix: 'churnalert', targetRole: 'admin',
    title: `Baja con alerta de riesgo previa — ${args.studentName}`,
    body:
      `El alumno ${args.studentName} (profesor ${teacher}) se dio de baja. ` +
      `Tenía ${pendientes} alerta${pendientes === 1 ? '' : 's'} de riesgo con seguimiento pendiente. Ver historial.`,
    type: 'churn_open_alert', createdBy: 'sistema',
  });

  console.log(`[interventionStore] Baja de "${args.studentName}" con alerta de riesgo previa (${pendientes} pendiente/s).`);
  return { flagged: true, unattended: ctx.unattended };
}
