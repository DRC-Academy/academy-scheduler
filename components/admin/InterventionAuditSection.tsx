'use client';

// "Seguimiento de intervenciones" — sección de la pestaña 🤖 IA y Riesgo.
//
// Muestra las alertas de riesgo que, según la IA, podrían no haberse atendido.
// IMPORTANTE: esto NO penaliza a nadie. El sistema no descuenta scoring por
// estas filas. Una intervención buena es sutil y puede no verse en el
// transcript, así que lo que hay aquí son SEÑALES y la decisión es del admin:
//
//   · Ver detalle          → qué se sugirió y qué encontró la IA en cada clase.
//   · Marcar como atendida → el admin sabe que el profesor sí intervino.
//   · Registrar incidencia → solo si decide que hubo negligencia real (a mano).

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { dbAddScoringEvent, EVENT_POINTS } from '@/lib/db';
import {
  asIntervention, CHANNEL_LABEL,
  type ActiveIntervention, type InterventionAuditRow, type InterventionSuggestion,
} from '@/lib/interventions';
import {
  fetchChurnedWithOpenAlert, fetchInterventionAudits, markInterventionAttended,
  type ChurnedWithAlert,
} from '@/lib/interventionsClient';
import { Modal, ModalHeader } from '@/components/ai/modalUi';
import { formatDate } from '@/components/ai/FichaView';
import type { StudentProfileRow } from '@/lib/aiTypes';

/** Alumno tal como lo tiene ya resuelto AiRiskTab (ficha + profesor). */
export interface AuditStudent {
  profileId: string;
  studentId: string | null;
  studentName: string;
  teacherId: string | null;
  teacherName: string;
  /** false → alumno sin ficha (solo en class_analyses): no hay dónde cerrar la alerta. */
  hasProfile: boolean;
}

interface Row extends AuditStudent {
  unattended: number;
  active: ActiveIntervention | null;
  audits: InterventionAuditRow[];
  lastAudit: InterventionAuditRow | null;
}

const norm = (s: string) => s.trim().toLowerCase();

const CONF_COLOR: Record<string, string> = {
  alta: '#B91C1C', media: '#B45309', baja: '#6b7280',
};

