'use client';

// ── La barra del diploma en la ficha de progreso ─────────────────────────────
//
// Es el banner del diploma del LMS (components/BannerDiploma.tsx allí), portado
// al sistema de estilos de la ficha (clases pg-*, hoja inline, sin Tailwind).
// Mismo dibujo: una línea con la cifra y el recuento, y debajo un carril de
// 12 px con el relleno en verde de marca y la punta clara.
//
// ES UNA TARJETA MÁS (`pg-card`), entre la escalera de niveles y el banner de
// ritmo: mismo fondo, borde, radio y padding que sus vecinas, y la separación la
// pone el `gap` de `.pg-main` (por eso no lleva margen propio). Un poco más ancha
// que las otras donde hay margen lateral para ello, para que resalte.
//
// LLEGA TARDE Y NO PUEDE MOVER NADA DE LO DE ABAJO. El dato lo da el LMS
// (lib/lmsDiploma.ts), que tarda hasta 5-6 s en frío, así que la ficha se pinta
// entera sin él y esta tarjeta se rellena después. Para que el banner de ritmo
// no se desplace, el hueco queda reservado desde el primer render con la MISMA
// altura que tendrá la tarjeta (`min-height` del contenido, igual en los
// cuatro estados), con un esqueleto tenue dentro. Si no hay nada que enseñar
// —sin curso, o el LMS no contestó— la tarjeta entera se cierra con una
// transición (altura, padding, borde y el hueco del gap) y desaparece: no queda
// una caja blanca vacía.
//
// Va DENTRO de `.pg-page` (es hijo de `.pg-main`): así la medición de altura
// para el iframe de Mi cuenta (components/ProgresoAltura.tsx) lo incluye, y
// su ResizeObserver avisa al padre cuando el bloque cambia.
//
// UN ESTADO DISTINTO AL LMS: "en curso con cero lecciones". El LMS enseña la
// barra vacía y "0 de 187"; aquí eso no invita a nada, así que se cambia por
// una frase y un enlace al LMS en pestaña nueva (la ficha vive embebida en Mi
// cuenta y no hay que sacar al alumno del iframe).
//
// Textos en español de España con tuteo, como el resto de la ficha.

import { use, useEffect, useState } from 'react';
import type { Diploma } from '@/lib/diplomaTypes';

/** A dónde lleva "Empieza ahora": el inicio del LMS, que resuelve la sesión. */
export const LMS_PUBLIC_URL = 'https://drc-lms.vercel.app';

/** 'cargando' mientras se espera al LMS; null cuando no hay nada que enseñar. */
export type DiplomaEstadoSlot = Diploma | null | 'cargando';

// ─── Textos ──────────────────────────────────────────────────────────────────

const T = {
  tuDiploma: 'Tu diploma',
  leccionesParaTuDiploma: (n: number) => (n === 1 ? 'lección para tu diploma' : 'lecciones para tu diploma'),
  progreso: (hechas: number, total: number) => `${hechas} de ${total}`,
  faltan: (restantes: number, total: number) =>
    `Te ${restantes === 1 ? 'falta' : 'faltan'} ${restantes} de ${total} lecciones para tu diploma`,
  cursoCompletado: 'Curso completado',
  diplomaConseguido: 'Diploma conseguido',
  teEspera: 'Tu curso te espera:',
  lecciones: (n: number) => `${n} ${n === 1 ? 'lección' : 'lecciones'}`,
  empieza: 'Empieza ahora →',
};

// ─── El hueco: reservado, con contenido, o cerrándose ────────────────────────

/**
 * El bloque con su hueco. Recibe el estado resuelto (o 'cargando') y decide
 * qué pintar. Cuando no hay nada que enseñar, se cierra solo: primero la
 * transición (`pg-diploma-cerrando`) y al terminar deja de existir.
 */
