'use client';
// Panel de admin — Predicción de bajas (churn). FASE DE RECOPILACIÓN.
// Muestra el progreso del dataset (bajas reales capturadas hacia la meta ~100),
// los alumnos activos en riesgo según la última foto, y permite escanear ahora.

import { useEffect, useState } from 'react';
import { dbGetChurnOverview, type ChurnOverview } from '@/lib/db';

const GOAL = 100;   // bajas estimadas para que la muestra sea fiable (~3 meses)

// Alineado con el umbral de aviso del escaneo (65).
function riskColor(r: number | null): string {
  if (r == null) return '#6b7280';
  if (r >= 65) return '#dc2626';
  if (r >= 40) return '#ea580c';
  if (r > 0)   return '#b45309';
  return '#6b7280';
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

export default function ChurnTab() {
  const [data, setData] = useState<ChurnOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setData(await dbGetChurnOverview());
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  /**
   * El escaneo va POR LOTES: el servidor procesa lo que le cabe en su presupuesto
   * de tiempo y devuelve `nextOffset`. Aquí se repite hasta `done`, para que se
   * cubran los 177 alumnos y no solo los primeros que entren en una llamada.
   */
  async function scanNow() {
    setScanning(true); setScanMsg(null);
    try {
      let offset = 0, scanned = 0, alerts = 0, vueltas = 0;
      for (;;) {
        const res = await fetch(`/api/churn/scan?offset=${offset}`, { method: 'POST' });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || 'El escaneo falló.');

        scanned += j.scanned ?? 0;
        alerts  += j.alerts ?? 0;
        offset   = j.nextOffset ?? offset;
        setScanMsg(`Escaneando… ${scanned} de ${j.total ?? '?'} alumnos.`);

        if (j.done) break;
        // Cortafuegos: si el servidor no avanza, no entrar en bucle infinito.
        if (++vueltas > 20 || (j.scanned ?? 0) === 0) break;
      }
      setScanMsg(`Escaneados ${scanned} alumnos · ${alerts} aviso(s) nuevo(s).`);
      await load();
    } catch (e) {
      setScanMsg((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  // Bajas antiguas que se registraron antes de que la baja manual capturara la
  // foto: su historial sigue en la base, así que se pueden recuperar.
  async function backfill() {
    setBackfilling(true); setScanMsg(null);
    try {
      const prev = await (await fetch('/api/churn/backfill')).json();
      if (prev?.error) throw new Error(prev.error);
      if (!prev.pendingStudents) {
        setScanMsg('No hay bajas antiguas pendientes: todas tienen su foto.');
        return;
      }
      const res = await fetch('/api/churn/backfill', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'La recuperación falló.');
      setScanMsg(`${j.captured} baja(s) recuperada(s)${j.failed ? `, ${j.failed} sin datos suficientes` : ''}.`);
      await load();
    } catch (e) {
      setScanMsg((e as Error).message);
    } finally {
      setBackfilling(false);
    }
  }

  const pct = data ? Math.min(100, Math.round((data.churnedCount / GOAL) * 100)) : 0;

  const card = (label: string, value: React.ReactNode, sub?: string) => (
    <div style={{ flex: 1, minWidth: 160, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Predicción de bajas</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3, maxWidth: 640, lineHeight: 1.5 }}>
            Fase de recopilación. Cada baja real registra las señales de sus últimas 10 clases para construir el dataset.
            Hasta reunir ~{GOAL} bajas (estimado 3 meses) las alertas son orientativas, no fiables.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={backfill} disabled={backfilling || scanning}
            title="Recupera las bajas que se registraron antes de que la baja manual guardara sus señales"
            style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: backfilling ? 'wait' : 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
            {backfilling ? 'Recuperando…' : 'Recuperar bajas antiguas'}
          </button>
          <button onClick={scanNow} disabled={scanning || backfilling}
            style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: scanning ? '#c8d3cb' : '#1E9E3A', color: 'white', cursor: scanning ? 'wait' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
            {scanning ? 'Escaneando…' : 'Escanear ahora'}
          </button>
        </div>
      </div>

      {scanMsg && (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 13px' }}>{scanMsg}</div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {card('Bajas registradas', `${data?.churnedCount ?? 0}`, `Meta ~${GOAL} para fiabilidad`)}
        {card('Alumnos escaneados', `${data?.studentsScanned ?? 0}`, `${data?.activeScannedCount ?? 0} fotos en total`)}
        {card('Superan el umbral de aviso', `${data?.aboveThreshold ?? 0}`, 'riesgo 65 o más')}
      </div>

      {/* Progreso del dataset */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 6 }}>
          <span>Progreso hacia una muestra fiable</span>
          <span><b style={{ color: 'var(--text-primary)' }}>{data?.churnedCount ?? 0}</b> / {GOAL}</span>
        </div>
        <div style={{ height: 10, borderRadius: 999, background: 'var(--bg-surface-3)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg,#1E9E3A,#34c256)', borderRadius: 999, transition: 'width 0.4s' }} />
        </div>
      </div>

      {/* Alumnos en riesgo */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)' }}>Cargando…</div>
      ) : (data?.atRisk.length ?? 0) === 0 ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)' }}>
          Todavía no hay ningún alumno escaneado. Pulsa «Escanear ahora».
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12 }}>
          <div style={{ padding: '10px 14px', fontSize: 12.5, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
            Alumnos con más riesgo según su última foto. Se muestran los {data!.atRisk.length} primeros,
            ordenados de mayor a menor, aunque no lleguen al umbral de aviso.
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)', textAlign: 'left' }}>
                {['Alumno', 'Riesgo', 'Sin actividad', 'Cancelaciones', 'Retrasos', 'Habla', 'Motivo (IA)', 'Última foto'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', fontWeight: 700, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data!.atRisk.map(s => (
                <tr key={s.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', fontWeight: 600 }}>
                    {s.studentName}{s.explicitQuit && <span title="Mencionó dejarlo" style={{ marginLeft: 6 }}>🚪</span>}
                  </td>
                  <td style={{ padding: '10px 12px', fontWeight: 800, color: riskColor(s.combinedRisk) }}>{s.combinedRisk ?? '—'}</td>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: (s.daysSinceLastClass ?? 0) > 30 ? '#dc2626' : (s.daysSinceLastClass ?? 0) > 14 ? '#ea580c' : 'var(--text-secondary)' }}>
                    {s.daysSinceLastClass == null ? '—' : `${s.daysSinceLastClass} d`}
                  </td>
                  <td style={{ padding: '10px 12px' }}>{s.cancellations ?? 0}</td>
                  <td style={{ padding: '10px 12px' }}>{s.lateCount ?? 0}</td>
                  <td style={{ padding: '10px 12px', color: s.speakingTrend === 'down' ? '#dc2626' : 'var(--text-secondary)' }}>
                    {s.speakingTrend === 'down' ? '↓ baja' : s.speakingTrend === 'up' ? '↑ sube' : s.speakingTrend === 'stable' ? '→ estable' : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', maxWidth: 320, color: 'var(--text-secondary)' }}>{s.aiReasoning ?? '—'}</td>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{fmtDate(s.capturedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
