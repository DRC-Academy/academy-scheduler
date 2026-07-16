'use client';

// Piezas de presentación compartidas del módulo de IA.
// Sin lógica de datos: reciben props y pintan. Branding DRC.

import { useState, type CSSProperties } from 'react';
import {
  RISK_META, asObject, isRiskSignal,
  type ClassAnalysisRow, type FichaIA, type NextClassIA, type TranscriptIA, type RiskSignal,
} from '@/lib/aiTypes';

export const DRC = {
  green: '#1E9E3A',
  greenDark: '#167a2d',
  yellow: '#FFC400',
  bg: '#F7F7F5',
  font: "'Radio Canada', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

// ── Bloque etiqueta + texto ───────────────────────────────────────────────────
export function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value?.trim()) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11.5, fontWeight: 800, color: DRC.green, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{value}</div>
    </div>
  );
}

export const panelBox: CSSProperties = {
  background: 'white', border: '1px solid #d1d5db', borderRadius: 10, padding: '14px 16px',
};

// ── Badge de riesgo ───────────────────────────────────────────────────────────
export function RiskBadge({ risk, compact }: { risk: RiskSignal; compact?: boolean }) {
  const m = RISK_META[risk];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: compact ? '2px 8px' : '3px 10px', borderRadius: 10,
      fontSize: compact ? 10.5 : 11.5, fontWeight: 700, whiteSpace: 'nowrap',
      background: m.bg, border: `1px solid ${m.border}`, color: m.color,
    }}>
      {m.emoji} {m.label}
    </span>
  );
}

// ═══ SECCIÓN A — Perfil del alumno ════════════════════════════════════════════
const PROFILE_CARDS: Array<{ icon: string; label: string; key: keyof FichaIA; wide?: boolean }> = [
  { icon: '🎯', label: 'Objetivo',             key: 'personalObjective' },
  { icon: '💼', label: 'Perfil',               key: 'occupation' },
  { icon: '🧠', label: 'Estilo de aprendizaje', key: 'learningStyle' },
  { icon: '✅', label: 'Puntos fuertes',        key: 'strongPoints' },
  { icon: '⚠️', label: 'Áreas a trabajar',      key: 'weakPoints' },
  { icon: '🔍', label: 'Diagnóstico inicial',   key: 'initialDiagnosis', wide: true },
  { icon: '📚', label: 'Foco recomendado',      key: 'recommendedFocus', wide: true },
];

export function ProfileCards({ ficha }: { ficha: FichaIA }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
      {PROFILE_CARDS.map(c => {
        const value = ficha[c.key];
        if (!value?.trim()) return null;
        return (
          <div key={c.key} style={{ ...panelBox, gridColumn: c.wide ? '1 / -1' : undefined, padding: '13px 15px' }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: DRC.green, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>
              {c.icon} {c.label}
            </div>
            <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{value}</div>
          </div>
        );
      })}
    </div>
  );
}

// ═══ SECCIÓN B — Resumen de estado ════════════════════════════════════════════
export function StatusSummary({
  totalClasses, lastClassAt, progressScore, risk, nextClass,
}: {
  totalClasses: number;
  lastClassAt: string | null;
  progressScore: number;
  risk: RiskSignal | null;
  nextClass: NextClassIA | null;
}) {
  return (
    <div style={{ ...panelBox, padding: '16px 18px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14, alignItems: 'start' }}>
        <Stat label="Clases analizadas" value={String(totalClasses)} />
        <Stat label="Última clase" value={lastClassAt ? relativeDays(lastClassAt) : '—'} />
        <div>
          <div style={statLabel}>Progreso general</div>
          <ProgressBar score={progressScore} />
        </div>
        <div>
          <div style={statLabel}>Señal de riesgo</div>
          {risk ? <RiskBadge risk={risk} /> : <span style={{ fontSize: 13, color: '#9ca3af' }}>Sin analizar</span>}
        </div>
      </div>
      {nextClass && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #e5e7eb' }}>
          <div style={statLabel}>Última clase preparada</div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111827' }}>
            Clase {nextClass.classNumber} — {nextClass.classTitle}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={statLabel}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: '#111827', lineHeight: 1.2 }}>{value}</div>
    </div>
  );
}

const statLabel: CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: 5,
};

