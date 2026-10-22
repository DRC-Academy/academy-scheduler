'use client';
// ── Panel inferior: "Cambió cómo se cancelan y recuperan las clases" ─────────
//
// Anuncia la guía de penalizaciones (lib/penaltyGuide) a los PROFESORES hasta el
// GUIDE_BANNER_UNTIL inclusive. Sube desde abajo sin bloquear nada: centrado en
// escritorio y a todo el ancho en el teléfono.
//
//   · "Iniciar guía" abre el recorrido (mismo motor que el tutorial).
//   · "Más tarde" y la X lo esconden HASTA MAÑANA (día de España, por profesor,
//     en localStorage) o hasta el próximo inicio de sesión, que lo olvida
//     (AuthContext.login → forgetGuideLater). Si se pierde, el panel sale
//     antes, nunca se pierde la guía.
//   · Solo "Entendido" en el último paso lo apaga para siempre, y eso sí va a la
//     base (lib/penaltyGuideStore), así que vale en todos los dispositivos.
//
// Se monta una vez en components/Providers. Las reglas de cuándo sale son
// puras (`shouldShowGuideBanner`) y tienen su test.
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { useOnboarding } from '@/lib/OnboardingContext';
import { GUIDE_BANNER, laterKey, shouldShowGuideBanner, spainToday } from '@/lib/penaltyGuide';

function readLater(teacherId: string): string | null {
  try { return localStorage.getItem(laterKey(teacherId)); } catch { return null; }
}

function writeLater(teacherId: string, day: string): void {
  try { localStorage.setItem(laterKey(teacherId), day); } catch { /* modo privado */ }
}

export function PenaltyGuideBanner() {
  const { user } = useAuth();
  const { mode, penaltyGuideDone, openPenaltyGuide } = useOnboarding();
  const teacherId = user?.role === 'teacher' ? user.teacherId ?? null : null;

  // `today` y `laterOn` solo existen en el cliente: hasta montar no se pinta
  // nada, así el HTML del servidor no puede discrepar del primer render.
  const [today, setToday] = useState<string | null>(null);
  const [laterOn, setLaterOn] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToday(spainToday());
    setLaterOn(teacherId ? readLater(teacherId) : null);
  }, [teacherId]);

  if (!teacherId || !today) return null;
  const visible = shouldShowGuideBanner({
    role: user?.role, today, completedAt: penaltyGuideDone ? 'si' : null,
    laterOn, tourOpen: mode !== 'off',
  });
  if (!visible) return null;

  const later = () => { writeLater(teacherId, today); setLaterOn(today); };

  return (
    <div className="pgb-wrap" role="region" aria-labelledby="pgb-title">
      <style>{PGB_CSS}</style>
      <div className="pgb-top">
        <span className="pgb-tag">✨ {GUIDE_BANNER.tag}</span>
        <button type="button" className="pgb-x" onClick={later} aria-label="Cerrar, recordármelo mañana">×</button>
      </div>
      <div id="pgb-title" className="pgb-title">{GUIDE_BANNER.title}</div>
      <p className="pgb-body">{GUIDE_BANNER.body}</p>
      <div className="pgb-actions">
        <button type="button" className="pgb-btn pgb-btn-primary" onClick={openPenaltyGuide}>{GUIDE_BANNER.start}</button>
        <button type="button" className="pgb-btn pgb-btn-ghost" onClick={later}>{GUIDE_BANNER.later}</button>
      </div>
    </div>
  );
}

const PGB_CSS = `
.pgb-wrap {
  position: fixed; left: 0; right: 0; margin: 0 auto;
  bottom: calc(16px + env(safe-area-inset-bottom));
  width: min(560px, calc(100% - 32px)); box-sizing: border-box;
  z-index: 80; background: #fff; color: #1a1c1a;
  border: 1px solid #e4e5e1; border-radius: 16px;
  box-shadow: 0 12px 40px rgba(15, 20, 16, 0.18);
  padding: 14px 18px 16px; font-family: inherit;
  animation: pgb-in 0.32s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
/* El aviso de "Instalar app" también vive abajo y va por encima de todo: se
   sube el panel para que no se tapen entre los dos. */
body:has([data-install-prompt]) .pgb-wrap { bottom: calc(190px + env(safe-area-inset-bottom)); }
/* Con un modal abierto (pop-up de transcripts, "No puedo dar esta clase"…) el
   panel no compite con él: se esconde y vuelve al cerrarlo. */
body:has([role="dialog"][aria-modal="true"]) .pgb-wrap { display: none; }
@keyframes pgb-in { from { opacity: 0; transform: translateY(28px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .pgb-wrap { animation: none; } }
.pgb-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: -4px -8px 4px 0; }
.pgb-tag {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase;
  background: #FFC400; color: #3d2f00; padding: 3px 10px; border-radius: 999px;
}
.pgb-x {
  width: 44px; height: 44px; min-height: 44px; border: none; background: transparent;
  border-radius: 50%; font-size: 24px; line-height: 1; color: #5f6360; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; font-family: inherit;
}
.pgb-x:hover { background: #F7F7F5; color: #1a1c1a; }
.pgb-title { font-size: 17px; font-weight: 700; line-height: 1.3; margin: 0 0 4px; }
.pgb-body { font-size: 14px; line-height: 1.5; color: #5f6360; margin: 0 0 14px; }
.pgb-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.pgb-btn {
  min-height: 44px; padding: 0 20px; border-radius: 10px; font-size: 15px; font-weight: 700;
  cursor: pointer; font-family: inherit; transition: background 0.15s, border-color 0.15s;
}
.pgb-btn-primary { background: #1E9E3A; color: #fff; border: 1px solid #1E9E3A; }
.pgb-btn-primary:hover { background: #188232; border-color: #188232; }
.pgb-btn-ghost { background: #F7F7F5; color: #1a1c1a; border: 1px solid #e4e5e1; }
.pgb-btn-ghost:hover { border-color: #c9cbc5; }
.pgb-btn:focus-visible, .pgb-x:focus-visible { outline: 3px solid rgba(30, 158, 58, 0.35); outline-offset: 2px; }
@media (max-width: 600px) {
  .pgb-wrap {
    width: 100%; bottom: 0; border-radius: 16px 16px 0 0; border-bottom: none;
    padding: 12px 16px calc(16px + env(safe-area-inset-bottom));
  }
  body:has([data-install-prompt]) .pgb-wrap { bottom: 170px; border-radius: 16px; }
  .pgb-btn { flex: 1 1 0; padding: 0 12px; }
}
`;
