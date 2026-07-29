'use client';

// Pestaña "🤖 IA y Riesgo" del panel de admin.
//
//   · Cards con el reparto de alumnos por señal de riesgo.
//   · Tabla de alertas (🔴 y 🟡) con el motivo completo y acción por alumno.
//   · Tabla por profesor: analizados, % de uso del módulo y riesgo promedio.
//   · Al abrir un alumno: su ficha completa, igual que la ve el profesor.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { fetchAllClassAnalyses, fetchRiskProfiles, type ClassAnalysisRow } from '@/lib/aiClient';
import { RISK_META, isRiskSignal, type RiskSignal, type StudentProfileRow } from '@/lib/aiTypes';
import { RiskBadge, DRC, formatDate } from '@/components/ai/FichaView';
import AiStudentPanel from '@/components/ai/AiStudentPanel';
import InterventionAuditSection from '@/components/admin/InterventionAuditSection';
import { Modal, ModalHeader } from '@/components/ai/modalUi';
import type { Assignment, Teacher } from '@/types';

interface Props {
  teachers: Teacher[];
  assignments: Assignment[];
}

interface Row {
  profileId: string;
  studentId: string | null;
  studentName: string;
  risk: RiskSignal;
  riskExplanation: string | null;
  teacherId: string | null;
  teacherName: string;
  lastClassAt: string | null;
  classNumber: number | null;
  /** false → el alumno solo existe en class_analyses, todavía sin ficha. */
  hasProfile: boolean;
  /** true → el riesgo mostrado sale de la última clase, no de la ficha. */
  riskFromClass: boolean;
}

const norm = (s: string) => s.trim().toLowerCase();
const RISK_SCORE: Record<RiskSignal, number> = { verde: 1, amarillo: 2, rojo: 3 };

/** Claves con las que se reconoce a un alumno: por id y por nombre normalizado. */
const aliasesOf = (studentId: string | null | undefined, name: string): string[] =>
  [studentId || null, `name:${norm(name)}`].filter((k): k is string => !!k);