export function ProgressBar({ score }: { score: number }) {
  const s = Math.min(10, Math.max(1, score || 5));
  const color = s >= 7 ? DRC.green : s >= 4 ? DRC.yellow : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <div style={{ flex: 1, minWidth: 60, height: 9, borderRadius: 5, background: '#e5e7eb', overflow: 'hidden' }}>
        <div style={{ width: `${s * 10}%`, height: '100%', background: color, borderRadius: 5, transition: 'width 0.4s ease' }} />
      </div>
      <span style={{ fontSize: 13.5, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>{s}/10</span>
    </div>
  );
}

export function relativeDays(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'hoy';
  if (days === 1) return 'ayer';
  return `hace ${days} días`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ═══ SECCIÓN B — Línea de tiempo de clases ════════════════════════════════════
export function ClassTimeline({ rows }: { rows: ClassAnalysisRow[] }) {
  if (rows.length === 0) {
    return (
      <div style={{ ...panelBox, textAlign: 'center', padding: '22px 16px', color: '#6b7280', fontSize: 13 }}>
        Todavía no hay clases analizadas. Usa “➕ Registrar clase dada” después de dar una clase.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map(r => <TimelineRow key={r.id} row={r} />)}
    </div>
  );
}

function TimelineRow({ row }: { row: ClassAnalysisRow }) {
  const [open, setOpen] = useState(false);
  const risk = isRiskSignal(row.risk_signal) ? row.risk_signal : null;
  const when = row.class_date ?? row.analyzed_at;
  const guide = asObject(row.next_class_guide);

  return (
    <div style={{ ...panelBox, padding: 0, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
          padding: '12px 14px', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 800, color: '#111827' }}>
            {row.class_number != null ? `Clase ${row.class_number}` : 'Clase'}
            {when && <span style={{ fontWeight: 500, color: '#6b7280' }}> — {formatDate(when)}</span>}
          </span>
          {risk && <RiskBadge risk={risk} compact />}
        </div>
        {row.class_title && (
          <div style={{ fontSize: 13, color: '#4b5563', marginTop: 3, fontStyle: 'italic' }}>“{row.class_title}”</div>
        )}
        <div style={{ fontSize: 11.5, color: DRC.green, fontWeight: 700, marginTop: 6 }}>
          {open ? '▲ Ocultar resumen' : '▼ Ver resumen'}
        </div>
      </button>

      {open && (
        <div style={{ padding: '2px 14px 14px', borderTop: '1px dashed #e5e7eb' }}>
          <div style={{ height: 10 }} />
          <Field label="Resumen de lo que se trabajó" value={row.class_summary} />
          <Field label="Errores detectados" value={row.errors_detected} />
          <Field label="Progreso respecto a la anterior" value={row.progress_notes} />
          <Field label="Contenidos" value={row.topics_covered} />
          {row.risk_explanation && <Field label="Motivo de la señal de riesgo" value={row.risk_explanation} />}
          {guide && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed #e5e7eb' }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: '#111827', marginBottom: 8 }}>
                🎯 Guía que se generó para la siguiente clase
              </div>
              <Field label="Prioridad" value={guide.priority} />
              <Field label="Warm-up" value={guide.warmUp} />
              <Field label="Foco principal" value={guide.mainFocus} />
              <Field label="Actividad" value={guide.activity} />
              <Field label="Notas" value={guide.notes} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Análisis de una clase (resultado del paso 3) ───────────────────────────────
export function TranscriptAnalysisView({ a }: { a: TranscriptIA }) {
  const risk = isRiskSignal(a.riskSignal) ? a.riskSignal : 'verde';
  const m = RISK_META[risk];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Section icon="📊" title="Resumen de la clase"><Body text={a.classSummary} /></Section>
      <Section icon="📝" title="Errores y patrones detectados"><Body text={a.errorsDetected} /></Section>
      <Section icon="📈" title="Progreso">
        <Body text={a.progressNotes} />
        <div style={{ marginTop: 10 }}><ProgressBar score={a.progressScore} /></div>
      </Section>
      <Section icon="🚦" title={`Señal de riesgo: ${m.emoji} ${m.label}`}>
        <div style={{ padding: '10px 12px', borderRadius: 8, background: m.bg, border: `1px solid ${m.border}`, fontSize: 13, color: m.color, lineHeight: 1.55 }}>
          {a.riskExplanation}
        </div>
      </Section>
      <Section icon="✨" title="Guía para la siguiente clase" defaultOpen>
        <Field label="Prioridad" value={a.nextClassGuide?.priority} />
        <Field label="Warm-up" value={a.nextClassGuide?.warmUp} />
        <Field label="Foco principal" value={a.nextClassGuide?.mainFocus} />
        <Field label="Actividad" value={a.nextClassGuide?.activity} />
        <Field label="Notas" value={a.nextClassGuide?.notes} />
      </Section>
    </div>
  );
}

function Body({ text }: { text?: string | null }) {
  if (!text?.trim()) return <div style={{ fontSize: 13, color: '#9ca3af' }}>—</div>;
  return <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{text}</div>;
}

export function Section({ icon, title, children, defaultOpen = true }: {
  icon: string; title: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ ...panelBox, padding: 0, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: 'transparent', border: 'none', padding: '11px 14px', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 13, fontWeight: 800, color: '#111827', textAlign: 'left',
        }}
      >
        <span>{icon} {title}</span>
        <span style={{ color: DRC.green, fontSize: 11 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && <div style={{ padding: '0 14px 14px' }}>{children}</div>}
    </div>
  );
}

// ── Clase generada ────────────────────────────────────────────────────────────
export function NextClassView({ nc }: { nc: NextClassIA }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {nc.objectives?.length > 0 && (
        <Section icon="🎯" title="Objetivos">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: '#374151', lineHeight: 1.6 }}>
            {nc.objectives.map((o, i) => <li key={i}>{o}</li>)}
          </ul>
        </Section>
      )}
      <BlockSection icon="🔥" block={nc.warmUp} fallback="Warm-up" />
      <BlockSection icon="📚" block={nc.mainContent} fallback="Contenido principal" />
      <BlockSection icon="✍️" block={nc.practiceActivity} fallback="Práctica" />
      <BlockSection icon="🎯" block={nc.closing} fallback="Cierre" />
      <Section icon="📌" title="Notas para el profesor">
        <div style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(255,196,0,0.12)', border: '1px solid rgba(255,196,0,0.4)', fontSize: 13, color: '#78350f', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
          {nc.teacherNotes}
        </div>
        {nc.connectionToPrevious && (
          <div style={{ marginTop: 10 }}>
            <Field label="Conexión con la clase anterior" value={nc.connectionToPrevious} />
          </div>
        )}
      </Section>
    </div>
  );
}

function BlockSection({ icon, block, fallback }: { icon: string; block?: { title: string; duration: string; content: string }; fallback: string }) {
  if (!block) return null;
  return (
    <Section icon={icon} title={`${block.title || fallback}${block.duration ? ` (${block.duration})` : ''}`}>
      <Body text={block.content} />
    </Section>
  );
}

/** Texto plano de la clase, para copiar al portapapeles. */
export function nextClassToText(nc: NextClassIA, studentName: string): string {
  const block = (icon: string, b?: { title: string; duration: string; content: string }) =>
    b ? `\n${icon} ${b.title.toUpperCase()}${b.duration ? ` (${b.duration})` : ''}\n${'-'.repeat(50)}\n${b.content}\n` : '';

  return [
    `${nc.classTitle}`,
    `Clase ${nc.classNumber} — ${studentName}${nc.duration ? ` · ${nc.duration}` : ''}`,
    '='.repeat(50),
    nc.objectives?.length ? `\n🎯 OBJETIVOS\n${nc.objectives.map(o => `  • ${o}`).join('\n')}\n` : '',
    block('🔥', nc.warmUp),
    block('📚', nc.mainContent),
    block('✍️', nc.practiceActivity),
    block('🎯', nc.closing),
    `\n📌 NOTAS PARA EL PROFESOR\n${'-'.repeat(50)}\n${nc.teacherNotes}`,
    nc.connectionToPrevious ? `\n🔗 CONEXIÓN CON LA CLASE ANTERIOR\n${nc.connectionToPrevious}` : '',
  ].filter(Boolean).join('\n');
}

// ── Ficha en markdown (formato anterior) ──────────────────────────────────────
export function FichaMarkdown({ text }: { text: string }) {
  return (
    <div style={panelBox}>
      {text.split('\n').map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return <div key={i} style={{ height: 8 }} />;
        if (line.startsWith('## ')) return <div key={i} style={{ fontSize: 15, fontWeight: 800, color: DRC.green, margin: '10px 0 6px' }}>{line.slice(3)}</div>;
        if (line.startsWith('# ')) return <div key={i} style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: '10px 0 6px' }}>{line.slice(2)}</div>;
        if (/^\s*[-*]\s+/.test(line)) {
          return (
            <div key={i} style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.5, paddingLeft: 14, position: 'relative' }}>
              <span style={{ position: 'absolute', left: 0, color: DRC.green }}>•</span>{line.replace(/^\s*[-*]\s+/, '')}
            </div>
          );
        }
        return <div key={i} style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.5, margin: '2px 0' }}>{line}</div>;
      })}
    </div>
  );
}
