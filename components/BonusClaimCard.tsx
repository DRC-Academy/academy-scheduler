'use client';
// ── Tarjeta "Reclamar bono" del profesor ─────────────────────────────────────
//
// La usan "Mi Scoring" (una por alumno disponible) y el banner del panel. El
// estado NO se guarda en localStorage: lo da la tabla teacher_bonuses. Cuando el
// profesor reclama, la fila pasa a 'reclamado' y la tarjeta cambia sola; si el
// índice único rechaza el insert (ya había bono), se muestra "ya reclamado".
//
// El botón se deshabilita mientras guarda: un doble clic mandaba dos inserts y
// el segundo volvía con 23505, que sin este guard se veía como un error.

import { useState } from 'react';
import type { Assignment } from '@/types';
import { BonusAlreadyExistsError } from '@/lib/db';
import type { BonusRowState } from '@/lib/bonuses';

export function fechaCorta(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Texto del estado tal como lo lee el profesor. */
export function estadoProfesor(estado: BonusRowState, note?: string | null): string {
  switch (estado) {
    case 'reclamado':      return 'Reclamado · pendiente de aprobación';
    case 'aprobado':       return 'Aprobado · se suma a tu liquidación';
    case 'pagado':         return 'Pagado';
    case 'pagado_externo': return 'Pagado';
    case 'rechazado':      return note ? `Rechazado: ${note}` : 'Rechazado';
    case 'disponible':     return 'Disponible';
    case 'proximo':        return 'Próximo';
    case 'en_curso':       return 'En curso';
  }
}

export function BonusClaimCard({ assignment, dueDate, euros, estado, onClaim, compact }: {
  assignment: Assignment;
  dueDate: string | null;
  euros: number;
  estado: BonusRowState;
  /** Inserta la fila 'reclamado'. Lanza BonusAlreadyExistsError si ya existía. */
  onClaim: (assignment: Assignment) => Promise<unknown>;
  /** Banner del panel: una sola línea, sin fecha larga. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [yaReclamado, setYaReclamado] = useState(false);

  async function handleClaim() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await onClaim(assignment);
    } catch (err) {
      if (err instanceof BonusAlreadyExistsError) setYaReclamado(true);
      else setError(err instanceof Error ? err.message : 'No se pudo reclamar el bono.');
    } finally {
      setBusy(false);
    }
  }

  const reclamable = estado === 'disponible' && !yaReclamado;

  return (
    <div style={{
      background: '#FFFBEB', border: '1.5px solid #D97706', borderLeft: '5px solid #D97706',
      borderRadius: 12, padding: compact ? '12px 16px' : '14px 18px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#92400E', lineHeight: 1.4 }}>
          🎁 {compact ? `¡${assignment.studentName} cumplió 6 meses con vos!` : assignment.studentName}
        </div>
        <div style={{ fontSize: 12.5, color: '#B45309', marginTop: 2 }}>
          {compact
            ? `Bono de retención de €${euros}.`
            : dueDate ? `Cumplió 6 meses con vos el ${fechaCorta(dueDate)} · bono de €${euros}` : `Bono de retención de €${euros}`}
          {yaReclamado && <> · <b>Ya estaba reclamado</b></>}
        </div>
        {error && <div style={{ fontSize: 12, color: '#B91C1C', marginTop: 4 }}>{error}</div>}
      </div>
      {reclamable ? (
        <button
          type="button"
          onClick={handleClaim}
          disabled={busy}
          style={{
            background: busy ? '#86efac' : '#1E9E3A', color: 'white', border: 'none', borderRadius: 9,
            padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: busy ? 'wait' : 'pointer',
            fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0,
          }}
        >
          {busy ? 'Reclamando…' : 'Reclamar bono'}
        </button>
      ) : (
        <span style={{
          fontSize: 12, fontWeight: 700, color: '#92400E', background: 'rgba(217,119,6,0.14)',
          border: '1px solid rgba(217,119,6,0.4)', borderRadius: 999, padding: '5px 11px', whiteSpace: 'nowrap',
        }}>
          {yaReclamado ? 'Reclamado · pendiente de aprobación' : estadoProfesor(estado)}
        </span>
      )}
    </div>
  );
}