export default function InterventionAuditSection({ students, profiles, onRefresh }: {
  students: AuditStudent[];
  profiles: StudentProfileRow[];
  onRefresh: () => Promise<void>;
}) {
  const { user } = useAuth();
  const [audits, setAudits] = useState<InterventionAuditRow[]>([]);
  const [churned, setChurned] = useState<ChurnedWithAlert[]>([]);
  const [missingTable, setMissingTable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Row | null>(null);
  const [incident, setIncident] = useState<Row | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Recarga de las auditorías. La primera pasa por el efecto (con guarda de
  // cancelación); las siguientes las disparan las acciones del admin.
  const load = useCallback(async () => {
    const res = await fetchInterventionAudits();
    setAudits(res.rows);
    setMissingTable(res.missingTable);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [res, bajas] = await Promise.all([
        fetchInterventionAudits(), fetchChurnedWithOpenAlert(),
      ]);
      if (cancelled) return;
      setAudits(res.rows);
      setMissingTable(res.missingTable);
      setChurned(bajas);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Auditorías por alumno (por id y, como respaldo, por nombre normalizado: el
  // mismo criterio tolerante que usa el resto del sistema).
  const auditsOf = useCallback((s: AuditStudent) => audits.filter(a =>
    (s.studentId && a.student_id === s.studentId) ||
    (!!a.student_name && norm(a.student_name) === norm(s.studentName))
  ), [audits]);

  const profileById = useMemo(() => {
    const m = new Map<string, StudentProfileRow>();
    for (const p of profiles) m.set(p.id, p);
    return m;
  }, [profiles]);

  // El alumno de una baja ya no existe: su profesor se resuelve por el id que
  // quedó guardado en la fila de la baja.
  const teacherName = useCallback((teacherId: string | null) =>
    students.find(s => s.teacherId === teacherId)?.teacherName ?? 'sin asignar',
    [students]);

  const rows: Row[] = useMemo(() => students.map(s => {
    const p = profileById.get(s.profileId);
    const mine = auditsOf(s);
    return {
      ...s,
      unattended: Number(p?.unattended_alerts ?? 0) || 0,
      active:     asIntervention(p?.active_intervention),
      audits:     mine,
      lastAudit:  mine[0] ?? null,
    };
  })
    // Solo interesa quien tiene algo que revisar: alertas sin atender, una
    // intervención todavía abierta o auditorías registradas.
    .filter(r => r.unattended > 0 || r.active || r.audits.length > 0)
    .sort((a, b) => b.unattended - a.unattended ||
      (b.lastAudit?.created_at ?? '').localeCompare(a.lastAudit?.created_at ?? '')),
    [students, profileById, auditsOf]);

  async function handleAttended(r: Row) {
    setBusyId(r.profileId);
    try {
      await markInterventionAttended(r.profileId);
      await onRefresh();
      await load();
      setMsg(`Intervención de ${r.studentName} marcada como atendida.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'No se pudo cerrar la intervención.');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div style={card}>
        <div style={sectionTitle}>🔎 Seguimiento de intervenciones</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Cargando auditorías…</div>
      </div>
    );
  }

  return (
    <div style={card}>
      <div style={sectionTitle}>🔎 Seguimiento de intervenciones ({rows.length})</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 14 }}>
        Alertas de riesgo en las que la IA no vio señales claras de intervención. No se aplica ninguna
        penalización automática: una intervención bien hecha es sutil y puede no reflejarse en el
        transcript. Revisa el detalle antes de tomar cualquier medida.
      </div>

      {msg && (
        <div style={{
          marginBottom: 12, padding: '9px 12px', borderRadius: 8,
          background: 'rgba(30,158,58,0.1)', border: '1px solid rgba(30,158,58,0.35)',
          fontSize: 12.5, color: '#166534',
        }}>
          {msg}
        </div>
      )}

      {missingTable ? (
        <div style={{ fontSize: 13, color: '#B45309', lineHeight: 1.6 }}>
          La tabla <code>intervention_audits</code> todavía no existe. Corré <code>supabase-interventions.sql</code> en Supabase.
        </div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>
          Ninguna alerta con seguimiento pendiente. 🎉
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Alumno</th>
                <th style={th}>Profesor</th>
                <th style={th}>Alertas sin atender</th>
                <th style={th}>Última evidencia</th>
                <th style={th}>Confianza</th>
                <th style={th}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.profileId}>
                  <td style={{ ...td, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {r.studentName}
                    {r.active && (
                      <div style={{ fontSize: 10.5, fontWeight: 600, color: r.active.risk === 'rojo' ? '#B91C1C' : '#B45309', marginTop: 2 }}>
                        {r.active.risk === 'rojo' ? '🔴' : '🟡'} intervención abierta
                      </div>
                    )}
                  </td>
                  <td style={td}>{r.teacherName}</td>
                  <td style={{ ...td, fontWeight: 800, color: r.unattended >= 2 ? '#B91C1C' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                    {r.unattended}
                  </td>
                  <td style={{ ...td, maxWidth: 320 }}>
                    {r.lastAudit?.evidence
                      ? <span style={{ lineHeight: 1.5 }}>{r.lastAudit.evidence}</span>
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td style={td}>
                    {r.lastAudit?.confidence ? (
                      <span style={{ fontWeight: 700, color: CONF_COLOR[r.lastAudit.confidence] ?? 'var(--text-secondary)' }}>
                        {r.lastAudit.confidence}
                      </span>
                    ) : '—'}
                  </td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button onClick={() => setDetail(r)} style={detailBtn}>👁️ Ver detalle</button>
                      <button
                        onClick={() => handleAttended(r)}
                        disabled={busyId === r.profileId || !r.hasProfile}
                        title={r.hasProfile
                          ? 'Cierra la alerta en la ficha del alumno'
                          : 'El alumno todavía no tiene ficha: se creará al analizar su próxima clase'}
                        style={{ ...okBtn, opacity: busyId === r.profileId || !r.hasProfile ? 0.5 : 1 }}
                      >
                        ✅ Marcar como atendida
                      </button>
                      <button
                        onClick={() => { setIncident(r); }}
                        disabled={!r.teacherId}
                        title={r.teacherId ? 'Solo si hubo negligencia real' : 'El alumno no tiene profesor asignado'}
                        style={{ ...warnBtn, opacity: r.teacherId ? 1 : 0.5 }}
                      >
                        ⚠️ Registrar incidencia
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Bajas que se fueron con la alerta abierta. Contexto puro: sirve para
          distinguir una baja sin seguimiento de una inevitable. */}
      {churned.length > 0 && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)', marginBottom: 4 }}>
            Bajas con alerta de riesgo previa ({churned.length})
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 10 }}>
            Se dieron de baja mientras tenían una alerta con seguimiento pendiente. Dato de contexto,
            sin efecto en el scoring.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {churned.map(b => {
              const teacher = teacherName(b.teacher_id);
              return (
                <div key={b.id} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 12.5 }}>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{b.student_name}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{teacher}</span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {b.dropped_at ? formatDate(b.dropped_at) : '—'}
                    {b.unattended_alerts ? ` · ${b.unattended_alerts} sin atender` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {detail && (
        <Modal onClose={() => setDetail(null)} maxWidth={680}>
          <ModalHeader
            title={`🔎 ${detail.studentName}`}
            subtitle={`Profesor: ${detail.teacherName} · ${detail.audits.length} auditoría(s)`}
            onClose={() => setDetail(null)}
          />
          <AuditHistory row={detail} />
        </Modal>
      )}

      {incident && (
        <IncidentModal
          row={incident}
          createdBy={user?.displayName ?? 'Admin'}
          onClose={() => setIncident(null)}
          onSaved={async (name) => {
            setIncident(null);
            await onRefresh();
            setMsg(`Incidencia registrada para ${name}.`);
          }}
        />
      )}
    </div>
  );
}

// ── Detalle: qué se sugirió y qué encontró la IA en cada clase ────────────────
function AuditHistory({ row }: { row: Row }) {
  if (row.audits.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
        Todavía no hay auditorías de este alumno. Se generan al analizar la clase siguiente
        a una alerta de riesgo.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {row.active && (
        <div style={{
          border: '1px solid rgba(255,196,0,0.5)', background: 'rgba(255,196,0,0.1)',
          borderRadius: 10, padding: '12px 14px',
        }}>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#8A6A00', marginBottom: 6 }}>
            Intervención abierta ahora mismo
          </div>
          <SuggestionBody s={row.active} />
        </div>
      )}

      {row.audits.map(a => {
        const sug = asIntervention(a.intervention_suggested);   // jsonb: objeto o string
        const signs = a.signs_of_intervention === true;
        return (
          <div key={a.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: signs ? '#166534' : '#B91C1C' }}>
                {signs ? '✅ Señales de intervención' : '⚠️ Sin señales claras'}
                <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>
                  {' '}· confianza {a.confidence ?? '—'}
                </span>
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {a.created_at ? formatDate(a.created_at) : '—'}
                {a.alert_signal ? ` · alerta ${a.alert_signal}` : ''}
              </span>
            </div>

            {a.evidence && (
              <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', marginBottom: 8 }}>
                {a.evidence}
              </div>
            )}

            {sug && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--accent)' }}>
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

function SuggestionBody({ s }: { s: InterventionSuggestion }) {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
      <div>{s.action}</div>
      {s.reconnectHook && <div style={{ marginTop: 6 }}><strong>Oportunidad:</strong> {s.reconnectHook}</div>}
      <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
        Canal: {CHANNEL_LABEL[s.channel]}{s.escalateToSupport ? ' · escalado a soporte' : ''}
      </div>
    </div>
  );
}

// ── Registrar incidencia (decisión humana, nunca automática) ──────────────────
function IncidentModal({ row, createdBy, onClose, onSaved }: {
  row: Row;
  createdBy: string;
  onClose: () => void;
  onSaved: (studentName: string) => Promise<void>;
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
        title="⚠️ Registrar incidencia"
        subtitle={`${row.studentName} · profesor ${row.teacherName}`}
        onClose={onClose}
      />

      <div style={{
        border: '1px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.06)',
        borderRadius: 10, padding: '11px 13px', fontSize: 12.5, color: '#991B1B', lineHeight: 1.6, marginBottom: 14,
      }}>
        Esto sí penaliza al profesor ({points} puntos). Regístralo solo si has comprobado que
        realmente no hubo seguimiento. La auditoría de la IA por sí sola no es prueba suficiente.
      </div>

      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
        Motivo (queda en el historial del profesor)
      </label>
      <textarea
        value={note}
        onChange={e => { setNote(e.target.value); setError(''); }}
        rows={4}
        style={{
          width: '100%', boxSizing: 'border-box', borderRadius: 9, border: '1px solid var(--border)',
          padding: '10px 12px', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5, resize: 'vertical',
        }}
      />

      {error && <div style={{ marginTop: 10, fontSize: 12.5, color: '#B91C1C' }}>{error}</div>}

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button onClick={onClose} disabled={busy} style={{ ...detailBtn, flex: 1, padding: '9px 14px' }}>Cancelar</button>
        <button
          onClick={save}
          disabled={busy || !note.trim()}
          style={{ ...warnBtn, flex: 1, padding: '9px 14px', opacity: busy || !note.trim() ? 0.6 : 1 }}
        >
          {busy ? 'Registrando…' : `Registrar (${points} pts)`}
        </button>
      </div>
    </Modal>
  );
}

const card: CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px',
};
const sectionTitle: CSSProperties = { fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', marginBottom: 6 };
const table: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th: CSSProperties = {
  textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td: CSSProperties = {
  padding: '10px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', verticalAlign: 'top',
};
const baseBtn: CSSProperties = {
  padding: '6px 12px', borderRadius: 7, fontSize: 11.5, fontWeight: 600,
  fontFamily: 'inherit', whiteSpace: 'nowrap', cursor: 'pointer',
};
const detailBtn: CSSProperties = {
  ...baseBtn, border: '1px solid var(--border)', background: 'var(--bg-surface-3)', color: 'var(--text-secondary)',
};
const okBtn: CSSProperties = {
  ...baseBtn, border: '1.5px solid #1E9E3A', background: 'white', color: '#1E9E3A', fontWeight: 700,
};
const warnBtn: CSSProperties = {
  ...baseBtn, border: '1.5px solid #dc2626', background: 'white', color: '#dc2626', fontWeight: 700,
};
