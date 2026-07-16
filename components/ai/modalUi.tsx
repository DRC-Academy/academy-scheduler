'use client';

// Chrome compartido de los modales del módulo de IA (branding DRC).

import type { CSSProperties, ReactNode } from 'react';
import { DRC } from '@/components/ai/FichaView';

export function Modal({ children, onClose, maxWidth = 680, locked }: {
  children: ReactNode; onClose: () => void; maxWidth?: number; locked?: boolean;
}) {
  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <div style={{ ...modalBox, maxWidth }}>{children}</div>
    </div>
  );
}

export function ModalHeader({ title, subtitle, onClose, locked }: {
  title: string; subtitle?: string; onClose: () => void; locked?: boolean;
}) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 17, color: DRC.green }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12.5, color: '#6b7280', marginTop: 3 }}>{subtitle}</div>}
        </div>
        <button onClick={onClose} disabled={locked} style={closeBtn} aria-label="Cerrar">×</button>
      </div>
      <div style={{ height: 3, width: 48, background: DRC.yellow, borderRadius: 2, margin: '10px 0 16px' }} />
    </>
  );
}

export const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
  zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  fontFamily: DRC.font,
};
export const modalBox: CSSProperties = {
  background: DRC.bg, border: `2px solid ${DRC.green}`, borderRadius: 16, padding: 24,
  width: '100%', maxHeight: '90vh', overflowY: 'auto',
};
export const closeBtn: CSSProperties = {
  border: 'none', background: 'transparent', fontSize: 22, cursor: 'pointer', color: '#6b7280', lineHeight: 1,
};
export const primaryBtn: CSSProperties = {
  padding: '9px 17px', borderRadius: 9, border: `1.5px solid ${DRC.green}`, background: DRC.green,
  color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
};
export const ghostBtn: CSSProperties = {
  padding: '9px 15px', borderRadius: 9, border: '1.5px solid #d1d5db', background: 'white',
  color: '#4b5563', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
};
export const outlineBtn: CSSProperties = {
  padding: '8px 14px', borderRadius: 8, border: `1.5px solid ${DRC.green}`, background: 'white',
  color: DRC.green, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
};
export const errBox: CSSProperties = {
  padding: '11px 14px', borderRadius: 9, background: 'rgba(192,57,43,0.08)',
  border: '1px solid rgba(192,57,43,0.35)', color: '#C0392B', fontSize: 13, fontWeight: 600,
};
export const okBox: CSSProperties = {
  padding: '11px 14px', borderRadius: 9, background: 'rgba(30,158,58,0.1)',
  border: `1px solid ${DRC.green}55`, color: '#166534', fontSize: 13, fontWeight: 600,
};
export const inputStyle: CSSProperties = {
  width: '100%', borderRadius: 9, border: '1.5px solid #d1d5db', padding: '9px 12px',
  fontFamily: 'inherit', fontSize: 14, color: '#111827', background: 'white',
};
export const labelStyle: CSSProperties = {
  fontSize: 11.5, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: 5, display: 'block',
};
