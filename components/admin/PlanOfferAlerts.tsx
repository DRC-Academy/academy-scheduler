'use client';

// Avisos de la OFERTA NUEVA en el listado de alumnos (solo admin): productos sin
// regla, pedidos o suscripciones sin alumno, planes de 2 personas con la segunda
// sin vincular, pedidos activados y después reembolsados. Los genera
// lib/planOrders; acá solo se listan y se marcan como revisados.
//
// Sin la sesión de servidor de admin, o sin la tabla (SQL sin correr), no pinta
// nada: es un aviso, no puede romper la página.

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { adminFetch } from '@/lib/adminSessionClient';

interface Alert {
  key: string; sourceType: string; sourceId: number; productId: number;
  productName: string; result: string; note: string; email: string; billingName: string; createdAt: string;
}

const KIND: Record<string, string> = {
  sin_regla: 'Producto sin regla',
  sin_alumno: 'Sin alumno',
  reembolsado: 'Reembolsado',
};

export function PlanOfferAlerts() {
  const { user } = useAuth();
  const creds = useMemo(() => (user ? { username: user.username, password: user.password } : null), [user]);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    adminFetch('/api/admin/planes-oferta/avisos', { cache: 'no-store' }, creds)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { alerts?: Alert[] } | null) => { if (!cancelled) setAlerts(d?.alerts ?? []); })
      .catch(() => { if (!cancelled) setAlerts([]); });
    return () => { cancelled = true; };
  }, [creds]);

  async function resolve(key: string) {
    setBusy(key);
    try {
      const r = await adminFetch('/api/admin/planes-oferta/avisos', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
      }, creds);
      if (r.ok) setAlerts(prev => (prev ?? []).filter(a => a.key !== key));
    } finally {
      setBusy(null);
    }
  }

  if (!alerts || alerts.length === 0) return null;

  return (
    <div style={{ marginBottom: 16, border: '1px solid rgba(180,83,9,0.35)', background: 'rgba(255,196,0,0.08)', borderRadius: 12, padding: '12px 14px' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#92400e' }}>
          ⚠️ {alerts.length} aviso{alerts.length !== 1 ? 's' : ''} de planes de la oferta nueva
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#92400e' }}>{open ? 'Ocultar' : 'Ver'}</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {alerts.map(a => (
            <div key={a.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px' }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                  {a.result === 'sin_regla' ? a.note : `${KIND[a.result] ?? 'Revisar'} · ${a.productName}`}
                </div>
                {a.result !== 'sin_regla' && <div style={{ wordBreak: 'break-word' }}>{a.note}</div>}
                <div style={{ color: 'var(--text-muted)' }}>
                  {a.sourceType === 'order' ? 'Pedido' : 'Suscripción'} {a.sourceId} · {a.billingName || 'sin nombre'} · {a.email || 'sin email'}
                </div>
              </div>
              <button onClick={() => resolve(a.key)} disabled={busy === a.key}
                style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: busy === a.key ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                {busy === a.key ? '...' : 'Marcar revisado'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
