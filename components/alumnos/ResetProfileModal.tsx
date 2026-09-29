'use client';

// "Reiniciar perfil de IA" de un alumno: rehace SOLO la parte de la IA (ficha de
// la IA e informes de clase) con las respuestas del formulario ya guardadas. No
// le pide nada al alumno ni toca el nivel ni el formulario. Para que el alumno
// repita formulario y prueba está "Regenerar todo" (otro botón, otro uso).
//
// Lo que NO toca: el transcript de cada clase, su fecha y su profesor. Son el
// segundo factor de verificación de finanzas — borrarlos dejaría clases ya dadas
// sin pagar. El endpoint /api/students/reset-profile solo limpia los campos de
// análisis de esas filas.

import { useState } from 'react';
import { btnSecondary } from '@/components/alumnos/ui';

export interface ResetProfileResult {
  profilesCleared: number;
  analysesCleared: number;
  /** true si se está rehaciendo la ficha de la IA con las respuestas guardadas. */
  fichaRegenerating: boolean;
}

/** Una frase para el botón y el menú: qué hace, sin confundirlo con "Regenerar todo". */
export const RESET_PROFILE_HINT = 'Rehace la ficha de la IA y los informes de clase con las respuestas ya guardadas. No le pide nada al alumno.';

export default function ResetProfileModal({ payload, onClose, onDone }: {
  payload: {
    studentId?: string | null;
    studentName: string;
    studentEmail?: string | null;
    teacherId: string;
    teacherName: string;
    assignmentId?: string | null;
    plan?: string | null;
    level?: string | null;
  };
  onClose: () => void;
  onDone: (r: ResetProfileResult) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/students/reset-profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const raw = await res.text();
      let data: Record<string, unknown> = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { /* respuesta sin JSON */ }
      if (!res.ok) {
        console.error('[reiniciar perfil] Respuesta', res.status, raw.slice(0, 400));
        throw new Error(typeof data.error === 'string' ? data.error : `No se pudo reiniciar (error ${res.status}).`);
      }
      await onDone({
        profilesCleared: Number(data.profilesCleared ?? 0),
        analysesCleared: Number(data.analysesCleared ?? 0),
        fichaRegenerating: !!data.fichaRegenerating,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo reiniciar el perfil.');
      setBusy(false);
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="sp" style={{ background: '#fff', borderRadius: 14, padding: 24, maxWidth: 480, width: '100%', margin: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10 }}>
          Reiniciar perfil de IA de {payload.studentName}
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--sp-t2)', lineHeight: 1.65 }}>
          Se borran y se vuelven a hacer la <strong>ficha de la IA</strong> y los{' '}
          <strong>informes de las clases</strong>. La ficha se rehace con las respuestas
          del formulario que ya tenemos guardadas.
          <br /><br />
          <strong>No cambia:</strong> el nivel, la confirmación del profe, las respuestas
          del formulario ni las clases registradas y sus transcripciones (finanzas).
          Al alumno no se le pide nada.
          <br /><br />
          Si lo que quieres es que el alumno repita el formulario y la prueba, usa
          «Regenerar todo». ¿Continuar?
        </div>

        {error && (
          <div style={{ marginTop: 14, padding: '10px 13px', borderRadius: 9, background: 'rgba(220,38,38,0.07)', color: '#B91C1C', fontSize: 13, lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        <div className="sp-btn-row" style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button onClick={onClose} disabled={busy} style={{ ...btnSecondary, flex: 1 }}>Cancelar</button>
          <button
            onClick={confirm}
            disabled={busy}
            style={{
              flex: 1, padding: '9px 16px', borderRadius: 8, border: '1px solid #dc2626',
              background: busy ? '#e07a72' : '#dc2626', color: 'white', cursor: busy ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
            }}
          >
            {busy ? 'Reiniciando…' : 'Sí, reiniciar'}
          </button>
        </div>
      </div>
    </div>
  );
}
