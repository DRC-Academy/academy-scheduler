'use client';

// Piezas de presentación compartidas del módulo de IA: ficha estructurada,
// primera clase, análisis de transcripción y badge de riesgo.
// Sin lógica de datos: sólo recibe props y pinta.

import type { CSSProperties } from 'react';
import { RISK_META, type FichaIA, type FirstClassIA, type TranscriptIA, type RiskSignal } from '@/lib/aiTypes';

// ── Bloque etiqueta + texto ───────────────────────────────────────────────────
export function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value?.trim()) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11.5, fontWeight: 800, color: '#1E9E3A', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
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

// ── Ficha estructurada (8 campos) ─────────────────────────────────────────────
export function FichaFields({ ficha }: { ficha: FichaIA }) {
  return (
    <div style={panelBox}>
      <Field label="Diagnóstico inicial" value={ficha.initialDiagnosis} />
      <Field label="Puntos fuertes" value={ficha.strongPoints} />
      <Field label="Áreas a trabajar" value={ficha.weakPoints} />
      <Field label="Estilo de aprendizaje" value={ficha.learningStyle} />
      <Field label="Objetivo personal" value={ficha.personalObjective} />
      <Field label="Ocupación / contexto" value={ficha.occupation} />
      <Field label="Foco recomendado" value={ficha.recommendedFocus} />
    </div>
  );
}

// ── Primera clase ─────────────────────────────────────────────────────────────
export function FirstClassView({ fc }: { fc: FirstClassIA }) {
  return (
    <div style={panelBox}>
      <div style={{ fontSize: 16, fontWeight: 800, color: '#111827', marginBottom: 2 }}>{fc.classTitle}</div>
      {fc.duration && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>⏱ {fc.duration}</div>}
      <Field label="Warm-up" value={fc.warmUp} />
      <Field label="Contenido principal" value={fc.mainContent} />
      <Field label="Práctica" value={fc.practiceActivity} />
      <Field label="Cierre / tarea" value={fc.closingTask} />
      <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, background: 'rgba(255,196,0,0.12)', border: '1px solid rgba(255,196,0,0.4)' }}>
        <div style={{ fontSize: 11.5, fontWeight: 800, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
          Notas para el profesor
        </div>
        <div style={{ fontSize: 13, color: '#78350f', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{fc.teacherNotes}</div>
      </div>
    </div>
  );
}

// ── Análisis de una clase ─────────────────────────────────────────────────────
export function TranscriptAnalysisView({ a }: { a: TranscriptIA }) {
  const m = RISK_META[a.riskSignal] ?? RISK_META.verde;
  return (
    <div style={panelBox}>
      <div style={{ marginBottom: 12 }}><RiskBadge risk={a.riskSignal} /></div>
      <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 8, background: m.bg, border: `1px solid ${m.border}`, fontSize: 13, color: m.color, lineHeight: 1.55 }}>
        {a.riskExplanation}
      </div>
      <Field label="Resumen de la clase" value={a.classSummary} />
      <Field label="Errores detectados" value={a.errorsDetected} />
      <Field label="Progreso" value={a.progressNotes} />
      <Field label="Contenidos trabajados" value={a.topicsCovered} />

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px dashed #d1d5db' }}>
        <div style={{ fontSize: 13.5, fontWeight: 800, color: '#111827', marginBottom: 10 }}>🎯 Guía para la siguiente clase</div>
        <Field label="Prioridad" value={a.nextClassGuide?.priority} />
        <Field label="Warm-up" value={a.nextClassGuide?.warmUp} />
        <Field label="Foco principal" value={a.nextClassGuide?.mainFocus} />
        <Field label="Actividad" value={a.nextClassGuide?.activity} />
        <Field label="Notas" value={a.nextClassGuide?.notes} />
      </div>
    </div>
  );
}

// ── Ficha en markdown (formato anterior — fichas ya generadas) ────────────────
export function FichaMarkdown({ text }: { text: string }) {
  return (
    <div style={panelBox}>
      {text.split('\n').map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return <div key={i} style={{ height: 8 }} />;
        if (line.startsWith('## ')) {
          return <div key={i} style={{ fontSize: 15, fontWeight: 800, color: '#1E9E3A', margin: '10px 0 6px' }}>{line.slice(3)}</div>;
        }
        if (line.startsWith('# ')) {
          return <div key={i} style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: '10px 0 6px' }}>{line.slice(2)}</div>;
        }
        if (/^\s*[-*]\s+/.test(line)) {
          return (
            <div key={i} style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.5, paddingLeft: 14, position: 'relative' }}>
              <span style={{ position: 'absolute', left: 0, color: '#1E9E3A' }}>•</span>{line.replace(/^\s*[-*]\s+/, '')}
            </div>
          );
        }
        return <div key={i} style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.5, margin: '2px 0' }}>{line}</div>;
      })}
    </div>
  );
}
