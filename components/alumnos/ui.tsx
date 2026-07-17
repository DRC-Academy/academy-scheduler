'use client';

// Piezas de UI de /mis-alumnos. Diseño sobrio: sin emojis, punto de color para
// la señal de riesgo, tabs con línea verde bajo el activo.

import { useState, type CSSProperties, type ReactNode } from 'react';
import type { RiskSignal } from '@/lib/aiTypes';

export const DRC_GREEN = '#1E9E3A';
export const DRC_YELLOW = '#FFC400';

// ── Señal de riesgo: punto de color + texto ───────────────────────────────────
export const RISK_TEXT: Record<RiskSignal, { label: string; color: string }> = {
  verde:    { label: 'En seguimiento',    color: DRC_GREEN },
  amarillo: { label: 'Requiere atención', color: DRC_YELLOW },
  rojo:     { label: 'Riesgo de baja',    color: '#DC2626' },
};

export function RiskDot({ risk, showLabel = true, size = 8 }: {
  risk: RiskSignal; showLabel?: boolean; size?: number;
}) {
  const m = RISK_TEXT[risk];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
      <span style={{ width: size, height: size, borderRadius: '50%', background: m.color, flexShrink: 0 }} />
      {showLabel && <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{m.label}</span>}
    </span>
  );
}

// ── Título de sección ─────────────────────────────────────────────────────────
export function SectionLabel({ children }: { children: ReactNode }) {
  return <div style={sectionLabelStyle}>{children}</div>;
}

export const sectionLabelStyle: CSSProperties = {
  fontWeight: 600, fontSize: 14, color: 'var(--text-secondary)',
  textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12,
};

// ── Dato con etiqueta ─────────────────────────────────────────────────────────
export function DataField({ label, value }: { label: string; value?: ReactNode }) {
  if (value == null || value === '') return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={fieldLabelStyle}>{label}</div>
      <div style={bodyTextStyle}>{value}</div>
    </div>
  );
}

export const fieldLabelStyle: CSSProperties = {
  fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 3,
};
export const bodyTextStyle: CSSProperties = {
  fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
};

// ── Sección colapsable ────────────────────────────────────────────────────────
export function Collapsible({ title, meta, children, defaultOpen = false }: {
  title: string; meta?: string; children: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          gap: 10, background: 'transparent', border: 'none', padding: '12px 0',
          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          {title}
          {meta && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {meta}</span>}
        </span>
        <Chevron open={open} />
      </button>
      {open && <div style={{ padding: '0 0 14px' }}>{children}</div>}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span style={{
      color: 'var(--text-muted)', fontSize: 10, flexShrink: 0,
      transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s',
    }}>▼</span>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
export function Tabs<T extends string>({ tabs, active, onChange }: {
  tabs: ReadonlyArray<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="alu-tabs" style={{
      display: 'flex', gap: 4, borderBottom: '1px solid var(--border)',
      marginBottom: 20, overflowX: 'auto',
    }}>
      {tabs.map(t => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              padding: '9px 14px', background: 'transparent', border: 'none',
              borderBottom: `2px solid ${isActive ? DRC_GREEN : 'transparent'}`,
              marginBottom: -1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
              fontWeight: isActive ? 600 : 400,
              color: isActive ? DRC_GREEN : 'var(--text-secondary)',
              whiteSpace: 'nowrap', transition: 'color 0.12s, border-color 0.12s',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Botones ───────────────────────────────────────────────────────────────────
export const btnPrimary: CSSProperties = {
  padding: '9px 16px', borderRadius: 8, border: `1px solid ${DRC_GREEN}`,
  background: DRC_GREEN, color: 'white', cursor: 'pointer',
  fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
};
export const btnSecondary: CSSProperties = {
  padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
};

// ── Card ──────────────────────────────────────────────────────────────────────
export const cardStyle: CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 12, padding: 20,
};

// ── Avatar ────────────────────────────────────────────────────────────────────
export function Avatar({ name }: { name: string }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
  return (
    <div style={{
      width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
      background: 'rgba(30,158,58,0.12)', color: DRC_GREEN,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, fontWeight: 600,
    }}>
      {initials || '?'}
    </div>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────
export function Toast({ message }: { message: string }) {
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      background: 'var(--text-primary)', color: 'var(--bg-surface)',
      padding: '11px 20px', borderRadius: 8, fontSize: 13, fontWeight: 500,
      zIndex: 200, boxShadow: '0 6px 20px rgba(0,0,0,0.18)', maxWidth: 'calc(100vw - 32px)',
    }}>
      {message}
    </div>
  );
}

// ── Fechas ────────────────────────────────────────────────────────────────────
export function relativeDays(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return 'hoy';
  if (d === 1) return 'ayer';
  if (d < 30) return `hace ${d} días`;
  const m = Math.floor(d / 30);
  return m === 1 ? 'hace 1 mes' : `hace ${m} meses`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Estilos responsive de la página ───────────────────────────────────────────
export const PAGE_CSS = `
.alu-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.alu-tabs::-webkit-scrollbar { height: 0; }
@media (max-width: 767px) {
  .alu-two-col { grid-template-columns: 1fr; gap: 0; }
  .alu-btn-row { flex-direction: column; align-items: stretch; }
  .alu-btn-row > button { width: 100%; }
  .alu-card-head { flex-wrap: wrap; }
}
`;
