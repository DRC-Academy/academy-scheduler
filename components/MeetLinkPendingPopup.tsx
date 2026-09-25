'use client';
// ── Pop-up de enlaces de clase pendientes de definir ──────────────────────────
// Se muestra al profesor (desde el NavBar, components/MeetLinkReminder) cuando
// tiene alumnos sin el enlace de Meet definido. Toma TODO el estado visual
// (color, horas, umbrales) de la fuente única lib/meetLinkStatus, igual que el
// badge de Mis clases y de Avisos, para no divergir.
//
// Hasta sep/2026 era el recordatorio del email de presentación: desde la Fase 2
// ese email lo manda la plataforma y al profesor solo le queda el enlace.
//
// El modal NO se cierra al hacer clic fuera: solo con sus botones.
import { useState, useEffect } from 'react';
import type { Assignment } from '@/types';
import {
  getMeetLinkStatus,
  formatElapsed,
  isMeetLinkDefined,
  LINK_DEADLINE_HOURS,
  type MeetLinkStatus,
} from '@/lib/meetLinkStatus';

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// "hace 3 días" cuando ya pasó de las 24 h; "hace 5h 20min" en las primeras horas.
function formatAgo(hours: number, minutes: number): string {
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `Asignado hace ${days} día${days === 1 ? '' : 's'}`;
  }
  return `Asignado hace ${formatElapsed(hours, minutes)}`;
}

// Etiqueta corta del badge del popup según la urgencia (derivada del status de la
// fuente única). Verde/amarillo/naranja/rojo se mantienen fieles al branding DRC.
function shortBadge(st: MeetLinkStatus): { text: string; color: string } {
  switch (st.status) {
    case 'on_time': return { text: 'Reciente', color: '#1E9E3A' };
    case 'warning': return { text: 'Pendiente', color: '#FFC400' };
    case 'at_risk': {
      const remaining = Math.max(1, LINK_DEADLINE_HOURS - st.hoursElapsed);
      return { text: `Urgente — quedan ${remaining}h`, color: '#f97316' };
    }
    case 'overdue': return { text: 'Fuera de plazo', color: '#ef4444' };
    default: return { text: 'Pendiente', color: '#FFC400' };
  }
}

export function MeetLinkPendingPopup({ assignments, onDefine, onRemindLater }: {
  assignments: Assignment[];             // asignaciones sin enlace definido
  onDefine: (assignment: Assignment) => void;
  onRemindLater: () => void;
}) {
  // Reloj propio (cada minuto) para que las horas/badges se recalculen en vivo.
  // Antes del montaje usamos null → el status cae a createdAt como referencia
  // estable (evita desajuste de hidratación con Date.now() en el servidor).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  const pending = assignments.filter(a => !isMeetLinkDefined(a));
  if (pending.length === 0) return null;

  // Ordenados por urgencia: los más antiguos (más horas transcurridas) primero.
  const rows = pending
    .map(a => ({ a, st: getMeetLinkStatus(a, now ?? new Date(a.createdAt).getTime()) }))
    .sort((x, y) => new Date(x.a.createdAt).getTime() - new Date(y.a.createdAt).getTime());

  return (
    // `drc-modal-*`: el z-index sale de la escala documentada en globals.css
    // ("ORDEN DE CAPAS DEL TUTORIAL"). Con el 100 que tenía en línea, este aviso
    // quedaba POR DEBAJO del overlay del tutorial (10000): salía atenuado y sin
    // responder al ratón, y el profesor no podía ni cerrarlo ni entender por qué.
    <div
      className="drc-modal-backdrop"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      role="dialog"
      aria-modal="true"
      aria-label="Enlaces pendientes de definir"
    >
      <div className="drc-modal" style={{ background: '#F7F7F5', border: '2px solid #1E9E3A', borderRadius: 16, padding: 24, width: '90%', maxWidth: 540, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
        {/* Encabezado */}
        <div style={{ fontWeight: 800, fontSize: 18, color: '#1E9E3A', marginBottom: 6 }}>
          🔗 Enlaces pendientes de definir
        </div>
        <div style={{ height: 3, width: 48, background: '#FFC400', borderRadius: 2, marginBottom: 14 }} />
        <div style={{ fontSize: 13, color: '#4b5563', lineHeight: 1.5, marginBottom: 18 }}>
          Define el enlace de Meet de tus nuevos alumnos. Ellos reciben automáticamente las instrucciones para acceder a la plataforma; con tu enlace tendrán el botón para unirse a la clase.
        </div>

        {/* Lista de alumnos pendientes (scroll interno si hay muchos) */}
        <div style={{ overflowY: 'auto', flex: '1 1 auto', margin: '0 -4px', padding: '0 4px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(({ a, st }) => {
            const badge = shortBadge(st);
            const textColor = badge.color === '#FFC400' ? '#8a6d00' : badge.color;
            return (
              <div
                key={a.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                  padding: '12px 14px', borderRadius: 12, background: 'white',
                  border: `1.5px solid ${hexToRgba(badge.color, 0.42)}`,
                }}
              >
                <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.studentName}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                    {formatAgo(st.hoursElapsed, st.minutesElapsed)}
                  </div>
                  <span
                    style={{
                      display: 'inline-block', marginTop: 6, padding: '3px 10px', borderRadius: 999,
                      fontSize: 11.5, fontWeight: 700, color: textColor,
                      background: hexToRgba(badge.color, 0.12),
                      border: `1px solid ${hexToRgba(badge.color, 0.42)}`,
                    }}
                  >
                    {badge.text}
                  </span>
                </div>
                <button
                  onClick={() => onDefine(a)}
                  style={{
                    flex: '0 0 auto', minHeight: 44, padding: '10px 16px', borderRadius: 8,
                    border: 'none', background: '#1E9E3A', color: 'white', cursor: 'pointer',
                    fontSize: 13, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap',
                  }}
                >
                  Definir ahora
                </button>
              </div>
            );
          })}
        </div>

        {/* Botón inferior secundario */}
        <div style={{ marginTop: 18, display: 'flex' }}>
          <button
            onClick={onRemindLater}
            style={{
              flex: 1, minHeight: 44, padding: '11px', borderRadius: 8,
              border: '1px solid #d1d5db', background: 'white', color: '#6b7280',
              cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
            }}
          >
            Recordármelo más tarde
          </button>
        </div>
      </div>
    </div>
  );
}
