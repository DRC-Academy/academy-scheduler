'use client';

// Aviso ANTES de asignar: el alumno ya tiene profesor.
//
// Se usa en los dos sitios donde se asigna (el setter y el calendario del
// profesor), para que el control sea el mismo en ambos. Antes solo existía en el
// setter, comparaba únicamente el student_id exacto y no ofrecía mover al
// alumno: te mandaba a otra pantalla a hacerlo a mano.

import { useState } from 'react';
import { matchLabel, slotsLabel, type ExistingAssignmentMatch } from '@/lib/assignmentGuard';

export default function AlumnoYaAsignadoModal({
  studentName, targetTeacherName, matches, onMove, onKeepBoth, onCancel,
}: {
  studentName: string;
  /** Profesor al que se le está intentando asignar ahora. */
  targetTeacherName: string;
  matches: ExistingAssignmentMatch[];
  /** Mover: se quitan las asignaciones anteriores y se libera su calendario. */
  onMove: () => Promise<void> | void;
  /** Mantener las dos (casos legítimos: alumno con dos profesores). */
  onKeepBoth: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState<'move' | 'keep' | null>(null);
  const varios = matches.length > 1;
  const profes = [...new Set(matches.map(m => m.teacherName))];

  async function run(kind: 'move' | 'keep', fn: () => Promise<void> | void) {
    setBusy(kind);
    try { await fn(); } finally { setBusy(null); }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      role="alertdialog"
      aria-modal="true"
    >
      <div style={{ background: 'var(--bg-surface, #fff)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: 14, padding: 24, width: '100%', maxWidth: 460 }}>
        <div style={{ fontSize: 24, marginBottom: 10 }}>⚠️</div>
        <div style={{ fontWeight: 700, fontSize: 16.5, color: 'var(--text-primary, #111827)', marginBottom: 10 }}>
          Este alumno ya está asignado a {profes.join(' y ')}
        </div>

        <div style={{ fontSize: 13, color: 'var(--text-secondary, #4b5563)', lineHeight: 1.65, marginBottom: 14 }}>
          <b style={{ color: 'var(--text-primary, #111827)' }}>{studentName}</b> ya tiene
          {varios ? ' estas asignaciones activas:' : ' una asignación activa:'}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {matches.map(m => (
            <div key={m.assignmentId} style={{ background: 'var(--bg-surface-2, #f7f7f5)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 9, padding: '10px 13px', fontSize: 12.5, lineHeight: 1.55 }}>
              <div style={{ fontWeight: 700, color: 'var(--text-primary, #111827)' }}>{m.teacherName}</div>
              <div style={{ color: 'var(--text-secondary, #4b5563)' }}>{slotsLabel(m.slots)}</div>
              <div style={{ color: 'var(--text-muted, #9ca3af)', fontSize: 11.5, marginTop: 2 }}>
                {matchLabel(m.matchedBy)}
                {m.studentName !== studentName && ` · figura como "${m.studentName}"`}
              </div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 13, color: 'var(--text-secondary, #4b5563)', lineHeight: 1.65, marginBottom: 16 }}>
          ¿Deseas moverlo a <b style={{ color: 'var(--text-primary, #111827)' }}>{targetTeacherName}</b>?
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            onClick={() => run('move', onMove)}
            disabled={!!busy}
            style={{ padding: '11px', borderRadius: 8, border: 'none', background: busy ? '#8fc7a0' : '#1E9E3A', color: 'white', cursor: busy ? 'wait' : 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit' }}
          >
            {busy === 'move' ? 'Moviendo…' : `Sí, mover a ${targetTeacherName}`}
          </button>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted, #9ca3af)', textAlign: 'center', lineHeight: 1.5 }}>
            Se {varios ? 'eliminan las asignaciones anteriores' : 'elimina la asignación anterior'} y se
            {varios ? ' liberan esos horarios' : ' libera ese horario'}. El historial de clases se conserva.
          </div>

          <button
            onClick={() => run('keep', onKeepBoth)}
            disabled={!!busy}
            style={{ padding: '10px', borderRadius: 8, border: '1px solid var(--border, #e5e7eb)', background: 'var(--bg-surface-3, #f3f4f6)', color: 'var(--text-primary, #111827)', cursor: busy ? 'wait' : 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}
          >
            {busy === 'keep' ? 'Asignando…' : 'No, quiero que tenga los dos profesores'}
          </button>

          <button
            onClick={onCancel}
            disabled={!!busy}
            style={{ padding: '10px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-secondary, #4b5563)', cursor: busy ? 'not-allowed' : 'pointer', fontSize: 13, fontFamily: 'inherit' }}
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
