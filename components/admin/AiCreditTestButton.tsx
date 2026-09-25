'use client';

// Tarjeta "Aviso de IA sin crédito" de la pestaña Uso de IA: explica el aviso y
// deja mandar uno de PRUEBA sin quedarse sin saldo (ver lib/aiCreditAlert.ts y
// app/api/admin/ai-credit-test).

import { useState } from 'react';

interface Resultado { notified?: boolean; emailed?: boolean; reason?: string; error?: string }

function describir(r: Resultado): { ok: boolean; texto: string } {
  if (r.error) return { ok: false, texto: r.error };
  if (r.emailed) return { ok: true, texto: 'Prueba enviada: revisa tu correo y la campanita del admin.' };
  if (r.reason === 'falta AI_ALERT_EMAIL') {
    return { ok: false, texto: 'El aviso llegó a la campanita, pero NO salió email: falta crear la variable AI_ALERT_EMAIL en Vercel.' };
  }
  return { ok: false, texto: `No se pudo enviar el email${r.reason ? `: ${r.reason}` : '.'}` };
}

export default function AiCreditTestButton() {
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);

  async function probar() {
    setEnviando(true);
    setAviso(null);
    try {
      const res = await fetch('/api/admin/ai-credit-test', { method: 'POST' });
      setAviso(describir(await res.json().catch(() => ({ error: 'Respuesta inválida del servidor.' }))));
    } catch {
      setAviso({ ok: false, texto: 'No se pudo contactar con el servidor.' });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px',
      background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Aviso de IA sin crédito</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Si Anthropic rechaza una petición por falta de saldo, llega un email (como mucho uno al día) y
        un aviso a la campanita. Con este botón mandas uno de <b>prueba</b>: no gasta saldo ni el aviso real del día.
      </div>
      <div>
        <button type="button" className="adm-btn adm-btn-ghost" disabled={enviando} onClick={probar}>
          {enviando ? 'Enviando…' : 'Enviar aviso de prueba'}
        </button>
      </div>
      {aviso && (
        <div role="status" style={{ fontSize: 13, color: aviso.ok ? '#067647' : '#B42318' }}>{aviso.texto}</div>
      )}
    </div>
  );
}