export default function AiRiskTab({ teachers, assignments }: Props) {
  const [profiles, setProfiles] = useState<StudentProfileRow[]>([]);
  const [analyses, setAnalyses] = useState<ClassAnalysisRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Row | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, a] = await Promise.all([fetchRiskProfiles(), fetchAllClassAnalyses()]);
      if (!cancelled) { setProfiles(p); setAnalyses(a); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  // Recarga de las fichas tras una acción del admin sobre una intervención.
  const reloadProfiles = useCallback(async () => {
    setProfiles(await fetchRiskProfiles());
  }, []);

  // Último análisis por alumno (ya vienen ordenados por analyzed_at desc).
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

  // Los alumnos salen de DOS fuentes:
  //
  //   · student_profiles → la ficha, que es donde vive el riesgo "oficial".
  //   · class_analyses   → la señal que produjo la IA al analizar cada clase.
  //
  // Hace falta mirar las dos porque la ficha solo existía si el alumno había
  // completado el formulario inicial: los alumnos analizados sin ficha tenían su
  // riesgo únicamente en class_analyses y no aparecían acá. Cuando un alumno está
  // en ambas, gana la fuente MÁS RECIENTE (y se muestra una sola fila).
  const rows: Row[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Row[] = [];

    const nameOfTeacher = (id: string | null) => teachers.find(t => t.id === id)?.name ?? '—';

    for (const p of profiles) {
      const name = p.student_name;
      if (!name) continue;

      const last = (p.student_id && latestByStudent.get(p.student_id)) || latestByStudent.get(`name:${norm(name)}`);
      const teacherId = last?.teacher_id || p.teacher_id || teacherOfStudent.get(norm(name)) || null;

      const fichaRisk = isRiskSignal(p.risk_signal) ? p.risk_signal : 'verde';
      const claseRisk = isRiskSignal(last?.risk_signal) ? last!.risk_signal : null;

      // La ficha manda solo si se actualizó DESPUÉS de la última clase analizada.
      // Sin risk_updated_at (ficha que nunca recibió un análisis) gana la clase.
      const fichaAt = p.risk_updated_at ?? null;
      const claseAt = last?.analyzed_at ?? null;
      const usarClase = !!claseRisk && (!fichaAt || (!!claseAt && claseAt > fichaAt));

      out.push({
        profileId:   p.id,
        studentId:   p.student_id,
        studentName: name,
        risk:            usarClase ? claseRisk! : fichaRisk,
        riskExplanation: usarClase ? (last?.risk_explanation ?? null) : p.risk_explanation,
        teacherId,
        teacherName: nameOfTeacher(teacherId),
        lastClassAt: last?.class_date ?? last?.analyzed_at ?? p.last_class_analyzed_at ?? null,
        classNumber: last?.class_number ?? null,
        hasProfile:  true,
        riskFromClass: usarClase,
      });
      for (const k of aliasesOf(p.student_id, name)) seen.add(k);
    }

    // Alumnos analizados que todavía no tienen ficha. `analyses` viene ordenado
    // por analyzed_at desc, así que la primera aparición de cada uno es la última
    // clase; las siguientes se descartan solas por el Set.
    for (const a of analyses) {
      const name = a.student_name;
      if (!name) continue;
      const alias = aliasesOf(a.student_id, name);
      if (alias.some(k => seen.has(k))) continue;
      for (const k of alias) seen.add(k);

      const teacherId = a.teacher_id || teacherOfStudent.get(norm(name)) || null;
      out.push({
        // No hay ficha: la clave es sintética y `hasProfile` lo deja explícito.
        profileId:   `analysis:${a.id}`,
        studentId:   a.student_id,
        studentName: name,
        risk:            isRiskSignal(a.risk_signal) ? a.risk_signal : 'verde',
        riskExplanation: a.risk_explanation,
        teacherId,
        teacherName: nameOfTeacher(teacherId),
        lastClassAt: a.class_date ?? a.analyzed_at ?? null,
        classNumber: a.class_number ?? null,
        hasProfile:  false,
        riskFromClass: true,
      });
    }

    return out;
  }, [profiles, analyses, latestByStudent, teacherOfStudent, teachers]);

  const counts: Record<RiskSignal, number> = {
    verde:    rows.filter(r => r.risk === 'verde').length,
    amarillo: rows.filter(r => r.risk === 'amarillo').length,
    rojo:     rows.filter(r => r.risk === 'rojo').length,
  };

  const alerts = rows
    .filter(r => r.risk === 'rojo' || r.risk === 'amarillo')
    .sort((a, b) => RISK_SCORE[b.risk] - RISK_SCORE[a.risk]);

  const perTeacher = useMemo(() => teachers.map(t => {
    const unique = Array.from(new Set(assignments.filter(a => a.teacherId === t.id).map(a => norm(a.studentName))));
    const analyzed = unique.filter(n => analyses.some(a => norm(a.student_name) === n));
    const risks = rows.filter(r => r.teacherId === t.id).map(r => RISK_SCORE[r.risk]);
    return {
      id: t.id,
      name: t.name,
      total: unique.length,
      analyzed: analyzed.length,
      usage: unique.length ? Math.round((analyzed.length / unique.length) * 100) : 0,
      avgRisk: risks.length ? risks.reduce((x, y) => x + y, 0) / risks.length : null,
    };
  }).sort((a, b) => (b.avgRisk ?? 0) - (a.avgRisk ?? 0)), [teachers, assignments, analyses, rows]);

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 14 }}>Cargando datos de IA…</div>;
  }

  if (rows.length === 0) {
    return (
      <div style={card}>
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 34, marginBottom: 10 }}>🤖</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            Todavía no hay alumnos que mostrar
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Aparecen al analizar la primera clase o cuando completan el formulario inicial.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {(['verde', 'amarillo', 'rojo'] as const).map(r => (
          <div key={r} style={{ ...card, borderColor: RISK_META[r].border, background: RISK_META[r].bg }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: RISK_META[r].color, lineHeight: 1.1 }}>{counts[r]}</div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: RISK_META[r].color, marginTop: 2 }}>
              {RISK_META[r].emoji} {RISK_META[r].label}
            </div>
          </div>
        ))}
      </div>

      {/* Alertas */}
      <div style={card}>
        <div style={sectionTitle}>🚨 Alertas ({alerts.length})</div>
        {alerts.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>
            Ningún alumno en riesgo ahora mismo. 🎉
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {alerts.map(r => (
              <div key={r.profileId} style={{
                border: `1px solid ${RISK_META[r.risk].border}`, background: RISK_META[r.risk].bg,
                borderRadius: 10, padding: '12px 14px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 800, fontSize: 14, color: 'var(--text-primary)' }}>{r.studentName}</span>
                      <RiskBadge risk={r.risk} compact />
                      {!r.hasProfile && <span style={noFichaChip} title="El riesgo viene del análisis de la clase. La ficha se creará al analizar su próxima clase.">sin ficha</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                      Profesor: {r.teacherName}
                      {r.classNumber != null && ` · Clase ${r.classNumber}`}
                      {r.lastClassAt && ` · ${formatDate(r.lastClassAt)}`}
                      {r.riskFromClass && ' · según la última clase'}
                    </div>
                  </div>
                  <button onClick={() => setDetail(r)} style={r.risk === 'rojo' ? interveneBtn : detailBtn}>
                    {r.risk === 'rojo' ? '⚡ Intervenir' : '👁️ Ver detalle'}
                  </button>
                </div>
                {/* El motivo completo, para que el admin entienda por qué sin abrir nada. */}
                {r.riskExplanation && (
                  <div style={{
                    marginTop: 10, padding: '9px 11px', borderRadius: 8, background: 'rgba(255,255,255,0.65)',
                    fontSize: 12.5, color: RISK_META[r.risk].color, lineHeight: 1.55, whiteSpace: 'pre-wrap',
                  }}>
                    {r.riskExplanation}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Seguimiento de intervenciones (señal al admin, sin penalización automática) */}
      <InterventionAuditSection
        students={rows.map(r => ({
          profileId: r.profileId, studentId: r.studentId, studentName: r.studentName,
          teacherId: r.teacherId, teacherName: r.teacherName, hasProfile: r.hasProfile,
        }))}
        profiles={profiles}
        onRefresh={reloadProfiles}
      />

      {/* Todos los alumnos */}
      <div style={card}>
        <div style={sectionTitle}>👥 Todos los alumnos ({rows.length})</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Alumno</th><th style={th}>Profesor</th><th style={th}>Riesgo</th>
                <th style={th}>Última clase</th><th style={th}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.profileId}>
                  <td style={{ ...td, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {r.studentName}
                    {!r.hasProfile && <span style={{ ...noFichaChip, marginLeft: 6 }}>sin ficha</span>}
                  </td>
                  <td style={td}>{r.teacherName}</td>
                  <td style={td}><RiskBadge risk={r.risk} compact /></td>
                  <td style={td}>{r.lastClassAt ? formatDate(r.lastClassAt) : '—'}</td>
                  <td style={td}><button onClick={() => setDetail(r)} style={detailBtn}>📋 Ver ficha</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Por profesor */}
      <div style={card}>
        <div style={sectionTitle}>👨‍🏫 Uso del módulo por profesor</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Profesor</th><th style={th}>Analizados</th>
                <th style={th}>% uso módulo IA</th><th style={th}>Riesgo promedio</th>
              </tr>
            </thead>
            <tbody>
              {perTeacher.map(t => (
                <tr key={t.id}>
                  <td style={{ ...td, fontWeight: 700, color: 'var(--text-primary)' }}>{t.name}</td>
                  <td style={td}>{t.analyzed} / {t.total}</td>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 60, height: 7, borderRadius: 4, background: '#e5e7eb', overflow: 'hidden' }}>
                        <div style={{ width: `${t.usage}%`, height: '100%', background: t.usage >= 60 ? DRC.green : t.usage >= 30 ? DRC.yellow : '#ef4444' }} />
                      </div>
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{t.usage}%</span>
                    </div>
                  </td>
                  <td style={td}>{t.avgRisk == null ? '—' : <AvgRisk value={t.avgRisk} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <Modal onClose={() => setDetail(null)} maxWidth={760}>
          <ModalHeader
            title={`📋 ${detail.studentName}`}
            subtitle={`Profesor: ${detail.teacherName}`}
            onClose={() => setDetail(null)}
          />
          {/* Sólo lectura: el admin ve todo, pero no registra clases por el profesor. */}
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
    </div>
  );
}

// 1 = verde, 3 = rojo.
function AvgRisk({ value }: { value: number }) {
  const bucket: RiskSignal = value >= 2.5 ? 'rojo' : value >= 1.5 ? 'amarillo' : 'verde';
  const m = RISK_META[bucket];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, color: m.color }}>
      {m.emoji} {value.toFixed(2)}
    </span>
  );
}

const card: CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px',
};
const sectionTitle: CSSProperties = { fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', marginBottom: 12 };
const table: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th: CSSProperties = {
  textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td: CSSProperties = {
  padding: '10px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', verticalAlign: 'middle',
};
const interveneBtn: CSSProperties = {
  padding: '6px 12px', borderRadius: 7, border: '1.5px solid #dc2626', background: 'white',
  color: '#dc2626', fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap', cursor: 'pointer',
};
const detailBtn: CSSProperties = {
  padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-surface-3)',
  color: 'var(--text-secondary)', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap', cursor: 'pointer',
};
// Alumno analizado que todavía no tiene ficha (amarillo DRC, sin gritar).
const noFichaChip: CSSProperties = {
  fontSize: 10, fontWeight: 700, padding: '1.5px 7px', borderRadius: 999, whiteSpace: 'nowrap',
  background: 'rgba(255,196,0,0.16)', color: '#8A6A00', border: '1px solid rgba(255,196,0,0.45)',
};
