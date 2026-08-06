'use client';

// Pestaña "IA y Riesgo" del panel de admin — bandeja de trabajo priorizada.
//
// Antes eran tres bloques apilados: 31 alertas como tarjetas grandes con el
// texto entero de la IA visible, una tabla de 34 auditorías con tres botones por
// fila, y dos tablas más abajo. Scroll infinito y las mismas acciones repetidas
// 34 veces. Ahora es UNA card con tres pestañas y filas de una línea; la
// evidencia y las acciones viven en el desplegable de cada fila.
//
// Qué se conserva de la versión anterior (no estaba en el rediseño, pero
// funcionaba y se perdería):
//   · "Todos los alumnos"        → modal desde "Ver listado completo".
//   · "Uso del módulo por profesor" → sección plegable bajo la card.
//   · "Bajas con alerta previa"  → al pie de la pestaña de verificación.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { fetchAllClassAnalyses, fetchRiskProfiles, type ClassAnalysisRow } from '@/lib/aiClient';
import { RISK_META, isRiskSignal, type RiskSignal, type StudentProfileRow } from '@/lib/aiTypes';
import { RiskBadge, DRC, formatDate } from '@/components/ai/FichaView';
import AiStudentPanel from '@/components/ai/AiStudentPanel';
import { Modal, ModalHeader } from '@/components/ai/modalUi';
import { ColaRow, VerifRow } from '@/components/ai/riskRows';
import { AuditHistory, IncidentModal, type InterventionTarget } from '@/components/admin/interventionModals';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import {
  fetchChurnedWithOpenAlert, fetchInterventionAudits, markInterventionAttended,
  readInterventionSnapshot, restoreIntervention,
  type ChurnedWithAlert, type InterventionSnapshot,
} from '@/lib/interventionsClient';
import { asIntervention, currentReason, type InterventionAuditRow } from '@/lib/interventions';
import {
  SEV, SEV_OF, attendance30d, buildHistory, isFiltering, lastReadLabel,
  matchesBase, matchesSeverity, norm, rowsToCsv, sortRows,
  type Filters, type RiskRow, type Severity, type SortKey,
} from '@/lib/riskInbox';
import type { Assignment, Teacher } from '@/types';

interface Props {
  teachers: Teacher[];
  assignments: Assignment[];
}

type InnerTab = 'cola' | 'verif' | 'res';

/** Alerta cerrada en esta sesión. Ver nota de "Resueltas" más abajo. */
interface ResolvedItem {
  id: string;
  studentName: string;
  teacherName: string;
  from: InnerTab;
  closedBy: string;
  context: string;
  /** Estado previo de la ficha, para poder deshacer. null → no se pudo leer. */
  snapshot: InterventionSnapshot | null;
}

const PAGE = 20;   // filas por grupo antes de "Ver N alertas más"

/** 1 = verde … 3 = rojo. Para el riesgo promedio por profesor. */
const RISK_SCORE: Record<RiskSignal, number> = { verde: 1, amarillo: 2, rojo: 3 };

