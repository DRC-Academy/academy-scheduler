'use client';
// ── Recorrido guiado: resaltado en pantalla ───────────────────────────────────
//
// Un solo componente para las dos vías (automática y botón "Tutorial"): el modo
// lo decide lib/OnboardingContext y acá solo cambia quién manda el avance.
//
// El anclaje es por IDENTIFICADOR ESTABLE, nunca por posición: se busca
// `[data-onboarding="..."]` con los valores que declara el paso (lib/onboarding)
// y se ilumina el primero que exista. Un rediseño de la tarjeta no rompe nada
// mientras el atributo siga en el botón.
//
// Degradación cuando el botón NO está en pantalla (el profesor está en Finanzas,
// o ese paso no aplica a ninguna clase de hoy): en vez de resaltar al aire, la
// misma tarjeta del paso se muestra centrada con el texto de "dónde está". El
// recorrido nunca se queda mudo ni apuntando a un hueco.
//
// El overlay NO bloquea la pantalla: todas sus capas son pointer-events:none
// salvo la propia tarjeta. El profesor puede pulsar el botón resaltado (que es la
// idea) y también cualquier otra cosa, sin tener que cerrar nada.
import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useOnboarding } from '@/lib/OnboardingContext';
import {
  ONBOARDING_STEPS, ONBOARDING_TARGET_CLASSES, formationLabel,
  ONBOARDING_FINISHED_TITLE, ONBOARDING_FINISHED_BODY,
} from '@/lib/onboarding';

const VERDE    = '#1E9E3A';
const AMARILLO = '#FFC400';
const FONDO    = '#F7F7F5';

const PAD = 6;        // aire entre el botón y el aro de resaltado
const GAP = 12;       // separación entre el aro y la tarjeta del paso
const CARD_W = 340;
const MARGIN = 12;    // margen mínimo contra el borde del viewport

interface Rect { top: number; left: number; width: number; height: number; }

