'use client';
// Panel de admin — Validación de transcripciones (Bloque 1).
// Lista las clases marcadas por el sistema (score bajo, flags o IA sospechosa),
// permite ver el texto completo y aprobar/rechazar. Aprobar → cuenta para el pago;
// rechazar → no cuenta y avisa al profesor.

import { useEffect, useMemo, useState } from 'react';
import { useTeachers } from '@/lib/TeachersContext';
import { useAuth } from '@/lib/AuthContext';
import { dbGetFlaggedTranscripts, dbReviewTranscript, dbReopenTranscript, type FlaggedTranscript } from '@/lib/db';
import { flagLabel, SCORE_SEVERE } from '@/lib/transcriptValidation';
import { SCORE_AUTO_APPROVE } from '@/lib/transcriptVerdict';

const GREEN = '#1E9E3A';

type Vista = 'pendientes' | 'auto' | 'dudosas';

// Las "muy dudosas" no son un estado aparte en la base: son las pendientes con
// score por debajo del umbral severo. Se distinguen por el score para no tocar el
// contrato de finanzas, que decide qué se paga por validation_status.
const esMuyDudosa = (r: FlaggedTranscript): boolean =>
  r.validationStatus === 'review' && r.score != null && r.score < SCORE_SEVERE;

function scoreColor(score: number | null): string {
  if (score == null) return '#6b7280';
  if (score > 70) return '#1f7a3d';
  if (score >= 40) return '#b45309';
  return '#dc2626';
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

export default function TranscriptValidationTab() {
  const { teachers } = useTeachers();
  const { user } = useAuth();
  const [rows, setRows] = useState<FlaggedTranscript[]>([]);
  const [loading, setLoading] = useState(true);
  const [missingColumns, setMissingColumns] = useState(false);
  const [viewing, setViewing] = useState<FlaggedTranscript | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [vista, setVista] = useState<Vista>('pendientes');

  const teacherName = (id: string | null) => teachers.find(t => t.id === id)?.name ?? '—';

  async function load() {
    setLoading(true);
    const res = await dbGetFlaggedTranscripts();
    setRows(res.rows);
    setMissingColumns(res.missingColumns);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const autoAprobadas = rows.filter(r => r.validationStatus === 'auto_approved');
  const muyDudosas    = rows.filter(esMuyDudosa);
  // "Pendientes" son las que esperan decisión y NO son las muy dudosas (esas
  // tienen su propia pestaña, para que lo urgente no se pierda entre lo normal).
  const pendientes    = rows.filter(r => r.validationStatus === 'review' && !esMuyDudosa(r));

  // El filtrado va DENTRO del useMemo: si `visibles` se calcula fuera, cambia de
  // identidad en cada render y la memoización no sirve de nada.
  // Sin resolver primero; dentro de cada grupo, lo más reciente arriba.
  const ordered = useMemo(() => {
    const visibles = vista === 'auto'
      ? rows.filter(r => r.validationStatus === 'auto_approved')
      : vista === 'dudosas'
        ? rows.filter(esMuyDudosa)
        // Pendientes primero y las ya resueltas debajo, como historial.
        : rows.filter(r =>
            (r.validationStatus === 'review' && !esMuyDudosa(r)) ||
            r.validationStatus === 'approved' || r.validationStatus === 'rejected');
    return visibles.sort((a, b) =>
      (Number(b.validationStatus === 'review') - Number(a.validationStatus === 'review')) ||
      (b.analyzedAt ?? '').localeCompare(a.analyzedAt ?? ''));
  }, [rows, vista]);

  // Reabrir una auto-aprobada: vuelve a 'review' y deja de contar para el pago
  // hasta que el admin decida.
  async function reopen(row: FlaggedTranscript) {
    setBusyId(row.id);
    try {
      await dbReopenTranscript(row.id, user?.displayName ?? 'admin');
      setRows(prev => prev.map(r => r.id === row.id
        ? { ...r, validationStatus: 'review', reviewedBy: user?.displayName ?? 'admin', reviewedAt: new Date().toISOString() }
        : r));
      setViewing(null);
    } catch (e) {
      alert(`No se pudo reabrir: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function review(row: FlaggedTranscript, decision: 'approved' | 'rejected') {
    setBusyId(row.id);
    try {
      await dbReviewTranscript(
        { id: row.id, teacherId: row.teacherId, studentName: row.studentName, classDate: row.classDate },
        decision, user?.displayName ?? 'admin',
      );
      setRows(prev => prev.map(r => r.id === row.id
        ? { ...r, validationStatus: decision, reviewedBy: user?.displayName ?? 'admin', reviewedAt: new Date().toISOString() }
        : r));
      setViewing(null);
    } catch (e) {
      alert(`No se pudo guardar la revisión: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  const card = (label: string, value: number, color: string): React.ReactNode => (
    <div style={{ flex: 1, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
      <div style={{ fontSize: 26, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Transcripciones pendientes de revisión</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>
          Clases marcadas por el sistema por baja confianza estructural, señales cruzadas o análisis de IA.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {card(`Aprobadas automáticamente (score ≥ ${SCORE_AUTO_APPROVE})`, autoAprobadas.length, GREEN)}
        {card('Pendientes de revisión', pendientes.length, '#b45309')}
        {card(`Muy dudosas (score < ${SCORE_SEVERE})`, muyDudosas.length, '#dc2626')}
      </div>

      {/* Filtros. Se abre en Pendientes: es lo único que pide acción del admin. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {([
          ['pendientes', `Pendientes (${pendientes.length})`, '#b45309'],
          ['auto',       `Aprobadas automáticamente (${autoAprobadas.length})`, GREEN],
          ['dudosas',    `Muy dudosas (${muyDudosas.length})`, '#dc2626'],
        ] as const).map(([id, label, color]) => (
          <button key={id} onClick={() => setVista(id)} style={{
            padding: '7px 14px', borderRadius: 999, cursor: 'pointer',
            fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
            border: `1.5px solid ${vista === id ? color : 'var(--border)'}`,
            background: vista === id ? color : 'var(--bg-surface)',
            color: vista === id ? (id === 'auto' ? 'white' : 'white') : 'var(--text-secondary)',
          }}>
            {label}
          </button>
        ))}
      </div>

      {vista === 'auto' && (
        <div style={{
          border: `1px solid rgba(30,158,58,0.35)`, background: 'rgba(30,158,58,0.08)',
          borderRadius: 10, padding: '11px 14px', fontSize: 12.5, color: '#166534', lineHeight: 1.6,
        }}>
          Estas clases pasaron la validación con {SCORE_AUTO_APPROVE} puntos o más y sin ninguna señal:
          ya cuentan para el pago y no requieren que hagas nada. Están aquí solo para que puedas
          auditarlas. Si alguna te llama la atención, «Marcar para revisión» la reabre y deja de contar
          hasta que decidas.
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>Cargando…</div>
      ) : missingColumns ? (
        <div style={{
          border: '1px solid rgba(255,196,0,0.5)', background: 'rgba(255,196,0,0.1)',
          borderRadius: 10, padding: '14px 16px', fontSize: 13, color: '#8A6A00', lineHeight: 1.65,
        }}>
          <b>Falta la migración de validación.</b> La columna <code>validation_status</code> no existe en
          la base, así que esta pestaña no puede mostrar nada todavía. Corré{' '}
          <code>supabase-transcript-validation.sql</code> en el editor SQL de Supabase. Las clases que se
          registren después de correrla aparecerán acá automáticamente.
        </div>
      ) : ordered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          {vista === 'auto'    ? 'Todavía no hay clases aprobadas automáticamente.'
          : vista === 'dudosas' ? 'Ninguna transcripción muy dudosa. ✅'
          : 'No hay transcripciones pendientes de revisión. ✅'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
                {['Profesor', 'Alumno', 'Fecha', 'Score', 'Alertas', 'Acciones'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', fontWeight: 700, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordered.map(r => {
                const resolved = r.validationStatus !== 'review';
                // Solo se atenúa el historial ya decidido. Las auto-aprobadas se
                // ven a plena opacidad: son una categoría viva, no un archivo.
                const atenuada = r.validationStatus === 'approved' || r.validationStatus === 'rejected';
                return (
                  <tr key={r.id} style={{
                    borderTop: '1px solid var(--border)',
                    opacity: atenuada ? 0.6 : 1,
                    background: esMuyDudosa(r) ? 'rgba(220,38,38,0.06)' : undefined,
                  }}>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{teacherName(r.teacherId)}</td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{r.studentName}</td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{fmtDate(r.classDate)}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 800, color: scoreColor(r.score) }}>{r.score ?? '—'}</td>
                    <td style={{ padding: '10px 12px', maxWidth: 340 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {r.flags.length === 0 && <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        {r.flags.map(f => (
                          <span key={f} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(249,115,22,0.12)', color: '#9a6516', whiteSpace: 'nowrap' }}>
                            {flagLabel(f)}
                          </span>
                        ))}
                      </div>
                      {r.aiCheck?.reasoning && (
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>
                          IA ({r.aiCheck.confidence}%): {r.aiCheck.reasoning}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      {r.validationStatus === 'auto_approved' ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: GREEN }}>✓ Aprobada automáticamente</span>
                          <button onClick={() => setViewing(r)} style={btn('ghost')}>Ver transcript</button>
                          <button onClick={() => reopen(r)} disabled={busyId === r.id} style={btn('ghost')}>
                            Marcar para revisión
                          </button>
                        </div>
                      ) : resolved ? (
                        <span style={{ fontSize: 12, fontWeight: 700, color: r.validationStatus === 'approved' ? '#1f7a3d' : '#dc2626' }}>
                          {r.validationStatus === 'approved' ? '✅ Aprobada' : '❌ Rechazada'}
                        </span>
                      ) : (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => setViewing(r)} style={btn('ghost')}>Ver</button>
                          <button onClick={() => review(r, 'approved')} disabled={busyId === r.id} style={btn('green')}>Aprobar</button>
                          <button onClick={() => review(r, 'rejected')} disabled={busyId === r.id} style={btn('red')}>Rechazar</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {viewing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setViewing(null); }}>
          <div style={{ background: '#F7F7F5', border: '1px solid var(--border)', borderRadius: 14, width: '100%', maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>{viewing.studentName} · {fmtDate(viewing.classDate)}</div>
                <div style={{ fontSize: 12.5, color: '#6b7280' }}>
                  {teacherName(viewing.teacherId)} · Score <b style={{ color: scoreColor(viewing.score) }}>{viewing.score ?? '—'}/100</b>
                </div>
              </div>
              <button onClick={() => setViewing(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
            </div>
            <div style={{ padding: '16px 22px', overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, color: '#1a1c1a', fontFamily: 'ui-monospace, monospace' }}>
              {viewing.transcript}
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => review(viewing, 'rejected')} disabled={busyId === viewing.id} style={btn('red', true)}>Rechazar</button>
              <button onClick={() => review(viewing, 'approved')} disabled={busyId === viewing.id} style={btn('green', true)}>Aprobar y contar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function btn(kind: 'ghost' | 'green' | 'red', big = false): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: big ? '9px 18px' : '5px 11px', borderRadius: 8, cursor: 'pointer',
    fontSize: big ? 13 : 12, fontWeight: 700, fontFamily: 'inherit', border: 'none',
  };
  if (kind === 'ghost') return { ...base, border: '1px solid var(--border)', background: 'white', color: '#374151' };
  if (kind === 'green') return { ...base, background: GREEN, color: 'white' };
  return { ...base, background: 'white', border: '1px solid #f0c4bd', color: '#c0392b' };
}
