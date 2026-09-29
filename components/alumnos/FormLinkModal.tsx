'use client';

// Gestión del FORMULARIO INICIAL de un alumno desde su ficha:
//   · ver el enlace vigente y su estado (pendiente / completado / expirado)
//   · copiar el enlace o el email ya redactado
//   · REGENERAR TODO (30/09/2026): el alumno empieza de cero con el formulario
//     Y la prueba de nivel. Lo anterior queda como historial y los enlaces viejos
//     llevan a los nuevos (app/api/students/regenerate-all). Si el alumno ya hizo
//     algo, se pide confirmación diciendo qué.

import { useEffect, useRef, useState } from 'react';
import {
  buildFormEmail, buildFormUrl, fetchFormTokensIndex, formStateOf, lookupToken,
  generateFormToken,
  type FormState, type GenerateTokenPayload,
} from '@/lib/formClient';
import type { OnboardingStatus } from '@/lib/onboardingStatus';
import { btnPrimary, btnSecondary } from '@/components/alumnos/ui';

const STATE_LABEL: Record<FormState, { text: string; bg: string; color: string }> = {
  none:      { text: 'Sin enviar',            bg: 'rgba(120,120,120,0.12)', color: '#4b5563' },
  pending:   { text: 'Enviado — pendiente',   bg: 'rgba(120,120,120,0.12)', color: '#4b5563' },
  completed: { text: 'Completado',            bg: 'rgba(30,158,58,0.14)',   color: '#166534' },
  expired:   { text: 'Enlace expirado',       bg: 'rgba(249,115,22,0.12)',  color: '#c2410c' },
};

/** Una frase para el botón y el menú: qué hace, sin confundirlo con "Reiniciar perfil de IA". */
export const REGENERATE_ALL_HINT = 'El alumno repite el formulario y la prueba de nivel. Lo anterior queda guardado como historial.';

const fecha = (iso: string | null) => iso
  ? new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Madrid' })
  : '';

/**
 * Qué hizo ya el alumno, en una frase, para la confirmación. null si no hizo
 * nada (entonces se regenera sin preguntar: no hay nada que perder).
 */
function resumenHecho(st: OnboardingStatus): string | null {
  const partes: string[] = [];
  if (st.form.state === 'completed') partes.push(`completó el formulario el ${fecha(st.form.completedAt)}`);
  if (st.test.state === 'completed') {
    partes.push(`hizo la prueba de nivel el ${fecha(st.test.completedAt)}${st.test.cefr ? ` con nivel ${st.test.cefr}` : ''}`);
  } else if (st.test.state === 'in_progress') {
    partes.push(`tiene la prueba de nivel a medias (${st.test.answered} respuesta${st.test.answered === 1 ? '' : 's'})`);
  }
  if (!partes.length) return null;
  const frase = partes.length === 1 ? partes[0] : `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`;
  return `Ya ${frase}. Si regeneras, tendrá que hacer el formulario y la prueba de nuevo. Lo anterior quedará guardado como historial.`;
}