/** Primer elemento visible con alguno de los `data-onboarding` del paso. */
function findAnchor(anchors: string[]): HTMLElement | null {
  for (const name of anchors) {
    const nodes = document.querySelectorAll<HTMLElement>(`[data-onboarding="${name}"]`);
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      // Un elemento con tamaño 0 está oculto (display:none, o dentro de un menú
      // cerrado): resaltarlo sería un aro invisible en la esquina superior.
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

export function OnboardingTour() {
  const {
    mode, step, stepIndex, totalSteps, done, classesCompleted,
    close, skipAuto, next, prev, finishedNotice, dismissFinished,
    reportAction, markNotApplicable,
  } = useOnboarding();

  const [measuredRect, setMeasuredRect] = useState<Rect | null>(null);
  const [mounted, setMounted] = useState(false);
  const scrolledFor = useRef<string | null>(null);

  // El overlay se pinta en un portal a <body>, que no existe en el render del
  // servidor: hasta que no monta no hay nada que dibujar.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const anchors = step?.anchors ?? [];
  const anchorsKey = anchors.join('|');
  /** Con el recorrido cerrado (o en un paso informativo) no hay nada resaltado. */
  const activo = mode !== 'off' && !!step && anchors.length > 0;
  const rect = activo ? measuredRect : null;

  // Seguimiento del botón resaltado. Se remide en cada frame porque la tarjeta se
  // mueve por debajo del overlay por razones que no emiten evento: el filtro de la
  // lista, una recarga de datos a los 60 s o el propio scroll suave. Un rAF es más
  // barato que equivocarse de posición, y solo corre con el tutorial abierto.
  // Sin `setRect(null)` en el cuerpo del efecto: cuando el recorrido está cerrado
  // la medición simplemente no se usa (`activo`), así que no hace falta borrarla
  // de forma síncrona. La única escritura de estado ocurre dentro del rAF, que es
  // la suscripción a la geometría del DOM.
  useLayoutEffect(() => {
    if (!activo) return;

    let raf = 0;
    let last = '';
    const tick = () => {
      const el = findAnchor(anchors);
      if (!el) {
        if (last !== '') { last = ''; setMeasuredRect(null); }
      } else {
        const r = el.getBoundingClientRect();
        const key = `${Math.round(r.top)}_${Math.round(r.left)}_${Math.round(r.width)}_${Math.round(r.height)}`;
        if (key !== last) {
          last = key;
          setMeasuredRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  // `anchorsKey` en vez del array: su identidad cambia en cada render del padre.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activo, step?.id, anchorsKey]);

  // Traer el botón a la vista al cambiar de paso, una sola vez por paso: repetirlo
  // en cada frame pelearía con el scroll del profesor.
  useEffect(() => {
    if (!activo || !step) return;
    const marker = `${mode}_${step.id}`;
    if (scrolledFor.current === marker) return;
    const el = findAnchor(anchors);
    if (!el) return;
    scrolledFor.current = marker;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, step?.id, anchorsKey, rect === null]);

  // Paso opcional cuyo botón no está en ninguna clase a la vista: se descarta y el
  // recorrido sigue. Es el caso de la presentación, que se envía una sola vez por
  // alumno: sin esto el profesor se quedaría trabado en el paso 1 desde su segundo
  // día. La espera evita descartarlo mientras la lista de clases todavía carga.
  useEffect(() => {
    if (mode !== 'auto' || !step?.optional || rect) return;
    const t = setTimeout(() => {
      if (!findAnchor(step.anchors)) markNotApplicable(step.id);
    }, 2500);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, step?.id, step?.optional, rect, markNotApplicable]);

  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); }
  }, [close]);

  useEffect(() => {
    if (mode === 'off') return;
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onKey]);

  if (!mounted) return null;

  // ── Cartel de formación completada ──────────────────────────────────────────
  if (finishedNotice) {
    return createPortal(
      <div style={S.backdropBlocking} onClick={e => { if (e.target === e.currentTarget) dismissFinished(); }}>
        <div style={{ ...S.card, maxWidth: 400, pointerEvents: 'auto' }}>
          <div style={{ fontSize: 34, marginBottom: 6 }} aria-hidden>🎓</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#1a1c1a', marginBottom: 8 }}>
            {ONBOARDING_FINISHED_TITLE}
          </div>
          <div style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.6, marginBottom: 18 }}>
            {ONBOARDING_FINISHED_BODY}
          </div>
          <button onClick={dismissFinished} style={S.primaryBtn} autoFocus>Entendido</button>
        </div>
      </div>,
      document.body,
    );
  }

  if (mode === 'off' || !step) return null;

  const isAuto = mode === 'auto';
  const isLast = stepIndex === totalSteps - 1;
  // En automático los pasos accionables los cierra la acción real; "Entendido"
  // solo sirve para pasar de largo los informativos y los que ya están hechos.
  const esperandoAccion = isAuto && step.actionable && !done.has(step.id);

  // ── Posición de la tarjeta ──────────────────────────────────────────────────
  // Debajo del botón si este está en la mitad de arriba de la pantalla, encima si
  // está en la de abajo; y sin ancla, centrada abajo.
  //
  // El lado se decide por la posición del botón y NO por la altura de la tarjeta:
  // medirla obligaría a leerla del DOM en pleno render (y a un render extra por
  // cada cambio de paso). Con `translateY(-100%)` el navegador la sube sola sin
  // que haya que saber cuánto mide.
  let cardStyle: React.CSSProperties;
  if (rect) {
    const debajo = rect.top + rect.height / 2 < window.innerHeight * 0.5;
    const left = Math.min(
      Math.max(MARGIN, rect.left + rect.width / 2 - CARD_W / 2),
      Math.max(MARGIN, window.innerWidth - CARD_W - MARGIN),
    );
    cardStyle = {
      ...S.card, position: 'fixed', left, width: CARD_W,
      top: debajo ? rect.top + rect.height + PAD + GAP : rect.top - PAD - GAP,
      transform: debajo ? undefined : 'translateY(-100%)',
    };
  } else {
    cardStyle = {
      ...S.card, position: 'fixed', left: '50%', bottom: MARGIN + 8,
      transform: 'translateX(-50%)', width: `min(${CARD_W}px, calc(100vw - ${MARGIN * 2}px))`,
    };
  }

  return createPortal(
    <>
      {/* Atenuado del resto de la pantalla: cuatro paneles alrededor del hueco, en
          vez de una capa con recorte. Así el botón resaltado queda literalmente
          descubierto y su hover/foco siguen siendo los de siempre. */}
      {rect && (
        <>
          <div style={{ ...S.dim, top: 0, left: 0, right: 0, height: Math.max(0, rect.top - PAD) }} />
          <div style={{ ...S.dim, top: rect.top + rect.height + PAD, left: 0, right: 0, bottom: 0 }} />
          <div style={{ ...S.dim, top: rect.top - PAD, left: 0, width: Math.max(0, rect.left - PAD), height: rect.height + PAD * 2 }} />
          <div style={{ ...S.dim, top: rect.top - PAD, left: rect.left + rect.width + PAD, right: 0, height: rect.height + PAD * 2 }} />

          {/* Aro de resaltado */}
          <div
            aria-hidden
            style={{
              position: 'fixed',
              top: rect.top - PAD, left: rect.left - PAD,
              width: rect.width + PAD * 2, height: rect.height + PAD * 2,
              border: `2.5px solid ${AMARILLO}`,
              borderRadius: 12,
              boxShadow: `0 0 0 3px rgba(255,196,0,0.25), 0 0 22px rgba(255,196,0,0.5)`,
              pointerEvents: 'none',
              zIndex: 121,
              animation: 'drc-onb-pulse 1.8s ease-in-out infinite',
            }}
          />
        </>
      )}

      <div style={cardStyle} role="dialog" aria-live="polite" aria-label={`Tutorial, paso ${stepIndex + 1} de ${totalSteps}`}>
        {/* Cabecera: en qué paso va y, si es formación, en qué clase */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={S.stepPill}>Paso {stepIndex + 1} de {totalSteps}</span>
          {isAuto
            ? <span style={S.formPill}>{formationLabel(classesCompleted)}</span>
            : <span style={S.manualPill}>Tutorial</span>}
        </div>

        {/* Puntos de progreso: se pintan verdes los pasos ya cumplidos */}
        <div style={{ display: 'flex', gap: 5, marginBottom: 12 }}>
          {ONBOARDING_STEPS.map((s, i) => (
            <span key={s.id} aria-hidden style={{
              flex: 1, height: 4, borderRadius: 3,
              background: done.has(s.id) ? VERDE : i === stepIndex ? AMARILLO : '#e4e5e1',
            }} />
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 6 }}>
          {done.has(step.id) && <span style={{ color: VERDE, fontWeight: 800 }} aria-label="Completado">✓</span>}
          <span style={{ fontSize: 15.5, fontWeight: 800, color: '#1a1c1a', lineHeight: 1.35 }}>
            {step.title}
          </span>
        </div>

        <div style={{ fontSize: 13, color: '#5f6360', lineHeight: 1.6, marginBottom: 12 }}>
          {step.why}
        </div>

        {/* Sin botón que resaltar: se dice dónde encontrarlo. Es la degradación
            que evita un aro apuntando a la nada. */}
        {!rect && step.anchors.length > 0 && (
          <div style={S.whereBox}>
            <b style={{ color: '#7a6000' }}>Dónde está:</b> {step.where}
          </div>
        )}

        {esperandoAccion && rect && (
          <div style={S.waitingBox}>
            Pulsá el botón resaltado. El paso se marca solo cuando lo hagas.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isAuto ? (
            <>
              <button onClick={skipAuto} style={S.ghostBtn}>Saltar tutorial</button>
              {/* En automático el paso a la vista se deriva de los checks, así que
                  el botón no "avanza": cierra el paso actual. Un paso informativo
                  (o ya cumplido) se da por leído; uno accionable que el profesor no
                  va a hacer ahora se descarta sin marcarlo como hecho. */}
              <button
                onClick={() => (esperandoAccion ? markNotApplicable(step.id) : reportAction(step.id))}
                style={{ ...S.primaryBtn, flex: 1 }}>
                {esperandoAccion ? 'Ahora no' : 'Entendido'}
              </button>
            </>
          ) : (
            <>
              <button onClick={close} style={S.ghostBtn}>Cerrar</button>
              {stepIndex > 0 && <button onClick={prev} style={S.ghostBtn}>Atrás</button>}
              <button onClick={isLast ? close : next} style={{ ...S.primaryBtn, flex: 1 }} autoFocus>
                {isLast ? 'Terminar' : 'Siguiente'}
              </button>
            </>
          )}
        </div>

        {isAuto && (
          <div style={{ fontSize: 11, color: '#8b8e88', textAlign: 'center', marginTop: 9, lineHeight: 1.5 }}>
            Se muestra solo durante tus primeras {ONBOARDING_TARGET_CLASSES} clases.
            Después podés repasarlo desde el botón <b>Tutorial</b>.
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

// ── Estilos ───────────────────────────────────────────────────────────────────
// Inline y con la paleta DRC, igual que HelpTooltip: la app no usa Tailwind y el
// overlay vive en un portal a <body>, fuera de cualquier hoja con scope.
const S: Record<string, React.CSSProperties> = {
  dim: {
    position: 'fixed',
    background: 'rgba(16,18,16,0.52)',
    pointerEvents: 'none',
    zIndex: 120,
    transition: 'opacity 120ms ease',
  },
  backdropBlocking: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
    zIndex: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  },
  card: {
    background: FONDO,
    border: `1.5px solid ${VERDE}`,
    borderRadius: 14,
    padding: '16px 18px',
    boxShadow: '0 12px 34px rgba(0,0,0,0.28)',
    zIndex: 122,
    pointerEvents: 'auto',
    fontFamily: 'inherit',
    maxHeight: 'calc(100vh - 24px)',
    overflowY: 'auto',
  },
  stepPill: {
    fontSize: 11, fontWeight: 800, color: VERDE, background: 'rgba(30,158,58,0.12)',
    border: '1px solid rgba(30,158,58,0.3)', borderRadius: 20, padding: '2px 9px',
  },
  formPill: {
    fontSize: 11, fontWeight: 700, color: '#7a6000', background: 'rgba(255,196,0,0.16)',
    border: '1px solid rgba(255,196,0,0.5)', borderRadius: 20, padding: '2px 9px',
  },
  manualPill: {
    fontSize: 11, fontWeight: 700, color: '#5f6360', background: '#f0f1ee',
    border: '1px solid #e4e5e1', borderRadius: 20, padding: '2px 9px',
  },
  whereBox: {
    fontSize: 12.5, lineHeight: 1.55, color: '#8a6d00', background: 'rgba(255,196,0,0.12)',
    border: '1px solid rgba(255,196,0,0.5)', borderRadius: 9, padding: '9px 11px', marginBottom: 12,
  },
  waitingBox: {
    fontSize: 12.5, lineHeight: 1.55, color: '#1f7a3d', background: 'rgba(30,158,58,0.08)',
    border: '1px solid rgba(30,158,58,0.3)', borderRadius: 9, padding: '9px 11px', marginBottom: 12,
  },
  primaryBtn: {
    padding: '10px 14px', borderRadius: 9, border: 'none', background: VERDE, color: 'white',
    cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
  },
  ghostBtn: {
    padding: '10px 12px', borderRadius: 9, border: '1px solid #d9dad5', background: 'white',
    color: '#6b7280', cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit', whiteSpace: 'nowrap',
  },
  disabled: { background: '#d1d5db', cursor: 'not-allowed' },
};
