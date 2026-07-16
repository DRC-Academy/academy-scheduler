'use client';

// Pestaña "🤖 IA y Riesgo" del panel de admin.
//
//   · Cards con el reparto de alumnos por señal de riesgo.
//   · Tabla de alertas (🔴 y 🟡) con acción por alumno.
//   · Tabla por profesor: analizados, % de uso del módulo y riesgo promedio.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { fetchAllClassAnalyses, fetchRiskProfiles, type ClassAnalysisRow } from '@/lib/aiClient';
import { RISK_META, isRiskSignal, type RiskSignal } from '@/lib/aiTypes';
import { RiskBadge, TranscriptAnalysisView } from '@/components/ai/FichaView';
import type { Assignment, Teacher } from '@/types';

interface Props {
  teachers: Teacher[];
  assignments: Assignment[];
}

interface RiskProfile {
  id: string;
  student_id: string | null;
  student_name: string | null;
  risk_signal: string | null;
  updated_at: string | null;
}

const norm = (s: string) => s.trim().toLowerCase();

export default function AiRiskTab({ teachers, assignments }: Props) {
  const [profiles, setProfiles] = useState<RiskProfile[]>([]);
  const [analyses, setAnalyses] = useState<ClassAnalysisRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<ClassAnalysisRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, a] = await Promise.all([fetchRiskProfiles(), fetchAllClassAnalyses()]);
      if (!cancelled) { setProfiles(p); setAnalyses(a); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  // Último análisis por alumno: es el que manda para el estado actual.
  const latestByStudent = useMemo(() => {
    const m = new Map<string, ClassAnalysisRow>();
    for (const a of analyses) {           // ya vienen ordenados por fecha desc
      const key = a.student_id || `name:${norm(a.student_name)}`;
      if (!m.has(key)) m.set(key, a);
    }
    return m;
  }, [analyses]);

  // Profesor asignado a cada alumno (para atribuir el riesgo).
  const teacherOfStudent = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of assignments) m.set(norm(a.studentName), a.teacherId);
    return m;
  }, [assignments]);

  const rows = useMemo(() => {
    return profiles
      .filter(p => isRiskSignal(p.risk_signal) && p.student_name)
      .map(p => {
        const key = p.student_id || `name:${norm(p.student_name!)}`;
        const last = latestByStudent.get(key) ?? latestByStudent.get(`name:${norm(p.student_name!)}`);
        const teacherId = last?.teacher_id || teacherOfStudent.get(norm(p.student_name!)) || null;
        const teacher = teachers.find(t => t.id === teacherId);
        return {
          profileId:   p.id,
          studentName: p.student_name!,
          risk:        p.risk_signal as RiskSignal,
          teacherName: teacher?.name ?? last?.teacher_name ?? '—',
          lastClassAt: last?.created_at ?? p.updated_at ?? null,
          lastAnalysis: last ?? null,
        };
      });
  }, [profiles, latestByStudent, teacherOfStudent, teachers]);

  const counts: Record<RiskSignal, number> = {
    verde:    rows.filter(r => r.risk === 'verde').length,
    amarillo: rows.filter(r => r.risk === 'amarillo').length,
    rojo:     rows.filter(r => r.risk === 'rojo').length,
  };

  // Alertas: sólo lo que requiere acción, rojo primero.
  const alerts = rows
    .filter(r => r.risk === 'rojo' || r.risk === 'amarillo')
    .sort((a, b) => (a.risk === b.risk ? 0 : a.risk === 'rojo' ? -1 : 1));

  // Por profesor: alumnos asignados vs. alumnos con al menos un análisis.
  const perTeacher = useMemo(() => {
    const RISK_SCORE: Record<RiskSignal, number> = { verde: 1, amarillo: 2, rojo: 3 };
    return teachers.map(t => {
      const myStudents = assignments.filter(a => a.teacherId === t.id).map(a => norm(a.studentName));
      const unique = Array.from(new Set(myStudents));
      const analyzed = unique.filter(name =>
        analyses.some(a => a.teacher_id === t.id && norm(a.student_name) === name),
      );
      const risks = rows
        .filter(r => r.teacherName === t.name && isRiskSignal(r.risk))
        .map(r => RISK_SCORE[r.risk]);
      const avg = risks.length ? risks.reduce((x, y) => x + y, 0) / risks.length : null;
      return {
        id: t.id,
        name: t.name,
        total: unique.length,
        analyzed: analyzed.length,
        usage: unique.length ? Math.round((analyzed.length / unique.length) * 100) : 0,
        avgRisk: avg,
      };
    }).sort((a, b) => (b.avgRisk ?? 0) - (a.avgRisk ?? 0));
  }, [teachers, assignments, analyses, rows]);

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 14 }}>Cargando datos de IA…</div>;
  }

  if (rows.length === 0 && analyses.length === 0) {
    return (
      <div style={card}>
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 34, marginBottom: 10 }}>🤖</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            Todavía no hay clases analizadas
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Las señales de riesgo aparecen cuando los profesores suben transcripciones
            desde la ficha del alumno, en Mis alumnos.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Cards de riesgo */}
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
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Alumno</th>
                  <th style={th}>Profesor</th>
                  <th style={th}>Riesgo</th>
                  <th style={th}>Última clase</th>
                  <th style={th}>Acción</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map(r => (
                  <tr key={r.profileId}>
                    <td style={{ ...td, fontWeight: 700, color: 'var(--text-primary)' }}>{r.studentName}</td>
                    <td style={td}>{r.teacherName}</td>
                    <td style={td}><RiskBadge risk={r.risk} compact /></td>
                    <td style={td}>
                      {r.lastClassAt
                        ? new Date(r.lastClassAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })
                        : '—'}
                    </td>
                    <td style={td}>
                      <button
                        onClick={() => setDetail(r.lastAnalysis)}
                        disabled={!r.lastAnalysis}
                        style={{
                          ...(r.risk === 'rojo' ? interveneBtn : detailBtn),
                          opacity: r.lastAnalysis ? 1 : 0.45,
                          cursor: r.lastAnalysis ? 'pointer' : 'not-allowed',
                        }}
                      >
                        {r.risk === 'rojo' ? '⚡ Intervenir' : '👁️ Ver detalle'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Por profesor */}
      <div style={card}>
        <div style={sectionTitle}>👨‍🏫 Uso del módulo por profesor</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Profesor</th>
                <th style={th}>Analizados</th>
                <th style={th}>% uso módulo IA</th>
                <th style={th}>Riesgo promedio</th>
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
                        <div style={{ width: `${t.usage}%`, height: '100%', background: t.usage >= 60 ? '#1E9E3A' : t.usage >= 30 ? '#FFC400' : '#ef4444' }} />
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

      {detail && <DetailModal a={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

// 1 = verde, 3 = rojo. Mostramos el valor y el color del tramo más cercano.
function AvgRisk({ value }: { value: number }) {
  const bucket: RiskSignal = value >= 2.5 ? 'rojo' : value >= 1.5 ? 'amarillo' : 'verde';
  const m = RISK_META[bucket];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, color: m.color }}>
      {m.emoji} {value.toFixed(2)}
    </span>
  );
}