export function DiplomaSlot({ diploma }: { diploma: DiplomaEstadoSlot }) {
  const vacio = diploma === null || (diploma !== 'cargando' && diploma.estado === 'sin-curso');
  const [fase, setFase] = useState<'abierto' | 'cerrando' | 'cerrado'>('abierto');

  useEffect(() => {
    if (!vacio) return;
    // Un frame con el hueco abierto y luego la clase que lo cierra: así la
    // transición parte de la altura reservada y no de cero.
    const raf = requestAnimationFrame(() => setFase('cerrando'));
    const t = setTimeout(() => setFase('cerrado'), 380);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [vacio]);

  if (vacio && fase === 'cerrado') return null;

  const clase = `pg-card pg-diploma${fase === 'cerrando' ? ' pg-diploma-cerrando' : ''}`;
  if (vacio) return <div className={clase} aria-hidden><div className="pg-diploma-in" /></div>;
  if (diploma === 'cargando') return <div className={clase} aria-hidden><div className="pg-diploma-in"><Esqueleto /></div></div>;
  return (
    <section className={clase} aria-label={T.tuDiploma}>
      <div className="pg-diploma-in pg-diploma-llega"><DiplomaBanner diploma={diploma} /></div>
    </section>
  );
}

/** Ficha embebida (/progreso-cuenta): el servidor pasa la promesa sin esperarla. */
export function DiplomaFromPromise({ promise }: { promise: Promise<Diploma | null> }) {
  const diploma = use(promise);
  return <DiplomaSlot diploma={diploma} />;
}

/** Ficha pública (/progreso/[token]): se pide a /api/progreso/diploma desde el navegador. */
export function DiplomaFromToken({ token }: { token: string }) {
  const [diploma, setDiploma] = useState<DiplomaEstadoSlot>('cargando');

  useEffect(() => {
    let cancelado = false;
    const ctrl = new AbortController();
    // El servidor ya corta a los 8 s; esto solo cubre que la propia ruta se
    // quede colgada. Pasado el plazo, el hueco se cierra igual.
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    fetch(`/api/progreso/diploma?token=${encodeURIComponent(token)}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then((j: { diploma?: Diploma | null } | null) => {
        if (cancelado) return;
        const d = j?.diploma ?? null;
        setDiploma(d && typeof d.estado === 'string' ? d : null);
      })
      .catch(() => { if (!cancelado) setDiploma(null); })
      .finally(() => clearTimeout(timer));
    return () => { cancelado = true; ctrl.abort(); clearTimeout(timer); };
  }, [token]);

  return <DiplomaSlot diploma={diploma} />;
}

// ─── El dibujo ───────────────────────────────────────────────────────────────

/** El banner en sí, ya con datos. `sin-curso` no llega aquí: lo filtra el slot. */
export function DiplomaBanner({ diploma }: { diploma: Diploma }) {
  if (diploma.estado === 'conseguido') {
    return (
      <>
        <div className="pg-diploma-linea">
          <p className="pg-diploma-texto">
            <IconoDiploma conseguido />
            <span className="pg-diploma-hecho">{T.diplomaConseguido}</span>
          </p>
          <span className="pg-diploma-cuenta">{T.progreso(diploma.total, diploma.total)}</span>
        </div>
        <Barra relleno={100} descripcion={T.cursoCompletado} conseguido />
      </>
    );
  }

  // En curso sin empezar: una invitación breve en vez de una barra vacía.
  if (diploma.completadas === 0) {
    return (
      <>
        <div className="pg-diploma-linea pg-diploma-linea-cero">
          <p className="pg-diploma-texto">
            <IconoDiploma />
            <span>{T.teEspera} <span className="pg-diploma-cifra">{T.lecciones(diploma.total)}</span></span>
          </p>
        </div>
        <a className="pg-diploma-cta" href={LMS_PUBLIC_URL} target="_blank" rel="noopener">{T.empieza}</a>
      </>
    );
  }

  const hechas = Math.min(diploma.completadas, diploma.total);
  const relleno = diploma.total > 0 ? Math.round((hechas / diploma.total) * 100) : 0;
  return (
    <>
      <div className="pg-diploma-linea">
        <p className="pg-diploma-texto">
          <IconoDiploma />
          <span><span className="pg-diploma-cifra">{diploma.restantes}</span> {T.leccionesParaTuDiploma(diploma.restantes)}</span>
        </p>
        <span className="pg-diploma-cuenta">{T.progreso(hechas, diploma.total)}</span>
      </div>
      <Barra relleno={relleno} descripcion={T.faltan(diploma.restantes, diploma.total)} conseguido={false} />
    </>
  );
}

/** El carril. El porcentaje solo se ve; el recuento de arriba es su escala. */
function Barra({ relleno, descripcion, conseguido }: { relleno: number; descripcion: string; conseguido: boolean }) {
  return (
    <div className="pg-diploma-barra" role="progressbar" aria-valuenow={relleno} aria-valuemin={0} aria-valuemax={100} aria-label={descripcion}>
      <div className="pg-diploma-relleno" style={{ width: `${relleno}%` }} />
      {conseguido ? (
        <span className="pg-diploma-sello" aria-hidden>
          <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6.4 10.4l2.4 2.4 4.8-5.2" />
          </svg>
        </span>
      ) : (
        <span className="pg-diploma-punta" aria-hidden style={{ left: `${relleno}%` }} />
      )}
    </div>
  );
}

/** Lo que se ve mientras se espera al LMS: la silueta del bloque, en tenue. */
function Esqueleto() {
  return (
    <div className="pg-diploma-skel">
      <div className="pg-diploma-skel-linea" />
      <div className="pg-diploma-skel-barra" />
    </div>
  );
}

/** El pergamino del LMS: la hoja con su rollo a la izquierda. */
function IconoDiploma({ conseguido = false }: { conseguido?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="pg-diploma-icono" fill="none" stroke="#14722A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.6 4.2h8.6a1.9 1.9 0 0 1 1.9 1.9v7.8a1.9 1.9 0 0 1-1.9 1.9H5.6" />
      <ellipse cx="5.6" cy="10" rx="1.8" ry="5.8" />
      {conseguido ? <path d="M8.9 10.2l1.7 1.7 3.2-3.4" /> : <path d="M8.9 8.2h4.6M8.9 11.4h3" />}
    </svg>
  );
}

// ─── Estilos, en la hoja de la ficha ─────────────────────────────────────────
//
// Se concatenan a PROGRESO_CSS en ProgresoStyles. Colores: las variables de la
// ficha son la misma familia que las `marca.*` del LMS (verde #1E9E3A, verde
// oscuro #14722A, tinta, gris medio, gris tenue); el carril (#E8EEE9) y la punta
// (#6FD98A) van literales, como allí.
//
// LA ALTURA RESERVADA: línea de 18 px + 11 px + carril 12 px = 41 px de contenido.
// El estado "sin empezar" son dos líneas de 18 px con 5 px entre ellas: los
// mismos 41 px. El esqueleto mide igual. Con el padding de `pg-card` (24/20 px)
// y el borde, la tarjeta mide lo mismo en los cuatro estados: nada de lo de
// abajo se mueve.
//
// EL CIERRE: se animan a cero la altura, el padding, el borde y, con un margen
// negativo, el `gap` que `.pg-main` deja después de la tarjeta (18 px, 14 en
// móvil). Al terminar, el slot la desmonta: no hay salto residual.

export const DIPLOMA_CSS = `
.pg-diploma {
  box-sizing: border-box;
  max-height: 200px;
  opacity: 1;
  overflow: hidden;
  transition: max-height 300ms ease, padding 300ms ease, border-width 300ms ease, margin 300ms ease, opacity 200ms ease;
}
.pg-diploma-in { min-height: 41px; }
.pg-diploma-cerrando {
  max-height: 0; opacity: 0;
  padding-top: 0; padding-bottom: 0; border-top-width: 0; border-bottom-width: 0;
  margin-bottom: -18px;
}
/* Un poco más ancha que sus vecinas, comiéndose 12 px del margen lateral de
   .pg-main a cada lado. Solo donde ese margen existe: en el móvil es de 14 px y
   dentro de Mi cuenta (.pg-embed) es cero, y ahí una tarjeta más ancha que la
   página se recorta. */
@media (min-width: 721px) { .pg-diploma { margin-left: -12px; margin-right: -12px; } }
@media (max-width: 720px) { .pg-diploma-cerrando { margin-bottom: -14px; } }
.pg-embed .pg-diploma { margin-left: 0; margin-right: 0; }
/* El contenido entra con un fundido; la tarjeta no se mueve. */
.pg-diploma-llega { animation: pg-diploma-llega 220ms ease-out both; }
@keyframes pg-diploma-llega { from { opacity: 0; } to { opacity: 1; } }

/* Altura FIJA de 18 px: con align-items baseline y dos cuerpos distintos la línea crecía
   medio píxel y el bloque dejaba de medir lo reservado. */
.pg-diploma-linea { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; height: 18px; margin-bottom: 11px; }
.pg-diploma-linea-cero { margin-bottom: 5px; }
.pg-diploma-texto {
  display: flex; align-items: center; gap: 10px; min-width: 0; margin: 0;
  font-size: 14.5px; line-height: 1.25; color: var(--pg-muted);
}
.pg-diploma-texto > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-diploma-icono { width: 16px; height: 16px; flex-shrink: 0; }
.pg-diploma-cifra { font-weight: 700; color: var(--pg-ink); }
.pg-diploma-hecho { font-weight: 700; color: var(--pg-green-dark); }
.pg-diploma-cuenta { flex-shrink: 0; white-space: nowrap; font-size: 12.5px; line-height: 1; color: var(--pg-faint); }

.pg-diploma-barra { position: relative; height: 12px; border-radius: 6px; background: #E8EEE9; }
.pg-diploma-relleno { height: 100%; border-radius: 6px; background: linear-gradient(90deg, var(--pg-green) 0%, #37C25A 100%); }
.pg-diploma-punta {
  position: absolute; top: 50%; width: 10px; height: 10px; border-radius: 999px;
  background: #6FD98A; transform: translate(-50%, -50%);
}
.pg-diploma-sello {
  position: absolute; right: -4px; top: 50%; width: 22px; height: 22px; border-radius: 999px;
  border: 2px solid var(--pg-cream); background: var(--pg-green);
  display: grid; place-items: center; transform: translateY(-50%);
}

/* Sin empezar: la frase y, debajo, el enlace. 18 + 5 + 18 = los mismos 41 px.
   En bloque, no inline: un inline-block arrastraba el line box del padre. */
.pg-diploma-cta {
  /* Sangría = icono (16) + hueco (10): el enlace arranca donde arranca la frase. */
  display: block; width: fit-content; height: 18px; margin-left: 26px; font-size: 13.5px; line-height: 18px; font-weight: 600;
  color: var(--pg-green-dark); text-decoration: none;
}
.pg-diploma-cta:hover { text-decoration: underline; }

/* El esqueleto: la silueta de la línea y del carril, en tenue. */
/* 4 + 10 + 15 + 12 = 41 px. Padding y no margen arriba: un margen se escapaba
   del esqueleto y el hueco medía 45. */
.pg-diploma-skel { height: 41px; padding-top: 4px; box-sizing: border-box; }
.pg-diploma-skel-linea { width: 46%; max-width: 240px; height: 10px; border-radius: 5px; margin: 0 0 15px; background: var(--pg-grey-tint); }
.pg-diploma-skel-barra { height: 12px; border-radius: 6px; background: var(--pg-grey-tint); }
.pg-diploma-skel-linea, .pg-diploma-skel-barra { animation: pg-diploma-pulso 1.6s ease-in-out infinite; }
@keyframes pg-diploma-pulso { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }

@media (prefers-reduced-motion: reduce) {
  .pg-diploma { transition: none; }
  .pg-diploma-llega, .pg-diploma-skel-linea, .pg-diploma-skel-barra { animation: none; }
}
`;
