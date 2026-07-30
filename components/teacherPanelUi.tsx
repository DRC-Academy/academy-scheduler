'use client';
// ── Piezas compartidas del panel del profesor ─────────────────────────────────
// Helpers y badges que usan TANTO el Calendario (/teacher, pestaña Avisos) como
// el panel "Mis clases" (/clases). Vivían dentro de app/teacher/page.tsx cuando
// "Mis clases" era una pestaña de esa misma página; al pasar a ruta propia se
// sacaron acá para no duplicarlos.

import { useState, useEffect, type CSSProperties } from 'react';
import { getPresentationEmailStatus } from '@/lib/presentationEmailUtils';
import type { Assignment } from '@/types';

export function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function fmtDateDMY(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// El estado de suscripción se verifica con la fuente única de verdad
// (lib/useSubscriptionStatus.ts): mismo endpoint, misma interpretación y mismo
// cache compartido que el panel "Alumnos". Ver checkSubscription / subBadge.
//
// El flujo completo de "Ingresar a clase" (enlace de Meet → disclaimer de hito →
// verificación de suscripción → registro del acceso) vive en components/JoinClass:
// es lo que decide si la clase cuenta para el pago, así que no puede estar
// implementado dos veces. La vista semanal /clases usa el mismo hook.

// ─── Email de presentación (nuevo alumno) ─────────────────────────────────────
// El modal y el armado del cuerpo del email viven en components/PresentationModal
// (fuente única, reutilizada por el popup recordatorio del NavBar).

// Marca en localStorage qué presentaciones ya se enviaron (por alumno) para el
// badge "Presentación enviada" y el estado del botón (Enviar / Reenviar).
export function usePresentationSent(teacherId: string) {
  const [sent, setSent] = useState<Set<string>>(new Set());
  // localStorage no está disponible en SSR: se lee tras montar (sync desde un
  // sistema externo, patrón usado en el resto del archivo).
  useEffect(() => {
    try {
      const prefix = `presentation_sent_${teacherId}_`;
      const found = new Set<string>();
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix) && localStorage.getItem(k) === '1') found.add(k.slice(prefix.length));
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSent(found);
    } catch {}
  }, [teacherId]);
  const markSent = (studentName: string) => {
    try { localStorage.setItem(`presentation_sent_${teacherId}_${studentName}`, '1'); } catch {}
    setSent(prev => new Set(prev).add(studentName));
  };
  return { isSent: (name: string) => sent.has(name), markSent };
}

// Estilo del botón "Enviar/Reenviar presentación" (verde si nuevo, gris si ya se envió).
export function presentationBtnStyle(sent: boolean): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8,
    padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit',
  };
  return sent
    ? { ...base, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-muted)', fontWeight: 600 }
    : { ...base, border: 'none', background: '#1E9E3A', color: 'white', fontWeight: 700 };
}

// Convierte un color hex (#RRGGBB) en rgba con la opacidad dada.
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g2 = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g2}, ${b}, ${alpha})`;
}

// Badge dinámico del seguimiento del email de presentación. Se actualiza solo
// cada minuto (reloj propio) y toma TODO el estado visual de la fuente única
// lib/presentationEmailUtils.getPresentationEmailStatus.
export function PresentationEmailBadge({ assignment }: { assignment: Assignment }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  // Antes del montaje usamos createdAt como referencia estable (evita el desajuste
  // de hidratación de usar Date.now() en el render del servidor).
  const st = getPresentationEmailStatus(assignment, now ?? new Date(assignment.createdAt).getTime());
  const animClass = st.pulse ? 'pres-email-badge-pulse' : st.blink ? 'pres-email-badge-blink' : '';
  const textColor = st.badgeColor === '#FFC400' ? '#8a6d00' : st.badgeColor;

  return (
    <div style={{ marginTop: 8 }}>
      <span
        className={animClass}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 700,
          color: textColor,
          background: hexToRgba(st.badgeColor, 0.12),
          border: `1.5px solid ${hexToRgba(st.badgeColor, 0.42)}`,
        }}
      >
        {st.badgeText}
      </span>
      {st.subtextMessage && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45, maxWidth: 340 }}>
          {st.subtextMessage}
        </div>
      )}
    </div>
  );
}