export default function AiRiskTab({ teachers, assignments }: Props) {
  const { user } = useAuth();
  const { classRecords } = useTeachers();

  const [profiles, setProfiles] = useState<StudentProfileRow[]>([]);
  const [analyses, setAnalyses] = useState<ClassAnalysisRow[]>([]);
  const [audits, setAudits] = useState<InterventionAuditRow[]>([]);
  const [churned, setChurned] = useState<ChurnedWithAlert[]>([]);
  const [missingTable, setMissingTable] = useState(false);
  const [loading, setLoading] = useState(true);

  // ── Estado de la vista ─────────────────────────────────────────────────────
  const [tab, setTab] = useState<InnerTab>('cola');
  const [sev, setSev] = useState<Severity | 'todas'>('todas');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');                 // el valor con debounce
  const [prof, setProf] = useState('todos');
  const [solo, setSolo] = useState(false);
  const [sort, setSort] = useState<SortKey>('sev');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [gopen, setGopen] = useState({ riesgo: true, atencion: true });
  const [shown, setShown] = useState<Record<string, number>>({ riesgo: PAGE, atencion: PAGE });
  const [toast, setToast] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolvedItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Modales
  const [detail, setDetail] = useState<RiskRow | null>(null);
  const [auditDetail, setAuditDetail] = useState<RiskRow | null>(null);
  const [incident, setIncident] = useState<RiskRow | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showScoring, setShowScoring] = useState(false);
  const [showUsage, setShowUsage] = useState(false);

  // Búsqueda con debounce de 200 ms: filtra sobre cientos de filas en cada
  // pulsación y sin esto se nota al teclear.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 200);
    return () => clearTimeout(t);
  }, [qInput]);

  // ── Carga ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, a, au, ch] = await Promise.all([
        fetchRiskProfiles(), fetchAllClassAnalyses(),
        fetchInterventionAudits(), fetchChurnedWithOpenAlert(),
      ]);
      if (cancelled) return;
      setProfiles(p); setAnalyses(a);
      setAudits(au.rows); setMissingTable(au.missingTable);
      setChurned(ch); setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const reload = useCallback(async () => {
    const [p, au] = await Promise.all([fetchRiskProfiles(), fetchInterventionAudits()]);
    setProfiles(p); setAudits(au.rows); setMissingTable(au.missingTable);
  }, []);

  // ── Derivación de filas ────────────────────────────────────────────────────
  const latestByStudent = useMemo(() => {
    const m = new Map<string, ClassAnalysisRow>();
    for (const a of analyses) {
      for (const key of [a.student_id, `name:${norm(a.student_name)}`]) {
        if (key && !m.has(key)) m.set(key, a);
      }
    }
    return m;
  }, [analyses]);

  const teacherOfStudent = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of assignments) m.set(norm(a.studentName), a.teacherId);
    return m;
  }, [assignments]);

  /** Auditorías por alumno (por id y, de respaldo, por nombre normalizado). */
  const auditsOf = useCallback((studentId: string | null, studentName: string) => audits.filter(a =>
    (studentId && a.student_id === studentId) ||
    (!!a.student_name && norm(a.student_name) === norm(studentName))
  ), [audits]);

  // Los alumnos salen de DOS fuentes: student_profiles (la ficha, riesgo
  // "oficial") y class_analyses (la señal de cada clase). Hay que mirar las dos
  // porque un alumno analizado sin ficha solo tiene riesgo en class_analyses.
  // Cuando está en ambas gana la fuente MÁS RECIENTE, y se muestra una sola fila.
  const allRows: RiskRow[] = useMemo(() => {
    const seen = new Set<string>();
    const out: RiskRow[] = [];
    const nameOfTeacher = (id: string | null) => teachers.find(t => t.id === id)?.name ?? '—';

    const push = (r: Omit<RiskRow, 'sev' | 'audits' | 'confidence'>) => {
      const mine = auditsOf(r.studentId, r.studentName);
      out.push({
        ...r,
        sev: SEV_OF[r.risk],
        audits: mine,
        // No hay confianza por alerta en la base: la única que existe es la de
        // la última auditoría de intervención de ese alumno.
        confidence: mine[0]?.confidence ?? null,
      });
    };

    for (const p of profiles) {
      const name = p.student_name;
      if (!name) continue;
      const last = (p.student_id && latestByStudent.get(p.student_id)) || latestByStudent.get(`name:${norm(name)}`);
      const teacherId = last?.teacher_id || p.teacher_id || teacherOfStudent.get(norm(name)) || null;

      const fichaRisk = isRiskSignal(p.risk_signal) ? p.risk_signal : 'verde';
      const claseRisk = isRiskSignal(last?.risk_signal) ? last!.risk_signal : null;
      const fichaAt = p.risk_updated_at ?? null;
      const claseAt = last?.analyzed_at ?? null;
      const usarClase = !!claseRisk && (!fichaAt || (!!claseAt && claseAt > fichaAt));

      // Motivo VIGENTE de la alerta abierta: si sobrevivió a alguna clase, el
      // actualizado manda sobre el de la clase que la abrió. Sin esto, el admin
      // leía en la cola un diagnóstico de hace varias clases como si fuera de hoy.
      const activa = asIntervention(p.active_intervention);
      const motivoVigente = currentReason(activa);

      push({
        id: p.id,
        studentId: p.student_id,
        studentName: name,
        teacherId,
        teacherName: nameOfTeacher(teacherId),
        risk: usarClase ? claseRisk! : fichaRisk,
        evidence: motivoVigente || ((usarClase ? last?.risk_explanation : p.risk_explanation) ?? ''),
        date: last?.class_date ?? last?.analyzed_at ?? p.last_class_analyzed_at ?? null,
        classNumber: last?.class_number ?? null,
        hasProfile: true,
        riskFromClass: usarClase,
        unattended: Number(p.unattended_alerts ?? 0) || 0,
        active: activa,
      });
      for (const k of [p.student_id, `name:${norm(name)}`]) if (k) seen.add(k);
    }

    // Alumnos analizados que todavía no tienen ficha. `analyses` viene ordenado
    // por analyzed_at desc: la primera aparición de cada uno es su última clase.
    for (const a of analyses) {
      const name = a.student_name;
      if (!name) continue;
      const alias = [a.student_id, `name:${norm(name)}`].filter((k): k is string => !!k);
      if (alias.some(k => seen.has(k))) continue;
      for (const k of alias) seen.add(k);

      const teacherId = a.teacher_id || teacherOfStudent.get(norm(name)) || null;
      push({
        id: `analysis:${a.id}`,
        studentId: a.student_id,
        studentName: name,
        teacherId,
        teacherName: nameOfTeacher(teacherId),
        risk: isRiskSignal(a.risk_signal) ? a.risk_signal : 'verde',
        evidence: a.risk_explanation ?? '',
        date: a.class_date ?? a.analyzed_at ?? null,
        classNumber: a.class_number ?? null,
        hasProfile: false,
        riskFromClass: true,
        unattended: 0,
        active: null,
      });
    }
    return out;
  }, [profiles, analyses, latestByStudent, teacherOfStudent, teachers, auditsOf]);

  // Los cerrados en esta sesión desaparecen de sus pestañas de origen.
  const resolvedIds = useMemo(() => new Set(resolved.map(r => r.id)), [resolved]);

  const counts = useMemo(() => ({
    buen:     allRows.filter(r => r.sev === 'buen').length,
    atencion: allRows.filter(r => r.sev === 'atencion').length,
    riesgo:   allRows.filter(r => r.sev === 'riesgo').length,
  }), [allRows]);

  // Objeto memoizado: si se recreara en cada render invalidaría los useMemo de
  // las dos listas y se recalcularían cientos de filas por pulsación de tecla.
  const filters: Filters = useMemo(() => ({ q, prof, solo, sev }), [q, prof, solo, sev]);
  const filtering = isFiltering(filters);

  /** Cola: alumnos en rojo o amarillo. */
  const colaAll = useMemo(
    () => allRows.filter(r => (r.sev === 'riesgo' || r.sev === 'atencion') && !resolvedIds.has(r.id)),
    [allRows, resolvedIds],
  );
  const colaVisible = useMemo(
    () => sortRows(colaAll.filter(r => matchesBase(r, filters) && matchesSeverity(r, sev)), sort),
    [colaAll, filters, sev, sort],
  );

  /** Verificación: quien tiene alertas sin atender, intervención abierta o auditorías. */
  const verifAll = useMemo(
    () => allRows.filter(r => !resolvedIds.has(r.id) && (r.unattended > 0 || r.active || r.audits.length > 0)),
    [allRows, resolvedIds],
  );
  const verifVisible = useMemo(
    () => sortRows(verifAll.filter(r => matchesBase(r, filters) && matchesSeverity(r, sev)), sort),
    [verifAll, filters, sev, sort],
  );

  /** Profesores que de verdad tienen filas (el select no lista a los 27). */
  const profOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const r of [...colaAll, ...verifAll]) if (r.teacherId) ids.add(r.teacherId);
    return teachers.filter(t => ids.has(t.id)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [colaAll, verifAll, teachers]);

  const lastAnalyzedAt = useMemo(() => {
    let best: string | null = null;
    for (const a of analyses) if (a.analyzed_at && (!best || a.analyzed_at > best)) best = a.analyzed_at;
    return best;
  }, [analyses]);

  // `nowMs` se fija UNA vez al montar (inicializador perezoso de useState): con
  // `Date.now()` suelto en el render el componente sería impuro y las etiquetas
  // relativas ("hace 12 min") cambiarían en cada repintado.
  const [nowMs] = useState(() => Date.now());

  // ── Acciones ───────────────────────────────────────────────────────────────
  const targetOf = (r: RiskRow): InterventionTarget => ({
    studentName: r.studentName, teacherId: r.teacherId, teacherName: r.teacherName,
    unattended: r.unattended, active: r.active, audits: r.audits,
  });

  async function closeOne(r: RiskRow, from: InnerTab) {
    if (!r.hasProfile) return;
    setBusyId(r.id);
    try {
      // La foto ANTES: markInterventionAttended borra active_intervention, así
      // que sin esto "Deshacer" no tendría qué restaurar.
      const snapshot = await readInterventionSnapshot(r.id);
      await markInterventionAttended(r.id);
      setResolved(prev => [{
        id: r.id, studentName: r.studentName, teacherName: r.teacherName, from,
        closedBy: user?.displayName ?? 'Administrador',
        context: r.date ? `alerta del ${formatDate(r.date)}` : `profesor ${r.teacherName}`,
        snapshot,
      }, ...prev]);
      setSel(prev => { const n = new Set(prev); n.delete(r.id); return n; });
      setToast(`Intervención de ${r.studentName} marcada como atendida.`);
      await reload();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'No se pudo cerrar la intervención.');
    } finally {
      setBusyId(null);
    }
  }

  async function closeSelected() {
    const rows = [...colaAll, ...verifAll].filter(r => sel.has(r.id) && r.hasProfile);
    // Un alumno puede estar en las dos pestañas: se cierra una sola vez.
    const unique = [...new Map(rows.map(r => [r.id, r])).values()];
    if (unique.length === 0) { setSel(new Set()); return; }

    setBusyId('bulk');
    const done: ResolvedItem[] = [];
    let failed = 0;
    for (const r of unique) {
      try {
        const snapshot = await readInterventionSnapshot(r.id);
        await markInterventionAttended(r.id);
        done.push({
          id: r.id, studentName: r.studentName, teacherName: r.teacherName,
          from: colaAll.some(c => c.id === r.id) ? 'cola' : 'verif',
          closedBy: user?.displayName ?? 'Administrador',
          context: r.date ? `alerta del ${formatDate(r.date)}` : `profesor ${r.teacherName}`,
          snapshot,
        });
      } catch { failed++; }
    }
    setResolved(prev => [...done, ...prev]);
    setSel(new Set());
    setBusyId(null);
    setToast(failed === 0
      ? `${done.length} alerta${done.length === 1 ? '' : 's'} marcada${done.length === 1 ? '' : 's'} como atendida${done.length === 1 ? '' : 's'}.`
      : `${done.length} cerradas · ${failed} no se pudieron cerrar.`);
    await reload();
  }

  async function undo(item: ResolvedItem) {
    if (!item.snapshot) {
      setToast(`No se puede deshacer ${item.studentName}: no se pudo leer su estado anterior.`);
      return;
    }
    setBusyId(item.id);
    try {
      await restoreIntervention(item.id, item.snapshot);
      setResolved(prev => prev.filter(r => r.id !== item.id));
      setToast(`Alerta de ${item.studentName} devuelta a la bandeja.`);
      await reload();
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'No se pudo deshacer.');
    } finally {
      setBusyId(null);
    }
  }

  const toggleIn = (setter: typeof setOpen) => (id: string) =>
    setter(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleOpen = toggleIn(setOpen);
  const toggleSel  = toggleIn(setSel);

  function pickSev(s: Severity) {
    setSev(prev => (prev === s ? 'todas' : s));
    setShown({ riesgo: PAGE, atencion: PAGE });
  }

  function exportCsv() {
    const rows = tab === 'verif' ? verifVisible : colaVisible;
    const blob = new Blob([rowsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `riesgo-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return <div style={{ textAlign: 'center', padding: '48px 0', color: '#7d8b83', fontSize: 14 }}>Cargando datos de IA…</div>;
  }

  if (allRows.length === 0) {
    return (
      <div style={cardBox}>
        <div style={{ textAlign: 'center', padding: '40px 20px', color: '#7d8b83' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#2b3a32', marginBottom: 6 }}>
            Todavía no hay alumnos que mostrar
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            Aparecen al analizar la primera clase o cuando completan el formulario inicial.
          </div>
        </div>
      </div>
    );
  }

  const selCount = sel.size;
  const showBuenEmpty = tab === 'cola' && sev === 'buen';

  return (
    <div>
      {/* ── 1 · Cabecera de sección ── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, margin: '0 2px 14px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-.2px', color: '#1d2622', margin: 0 }}>
            Riesgo de baja
          </h2>
          <div style={{ fontSize: 13, color: '#7d8b83', marginTop: 3 }}>
            {allRows.length} alumno{allRows.length === 1 ? '' : 's'} analizado{allRows.length === 1 ? '' : 's'} por la IA
            {' · '}{lastReadLabel(lastAnalyzedAt, nowMs)}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" onClick={() => setShowScoring(true)} style={linkBtn}>
            Cómo puntúa la IA
          </button>
          <button type="button" onClick={exportCsv} style={secondaryBtn}>Exportar</button>
        </div>
      </div>

      {/* ── 2 · Tarjetas-resumen que filtran ── */}
      <div className="rk-cards">
        <SummaryCard n={counts.buen}     numColor="#157f3d" dot="#12a04b" label="En buen camino"  aux="sin señales"    active={sev === 'buen'}     onClick={() => pickSev('buen')} />
        <SummaryCard n={counts.atencion} numColor="#a97410" dot="#e0a92b" label="Atención"        aux="a vigilar"      active={sev === 'atencion'} onClick={() => pickSev('atencion')} />
        <SummaryCard n={counts.riesgo}   numColor="#b8332a" dot="#cf3a30" label="Riesgo de baja"  aux="intervenir hoy" active={sev === 'riesgo'}   onClick={() => pickSev('riesgo')} />
      </div>

      {/* ── 3 · Card principal con tres pestañas ── */}
      <div style={{ ...cardBox, borderRadius: 16, marginTop: 14, overflow: 'hidden', padding: 0 }}>
        <div style={{ display: 'flex', gap: 2, padding: '0 16px', borderBottom: '1px solid #edefea', overflowX: 'auto' }} role="tablist">
          <InnerTabBtn id="cola"  active={tab} onPick={setTab} label="Cola de riesgo"           badge={colaAll.length} />
          <InnerTabBtn id="verif" active={tab} onPick={setTab} label="Verificar intervenciones" badge={verifAll.length} />
          <InnerTabBtn id="res"   active={tab} onPick={setTab} label="Resueltas"                badge={resolved.length} />
        </div>

        {/* ── 4 · Barra de herramientas (compartida por las tres pestañas) ── */}
        <div className="rk-toolbar" style={{ padding: '13px 18px', background: '#fbfcfa', borderBottom: '1px solid #edefea' }}>
          <div style={{ position: 'relative', width: 290, maxWidth: '100%' }}>
            <span aria-hidden style={{ position: 'absolute', left: 11, top: 8, fontSize: 13, color: '#9aa79f' }}>⌕</span>
            <input
              value={qInput}
              onChange={e => setQInput(e.target.value)}
              placeholder="Buscar alumno o profesor"
              aria-label="Buscar alumno o profesor"
              style={{ ...control, width: '100%', paddingLeft: 28 }}
            />
          </div>
          <select value={prof} onChange={e => setProf(e.target.value)} aria-label="Filtrar por profesor" style={{ ...control, fontWeight: 600 }}>
            <option value="todos">Todos los profesores</option>
            {profOptions.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button
            type="button"
            onClick={() => setSolo(v => !v)}
            aria-pressed={solo}
            style={{
              ...control, cursor: 'pointer', fontWeight: 700,
              background: solo ? '#eaf5ee' : '#fff',
              border: `1px solid ${solo ? '#cfe8d8' : '#e2e5df'}`,
              color: solo ? '#0d7a39' : '#3f4c45',
            }}
          >
            Solo sin atender
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#8a9790', fontWeight: 600 }}>
            <label htmlFor="rk-sort">Orden</label>
            <select id="rk-sort" value={sort} onChange={e => setSort(e.target.value as SortKey)} style={{ ...control, fontSize: 13, fontWeight: 600 }}>
              <option value="sev">Severidad</option>
              <option value="fecha">Más reciente</option>
              <option value="alertas">Alertas sin atender</option>
            </select>
          </div>
        </div>

        {/* Confirmación */}
        {toast && (
          <div role="status" aria-live="polite" style={{
            display: 'flex', alignItems: 'center', gap: 10, margin: '14px 18px 0',
            background: '#eaf5ee', border: '1px solid #cfe8d8', borderRadius: 10, padding: '10px 14px',
          }}>
            <span aria-hidden style={{ color: '#0d7a39', fontWeight: 800, fontSize: 13 }}>✓</span>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#136b34' }}>{toast}</div>
            <button type="button" onClick={() => setToast(null)} aria-label="Cerrar aviso"
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#5c7a67', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
              ✕
            </button>
          </div>
        )}

        {/* Selección múltiple */}
        {selCount > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '14px 18px 0',
            background: '#f2f6f3', border: '1px solid #dde5df', borderRadius: 10, padding: '10px 14px',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#2b3a32' }}>
              {selCount === 1 ? '1 alerta seleccionada' : `${selCount} alertas seleccionadas`}
            </div>
            <button type="button" onClick={closeSelected} disabled={busyId === 'bulk'}
              style={{ background: '#12a04b', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', opacity: busyId === 'bulk' ? 0.6 : 1 }}>
              {busyId === 'bulk' ? 'Cerrando…' : 'Marcar como atendidas'}
            </button>
            <button type="button" onClick={() => setSel(new Set())}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 12.5, fontWeight: 700, color: '#6b7a70', cursor: 'pointer', fontFamily: 'inherit' }}>
              Quitar selección
            </button>
          </div>
        )}

        {/* ── Pestaña: en buen camino (estado vacío con salida al listado) ── */}
        {showBuenEmpty && (
          <div style={{ padding: '46px 18px', textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#2b3a32' }}>
              {counts.buen} alumno{counts.buen === 1 ? '' : 's'} sin señales de riesgo
            </div>
            <div style={{ fontSize: 13, color: '#7d8b83', marginTop: 6 }}>
              No requieren intervención en los últimos 30 días.
            </div>
            <button type="button" onClick={() => setShowAll(true)} style={{ ...secondaryBtn, marginTop: 14 }}>
              Ver listado completo
            </button>
          </div>
        )}

        {/* ── 5 y 6 · Cola de riesgo ── */}
        {tab === 'cola' && !showBuenEmpty && (
          <ColaTab
            rows={colaVisible}
            grouped={sev === 'todas'}
            filtering={filtering}
            totals={{ riesgo: colaAll.filter(r => r.sev === 'riesgo').length, atencion: colaAll.filter(r => r.sev === 'atencion').length }}
            gopen={gopen}
            onToggleGroup={k => setGopen(g => ({ ...g, [k]: !g[k] }))}
            shown={shown}
            onShowMore={k => setShown(s => ({ ...s, [k]: (s[k] ?? PAGE) + PAGE }))}
            open={open} sel={sel} busyId={busyId}
            history={r => buildHistory(
              analyses.filter(a => (r.studentId && a.student_id === r.studentId) || norm(a.student_name) === norm(r.studentName)),
              r.audits,
            )}
            attendance={r => attendance30d(classRecords, r.studentName, nowMs)}
            onToggle={toggleOpen} onSelect={toggleSel}
            onIntervene={setDetail}
            onDone={r => closeOne(r, 'cola')}
            onIncident={setIncident}
          />
        )}

        {/* ── 8 · Verificar intervenciones ── */}
        {tab === 'verif' && (
          <VerifTab
            rows={verifVisible}
            missingTable={missingTable}
            churned={churned}
            teacherNameOf={id => teachers.find(t => t.id === id)?.name ?? 'sin asignar'}
            open={open} sel={sel} busyId={busyId}
            onToggle={toggleOpen} onSelect={toggleSel}
            onDone={r => closeOne(r, 'verif')}
            onDetail={setAuditDetail}
            onIncident={setIncident}
          />
        )}

        {/* ── 9 · Resueltas ── */}
        {tab === 'res' && (
          <ResueltasTab items={resolved} busyId={busyId} onUndo={undo} />
        )}
      </div>

      {/* Preservado del panel anterior: uso del módulo por profesor. */}
      <TeacherUsage
        open={showUsage}
        onToggle={() => setShowUsage(v => !v)}
        teachers={teachers}
        assignments={assignments}
        analyses={analyses}
        rows={allRows}
      />

      {/* ── Modales ── */}
      {detail && (
        <Modal onClose={() => setDetail(null)} maxWidth={760}>
          <ModalHeader
            title={detail.studentName}
            subtitle={`Profesor: ${detail.teacherName}`}
            onClose={() => setDetail(null)}
          />
          {/* Solo lectura: el admin ve todo, pero no registra clases por el profesor. */}
          <AiStudentPanel
            studentName={detail.studentName}
            studentId={detail.studentId}
            teacherId={detail.teacherId}
            teacherName={detail.teacherName}
            classNumber={detail.classNumber}
            alwaysOpen
            canEdit={false}
          />
        </Modal>
      )}

      {auditDetail && (
        <Modal onClose={() => setAuditDetail(null)} maxWidth={680}>
          <ModalHeader
            title={auditDetail.studentName}
            subtitle={`Profesor: ${auditDetail.teacherName} · ${auditDetail.audits.length} auditoría(s)`}
            onClose={() => setAuditDetail(null)}
          />
          <AuditHistory row={targetOf(auditDetail)} />
        </Modal>
      )}

      {incident && (
        <IncidentModal
          row={targetOf(incident)}
          createdBy={user?.displayName ?? 'Admin'}
          onClose={() => setIncident(null)}
          onSaved={async name => {
            setIncident(null);
            await reload();
            setToast(`Incidencia registrada para ${name}.`);
          }}
        />
      )}

      {showAll && (
        <AllStudentsModal rows={allRows} onClose={() => setShowAll(false)} onOpen={r => { setShowAll(false); setDetail(r); }} />
      )}

      {showScoring && <ScoringModal onClose={() => setShowScoring(false)} />}
    </div>
  );
}

// ═══ Tarjeta-resumen ═══════════════════════════════════════════════════════════
function SummaryCard({ n, numColor, dot, label, aux, active, onClick }: {
  n: number; numColor: string; dot: string; label: string; aux: string;
  active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'left',
        background: '#fff', borderRadius: 14, padding: '15px 18px', cursor: 'pointer',
        fontFamily: 'inherit', transition: 'box-shadow .15s, border-color .15s',
        border: active ? '1.5px solid #12a04b' : '1px solid #e7e9e4',
        boxShadow: active ? '0 0 0 3px rgba(18,160,75,.12)' : '0 1px 2px rgba(24,38,28,.05)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 32, fontWeight: 800, color: numColor, lineHeight: 1 }}>{n}</span>
        <span style={{ fontSize: 12, color: '#7d8b83', fontWeight: 600 }}>{aux}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8, fontSize: 13.5, fontWeight: 700, color: '#3f4c45' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
        {label}
      </span>
    </button>
  );
}

// ═══ Pestaña interna ═══════════════════════════════════════════════════════════
function InnerTabBtn({ id, active, onPick, label, badge }: {
  id: InnerTab; active: InnerTab; onPick: (t: InnerTab) => void; label: string; badge: number;
}) {
  const on = active === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={() => onPick(id)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '14px 15px', fontSize: 14,
        background: 'none', border: 'none', fontFamily: 'inherit', cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontWeight: on ? 800 : 600, color: on ? '#0d7a39' : '#6b7a70',
        boxShadow: on ? 'inset 0 -2px 0 #12a04b' : 'none',
      }}
    >
      {label}
      <span style={{
        fontSize: 11.5, fontWeight: 800, borderRadius: 999, padding: '1px 8px',
        background: on ? '#eaf5ee' : '#f2f4f1',
        border: `1px solid ${on ? '#cfe8d8' : '#e6e9e4'}`,
        color: on ? '#0d7a39' : '#7d8b83',
      }}>
        {badge}
      </span>
    </button>
  );
}

// ═══ Cola de riesgo ════════════════════════════════════════════════════════════
function ColaTab(p: {
  rows: RiskRow[];
  grouped: boolean;
  filtering: boolean;
  totals: { riesgo: number; atencion: number };
  gopen: { riesgo: boolean; atencion: boolean };
  onToggleGroup: (k: 'riesgo' | 'atencion') => void;
  shown: Record<string, number>;
  onShowMore: (k: string) => void;
  open: Set<string>; sel: Set<string>; busyId: string | null;
  history: (r: RiskRow) => ReturnType<typeof buildHistory>;
  attendance: (r: RiskRow) => string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onIntervene: (r: RiskRow) => void;
  onDone: (r: RiskRow) => void;
  onIncident: (r: RiskRow) => void;
}) {
  if (p.rows.length === 0) {
    return <div style={emptyBox}>Ninguna alerta coincide con los filtros.</div>;
  }

  const renderRow = (r: RiskRow) => (
    <ColaRow
      key={r.id}
      row={r}
      open={p.open.has(r.id)}
      selected={p.sel.has(r.id)}
      busy={p.busyId === r.id}
      history={p.history(r)}
      attendance={p.attendance(r)}
      onToggle={() => p.onToggle(r.id)}
      onSelect={() => p.onSelect(r.id)}
      onIntervene={() => p.onIntervene(r)}
      onDone={() => p.onDone(r)}
      onIncident={() => p.onIncident(r)}
    />
  );

  // Con una severidad concreta seleccionada la lista va plana: agrupar por un
  // solo grupo sería una cabecera que no informa de nada.
  if (!p.grouped) {
    return <div style={{ padding: '8px 0 6px' }}>{p.rows.map(renderRow)}</div>;
  }

  const keys: Array<'riesgo' | 'atencion'> = ['riesgo', 'atencion'];
  return (
    <div style={{ padding: '8px 0 6px' }}>
      {keys.map(k => {
        const groupRows = p.rows.filter(r => r.sev === k);
        // Con filtros activos, un grupo vacío no se pinta: una cabecera con 0 es
        // ruido y contradice el recuento.
        if (groupRows.length === 0 && p.filtering) return null;

        const s = SEV[k];
        const limit = p.shown[k] ?? 20;
        const visible = groupRows.slice(0, limit);
        const hidden = groupRows.length - visible.length;
        // Con filtros el badge cuenta lo filtrado, no el total absoluto.
        const badge = p.filtering ? groupRows.length : p.totals[k];

        return (
          <div key={k} style={{ borderBottom: '1px solid #f1f3ef' }}>
            <button
              type="button"
              onClick={() => p.onToggleGroup(k)}
              aria-expanded={p.gopen[k]}
              style={{
                display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
                padding: '12px 18px', background: '#fcfdfb', border: 'none',
                borderBottom: '1px solid #f1f3ef', fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.accent, flex: 'none' }} />
              <span style={{ fontSize: 14, fontWeight: 800, color: '#22302a' }}>{s.label}</span>
              <span style={{
                fontSize: 11.5, fontWeight: 700, color: s.fg, background: s.bg,
                border: `1px solid ${s.bd}`, borderRadius: 999, padding: '1px 9px',
              }}>
                {badge}
              </span>
              <span style={{ fontSize: 12.5, color: '#8a9790', fontWeight: 600 }}>
                {p.filtering ? 'coinciden con los filtros' : s.hint}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8a9790', fontWeight: 700 }}>
                {p.gopen[k] ? 'Ocultar ▾' : 'Mostrar ▸'}
              </span>
            </button>

            {p.gopen[k] && (
              <div>
                {visible.map(renderRow)}
                {/* Sin filtros y con más filas: se pagina. Con filtros el enlace
                    se oculta (ya se está viendo un subconjunto explícito). */}
                {!p.filtering && hidden > 0 && (
                  <div style={{ borderTop: '1px solid #f1f3ef', padding: '12px 18px 12px 40px' }}>
                    <button type="button" onClick={() => p.onShowMore(k)} style={linkBtn}>
                      Ver {hidden} alerta{hidden === 1 ? '' : 's'} más de este grupo
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ═══ Verificar intervenciones ══════════════════════════════════════════════════
function VerifTab(p: {
  rows: RiskRow[];
  missingTable: boolean;
  churned: ChurnedWithAlert[];
  teacherNameOf: (id: string | null) => string;
  open: Set<string>; sel: Set<string>; busyId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onDone: (r: RiskRow) => void;
  onDetail: (r: RiskRow) => void;
  onIncident: (r: RiskRow) => void;
}) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, padding: '14px 18px 12px', borderBottom: '1px solid #f1f3ef' }}>
        <span aria-hidden style={{ fontSize: 15, flex: 'none' }}>🔍</span>
        <div style={{ fontSize: 12.8, color: '#6b7a70', lineHeight: 1.55, maxWidth: 900 }}>
          Alertas de riesgo en las que la IA no vio señales claras de intervención. No se aplica ninguna
          penalización automática: una intervención bien hecha es sutil y puede no reflejarse en el
          transcript. Revisa el detalle antes de tomar cualquier medida.
        </div>
      </div>

      {p.missingTable ? (
        <div style={{ padding: '32px 18px', fontSize: 13, color: '#8a5f0a', lineHeight: 1.6, textAlign: 'center' }}>
          La tabla <code>intervention_audits</code> todavía no existe. Corré <code>supabase-interventions.sql</code> en Supabase.
        </div>
      ) : p.rows.length === 0 ? (
        <div style={emptyBox}>Ninguna intervención coincide con los filtros.</div>
      ) : (
        <>
          <div className="rk-verif-head">
            <div />
            <div>Alumno</div><div>Profesor</div><div>Sin atender</div>
            <div className="rk-preview">Última evidencia</div>
            <div>Confianza</div><div>Acción</div><div />
          </div>
          {p.rows.map(r => (
            <VerifRow
              key={r.id}
              row={r}
              open={p.open.has(r.id)}
              selected={p.sel.has(r.id)}
              busy={p.busyId === r.id}
              onToggle={() => p.onToggle(r.id)}
              onSelect={() => p.onSelect(r.id)}
              onDone={() => p.onDone(r)}
              onDetail={() => p.onDetail(r)}
              onIncident={() => p.onIncident(r)}
            />
          ))}
        </>
      )}

      {/* Preservado: bajas que se fueron con la alerta abierta. Contexto puro,
          sin efecto en el scoring. */}
      {p.churned.length > 0 && (
        <div style={{ padding: '16px 18px', borderTop: '1px solid #f1f3ef' }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, color: '#1d2622', marginBottom: 4 }}>
            Bajas con alerta de riesgo previa ({p.churned.length})
          </div>
          <div style={{ fontSize: 12, color: '#8a9790', lineHeight: 1.6, marginBottom: 10 }}>
            Se dieron de baja mientras tenían una alerta con seguimiento pendiente. Dato de contexto,
            sin efecto en el scoring.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {p.churned.map(b => (
              <div key={b.id} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 12.5 }}>
                <span style={{ fontWeight: 700, color: '#1d2622' }}>{b.student_name}</span>
                <span style={{ color: '#3f4c45' }}>{p.teacherNameOf(b.teacher_id)}</span>
                <span style={{ color: '#8a9790' }}>
                  {b.dropped_at ? formatDate(b.dropped_at) : '—'}
                  {b.unattended_alerts ? ` · ${b.unattended_alerts} sin atender` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ Resueltas ═════════════════════════════════════════════════════════════════
function ResueltasTab({ items, busyId, onUndo }: {
  items: ResolvedItem[]; busyId: string | null; onUndo: (r: ResolvedItem) => void;
}) {
  if (items.length === 0) {
    return <div style={emptyBox}>Todavía no has cerrado ninguna alerta.</div>;
  }
  return (
    <div>
      {items.map(r => (
        <div key={r.id} className="rk-res-row">
          <div style={{ fontSize: 14, fontWeight: 800, color: '#1d2622', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {r.studentName}
          </div>
          <div className="rk-span" style={{
            justifySelf: 'start', fontSize: 11.5, fontWeight: 800, color: '#136b34',
            background: '#eaf5ee', border: '1px solid #cfe8d8', borderRadius: 999, padding: '3px 10px',
          }}>
            Atendida
          </div>
          <div className="rk-span" style={{ fontSize: 13, color: '#6b7a70', fontWeight: 600 }}>
            Cerrada hoy por {r.closedBy} · {r.context}
          </div>
          <button
            type="button"
            onClick={() => onUndo(r)}
            disabled={busyId === r.id || !r.snapshot}
            title={r.snapshot ? 'Devuelve la alerta a su pestaña' : 'No se pudo leer el estado anterior: no es reversible'}
            style={{
              justifySelf: 'end', background: 'none', border: 'none', fontFamily: 'inherit',
              fontSize: 12.5, fontWeight: 700, color: '#6b7a70',
              cursor: r.snapshot ? 'pointer' : 'not-allowed', opacity: r.snapshot ? 1 : 0.45,
            }}
          >
            {busyId === r.id ? 'Deshaciendo…' : 'Deshacer'}
          </button>
        </div>
      ))}
      <div style={{ padding: '12px 18px', fontSize: 11.5, color: '#8a9790', lineHeight: 1.5 }}>
        Esta lista es de la sesión actual: la base no guarda cuándo se cerró cada alerta, así que al
        recargar la página se vacía. Lo cerrado sigue cerrado.
      </div>
    </div>
  );
}

// ═══ Preservado: uso del módulo por profesor ═══════════════════════════════════
function TeacherUsage({ open, onToggle, teachers, assignments, analyses, rows }: {
  open: boolean; onToggle: () => void;
  teachers: Teacher[]; assignments: Assignment[]; analyses: ClassAnalysisRow[]; rows: RiskRow[];
}) {
  const perTeacher = useMemo(() => teachers.map(t => {
    const unique = Array.from(new Set(assignments.filter(a => a.teacherId === t.id).map(a => norm(a.studentName))));
    const analyzed = unique.filter(n => analyses.some(a => norm(a.student_name) === n));
    const risks = rows.filter(r => r.teacherId === t.id).map(r => RISK_SCORE[r.risk]);
    return {
      id: t.id, name: t.name, total: unique.length, analyzed: analyzed.length,
      usage: unique.length ? Math.round((analyzed.length / unique.length) * 100) : 0,
      avgRisk: risks.length ? risks.reduce((x, y) => x + y, 0) / risks.length : null,
    };
  }).sort((a, b) => (b.avgRisk ?? 0) - (a.avgRisk ?? 0)), [teachers, assignments, analyses, rows]);

  return (
    <div style={{ ...cardBox, marginTop: 14, padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
          padding: '14px 18px', background: 'none', border: 'none', fontFamily: 'inherit', cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 800, color: '#22302a' }}>Uso del módulo por profesor</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8a9790', fontWeight: 700 }}>
          {open ? 'Ocultar ▾' : 'Mostrar ▸'}
        </span>
      </button>

      {open && (
        <div style={{ overflowX: 'auto', borderTop: '1px solid #f1f3ef' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 520 }}>
            <thead>
              <tr>
                {['Profesor', 'Analizados', '% uso módulo IA', 'Riesgo promedio'].map(h => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {perTeacher.map(t => (
                <tr key={t.id}>
                  <td style={{ ...tdStyle, fontWeight: 700, color: '#1d2622' }}>{t.name}</td>
                  <td style={tdStyle}>{t.analyzed} / {t.total}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 60, height: 7, borderRadius: 4, background: '#eef0ec', overflow: 'hidden' }}>
                        <div style={{ width: `${t.usage}%`, height: '100%', background: t.usage >= 60 ? DRC.green : t.usage >= 30 ? DRC.yellow : '#cf3a30' }} />
                      </div>
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{t.usage}%</span>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    {t.avgRisk == null ? '—' : (
                      <span style={{ fontWeight: 700, color: RISK_META[t.avgRisk >= 2.5 ? 'rojo' : t.avgRisk >= 1.5 ? 'amarillo' : 'verde'].color }}>
                        {t.avgRisk.toFixed(2)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══ Preservado: listado completo de alumnos ═══════════════════════════════════
function AllStudentsModal({ rows, onClose, onOpen }: {
  rows: RiskRow[]; onClose: () => void; onOpen: (r: RiskRow) => void;
}) {
  const [q, setQ] = useState('');
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? rows.filter(r => `${r.studentName} ${r.teacherName}`.toLowerCase().includes(needle))
      : rows;
    return [...list].sort((a, b) => a.studentName.localeCompare(b.studentName, 'es'));
  }, [rows, q]);

  return (
    <Modal onClose={onClose} maxWidth={760}>
      <ModalHeader title="Todos los alumnos" subtitle={`${rows.length} analizados por la IA`} onClose={onClose} />
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Buscar alumno o profesor"
        aria-label="Buscar en el listado"
        style={{ ...control, width: '100%', marginBottom: 12 }}
      />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 520 }}>
          <thead>
            <tr>{['Alumno', 'Profesor', 'Riesgo', 'Última clase', ''].map((h, i) => <th key={i} style={thStyle}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {visible.map(r => (
              <tr key={r.id}>
                <td style={{ ...tdStyle, fontWeight: 700, color: '#1d2622' }}>{r.studentName}</td>
                <td style={tdStyle}>{r.teacherName}</td>
                <td style={tdStyle}><RiskBadge risk={r.risk} compact /></td>
                <td style={tdStyle}>{r.date ? formatDate(r.date) : '—'}</td>
                <td style={tdStyle}>
                  <button type="button" onClick={() => onOpen(r)} style={{ ...secondaryBtn, padding: '5px 11px', fontSize: 12 }}>
                    Ver ficha
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: '#8a9790' }}>
            Ningún alumno coincide con la búsqueda.
          </div>
        )}
      </div>
    </Modal>
  );
}

// ═══ Cómo puntúa la IA ═════════════════════════════════════════════════════════
// El texto sale del mismo criterio que ya explica lib/helpFaq (q16) y de cómo
// funciona de verdad el pipeline; no describe nada que el sistema no haga.
function ScoringModal({ onClose }: { onClose: () => void }) {
  const items: Array<{ k: string; v: string }> = [
    { k: 'En buen camino (verde)', v: 'El alumno progresa y sigue comprometido. No genera alerta ni protocolo.' },
    { k: 'Atención (amarillo)', v: 'La IA vio señales de desmotivación, falta de estructura o dificultades. Genera aviso al profesor y una sugerencia de intervención.' },
    { k: 'Riesgo de baja (rojo)', v: 'Hay señal directa de posible baja (lo dijo, faltó sin avisar, canceló repetido). Avisa al profesor y también al admin.' },
  ];
  return (
    <Modal onClose={onClose} maxWidth={560}>
      <ModalHeader title="Cómo puntúa la IA" subtitle="Señal de riesgo por alumno" onClose={onClose} />
      <div style={{ fontSize: 13, lineHeight: 1.65, color: '#3f4c45' }}>
        <p style={{ margin: '0 0 14px' }}>
          La señal se calcula al analizar el transcript de cada clase. La ficha del alumno guarda la
          última señal; si la clase analizada es más reciente que la ficha, manda la clase.
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          {items.map(i => (
            <div key={i.k} style={{ border: '1px solid #e7e9e4', borderRadius: 10, padding: '11px 13px', background: '#fcfdfb' }}>
              <div style={{ fontWeight: 800, fontSize: 12.5, marginBottom: 3 }}>{i.k}</div>
              <div style={{ fontSize: 12.5, color: '#5c6a62' }}>{i.v}</div>
            </div>
          ))}
        </div>
        <p style={{ margin: '14px 0 0', fontSize: 12.5, color: '#6b7a70' }}>
          La columna <strong>Confianza IA</strong> no es la de la alerta: es la de la última auditoría de
          intervención de ese alumno (cuánta seguridad tenía la IA al juzgar si el profesor actuó).
          Los alumnos sin auditoría no tienen ninguna y muestran «—».
        </p>
      </div>
    </Modal>
  );
}

// ═══ Estilos compartidos ═══════════════════════════════════════════════════════
const cardBox: CSSProperties = {
  background: '#fff', border: '1px solid #e7e9e4', borderRadius: 16,
  boxShadow: '0 1px 2px rgba(24,38,28,.05)',
};
const control: CSSProperties = {
  border: '1px solid #e2e5df', borderRadius: 9, padding: '8px 12px',
  fontSize: 13.5, color: '#1d2622', background: '#fff', fontFamily: 'inherit',
  boxSizing: 'border-box',
};
const secondaryBtn: CSSProperties = {
  background: '#fff', border: '1px solid #e2e5df', borderRadius: 9, padding: '8px 14px',
  fontSize: 13, fontWeight: 700, color: '#3f4c45', fontFamily: 'inherit', cursor: 'pointer',
};
const linkBtn: CSSProperties = {
  background: 'none', border: 'none', padding: 0, fontSize: 13, fontWeight: 700,
  color: '#0d7a39', fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left',
};
const emptyBox: CSSProperties = {
  padding: '44px 18px', textAlign: 'center', fontSize: 14, color: '#7d8b83', fontWeight: 600,
};
const thStyle: CSSProperties = {
  textAlign: 'left', padding: '8px 10px', fontSize: 10.8, fontWeight: 800, textTransform: 'uppercase',
  letterSpacing: '.7px', color: '#8a9790', borderBottom: '1px solid #edefea', whiteSpace: 'nowrap',
};
const tdStyle: CSSProperties = {
  padding: '10px', borderBottom: '1px solid #f1f3ef', color: '#3f4c45', verticalAlign: 'middle',
};
