'use client';

// Modales compartidos de la bandeja de riesgo (pestaña "IA y Riesgo").
//
// Vivían dentro de InterventionAuditSection, que era a la vez sección y dueña de
// estos diálogos. Al pasar la sección a ser una pestaña de la bandeja, los
// diálogos los abren dos sitios distintos (la cola y la verificación), así que
// salen de allí sin cambiarles el comportamiento:
//
//   · AuditHistory   → qué se sugirió al profesor y qué encontró la IA después.
//   · IncidentModal  → registrar incidencia. Es lo ÚNICO que penaliza, y siempre
//                      es una decisión humana: la auditoría de la IA no basta.

import { useState, type CSSProperties } from 'react';
import { dbAddScoringEvent, EVENT_POINTS } from '@/lib/db';
import {
  asIntervention, CHANNEL_LABEL,
  type ActiveIntervention, type InterventionAuditRow, type InterventionSuggestion,
} from '@/lib/interventions';
import { Modal, ModalHeader } from '@/components/ai/modalUi';
import { formatDate } from '@/components/ai/FichaView';

/** Lo mínimo que necesitan los modales de una fila de la bandeja. */
export interface InterventionTarget {
  studentName: string;
  teacherId: string | null;
  teacherName: string;
  unattended: number;
  active: ActiveIntervention | null;
  audits: InterventionAuditRow[];
}

// ── Detalle: qué se sugirió y qué encontró la IA en cada clase ────────────────
export function AuditHistory({ row }: { row: InterventionTarget }) {
  if (row.audits.length === 0 && !row.active) {
    return (
      <div style={{ fontSize: 13, color: '#6b7a70', padding: '8px 0', lineHeight: 1.6 }}>
        Todavía no hay auditorías de este alumno. Se generan al analizar la clase siguiente
        a una alerta de riesgo.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {row.active && (
        <div style={{
          border: '1px solid #eddfb6', background: '#fdf5e4',
          borderRadius: 10, padding: '12px 14px',
        }}>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#8a5f0a', marginBottom: 6 }}>
            Intervención abierta ahora mismo
          </div>
          <SuggestionBody s={row.active} />
        </div>
      )}

      {row.audits.map(a => {
        const sug = asIntervention(a.intervention_suggested);   // jsonb: objeto o string
        const signs = a.signs_of_intervention === true;
        return (
          <div key={a.id} style={{ border: '1px solid #e7e9e4', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: signs ? '#136b34' : '#a52b23' }}>
                {signs ? 'Señales de intervención' : 'Sin señales claras'}
                <span style={{ fontWeight: 500, color: '#8a9790' }}>
                  {' '}· confianza {a.confidence ?? '—'}
                </span>
              </span>
              <span style={{ fontSize: 11.5, color: '#8a9790' }}>
                {a.created_at ? formatDate(a.created_at) : '—'}
                {a.alert_signal ? ` · alerta ${a.alert_signal}` : ''}
              </span>
            </div>

            {/* Texto literal de la IA. */}
            {a.evidence && (
              <div style={{ fontSize: 13, lineHeight: 1.6, color: '#3f4c45', marginBottom: 8 }}>
                {a.evidence}
              </div>
            )}

            {sug && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: '#0d7a39' }}>
                  Ver qué se le sugirió al profesor
                </summary>
                <div style={{ marginTop: 8 }}><SuggestionBody s={sug} /></div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SuggestionBody({ s }: { s: InterventionSuggestion }) {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6, color: '#3f4c45' }}>
      <div>{s.action}</div>
      {s.reconnectHook && <div style={{ marginTop: 6 }}><strong>Oportunidad:</strong> {s.reconnectHook}</div>}
      <div style={{ marginTop: 6, fontSize: 11.5, color: '#8a9790' }}>
        Canal: {CHANNEL_LABEL[s.channel]}{s.escalateToSupport ? ' · escalado a soporte' : ''}
      </div>
    </div>
  );
}

// ── Registrar incidencia (decisión humana, nunca automática) ──────────────────
export function IncidentModal({ row, createdBy, onClose, onSaved }: {
  row: InterventionTarget;
  createdBy: string;
  onClose: () => void;
  onSaved: (studentName: string) => Promise<void> | void;
}) {
  const [note, setNote] = useState(
    `Alerta de riesgo de ${row.studentName} sin señales de intervención en ${row.unattended} clase(s).`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const points = EVENT_POINTS.alerta_no_atendida ?? -10;

  async function save() {
    if (!row.teacherId || !note.trim()) return;
    setBusy(true); setError('');
    try {
      await dbAddScoringEvent({
        teacherId:   row.teacherId,
        teacherName: row.teacherName,
        eventType:   'alerta_no_atendida',
        points,
        euros:       0,
        note:        note.trim(),
        createdBy,
        studentRef:  row.studentName,
      });
      await onSaved(row.studentName);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo registrar la incidencia.');
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} maxWidth={520}>
      <ModalHeader
        title="Registrar incidencia"
        subtitle={`${row.studentName} · profesor ${row.teacherName}`}
        onClose={onClose}
      />

      <div style={{
        border: '1px solid #f3cfca', background: '#fdeeec',
        borderRadius: 10, padding: '11px 13px', fontSize: 12.5, color: '#a52b23', lineHeight: 1.6, marginBottom: 14,
      }}>
        Esto sí penaliza al profesor ({points} puntos). Regístralo solo si has comprobado que
        realmente no hubo seguimiento. La auditoría de la IA por sí sola no es prueba suficiente.
      </div>

      <label htmlFor="incident-note" style={{ fontSize: 12, fontWeight: 600, color: '#3f4c45', display: 'block', marginBottom: 6 }}>
        Motivo (queda en el historial del profesor)
      </label>
      <textarea
        id="incident-note"
        value={note}
        onChange={e => { setNote(e.target.value); setError(''); }}
        rows={4}
        style={{
          width: '100%', boxSizing: 'border-box', borderRadius: 9, border: '1px solid #e2e5df',
          padding: '10px 12px', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5, resize: 'vertical',
        }}
      />

      {error && <div style={{ marginTop: 10, fontSize: 12.5, color: '#a52b23' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button onClick={onClose} disabled={busy} style={{ ...ghost, flex: 1 }}>Cancelar</button>
        <button
          onClick={save}
          disabled={busy || !note.trim()}
          style={{ ...danger, flex: 1, opacity: busy || !note.trim() ? 0.6 : 1 }}
        >
          {busy ? 'Registrando…' : `Registrar (${points} pts)`}
        </button>
      </div>
    </Modal>
  );
}

const ghost: CSSProperties = {
  padding: '9px 14px', borderRadius: 9, border: '1px solid #e2e5df', background: '#fff',
  color: '#3f4c45', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
};
const danger: CSSProperties = {
  padding: '9px 14px', borderRadius: 9, border: '1px solid #f3cfca', background: '#fff',
  color: '#a52b23', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
};
