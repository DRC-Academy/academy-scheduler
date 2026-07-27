'use client';

// Gestión del FORMULARIO INICIAL de un alumno desde su ficha:
//   · ver el enlace vigente y su estado (pendiente / completado / expirado)
//   · copiar el enlace o el email ya redactado
//   · REGENERAR el enlace (el anterior deja de funcionar)
//
// Cuándo se regenera: el enlace caducó, el alumno lo perdió, o se envió a un
// email equivocado.

import { useEffect, useState } from 'react';
import {
  buildFormEmail, buildFormUrl, fetchFormTokensIndex, formStateOf, lookupToken,
  regenerateFormLink, generateFormToken,
  type FormState, type GenerateTokenPayload,
} from '@/lib/formClient';
import { btnPrimary, btnSecondary } from '@/components/alumnos/ui';

const STATE_LABEL: Record<FormState, { text: string; bg: string; color: string }> = {
  none:      { text: 'Sin enviar',            bg: 'rgba(120,120,120,0.12)', color: '#4b5563' },
  pending:   { text: 'Enviado — pendiente',   bg: 'rgba(120,120,120,0.12)', color: '#4b5563' },
  completed: { text: 'Completado',            bg: 'rgba(30,158,58,0.14)',   color: '#166534' },
  expired:   { text: 'Enlace expirado',       bg: 'rgba(249,115,22,0.12)',  color: '#c2410c' },
};

export default function FormLinkModal({ payload, initialUrl, onClose, onToast }: {
  payload: GenerateTokenPayload;
  /** Enlace recién creado (p. ej. tras reiniciar el perfil): se muestra ya listo. */
  initialUrl?: string | null;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(initialUrl ?? null);
  const [state, setState] = useState<FormState>(initialUrl ? 'pending' : 'none');
  const [loading, setLoading] = useState(!initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(initialUrl ? 'Se ha generado un nuevo enlace. El anterior ya no funciona.' : '');

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

  async function handleRegenerate() {
    setBusy(true); setError(''); setNotice('');
    try {
      const { formUrl } = await regenerateFormLink(payload);
      setUrl(formUrl);
      setState('pending');
      setNotice('Se ha generado un nuevo enlace. El anterior ya no funciona.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo regenerar el enlace.');
    } finally {
      setBusy(false);
    }
  }

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
              <div style={{ fontSize: 12.5, color: 'var(--sp-t3)', lineHeight: 1.6, marginBottom: 10 }}>
                ¿El alumno perdió el enlace, caducó o lo mandaste a un email equivocado?
              </div>
              <button onClick={handleRegenerate} disabled={busy} style={{ ...btnSecondary, opacity: busy ? 0.6 : 1 }}>
                {busy ? 'Regenerando…' : 'Regenerar enlace'}
              </button>
            </div>
          </>
        ) : null}

        <button onClick={onClose} disabled={busy} style={{ ...btnSecondary, width: '100%', marginTop: 18 }}>Cerrar</button>
      </div>
    </div>
  );
}
