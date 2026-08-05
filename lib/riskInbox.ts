// Derivación de la bandeja de riesgo (pestaña "IA y Riesgo" del admin).
//
// Todo lo que se puede calcular sin React vive acá: filtrado, orden, agrupado,
// truncado, asistencia e historial. El componente solo pinta.
//
// De dónde sale cada dato (importa, porque el diseño pide campos que la base no
// tiene y aquí se ve exactamente qué es real):
//
//   · severidad            → student_profiles.risk_signal / class_analyses.risk_signal
//   · evidencia            → risk_explanation (LITERAL, nunca se reescribe)
//   · alertas_sin_atender  → student_profiles.unattended_alerts
//   · estado_intervencion  → student_profiles.active_intervention
//   · confianza            → intervention_audits.confidence de la ÚLTIMA auditoría
//                            del alumno. No hay confianza por alerta: los alumnos
//                            sin auditoría no tienen ninguna, y se muestra "—".
//   · historial            → se compone de sus class_analyses + intervention_audits
//   · asistencia_30d       → class_records de los últimos 30 días

import type { RiskSignal } from '@/lib/aiTypes';
import type { ClassAnalysisRow } from '@/lib/aiTypes';
import type { InterventionAuditRow, ActiveIntervention } from '@/lib/interventions';
import type { ClassRecord } from '@/types';

// ── Severidad ────────────────────────────────────────────────────────────────
export type Severity = 'riesgo' | 'atencion' | 'buen';

export const SEV_OF: Record<RiskSignal, Severity> = {
  rojo: 'riesgo', amarillo: 'atencion', verde: 'buen',
};

export interface SevStyle {
  label: string; accent: string; bg: string; bd: string; fg: string; hint: string;
}

/** Paleta del handoff. Los tintes/bordes son propios de esta vista: los tokens
 *  globales (RISK_META) usan rgba sobre el verde/amarillo DRC y no dan el mismo
 *  contraste en filas de una línea sobre fondo blanco. */
export const SEV: Record<'riesgo' | 'atencion', SevStyle> = {
  riesgo: {
    label: 'Riesgo de baja', accent: '#cf3a30', bg: '#fdeeec', bd: '#f3cfca', fg: '#a52b23',
    hint: 'intervenir hoy',
  },
  atencion: {
    label: 'Atención', accent: '#e0a92b', bg: '#fdf5e4', bd: '#eddfb6', fg: '#8a5f0a',
    hint: 'vigilar esta semana',
  },
};

export const CONF_STYLE: Record<string, { fg: string; bg: string; bd: string }> = {
  alta:  { fg: '#136b34', bg: '#eaf5ee', bd: '#cfe8d8' },
  media: { fg: '#8a5f0a', bg: '#fdf5e4', bd: '#eddfb6' },
  baja:  { fg: '#6b7a70', bg: '#f2f4f1', bd: '#e2e5df' },
};

// ── Normalización ────────────────────────────────────────────────────────────
/** Sin tildes, sin mayúsculas: la búsqueda no debe distinguir "Sebastián" de
 *  "sebastian". Mismo criterio que el resto del proyecto. */
export const fold = (s: string): string =>
  (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

export const norm = (s: string) => (s ?? '').trim().toLowerCase();

/** Corta a `n` caracteres para la vista previa de una línea. El texto completo
 *  sigue intacto en el desplegable: acá solo se recorta lo que se PINTA. */
export function cut(text: string | null | undefined, n: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > n ? `${t.slice(0, n).trim()}…` : t;
}

// ── Fila de la bandeja ───────────────────────────────────────────────────────
export interface RiskRow {
  /** profileId, o `analysis:<id>` si el alumno todavía no tiene ficha. */
  id: string;
  studentId: string | null;
  studentName: string;
  teacherId: string | null;
  teacherName: string;
  risk: RiskSignal;
  sev: Severity;
  /** Texto literal de la IA. Nunca se reescribe. */
  evidence: string;
  /** ISO de la última clase conocida. */
  date: string | null;
  classNumber: number | null;
  hasProfile: boolean;
  /** El riesgo sale de la última clase, no de la ficha. */
  riskFromClass: boolean;
  unattended: number;
  active: ActiveIntervention | null;
  confidence: string | null;
  audits: InterventionAuditRow[];
}

// ── Filtros ──────────────────────────────────────────────────────────────────
export interface Filters {
  q: string;
  prof: string;          // 'todos' | teacherId
  solo: boolean;         // solo filas con alertas sin atender
  sev: Severity | 'todas';
}

/** ¿Hay algún filtro que reduzca la lista? El agrupado cambia de comportamiento
 *  con esto (badges de recuento, texto auxiliar y enlace "Ver N más"). */
export function isFiltering(f: Filters): boolean {
  return f.q.trim() !== '' || f.prof !== 'todos' || f.solo;
}

/** Búsqueda + profesor + "solo sin atender". La severidad se aplica aparte
 *  porque las tarjetas-resumen necesitan los recuentos SIN ese filtro. */
export function matchesBase(r: RiskRow, f: Filters): boolean {
  const q = fold(f.q);
  if (q && !fold(`${r.studentName} ${r.teacherName}`).includes(q)) return false;
  if (f.prof !== 'todos' && r.teacherId !== f.prof) return false;
  if (f.solo && r.unattended === 0) return false;
  return true;
}

export function matchesSeverity(r: RiskRow, sev: Filters['sev']): boolean {
  return sev === 'todas' || r.sev === sev;
}

// ── Orden ────────────────────────────────────────────────────────────────────
export type SortKey = 'sev' | 'fecha' | 'alertas';

const SEV_ORDER: Record<Severity, number> = { riesgo: 0, atencion: 1, buen: 2 };

const ts = (iso: string | null): number => (iso ? new Date(iso).getTime() || 0 : 0);

/** Orden por defecto: severidad y, dentro de cada nivel, lo más reciente arriba.
 *  Los otros dos criterios desempatan igual, para que el orden sea estable. */
export function sortRows(rows: RiskRow[], sort: SortKey): RiskRow[] {
  const out = [...rows];
  out.sort((a, b) => {
    if (sort === 'alertas' && b.unattended !== a.unattended) return b.unattended - a.unattended;
    if (sort === 'fecha' && ts(b.date) !== ts(a.date)) return ts(b.date) - ts(a.date);
    if (sort === 'sev' && SEV_ORDER[a.sev] !== SEV_ORDER[b.sev]) return SEV_ORDER[a.sev] - SEV_ORDER[b.sev];
    return ts(b.date) - ts(a.date) || a.studentName.localeCompare(b.studentName, 'es');
  });
  return out;
}

// ── Asistencia de los últimos 30 días ────────────────────────────────────────
const DAY = 86_400_000;

/**
 * "N de M clases" en la ventana de 30 días, contando SOLO los registros de
 * class_records del alumno. M son todas las clases registradas (incluidas faltas
 * y cancelaciones) y N las que cuentan como dadas (normal/recuperación), que es
 * el mismo criterio que usa el conteo de progreso.
 *
 * Sin registros devuelve null: "0 de 0" leería como abandono cuando en realidad
 * es que ese alumno no registra clases por aquí.
 */
export function attendance30d(records: ClassRecord[], studentName: string, nowMs: number): string | null {
  const target = norm(studentName);
  const from = nowMs - 30 * DAY;
  let total = 0, given = 0;
  for (const r of records) {
    if (norm(r.studentName) !== target) continue;
    const t = r.classDate ? new Date(`${r.classDate}T00:00:00`).getTime() : 0;
    if (!t || t < from || t > nowMs) continue;
    total++;
    const ct = r.classType;
    if (ct == null || ct === 'normal' || ct === 'recuperacion') given++;
  }
  return total === 0 ? null : `${given} de ${total} clases`;
}

// ── Historial ────────────────────────────────────────────────────────────────
export interface HistoryEvent { at: string; text: string }

const shortDate = (iso: string): string => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
};

