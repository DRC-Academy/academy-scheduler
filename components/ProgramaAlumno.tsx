// Línea del PROGRAMA del alumno (oferta de oct/2026): programa, forma de pago,
// fecha de inicio y de fin, y el aviso si algo va mal (cuota pendiente, pedido
// reembolsado…). La ven el admin (tarjeta del panel de alumnos, con el nº de
// pedido) y el profesor (su ficha). No pinta nada si el alumno no tiene programa.
//
// EnlazarProgramaModal: enlace MANUAL de un pedido por número, desde el menú ⋮
// del panel de alumnos (programas de menores: factura el padre con otro email).

'use client';

import { useState } from 'react';
import {
  currentProgram, programFullLabel, formatDateEs, isOrderPaid, daysBetween,
  type StudentProgramRow,
} from '@/lib/programs';
import { madridToday } from '@/lib/subscriptionAccess';

interface AdminProps {
  studentId: string;
  /** Quién enlaza (queda en student_programs.linked_by). */
  by: string;
  onChanged: () => void | Promise<void>;
}

function estadoDe(r: StudentProgramRow, today: string): { text: string; color: string } | null {
  if (!isOrderPaid(r.order_status)) return { text: 'pedido cancelado o reembolsado', color: '#dc2626' };
  if (r.payment_mode === 'fraccionado') {
    if (r.subscription_status === 'on-hold') return { text: 'cuota pendiente', color: '#92400e' };
    if (r.subscription_status === 'cancelled') return { text: 'suscripción cancelada', color: '#dc2626' };
  }
  if (r.end_date && r.end_date < today) return { text: 'terminado', color: '#dc2626' };
  return null;
}

export default function ProgramaAlumno({ programs, showOrder, compact }: {
  programs: StudentProgramRow[];
  /** Admin: muestra el nº de pedido y si se enlazó a mano. */
  showOrder?: boolean;
  compact?: boolean;
}) {
  const today = madridToday();
  const row = currentProgram(programs, today);
  if (!row) return null;

  const estado = estadoDe(row, today);
  const dias = row.end_date ? daysBetween(today, row.end_date) : null;

  return (
    <div style={{
      marginTop: compact ? 6 : 10, padding: compact ? '6px 10px' : '10px 12px', borderRadius: 10,
      border: '1px solid var(--border)', background: 'var(--bg-surface-2, var(--bg-surface))',
      fontSize: 12, color: 'var(--text-secondary)',
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px',
    }}>
      <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>🎓 {programFullLabel(row)}</span>
      <span>Inicio: <b>{formatDateEs(row.start_date)}</b></span>
      <span title={row.end_date_source === 'calculada' && row.payment_mode === 'fraccionado' ? 'Calculada desde la fecha de pago: Woo no dio la fecha de fin de la suscripción' : undefined}>
        Fin: <b>{formatDateEs(row.end_date)}</b>
        {row.end_date_source === 'calculada' && row.payment_mode === 'fraccionado' ? '*' : ''}
        {dias != null && dias >= 0 ? ` (${dias === 0 ? 'hoy' : `${dias} d`})` : ''}
      </span>
      {estado && <span style={{ fontWeight: 700, color: estado.color }}>· {estado.text}</span>}
      {showOrder && (
        <span style={{ color: 'var(--text-muted)' }}>
          · pedido #{row.order_id}{row.link_source === 'manual' ? ' (enlazado a mano)' : ''}
        </span>
      )}
    </div>
  );
}

/** Ventana para enlazar a mano un pedido de programa con un alumno (admin). */
export function EnlazarProgramaModal({ studentName, programs, admin, onClose }: {
  studentName: string;
  programs: StudentProgramRow[];
  admin: AdminProps;
  onClose: () => void;
}) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 440, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 18, fontSize: 13, color: 'var(--text-secondary)' }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)', marginBottom: 4 }}>🔗 Enlazar pedido de programa</div>
        <div style={{ marginBottom: 12 }}>Alumno: <b>{studentName}</b></div>
        <EnlazarForm admin={admin} programs={programs} onClose={onClose} />
      </div>
    </div>
  );
}

function EnlazarForm({ admin, programs, onClose }: { admin: AdminProps; programs: StudentProgramRow[]; onClose: () => void }) {
  const [order, setOrder] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const manuales = programs.filter(p => p.link_source === 'manual' && p.student_id === admin.studentId);

  async function call(method: 'POST' | 'DELETE', orderId: string) {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/programas/enlazar', {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, studentId: admin.studentId, by: admin.by }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ ok: false, text: data?.error ?? `Error ${res.status}` }); return; }
      setMsg({ ok: true, text: method === 'POST' ? `Pedido #${orderId} enlazado.` : `Enlace del pedido #${orderId} quitado.` });
      setOrder('');
      await admin.onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={order} onChange={e => setOrder(e.target.value)} inputMode="numeric" placeholder="Nº de pedido (ej. 35123)"
          style={{ flex: '1 1 160px', minWidth: 0, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit' }}
        />
        <button type="button" disabled={busy || !order.trim()} onClick={() => call('POST', order.trim())}
          style={{ ...primaryBtn, opacity: busy || !order.trim() ? 0.6 : 1 }}>
          {busy ? 'Enlazando…' : 'Enlazar'}
        </button>
        <button type="button" onClick={onClose} style={linkBtn}>Cerrar</button>
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
        Para cuando el pedido lo pagó otra persona (padre o madre) con otro email. La sincronización no pisa este enlace.
      </div>
      {manuales.map(p => (
        <div key={p.order_id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Pedido #{p.order_id} enlazado a mano{p.linked_by ? ` por ${p.linked_by}` : ''}</span>
          <button type="button" disabled={busy} onClick={() => call('DELETE', String(p.order_id))} style={linkBtn}>Quitar enlace</button>
        </div>
      ))}
      {msg && <div style={{ fontWeight: 600, color: msg.ok ? '#1E9E3A' : '#dc2626' }}>{msg.text}</div>}
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, color: '#2563eb', cursor: 'pointer',
  fontSize: 12, fontWeight: 600, fontFamily: 'inherit', minHeight: 0,
};
const primaryBtn: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 8, border: 'none', background: '#1E9E3A', color: '#fff',
  fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
};
