// Lectura y acciones del panel de admin sobre la auditoría de intervenciones.
//
// Solo lo que el navegador necesita: las escrituras del análisis (abrir alerta,
// registrar auditoría, avisar) viven en lib/interventionStore.ts, que es de
// servidor. Acá el admin únicamente CONSULTA y CIERRA a mano.

import { supabase } from '@/lib/supabase';
import type { InterventionAuditRow } from '@/lib/interventions';

const isMissingTable = (e: { code?: string } | null | undefined): boolean =>
  e?.code === '42P01' || e?.code === 'PGRST205' || e?.code === '42703' || e?.code === 'PGRST204';

export interface AuditsResult {
  rows: InterventionAuditRow[];
  /** true si todavía no se corrió supabase-interventions.sql. */
  missingTable: boolean;
}

/** Historial de auditorías, más recientes primero. */
export async function fetchInterventionAudits(limit = 300): Promise<AuditsResult> {
  const { data, error } = await supabase
    .from('intervention_audits')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingTable(error)) {
      console.warn('[interventionsClient] Falta la tabla intervention_audits. Corré supabase-interventions.sql.');
      return { rows: [], missingTable: true };
    }
    console.error('[interventionsClient] Error al leer intervention_audits:', error);
    return { rows: [], missingTable: false };
  }
  return { rows: (data ?? []) as unknown as InterventionAuditRow[], missingTable: false };
}

export interface OpenAlertState {
  /** El alumno tenía una intervención abierta o alertas sin atender. */
  hasOpenAlert: boolean;
  unattended: number;
}

/**
 * ¿El alumno tiene una alerta de riesgo con seguimiento pendiente?
 *
 * Lo usa dbDeleteStudent para dejar el marcador en la fila de la baja (el
 * historial duradero: `students` se borra, `student_dropouts` no).
 */
export async function fetchOpenAlertState(args: {
  studentId?: string | null; studentName: string;
}): Promise<OpenAlertState> {
  const none: OpenAlertState = { hasOpenAlert: false, unattended: 0 };
  const cols = 'active_intervention, unattended_alerts';

  const q = supabase.from('student_profiles').select(cols)
    .order('updated_at', { ascending: false }).limit(1);
  const { data, error } = args.studentId
    ? await q.eq('student_id', args.studentId).maybeSingle()
    : await q.ilike('student_name', args.studentName.trim()).maybeSingle();

  if (error) {
    if (!isMissingTable(error)) console.error('[interventionsClient] Error al leer la ficha:', error);
    return none;
  }
  if (!data) return none;

  const row = data as unknown as { active_intervention: unknown; unattended_alerts: number | null };
  const unattended = Number(row.unattended_alerts ?? 0) || 0;
  return { hasOpenAlert: !!row.active_intervention || unattended > 0, unattended };
}

export interface ChurnedWithAlert {
  id: string;
  student_name: string;
  teacher_id: string | null;
  dropped_at: string | null;
  unattended_alerts: number | null;
}

/**
 * Bajas que se fueron con una alerta de riesgo pendiente. Es CONTEXTO para el
 * admin (distinguir una baja sin seguimiento de una inevitable), no una
 * penalización: nadie pierde puntos por aparecer aquí.
 */
export async function fetchChurnedWithOpenAlert(limit = 30): Promise<ChurnedWithAlert[]> {
  const { data, error } = await supabase
    .from('student_dropouts')
    .select('id, student_name, teacher_id, dropped_at, unattended_alerts')
    .eq('had_open_alert', true)
    .order('dropped_at', { ascending: false })
    .limit(limit);

  if (error) {
    if (!isMissingTable(error)) console.error('[interventionsClient] Error al leer las bajas:', error);
    return [];
  }
  return (data ?? []) as unknown as ChurnedWithAlert[];
}

/**
 * "Marcar como atendida": el admin sabe que el profesor sí intervino. Cierra la
 * alerta y pone el contador a cero. No toca el historial de auditorías: lo que
 * pasó queda registrado.
 */
export async function markInterventionAttended(profileId: string): Promise<void> {
  const { error } = await supabase.from('student_profiles').update({
    active_intervention:    null,
    active_intervention_at: null,
    unattended_alerts:      0,
    updated_at:             new Date().toISOString(),
  }).eq('id', profileId);
  if (error) throw new Error(`No se pudo cerrar la intervención: ${error.message}`);
}