const RISK_EVENT: Record<string, string> = {
  rojo:     'Alerta roja generada por la IA',
  amarillo: 'Alerta amarilla generada por la IA',
  verde:    'Clase analizada sin señales de riesgo',
};

/**
 * Historial real del alumno: sus clases analizadas y sus auditorías, mezcladas y
 * ordenadas. Máximo `max` eventos. No se inventa nada: si no hay filas, la lista
 * viene vacía y el detalle no pinta la sección.
 */
export function buildHistory(
  analyses: ClassAnalysisRow[],
  audits: InterventionAuditRow[],
  max = 5,
): HistoryEvent[] {
  const out: HistoryEvent[] = [];

  for (const a of analyses) {
    const at = a.class_date ?? a.analyzed_at;
    if (!at) continue;
    out.push({ at, text: RISK_EVENT[a.risk_signal ?? 'verde'] ?? 'Clase analizada' });
  }

  for (const v of audits) {
    if (!v.created_at) continue;
    out.push({
      at: v.created_at,
      text: v.signs_of_intervention === true
        ? 'Auditoría: se vieron señales de intervención'
        : 'Auditoría: sin señales claras de intervención',
    });
  }

  out.sort((x, y) => ts(y.at) - ts(x.at));
  return out.slice(0, max).map(e => ({ at: e.at, text: `${shortDate(e.at)} · ${e.text}` }));
}

// ── Etiquetas ────────────────────────────────────────────────────────────────
export function unattendedLabel(n: number): string {
  if (n === 0) return 'Sin pendientes';
  return n === 1 ? '1 alerta sin atender' : `${n} alertas sin atender`;
}

export function formatRowDate(iso: string | null): string {
  if (!iso) return 'sin fecha';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return isNaN(d.getTime())
    ? 'sin fecha'
    : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "hace 12 min" / "hace 3 h" / "el 2 ago". Para el subtítulo de la sección. */
export function lastReadLabel(iso: string | null, nowMs: number): string {
  if (!iso) return 'sin lecturas todavía';
  const t = ts(iso);
  if (!t) return 'sin lecturas todavía';
  const min = Math.floor((nowMs - t) / 60_000);
  if (min < 1) return 'última lectura ahora mismo';
  if (min < 60) return `última lectura hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `última lectura hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'última lectura ayer';
  if (d < 7) return `última lectura hace ${d} días`;
  return `última lectura el ${shortDate(iso)}`;
}

// ── Exportación ──────────────────────────────────────────────────────────────
const csvCell = (v: string | number | null): string => {
  const s = String(v ?? '');
  // El separador es ';' (Excel en español) y las comillas se duplican. El texto
  // de la IA lleva saltos de línea: van entrecomillados, no se recortan.
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function rowsToCsv(rows: RiskRow[]): string {
  const head = ['Alumno', 'Profesor', 'Severidad', 'Fecha', 'Alertas sin atender', 'Confianza IA', 'Evidencia'];
  const body = rows.map(r => [
    r.studentName,
    r.teacherName,
    r.sev === 'riesgo' ? 'Riesgo de baja' : r.sev === 'atencion' ? 'Atención' : 'En buen camino',
    formatRowDate(r.date),
    r.unattended,
    r.confidence ?? '—',
    r.evidence,
  ].map(csvCell).join(';'));
  // BOM para que Excel abra los acentos bien.
  return `﻿${[head.join(';'), ...body].join('\r\n')}`;
}
