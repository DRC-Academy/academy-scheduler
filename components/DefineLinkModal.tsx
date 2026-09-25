'use client';
// ── Modal "Definir enlace" (enlace de Meet de la clase de un alumno) ──────────
// Fuente ÚNICA del modal para definir o cambiar el enlace de la clase. Lo abren:
//   · "🔗 Definir enlace" y el menú de cada tarjeta en Mis clases;
//   · "Ingresar a clase" cuando el alumno aún no tiene enlace (components/JoinClass);
//   · la pestaña Avisos del Calendario y el pop-up del NavBar (MeetLinkReminder).
//
// Sustituye al antiguo "Email de presentación" (Fase 2, sep/2026): el profesor ya
// no escribe al alumno, la plataforma le manda la bienvenida sola
// (lib/welcomeEmailSend). Lo único que le toca es dejar aquí su enlace.
//
// El enlace se guarda con la ruta PUT /api/assignments/[assignmentId]/meet-link
// (vía updateMeetLink), que lo valida y, si el profesor pega la invitación
// entera de Zoom o de Meet, se queda solo con el enlace (lib/meetLink). Si no se
// puede guardar, el motivo se muestra aquí y el modal sigue abierto.
import { useState, type CSSProperties } from 'react';
import { ANCLA_MODAL_ENLACE } from '@/lib/onboarding';
import type { Assignment } from '@/types';

export function DefineLinkModal({ assignment, updateMeetLink, onClose, onSaved }: {
  assignment: Assignment;
  updateMeetLink: (assignmentId: string, link: string) => Promise<void>;
  onClose: () => void;
  /** Tras guardar bien (el modal se cierra solo). */
  onSaved?: () => void;
}) {
  const [value, setValue] = useState(assignment.meetLink ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hadLink = Boolean(assignment.meetLink);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateMeetLink(assignment.id, value);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el enlace. Inténtalo de nuevo.');
      setSaving(false);
    }
  }

  const disabled = saving || !value.trim();
  const input: CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${error ? '#ef4444' : '#d1d5db'}`,
    background: 'white', color: '#111827', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box',
  };

  return (
    // `drc-modal-*`: el z-index y los pointer-events viven en globals.css, en el
    // bloque que documenta el orden de capas frente al tutorial (el modal tiene
    // que quedar POR ENCIMA del overlay de driver.js).
    <div className="drc-modal-backdrop"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="drc-modal" role="dialog" aria-modal="true" aria-label={hadLink ? 'Cambiar enlace' : 'Definir enlace'}
        data-onboarding={ANCLA_MODAL_ENLACE}
        style={{ background: '#F7F7F5', border: '2px solid #1E9E3A', borderRadius: 16, padding: 24, width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontWeight: 800, fontSize: 17, color: '#1E9E3A', marginBottom: 6 }}>
          🔗 {hadLink ? 'Cambiar enlace' : 'Definir enlace'} · {assignment.studentName}
        </div>
        <div style={{ height: 3, width: 48, background: '#FFC400', borderRadius: 2, marginBottom: 16 }} />

        <label htmlFor="define-link-input" style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>
          Enlace de tu sala de Meet
        </label>
        <input id="define-link-input" value={value} autoFocus
          onChange={e => { setValue(e.target.value); setError(null); }}
          onKeyDown={e => { if (e.key === 'Enter' && !disabled) void save(); }}
          placeholder="https://meet.google.com/abc-defg-hij" style={input} />
        {error ? (
          <div role="alert" style={{ fontSize: 12.5, color: '#b42318', marginTop: 6, lineHeight: 1.45 }}>{error}</div>
        ) : (
          <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 6, lineHeight: 1.5 }}>
            Puedes pegar también la invitación entera: nos quedamos solo con el enlace. Se usará siempre
            para {assignment.studentName} y en tu botón «Ingresar a clase».
          </div>
        )}

        <div style={{ fontSize: 12.5, color: '#374151', background: 'rgba(30,158,58,0.08)', border: '1px solid rgba(30,158,58,0.25)', borderRadius: 10, padding: '10px 12px', margin: '16px 0 18px', lineHeight: 1.5 }}>
          El alumno recibe automáticamente las instrucciones para acceder a la plataforma. Tu enlace aparecerá en su área de alumno.
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={onClose} disabled={saving}
            style={{ flex: '1 1 90px', padding: '11px', borderRadius: 8, border: '1px solid #d1d5db', background: 'white', color: '#6b7280', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
            Cancelar
          </button>
          <button onClick={() => void save()} disabled={disabled}
            style={{ flex: '2 1 160px', padding: '11px', borderRadius: 8, border: 'none', background: disabled ? '#d1d5db' : '#1E9E3A', color: 'white', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 800, fontFamily: 'inherit' }}>
            {saving ? 'Guardando…' : 'Guardar enlace'}
          </button>
        </div>
      </div>
    </div>
  );
}