export default function FormLinkModal({ payload, initialUrl, startWithRegenerate, onClose, onToast, onRegenerated }: {
  payload: GenerateTokenPayload;
  /** Enlace recién creado: se muestra ya listo. */
  initialUrl?: string | null;
  /** Abierto desde "Regenerar todo" del menú: va directo a la confirmación. */
  startWithRegenerate?: boolean;
  onClose: () => void;
  onToast: (m: string) => void;
  /** Tras regenerar, para que la ficha refresque el estado y el historial. */
  onRegenerated?: () => void;
}) {
  const [url, setUrl] = useState<string | null>(initialUrl ?? null);
  const [state, setState] = useState<FormState>(initialUrl ? 'pending' : 'none');
  const [loading, setLoading] = useState(!initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Confirmación de "Regenerar todo": la frase con lo que ya hizo el alumno.
  const [confirmText, setConfirmText] = useState<string | null>(null);

  // Al abrir: enlace vigente del alumno (o uno nuevo si no hay ninguno).
  useEffect(() => {
    if (initialUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const index = await fetchFormTokensIndex();
        const existing = lookupToken(index, { id: payload.studentId, name: payload.studentName });
        const st = formStateOf(existing);
        if (existing && st !== 'expired') {
          if (!cancelled) { setUrl(buildFormUrl(existing.token)); setState(st); }
        } else {
          const created = await generateFormToken(payload);
          if (!cancelled) { setUrl(created.formUrl); setState('pending'); }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'No se pudo obtener el enlace.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copy(text: string, msg: string) {
    try {
      await navigator.clipboard.writeText(text);
      onToast(msg);
    } catch {
      onToast('No se pudo copiar automáticamente. Copialo a mano.');
    }
  }

  // Paso 1: mirar qué hizo ya el alumno. Si hizo algo, se confirma; si no, se
  // regenera directamente.
  async function startRegenerate() {
    setBusy(true); setError(''); setNotice('');
    try {
      const qs = new URLSearchParams({ studentName: payload.studentName });
      if (payload.studentId) qs.set('studentId', payload.studentId);
      const res = await fetch(`/api/students/onboarding-status?${qs}`, { cache: 'no-store' });
      const st = await res.json().catch(() => null);
      if (!res.ok || !st) throw new Error(st?.error || 'No se pudo comprobar qué ha hecho ya el alumno.');
      const texto = resumenHecho(st as OnboardingStatus);
      if (texto) { setConfirmText(texto); setBusy(false); return; }
      await regenerateAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo regenerar.');
      setBusy(false);
    }
  }

  // Paso 2: regenerar de verdad.
  async function regenerateAll() {
    setBusy(true); setError(''); setConfirmText(null);
    try {
      const res = await fetch('/api/students/regenerate-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'No se pudo regenerar.');
      setUrl(data.formUrl);
      setState('pending');
      setNotice('Listo: formulario y prueba de nivel nuevos. Los enlaces anteriores llevan a los nuevos y lo de antes queda en el historial de la ficha. Envíale este enlace al alumno.');
      onRegenerated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo regenerar.');
    } finally {
      setBusy(false);
    }
  }

  // Desde el menú "Regenerar todo": en cuanto el modal tiene su enlace, pregunta.
  const arrancado = useRef(false);
  useEffect(() => {
    if (!startWithRegenerate || loading || arrancado.current) return;
    arrancado.current = true;
    void startRegenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startWithRegenerate, loading]);

  const email = url ? buildFormEmail(payload.studentName, payload.teacherName, url) : null;
  const badge = STATE_LABEL[state];

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="sp" style={{ background: '#fff', borderRadius: 14, padding: 24, maxWidth: 520, width: '100%', margin: 0, maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Formulario inicial</div>
          <span style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 9px', borderRadius: 10, fontSize: 11.5, fontWeight: 700, background: badge.bg, color: badge.color }}>
            {badge.text}
          </span>
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--sp-t2)', lineHeight: 1.6, marginBottom: 16 }}>
          Enlace único de {payload.studentName} para completar el formulario. Caduca a los 30 días.
        </div>

        {notice && (
          <div style={{ marginBottom: 14, padding: '10px 13px', borderRadius: 9, background: '#fffdf5', border: '1px solid #f2e2c9', color: '#9a6516', fontSize: 13, lineHeight: 1.5 }}>
            {notice}
          </div>
        )}
        {error && (
          <div style={{ marginBottom: 14, padding: '10px 13px', borderRadius: 9, background: 'rgba(220,38,38,0.07)', color: '#B91C1C', fontSize: 13, lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ fontSize: 13.5, color: 'var(--sp-t3)' }}>Generando enlace…</div>
        ) : url ? (
          <>
            <div className="sp-linkbox">{url}</div>
            <div className="sp-btn-row" style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              <button onClick={() => copy(url, 'Link del formulario copiado')} style={btnPrimary}>Copiar link</button>
              {email && (
                <button
                  onClick={() => copy(`Asunto: ${email.subject}\n\n${email.body}`, 'Email copiado — pegalo en Gmail')}
                  style={btnSecondary}
                >
                  Copiar email
                </button>
              )}
              <a href={url} target="_blank" rel="noopener noreferrer" style={{ ...btnSecondary, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
                Abrir
              </a>
            </div>

            {email && (
              <details style={{ marginTop: 16 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--sp-t2)' }}>Ver el email que se envía</summary>
                <div style={{ marginTop: 10, padding: '12px 14px', borderRadius: 9, background: '#fbfbf9', border: '1px solid var(--border)', fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--sp-t2)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>{email.subject}</div>
                  {email.body}
                </div>
              </details>
            )}

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              {confirmText ? (
                <div role="alertdialog" aria-label="Confirmar regenerar todo" style={{ padding: '12px 14px', borderRadius: 10, background: '#fffdf5', border: '1px solid #f2e2c9' }}>
                  <div style={{ fontSize: 13.5, color: '#7a4d05', lineHeight: 1.6 }}>{confirmText}</div>
                  <div className="sp-btn-row" style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                    <button onClick={() => setConfirmText(null)} disabled={busy} style={{ ...btnSecondary, flex: 1 }}>Cancelar</button>
                    <button onClick={regenerateAll} disabled={busy} style={{ ...btnPrimary, flex: 1, opacity: busy ? 0.6 : 1 }}>
                      {busy ? 'Regenerando…' : 'Regenerar todo'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 12.5, color: 'var(--sp-t3)', lineHeight: 1.6, marginBottom: 10 }}>
                    {REGENERATE_ALL_HINT} Úsalo también si perdió el enlace o se lo mandaste a un email equivocado.
                  </div>
                  <button onClick={startRegenerate} disabled={busy} title={REGENERATE_ALL_HINT} style={{ ...btnSecondary, opacity: busy ? 0.6 : 1 }}>
                    {busy ? 'Comprobando…' : 'Regenerar todo'}
                  </button>
                </>
              )}
            </div>
          </>
        ) : null}

        <button onClick={onClose} disabled={busy} style={{ ...btnSecondary, width: '100%', marginTop: 18 }}>Cerrar</button>
      </div>
    </div>
  );
}
