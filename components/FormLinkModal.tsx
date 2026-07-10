'use client';

// Modal para enviarle al alumno el link del formulario inicial.
// Reutiliza un token 'pending' si existe; si no, genera uno nuevo.

import { useEffect, useState, type CSSProperties } from 'react';
import {
  buildFormUrl, buildFormEmail, generateFormToken, formStateOf, type FormTokenInfo,
} from '@/lib/formClient';

interface Props {
  student: { id?: string | null; name: string; email?: string | null };
  teacher: { id: string; name: string };
  assignment?: { id?: string | null; plan?: string | null; level?: string | null };
  existing?: FormTokenInfo | null;   // token ya conocido (del índice del padre)
  onClose: () => void;
  onGenerated?: () => void;          // avisar al padre para refrescar estados
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
}

export default function FormLinkModal({ student, teacher, assignment, existing, onClose, onGenerated }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toEmail, setToEmail] = useState(student.email ?? '');
  const [toast, setToast] = useState<string | null>(null);
  const reused = !!existing && formStateOf(existing) === 'pending';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Reutilizamos el token si sigue pendiente; si no, generamos uno nuevo.
      if (existing && formStateOf(existing) === 'pending') {
        if (!cancelled) { setUrl(buildFormUrl(existing.token)); setLoading(false); }
        return;
      }
      try {
        const { formUrl } = await generateFormToken({
          studentId: student.id ?? undefined,
          studentName: student.name,
          studentEmail: student.email ?? undefined,
          teacherId: teacher.id,
          teacherName: teacher.name,
          assignmentId: assignment?.id ?? undefined,
          plan: assignment?.plan ?? undefined,
          level: assignment?.level ?? undefined,
        });
        if (!cancelled) { setUrl(formUrl); onGenerated?.(); }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'No se pudo generar el link.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const email = url ? buildFormEmail(student.name, teacher.name, url) : null;

  function openMail() {
    if (!email) return;
    const mailto = `mailto:${toEmail.trim()}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`;
    window.location.href = mailto;
  }
  async function copyLink() {
    if (!url) return;
    await copyText(url);
    setToast('📋 Link copiado');
    setTimeout(() => setToast(null), 1600);
  }
  async function copyEmail() {
    if (!email) return;
    await copyText(`Para: ${toEmail.trim()}\nAsunto: ${email.subject}\n\n${email.body}`);
    setToast('📋 Email copiado — pegalo en Gmail');
    setTimeout(() => setToast(null), 1800);
  }

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        <div style={{ fontWeight: 800, fontSize: 17, color: '#1E9E3A', marginBottom: 6 }}>
          📋 Formulario inicial — {student.name}
        </div>
        <div style={{ height: 3, width: 48, background: '#FFC400', borderRadius: 2, marginBottom: 16 }} />

        {loading ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
            Generando link…
          </div>
        ) : error ? (
          <div style={{ padding: '14px 16px', borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.4)', color: '#b91c1c', fontSize: 14, fontWeight: 600 }}>
            {error}
          </div>
        ) : (
          <>
            {reused && (
              <div style={{ fontSize: 12.5, color: '#92400E', background: 'rgba(255,196,0,0.14)', border: '1px solid rgba(255,196,0,0.45)', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
                ⏳ Este alumno ya tenía un link pendiente. Podés reenviarlo.
              </div>
            )}

            <label style={fieldLabel}>Para (email del alumno)</label>
            <input value={toEmail} onChange={e => setToEmail(e.target.value)} placeholder="alumno@email.com"
              style={{ ...lightInput, marginBottom: 14 }} />

            <label style={fieldLabel}>Link del formulario</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input readOnly value={url ?? ''} style={{ ...lightInput, flex: 1, background: '#f3f4f6' }}
                onFocus={e => e.currentTarget.select()} />
              <button onClick={copyLink} style={{ ...ghostBtn, whiteSpace: 'nowrap' }}>📋 Copiar link</button>
            </div>

            <label style={fieldLabel}>Vista previa del email</label>
            <div style={{ fontSize: 12.5, color: '#374151', background: 'white', border: '1px solid #d1d5db', borderRadius: 8, padding: '12px 14px', whiteSpace: 'pre-wrap', lineHeight: 1.5, maxHeight: 220, overflowY: 'auto', marginBottom: 18 }}>
              <b>Asunto:</b> {email?.subject}{'\n\n'}{email?.body}
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={onClose} style={{ ...ghostBtn, flex: '1 1 80px', borderColor: '#d1d5db', color: '#6b7280' }}>
                Cerrar
              </button>
              <button onClick={copyEmail} style={{ ...ghostBtn, flex: '1 1 120px' }}>📋 Copiar email</button>
              <button onClick={openMail} disabled={!toEmail.trim()}
                style={{ flex: '2 1 180px', padding: '11px', borderRadius: 8, border: 'none', background: toEmail.trim() ? '#1E9E3A' : '#d1d5db', color: 'white', cursor: toEmail.trim() ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 800, fontFamily: 'inherit' }}>
                📧 Abrir en gestor de correo
              </button>
            </div>
          </>
        )}
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: '#1E9E3A', color: 'white', padding: '10px 22px', borderRadius: 24, fontSize: 14, fontWeight: 700, zIndex: 120, boxShadow: '0 4px 16px rgba(0,0,0,0.25)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
  zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
};
const modal: CSSProperties = {
  background: '#F7F7F5', border: '2px solid #1E9E3A', borderRadius: 16, padding: 24,
  width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto',
};
const fieldLabel: CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 };
const lightInput: CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db',
  background: 'white', color: '#111827', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box',
};
const ghostBtn: CSSProperties = {
  padding: '10px 14px', borderRadius: 8, border: '1.5px solid #1E9E3A', background: 'white',
  color: '#1E9E3A', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
};
