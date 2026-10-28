'use client';

// Puesta al día de la OFERTA NUEVA (simular / aplicar), junto a la de planes de
// empresa en el dashboard. Llama a /api/admin/planes-oferta: GET calcula la tabla
// sin escribir nada, POST la aplica. Las reglas viven en lib/planOrders.

import { useMemo, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { adminFetch } from '@/lib/adminSessionClient';
import { RESULT_LABEL, type PlanEvent } from '@/lib/planOrders';

interface SyncResult { applied: boolean; since: string; today: string; tableMissing: boolean; events: PlanEvent[]; errors: string[] }

const GREEN = { color: '#1f7a3d', bg: 'rgba(30,158,58,0.12)' };
const AMBER = { color: '#9a6516', bg: 'rgba(255,196,0,0.18)' };
const GRAY  = { color: 'var(--text-muted)', bg: 'var(--bg-surface-3)' };
const STYLE: Record<string, { color: string; bg: string }> = {
  activado: GREEN, ampliado: GREEN, vinculado: GREEN,
  conserva_fecha: AMBER, sin_alumno: AMBER, sin_regla: AMBER, reembolsado: AMBER,
  sin_cambios: GRAY, ya_procesado: GRAY,
};

const fmt = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');

export function PlanOfferSyncPanel() {
  const { user } = useAuth();
  const { reloadAll } = useTeachers();
  const creds = useMemo(() => (user ? { username: user.username, password: user.password } : null), [user]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(method: 'GET' | 'POST') {
    if (method === 'POST' && !window.confirm('¿Aplicar la tabla? Escribe fechas de acceso y el plan de cada alumno.')) return;
    setRunning(true); setError(null);
    try {
      const res = await adminFetch('/api/admin/planes-oferta', { method, cache: 'no-store' }, creds);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `Error ${res.status}`);
      setResult(data as SyncResult);
      if (method === 'POST') await reloadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo ejecutar.');
    } finally {
      setRunning(false);
    }
  }

  const count = (r: string) => result?.events.filter(e => e.result === r).length ?? 0;

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Oferta nueva (programas y mensuales)</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>
        Pedidos y suscripciones desde el 06/10/2026. Pago único: activa hasta fecha de pago + meses del programa, sin acortar nunca
        una fecha vigente. Suscripciones: apunta el plan para el cupo, sin tocar el acceso.
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <button onClick={() => run('GET')} disabled={running}
          style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
          {running ? 'Calculando...' : 'Simular (no escribe nada)'}
        </button>
        <button onClick={() => run('POST')} disabled={running}
          style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: running ? '#8fc7a0' : '#1E9E3A', color: 'white', cursor: running ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' }}>
          {running ? 'Aplicando...' : 'Aplicar'}
        </button>
      </div>

      {error && <div style={{ marginTop: 12, fontSize: 13, color: '#c73a28', lineHeight: 1.5 }}>{error}</div>}

      {result && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: result.applied ? '#1f7a3d' : 'var(--text-secondary)', lineHeight: 1.6 }}>
            {result.applied ? '✅ Aplicado' : '🔍 Simulación'} · {count('activado')} activados · {count('ampliado')} ampliados ·{' '}
            {count('conserva_fecha')} conservan su fecha · {count('vinculado')} planes apuntados ·{' '}
            {count('sin_alumno') + count('sin_regla') + count('reembolsado')} avisos
            {result.tableMissing && <> · <span style={{ color: '#c73a28' }}>falta correr el SQL (no se puede aplicar)</span></>}
            {result.errors.length > 0 && <> · <span style={{ color: '#c73a28' }}>{result.errors.length} error(es)</span></>}
          </div>
          <div style={{ marginTop: 12, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 760 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                  {['Origen', 'Alumno', 'Producto', 'Pago', 'Fin calculado', 'Antes', 'Queda', 'Resultado'].map(h =>
                    <th key={h} style={{ padding: '6px 8px', fontWeight: 600 }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {result.events.map(e => {
                  const st = STYLE[e.result] ?? GRAY;
                  return (
                    <tr key={`${e.sourceType}:${e.sourceId}:${e.productId}`} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{e.sourceType === 'order' ? 'Pedido' : 'Suscr.'} {e.sourceId}</td>
                      <td style={{ padding: '6px 8px' }}>{e.studentName ?? <span style={{ color: 'var(--text-muted)' }}>{e.billingName || e.email}</span>}</td>
                      <td style={{ padding: '6px 8px' }}>{e.productName}</td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmt(e.start)}</td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmt(e.computedUntil)}</td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmt(e.previousUntil)}</td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{fmt(e.finalUntil)}</td>
                      <td style={{ padding: '6px 8px' }} title={e.note}>
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontWeight: 700, fontSize: 11, background: st.bg, color: st.color, whiteSpace: 'nowrap' }}>
                          {RESULT_LABEL[e.result]}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
