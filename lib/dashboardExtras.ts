// Lo poco del dashboard que NO está ya en memoria.
//
// El grueso de la pantalla sale del contexto `useTeachers`, que carga profesores,
// alumnos, asignaciones, clases, ingresos, análisis, tarifas y scoring al
// arrancar la app. Acá quedan solo cinco cosas que nadie más pide, y se traen de
// una vez en paralelo.
//
// EGRESS. Todas piden columnas explícitas y cortas. En particular NO se usa
// `fetchRiskProfiles` de lib/aiClient para el riesgo: esa trae `next_class_content`
// y `ai_ficha`, dos jsonb con la clase generada y la ficha entera de cada alumno.
// Sirve para el panel de riesgo, donde se abren; en una portada que se carga
// muchas veces al día serían megabytes por visita para pintar dos números.

import { supabase } from '@/lib/supabase';
import { dbCountPendingValidations, type PendingValidationSummary } from '@/lib/db';
import { dbCountPendingReviewRequests } from '@/lib/reviewRequests';
import { dbGetStudentDropouts, type StudentDropout } from '@/lib/studentPeriod';
import { fetchAiGenerations } from '@/lib/aiUsage';

/** Lo mínimo para contar el riesgo y listar los más urgentes. */
export interface RiskLite {
  student_name: string | null;
  teacher_id: string | null;
  risk_signal: string | null;
  risk_explanation: string | null;
  risk_updated_at: string | null;
  /** supabase-interventions.sql. Ausente si la migración no se corrió. */
  active_intervention_at?: string | null;
}

const RISK_COLS = 'student_name, teacher_id, risk_signal, risk_explanation, risk_updated_at';

/**
 * Señal de riesgo por alumno, sin una sola columna pesada.
 *
 * `active_intervention_at` va en un segundo intento porque llega con una
 * migración posterior: pedirla sin que exista tumbaría la consulta entera (42703)
 * y el bloque de riesgo se quedaría vacío en vez de perder un dato.
 */
export async function fetchRiskLite(): Promise<RiskLite[]> {
  const read = (cols: string) => supabase
    .from('student_profiles').select(cols)
    .not('risk_signal', 'is', null)
    .order('risk_updated_at', { ascending: false });

  let res = await read(`${RISK_COLS}, active_intervention_at`);
  if (res.error?.code === '42703' || res.error?.code === 'PGRST204') res = await read(RISK_COLS);
  if (res.error) {
    console.error('[dashboard] No se pudo leer el riesgo:', res.error.message);
    return [];
  }
  return (res.data ?? []) as unknown as RiskLite[];
}

/**
 * Análisis de IA que fallaron y nadie reintentó. Conteo puro, sin filas.
 * Si la columna no existe (migración sin correr) devuelve 0: no hay estado que
 * contar, no es un error.
 */
export async function countFailedAnalyses(): Promise<number> {
  const { count, error } = await supabase
    .from('class_analyses')
    .select('id', { count: 'exact', head: true })
    .eq('analysis_status', 'failed');
  if (error) {
    if (error.code !== '42703' && error.code !== 'PGRST204') {
      console.warn('[dashboard] No se pudieron contar los análisis fallidos:', error.message);
    }
    return 0;
  }
  return count ?? 0;
}

export interface DashboardExtras {
  risk: RiskLite[];
  dropouts: StudentDropout[];
  /** Profesores que han generado alguna clase con IA. */
  teacherIdsConIA: Set<string>;
  validaciones: PendingValidationSummary;
  solicitudesRevision: number;
  analisisFallidos: number;
}

const VACIO: DashboardExtras = {
  risk: [], dropouts: [], teacherIdsConIA: new Set(),
  validaciones: { total: 0, oldestDate: null, oldestDays: 0 },
  solicitudesRevision: 0, analisisFallidos: 0,
};

/**
 * Las cinco lecturas de una vez.
 *
 * `allSettled` y no `all`: si una falla —una migración sin correr, un timeout—
 * el resto de la pantalla se pinta igual. Un dashboard al que le falta un número
 * sigue sirviendo; uno en blanco, no.
 */
export async function loadDashboardExtras(): Promise<DashboardExtras> {
  const [risk, dropouts, ia, val, rev, fallidos] = await Promise.allSettled([
    fetchRiskLite(),
    dbGetStudentDropouts(),
    fetchAiGenerations(),
    dbCountPendingValidations(),
    dbCountPendingReviewRequests(),
    countFailedAnalyses(),
  ]);

  const ok = <T,>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === 'fulfilled' ? r.value : fallback;

  const generaciones = ok(ia, { rows: [], missingTable: true });
  const conIA = new Set<string>();
  for (const g of generaciones.rows) if (g.teacher_id) conIA.add(g.teacher_id);

  return {
    risk: ok(risk, VACIO.risk),
    dropouts: ok(dropouts, VACIO.dropouts),
    teacherIdsConIA: conIA,
    validaciones: ok(val, VACIO.validaciones),
    solicitudesRevision: ok(rev, 0),
    analisisFallidos: ok(fallidos, 0),
  };
}

// ── Agregados sobre lo anterior ──────────────────────────────────────────────

export const esRiesgoRojo = (r: RiskLite): boolean =>
  (r.risk_signal ?? '').trim().toLowerCase() === 'rojo';

export interface RiesgoResumen {
  rojo: number;
  verde: number;
  /** En rojo y sin ninguna intervención registrada después de la alerta. */
  sinAtender: number;
}

/**
 * El reparto del riesgo. Dos niveles y no tres: desde julio de 2026 la IA
 * clasifica en verde o rojo y el amarillo se quitó a propósito de todo el
 * sistema. Si alguna vez vuelve, vuelve acá.
 */
export function riesgoResumen(rows: readonly RiskLite[]): RiesgoResumen {
  let rojo = 0, verde = 0, sinAtender = 0;
  for (const r of rows) {
    if (esRiesgoRojo(r)) {
      rojo += 1;
      const atendida = r.active_intervention_at && r.risk_updated_at
        ? r.active_intervention_at >= r.risk_updated_at
        : false;
      if (!atendida) sinAtender += 1;
    } else if ((r.risk_signal ?? '').trim()) {
      verde += 1;
    }
  }
  return { rojo, verde, sinAtender };
}

/** Bajas registradas en un mes 'YYYY-MM'. */
export function bajasDelMes(dropouts: readonly StudentDropout[], mes: string): number {
  return dropouts.filter(d => (d.droppedAt ?? '').slice(0, 7) === mes).length;
}
