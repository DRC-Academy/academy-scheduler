'use client';
// ── Tooltip de ayuda contextual ("?") ─────────────────────────────────────────
// Ícono discreto de signo de pregunta que, al hover (desktop), foco (teclado) o
// tap (mobile), muestra un popover con una explicación breve. El texto sale del
// diccionario centralizado (lib/help-tooltips) por `tooltipKey`, o inline por
// `content`.
//
// Implementación sin dependencias nuevas: el popover se renderiza en un portal a
// <body> con position:fixed, así NUNCA lo recorta un contenedor con overflow (las
// tablas de la app viven dentro de overflow-x:auto) ni desacomoda el layout. Los
// estilos son inline con los design tokens (la app no usa Tailwind).
//
// Accesibilidad: el disparador es un <button> (focusable con Tab, se activa con
// Enter/Espacio), con aria-label y aria-describedby → el popover tiene role="tooltip".
import {
  useState, useRef, useId, useEffect, useLayoutEffect, useCallback, type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { getHelpText, type HelpTooltipKey } from '@/lib/help-tooltips';

type Position = 'top' | 'bottom' | 'left' | 'right';

interface HelpTooltipProps {
  /** Clave del diccionario (lib/help-tooltips), p. ej. "finanzas.transcript". */
  tooltipKey?: HelpTooltipKey;
  /** Texto inline, alternativa a tooltipKey. */
  content?: string;
  /** Lado del popover respecto del ícono. */
  position?: Position;
  /** Ancho máximo del popover en px. */
  maxWidth?: number;
  /** aria-label del ícono (para lectores de pantalla). */
  label?: string;
}

interface Placement { top: number; left: number; tx: string; ty: string; }

const GAP = 8;             // separación ícono ↔ popover
const ENTER_DELAY = 200;   // ms antes de mostrar (hover)
const LEAVE_DELAY = 150;   // ms antes de ocultar (hover)
const ANIM_MS = 150;       // duración de la animación de entrada/salida

export function HelpTooltip({
  tooltipKey, content, position = 'top', maxWidth = 280, label = 'Ayuda',
}: HelpTooltipProps) {
  const text = content ?? (tooltipKey ? getHelpText(tooltipKey) : '');

  const [open, setOpen] = useState(false);     // intención lógica
  const [render, setRender] = useState(false); // montado en el DOM (para animar salida)
  const [anim, setAnim] = useState(false);     // estado visual de la animación
  const [hot, setHot] = useState(false);       // ícono resaltado (hover/foco/abierto)
  const [place, setPlace] = useState<Placement | null>(null);
  const [shiftX, setShiftX] = useState(0);     // corrección para no salirse del viewport

  const iconRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uid = useId();
  const popId = `help-${uid.replace(/[:]/g, '')}`;

  const clearTimers = () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  };
  const show = () => {
    if (!text) return;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    enterTimer.current = setTimeout(() => setOpen(true), ENTER_DELAY);
  };
  const hide = () => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    leaveTimer.current = setTimeout(() => setOpen(false), LEAVE_DELAY);
  };

  // Montaje con animación de salida: al cerrar, se mantiene 150ms para el fade-out.
  // El setState en el efecto es intencional (sincroniza el montaje con la intención
  // de abrir/cerrar); no hay forma de expresar el desmontaje diferido sin él.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) { setRender(true); return; }
    setAnim(false);
    const t = setTimeout(() => setRender(false), ANIM_MS);
    return () => clearTimeout(t);
  }, [open]);

  const compute = useCallback(() => {
    const el = iconRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let p: Placement;
    if (position === 'bottom') p = { top: r.bottom + GAP, left: cx, tx: '-50%', ty: '0' };
    else if (position === 'left') p = { top: cy, left: r.left - GAP, tx: '-100%', ty: '-50%' };
    else if (position === 'right') p = { top: cy, left: r.right + GAP, tx: '0', ty: '-50%' };
    else p = { top: r.top - GAP, left: cx, tx: '-50%', ty: '-100%' };
    setShiftX(0);
    setPlace(p);
  }, [position]);

  // Colocar al montar y arrancar la animación de entrada.
  useLayoutEffect(() => {
    if (!render) return;
    compute();
    const raf = requestAnimationFrame(() => setAnim(true));
    return () => cancelAnimationFrame(raf);
  }, [render, compute]);

  // Clamp horizontal dentro del viewport (solo top/bottom). El corrimiento se
  // calcula sobre la posición SIN corregir para no oscilar.
  useLayoutEffect(() => {
    if (!render || !popRef.current || (position !== 'top' && position !== 'bottom')) return;
    const rect = popRef.current.getBoundingClientRect();
    const naturalLeft = rect.left - shiftX;
    const naturalRight = rect.right - shiftX;
    let s = 0;
    if (naturalLeft < 8) s = 8 - naturalLeft;
    else if (naturalRight > window.innerWidth - 8) s = (window.innerWidth - 8) - naturalRight;
    if (Math.abs(s - shiftX) > 0.5) setShiftX(s);
  }, [render, place, shiftX, position]);

  // Reposicionar en scroll/resize; Escape cierra; tap/click afuera cierra.
  useEffect(() => {
    if (!render) return;
    const reposition = () => compute();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { clearTimers(); setOpen(false); } };
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (iconRef.current?.contains(t) || popRef.current?.contains(t)) return;
      clearTimers(); setOpen(false);
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('touchstart', onDown);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('touchstart', onDown);
    };
  }, [render, compute]);

  useEffect(() => () => clearTimers(), []);

  if (!text) return null;

  // Origen de la escala según el lado (para que "crezca" desde el ícono).
  const origin: Record<Position, string> = {
    top: 'bottom center', bottom: 'top center', left: 'right center', right: 'left center',
  };

  // Flecha: cuadrado rotado 45° pegado al borde que mira al ícono, con borde en
  // los dos lados visibles para calzar con el borde del popover.
  const arrowBase: CSSProperties = {
    position: 'absolute', width: 9, height: 9, background: 'var(--bg-surface)',
    transform: 'rotate(45deg)',
  };
  const arrowStyle: CSSProperties =
    position === 'bottom'
      ? { ...arrowBase, top: -5, left: `calc(50% - ${shiftX}px)`, marginLeft: -4.5, borderLeft: '1px solid var(--border)', borderTop: '1px solid var(--border)' }
      : position === 'left'
      ? { ...arrowBase, right: -5, top: '50%', marginTop: -4.5, borderTop: '1px solid var(--border)', borderRight: '1px solid var(--border)' }
      : position === 'right'
      ? { ...arrowBase, left: -5, top: '50%', marginTop: -4.5, borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)' }
      : { ...arrowBase, bottom: -5, left: `calc(50% - ${shiftX}px)`, marginLeft: -4.5, borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)' };

  const popover = render && place ? createPortal(
    <div
      ref={popRef}
      id={popId}
      role="tooltip"
      style={{
        position: 'fixed',
        top: place.top,
        left: place.left,
        transform: `translate(calc(${place.tx} + ${shiftX}px), ${place.ty}) scale(${anim ? 1 : 0.96})`,
        transformOrigin: origin[position],
        opacity: anim ? 1 : 0,
        transition: `opacity ${ANIM_MS}ms ease, transform ${ANIM_MS}ms ease`,
        zIndex: 200,
        maxWidth,
        width: 'max-content',
        background: 'var(--bg-surface)',
        color: 'var(--text-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-overlay)',
        padding: '10px 12px',
        fontSize: 'var(--fs-sm)',
        lineHeight: 'var(--lh-sm)',
        fontWeight: 'var(--fw-regular)',
        pointerEvents: 'auto',
      }}
      // Mantener abierto mientras el mouse está sobre el propio popover.
      onMouseEnter={() => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }}
      onMouseLeave={hide}
    >
      <span style={arrowStyle} aria-hidden="true" />
      {text}
    </div>,
    document.body,
  ) : null;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', lineHeight: 0 }}>
      <button
        ref={iconRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        onMouseEnter={() => { setHot(true); show(); }}
        onMouseLeave={() => { setHot(false); hide(); }}
        onFocus={() => { setHot(true); clearTimers(); setOpen(true); }}
        onBlur={() => { setHot(false); clearTimers(); setOpen(false); }}
        onMouseDown={(e) => { e.stopPropagation(); }}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); clearTimers(); setOpen(o => !o); }}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16, padding: 0, borderRadius: 'var(--radius-pill)',
          border: `1px solid ${hot ? 'var(--border-light)' : 'var(--border)'}`,
          background: hot ? 'var(--bg-surface-2)' : 'transparent',
          color: hot ? 'var(--text-secondary)' : 'var(--text-muted)',
          fontSize: 11, lineHeight: 1, fontWeight: 'var(--fw-semibold)',
          cursor: 'help', fontFamily: 'inherit', flexShrink: 0,
          transition: 'color 120ms ease, border-color 120ms ease, background 120ms ease',
        }}
      >
        ?
      </button>
      {popover}
    </span>
  );
}
