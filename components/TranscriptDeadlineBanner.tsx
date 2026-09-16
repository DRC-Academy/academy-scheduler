'use client';
// ── Banner fijo del plazo de 24 h para el transcript ─────────────────────────
//
// Va en Mis clases y en la pantalla de subir transcript. Es un BLOQUE de la
// página, no un pop-up: no se cierra solo ni tapa nada. Se puede ocultar con
// "Entendido" (localStorage, por navegador), pero VUELVE si el profesor tiene
// alguna clase con menos de 6 h de plazo o ya vencida (`urgent`): en ese caso
// el botón no aparece, porque no hay nada que aceptar sino algo que hacer.
//
// Un solo texto, el aprobado, en español de España. Vive en
// lib/transcriptDeadline (TRANSCRIPT_DEADLINE_NOTICE) para que el banner, el
// pop-up y cualquier otro sitio digan exactamente lo mismo.

import { useEffect, useState } from 'react';
import { TRANSCRIPT_DEADLINE_NOTICE, TRANSCRIPT_WARN_HOURS } from '@/lib/transcriptDeadline';

const ACK_KEY = 'drc_transcript_deadline_banner_ack';

export function TranscriptDeadlineBanner({ urgent = false, compact = false }: {
  /** Hay clases con menos de 6 h de plazo o vencidas: el banner no se puede ocultar. */
  urgent?: boolean;
  /** Dentro de un modal: márgenes más cortos. */
  compact?: boolean;
}) {
  // Empieza oculto y se decide tras montar: así no parpadea en quien ya lo aceptó.
  const [acked, setAcked] = useState(true);
  useEffect(() => {
    try { setAcked(localStorage.getItem(ACK_KEY) === '1'); } catch { setAcked(false); }
  }, []);

  if (acked && !urgent) return null;

  function dismiss() {
    try { localStorage.setItem(ACK_KEY, '1'); } catch { /* sin storage: se vuelve a mostrar */ }
    setAcked(true);
  }

  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap',
        padding: compact ? '10px 12px' : '12px 16px',
        margin: compact ? '0 0 14px' : '0 0 16px',
        borderRadius: 12,
        background: urgent ? '#FFF4BF' : '#FFF9E0',
        border: `1px solid ${urgent ? '#FFC400' : 'rgba(255,196,0,0.55)'}`,
        color: '#1a1c1a', fontSize: compact ? 13 : 13.5, lineHeight: 1.5,
      }}
    >
      <span aria-hidden style={{ fontSize: 18, lineHeight: 1.2 }}>⏱️</span>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div>{TRANSCRIPT_DEADLINE_NOTICE}</div>
        {urgent && (
          <div style={{ marginTop: 4, fontWeight: 600, color: '#8a6d00' }}>
            Tienes clases con menos de {TRANSCRIPT_WARN_HOURS} horas de plazo o ya vencidas.
          </div>
        )}
      </div>
      {!urgent && (
        <button
          type="button"
          onClick={dismiss}
          style={{
            alignSelf: 'center', padding: '7px 14px', borderRadius: 9, border: '1px solid rgba(0,0,0,0.12)',
            background: '#fff', color: '#1a1c1a', fontWeight: 600, fontSize: 13, cursor: 'pointer', minHeight: 36,
          }}
        >
          Entendido
        </button>
      )}
    </div>
  );
}
