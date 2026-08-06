// Lectura y acciones del panel de admin sobre la auditoría de intervenciones.
//
// Solo lo que el navegador necesita: las escrituras del análisis (abrir alerta,
// registrar auditoría, avisar) viven en lib/interventionStore.ts, que es de
// servidor. Acá el admin únicamente CONSULTA y CIERRA a mano.

import { supabase } from '@/lib/supabase';
import { asIntervention, buildRiskBriefing, type InterventionAuditRow, type RiskBriefing } from '@/lib/interventions';
import type { RiskSignal } from '@/lib/aiTypes';

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

// ── Aviso al entrar a clase (pop-up de "Ingresar a clase") ───────────────────

/** Briefings por nombre de alumno normalizado. */
export type RiskBriefingIndex = Map<string, RiskBriefing>;

const nkName = (s: string) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Lectura LIGERA para el panel de clases del profesor: solo las cinco columnas
 * que necesita el pop-up, nunca el bundle de la ficha (que arrastra todos los
 * class_analyses con su transcript entero).
 *
 * El filtro por nombre se hace AQUÍ y normalizado, no en la consulta: la ficha y
 * la assignment del mismo alumno no siempre escriben el nombre igual ("FACU
 * TEST" contra "Facu Test" existe hoy en la base), y un `.in()` exacto le
 * habría escondido el protocolo al profesor sin que nadie se enterara. Son unas
 * decenas de filas de cinco columnas: filtrar en memoria no cuesta nada.
 */
export async function fetchRiskBriefings(studentNames: string[]): Promise<RiskBriefingIndex> {
  const index: RiskBriefingIndex = new Map();
  const quiero = new Set(studentNames.map(nkName).filter(Boolean));
  if (quiero.size === 0) return index;

  // `risk_explanation` viaja también: es el contexto de respaldo del pop-up para
  // las alertas anteriores a `contextSummary` y para el aviso genérico, que sin
  // él llegaría al profesor sin ningún porqué. Sigue siendo una lectura ligera.
  const { data, error } = await supabase
    .from('student_profiles')
    .select('id, student_name, risk_signal, risk_explanation, active_intervention, intervention_shown_at');

  if (error) {
    // Sin las columnas de intervenciones el panel funciona igual: simplemente no
    // sale el aviso. Nunca debe impedir que el profesor entre a clase.
    if (isMissingTable(error)) console.warn('[interventionsClient] Faltan columnas de intervenciones. Corré supabase-interventions.sql.');
    else console.error('[interventionsClient] Error al leer los avisos de riesgo:', error);
    return index;
  }

  for (const row of (data ?? []) as unknown as Array<{
    id: string; student_name: string; risk_signal: string | null; risk_explanation: string | null;
    active_intervention: unknown; intervention_shown_at: string | null;
  }>) {
    if (!quiero.has(nkName(row.student_name))) continue;
    const briefing = buildRiskBriefing({
      studentName:  row.student_name,
      risk:         (row.risk_signal ?? null) as RiskSignal | null,
      intervention: asIntervention(row.active_intervention),
      profileId:    row.id,
      riskExplanation: row.risk_explanation,
    });
    if (!briefing) continue;
    // Varias fichas del mismo alumno: se queda la que tenga protocolo.
    const previo = index.get(nkName(row.student_name));
    if (previo && previo.kind === 'protocolo') continue;
    index.set(nkName(row.student_name), briefing);
  }
  return index;
}

/** Busca el aviso de un alumno en el índice (tolerante al formato del nombre). */
export function briefingFor(index: RiskBriefingIndex, studentName: string): RiskBriefing | null {
  return index.get(nkName(studentName)) ?? null;
}

/**
 * Deja constancia de que al profesor se le enseñó el protocolo antes de entrar.
 * Es lo que hace justa la auditoría de la clase siguiente: se juzga contra algo
 * que consta que vio, y con la marca de cuándo lo vio.
 *
 * Best-effort a propósito: si falla, el profesor entra igual a su clase.
 */
export async function markInterventionShown(profileId: string): Promise<string | null> {
  const shownAt = new Date().toISOString();
  const { error } = await supabase
    .from('student_profiles')
    .update({ intervention_shown_at: shownAt })
    .eq('id', profileId);

  if (error) {
    console.error('[interventionsClient] No se pudo registrar que se mostró el protocolo:', error);
    return null;
  }
  return shownAt;
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

/** Lo que había en la ficha antes de cerrar la alerta, para poder deshacer. */
export interface InterventionSnapshot {
  activeIntervention: unknown;
  activeInterventionAt: string | null;
  unattendedAlerts: number;
}

/**
 * Lee el estado ANTES de cerrar. Se llama justo antes de markInterventionAttended
 * porque ese update es destructivo (pone active_intervention a null) y sin la
 * foto previa el "Deshacer" no tendría qué restaurar.
 *
 * Devuelve null si la ficha no se puede leer: quien llama debe cerrar igual, pero
 * sabiendo que esa fila no se podrá revertir.
 */
export async function readInterventionSnapshot(profileId: string): Promise<InterventionSnapshot | null> {
  const { data, error } = await supabase
    .from('student_profiles')
    .select('active_intervention, active_intervention_at, unattended_alerts')
    .eq('id', profileId)
    .maybeSingle();

  if (error || !data) {
    if (error && !isMissingTable(error)) {
      console.error('[interventionsClient] No se pudo leer la ficha antes de cerrar:', error);
    }
    return null;
  }
  const row = data as unknown as {
    active_intervention: unknown; active_intervention_at: string | null; unattended_alerts: number | null;
  };
  return {
    activeIntervention:   row.active_intervention ?? null,
    activeInterventionAt: row.active_intervention_at ?? null,
    unattendedAlerts:     Number(row.unattended_alerts ?? 0) || 0,
  };
}

/** "Deshacer": devuelve la ficha al estado que tenía antes de cerrar la alerta. */
export async function restoreIntervention(profileId: string, snap: InterventionSnapshot): Promise<void> {
  const { error } = await supabase.from('student_profiles').update({
    active_intervention:    snap.activeIntervention ?? null,
    active_intervention_at: snap.activeInterventionAt,
    unattended_alerts:      snap.unattendedAlerts,
    updated_at:             new Date().toISOString(),
  }).eq('id', profileId);
  if (error) throw new Error(`No se pudo deshacer: ${error.message}`);
}
