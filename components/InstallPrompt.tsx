'use client';
import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'drc_install_dismissed';

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOSHint, setShowIOSHint] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Don't show if already dismissed
    if (localStorage.getItem(DISMISSED_KEY) === '1') return;

    // Don't show if already running as standalone PWA
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if ((window.navigator as Navigator & { standalone?: boolean }).standalone === true) return;

    // Detect iOS Safari (no beforeinstallprompt support)
    const ua = window.navigator.userAgent;
    const isIOS = /iphone|ipad|ipod/i.test(ua);
    const isSafari = /safari/i.test(ua) && !/chrome|crios|fxios/i.test(ua);
    if (isIOS && isSafari) {
      setShowIOSHint(true);
      setVisible(true);
      return;
    }

    // Android/Chrome: wait for beforeinstallprompt
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, '1');
    setVisible(false);
  }

  async function handleInstall() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setVisible(false);
    }
    setDeferredPrompt(null);
  }

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 20,
      left: 16,
      right: 16,
      zIndex: 9999,
      maxWidth: 420,
      margin: '0 auto',
      background: 'white',
      border: '1.5px solid #1E9E3A',
      borderRadius: 14,
      padding: '14px 16px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/icons/icon-192.png" alt="DRC" style={{ width: 36, height: 36, borderRadius: 8, flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>DRC Gestión</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Instalá la app en tu dispositivo</div>
          </div>
        </div>
        <button
          onClick={dismiss}
          aria-label="Cerrar"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#9ca3af', fontSize: 20, lineHeight: 1,
            padding: '2px 6px', borderRadius: 6, flexShrink: 0,
          }}>
          ✕
        </button>
      </div>

      {/* iOS hint */}
      {showIOSHint && (
        <div style={{ fontSize: 13, color: '#374151', background: 'rgba(30,158,58,0.08)', border: '1px solid rgba(30,158,58,0.25)', borderRadius: 9, padding: '10px 12px', lineHeight: 1.5 }}>
          Para instalar: tocá <b>Compartir</b> (icono cuadrado con flecha) y luego <b>&quot;Agregar a inicio&quot;</b>
        </div>
      )}

      {/* Android install button */}
      {deferredPrompt && (
        <button
          onClick={handleInstall}
          style={{
            background: '#1E9E3A',
            color: 'white',
            border: 'none',
            borderRadius: 9,
            padding: '11px 16px',
            fontSize: 14,
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            minHeight: 44,
          }}>
          📲 Instalar DRC Gestión
        </button>
      )}
    </div>
  );
}