function DetailModal({ a, onClose }: { a: ClassAnalysisRow; onClose: () => void }) {
  const risk = isRiskSignal(a.risk_signal) ? a.risk_signal : 'verde';
  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17, color: '#1E9E3A' }}>{a.student_name}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {a.class_number ? `Clase ${a.class_number} · ` : ''}
              {a.teacher_name ?? '—'} ·{' '}
              {new Date(a.created_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 22, cursor: 'pointer', color: '#6b7280', lineHeight: 1 }} aria-label="Cerrar">×</button>
        </div>
        <TranscriptAnalysisView
          a={{
            classSummary:    a.class_summary ?? '',
            errorsDetected:  a.errors_detected ?? '',
            progressNotes:   a.progress_notes ?? '',
            topicsCovered:   a.topics_covered ?? '',
            riskSignal:      risk,
            riskExplanation: a.risk_explanation ?? '',
            nextClassGuide:  (a.next_class_guide as never) ?? { priority: '', warmUp: '', mainFocus: '', activity: '', notes: '' },
          }}
        />
      </div>
    </div>
  );
}

const card: CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px',
};
const sectionTitle: CSSProperties = {
  fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', marginBottom: 12,
};
const table: CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontSize: 13,
};
const th: CSSProperties = {
  textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td: CSSProperties = {
  padding: '10px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', verticalAlign: 'middle',
};
const interveneBtn: CSSProperties = {
  padding: '5px 11px', borderRadius: 7, border: '1.5px solid #dc2626', background: 'rgba(239,68,68,0.1)',
  color: '#dc2626', fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap',
};
const detailBtn: CSSProperties = {
  padding: '5px 11px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-surface-3)',
  color: 'var(--text-secondary)', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
};
const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
  zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};
const modal: CSSProperties = {
  background: '#F7F7F5', border: '2px solid #1E9E3A', borderRadius: 16, padding: 24,
  width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto',
};
