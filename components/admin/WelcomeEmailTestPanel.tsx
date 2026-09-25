'use client';

// Tarjeta "Enviar bienvenida de prueba" de la pestaña Emails del admin.
//
// Manda el email de bienvenida de UNA asignación real a un destino de prueba,
// con "[PRUEBA]" en el asunto, para ver cómo le llegaría al alumno. No escribe
// nada en la base y funciona con el interruptor apagado (ver
// lib/welcomeEmailSend y app/api/admin/welcome-email-test).
//
// Al elegir la asignación avisa de lo que haría fallar el envío real: alumno
// sin email en su ficha o que no aparece en la plataforma de alumnos.

import { useMemo, useRef, useState } from 'react';
import type { Assignment } from '@/types';
import { WELCOME_EMAIL_ENABLED, WELCOME_VARIANT_LABEL, type WelcomeVariant } from '@/lib/welcomeEmail';

const VARIANTES: WelcomeVariant[] = ['bienvenida', 'cambio', 'adicional'];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export default function WelcomeEmailTestPanel({ assignments }: { assignments: Assignment[] }) {
  const [busqueda, setBusqueda] = useState('');
  const [assignmentId, setAssignmentId] = useState('');
  const [variant, setVariant] = useState<WelcomeVariant>('bienvenida');
  const [destino, setDestino] = useState('');
  const [avisos, setAvisos] = useState<string[] | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<{ ok: boolean; texto: string } | null>(null);

  const opciones = useMemo(() => {
    const q = norm(busqueda.trim());
    return [...assignments]
      .filter(a => (a.status ?? 'active') === 'active')
      .filter(a => !q || norm(`${a.studentName} ${a.teacherName}`).includes(q))
      .sort((x, y) => x.studentName.localeCompare(y.studentName, 'es'))
      .slice(0, 50);
  }, [assignments, busqueda]);

  // Al elegir la asignación: avisos del envío real y la variante que le tocaría.
  // `pedidaRef` descarta la respuesta si entretanto se eligió otra.
  const pedidaRef = useRef('');
  function elegir(id: string) {
    setAssignmentId(id);
    setResultado(null);
    setAvisos(null);
    pedidaRef.current = id;
    if (!id) return;
    fetch(`/api/admin/welcome-email-test?assignmentId=${encodeURIComponent(id)}`)
      .then(r => r.json())
      .then((d: { warnings?: string[]; suggestedVariant?: WelcomeVariant; error?: string }) => {
        if (pedidaRef.current !== id) return;
        setAvisos(d.error ? [d.error] : (d.warnings ?? []));
        if (d.suggestedVariant) setVariant(d.suggestedVariant);
      })
      .catch(() => { if (pedidaRef.current === id) setAvisos(['No se pudieron comprobar los datos del alumno.']); });
  }

  async function enviar() {
    setEnviando(true);
    setResultado(null);
    try {
      const res = await fetch('/api/admin/welcome-email-test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignmentId, variant, to: destino }),
      });
      const d = await res.json().catch(() => ({ error: 'Respuesta inválida del servidor.' })) as { ok?: boolean; error?: string; warnings?: string[] };
      if (d.warnings) setAvisos(d.warnings);
      setResultado(res.ok && d.ok
        ? { ok: true, texto: `Prueba enviada a ${destino.trim()}. Revisa la bandeja (y el spam).` }
        : { ok: false, texto: d.error ?? 'No se pudo enviar la prueba.' });
    } catch {
      setResultado({ ok: false, texto: 'No se pudo contactar con el servidor.' });
    } finally {
      setEnviando(false);
    }
  }

  const campo = { width: '100%', boxSizing: 'border-box' as const };
  const etiqueta = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 };

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', marginBottom: 20,
      background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Enviar bienvenida de prueba</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 4 }}>
          Manda el email de bienvenida de una asignación a tu correo, con «[PRUEBA]» en el asunto. No cambia
          nada en la base. Envío automático a los alumnos:{' '}
          <b style={{ color: WELCOME_EMAIL_ENABLED ? '#067647' : '#B42318' }}>{WELCOME_EMAIL_ENABLED ? 'activado' : 'apagado'}</b>.
        </div>
      </div>

      <div>
        <label style={etiqueta} htmlFor="wt-buscar">Asignación</label>
        <input id="wt-buscar" style={{ ...campo, marginBottom: 6 }} placeholder="Buscar por alumno o profesor…"
          value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        <select style={campo} value={assignmentId} onChange={e => elegir(e.target.value)}>
          <option value="">Elige una asignación…</option>
          {opciones.map(a => (
            <option key={a.id} value={a.id}>{a.studentName} · {a.teacherName}</option>
          ))}
        </select>
      </div>

      {avisos && avisos.length > 0 && (
        <div role="status" style={{ fontSize: 13, color: '#B54708', background: 'rgba(247,144,9,0.08)', border: '1px solid rgba(247,144,9,0.3)', borderRadius: 8, padding: '8px 10px', lineHeight: 1.5 }}>
          {avisos.map(t => <div key={t}>⚠️ {t}</div>)}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ flex: '1 1 180px' }}>
          <label style={etiqueta} htmlFor="wt-variante">Variante</label>
          <select id="wt-variante" style={campo} value={variant} onChange={e => setVariant(e.target.value as WelcomeVariant)}>
            {VARIANTES.map(v => <option key={v} value={v}>{WELCOME_VARIANT_LABEL[v]}</option>)}
          </select>
        </div>
        <div style={{ flex: '2 1 220px' }}>
          <label style={etiqueta} htmlFor="wt-destino">Enviar a</label>
          <input id="wt-destino" type="email" style={campo} placeholder="tu-email@drcacademy.com"
            value={destino} onChange={e => setDestino(e.target.value)} />
        </div>
      </div>

      <div>
        <button type="button" className="adm-btn adm-btn-ghost"
          disabled={enviando || !assignmentId || !destino.trim()} onClick={enviar}>
          {enviando ? 'Enviando…' : 'Enviar bienvenida de prueba'}
        </button>
      </div>

      {resultado && (
        <div role="status" style={{ fontSize: 13, color: resultado.ok ? '#067647' : '#B42318' }}>{resultado.texto}</div>
      )}
    </div>
  );
}
