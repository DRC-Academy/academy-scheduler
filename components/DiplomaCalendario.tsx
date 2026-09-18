'use client';

// ── El calendario de cuenta atrás del diploma, dentro de la tarjeta "Tu nivel" ─
//
// Sustituye (18/09/2026) al banner ancho de tres renglones que iba en su propia
// tarjeta ("TU CAMINO AL DIPLOMA / Te quedan 5 meses y 21 días"). Facundo lo
// veía demasiado ancho y ocupando demasiado; el sitio se le da ahora al banner
// de "Amplía tu plan", que sube. La cuenta atrás no desaparece: se queda en la
// tarjeta de la escalera, debajo de la tira de niveles, donde antes iba la fila
// de cifras (clases hechas, nivel, horas, próximo hito), que se quitó entera.
//
// EL DIBUJO: dos hojas de calendario de sobremesa, una al lado de la otra —
// número grande arriba, rótulo en mayúsculas pequeñas debajo—, "5 / MESES" y
// "21 / DÍAS". Al lado, en pequeño y en gris, "para tu diploma", y a la derecha
// del todo el enlace "Ir a la plataforma →" (el mismo destino que tenía el
// banner), como enlace pequeño con flecha y no como botón: el CTA de la página
// sigue siendo el "Amplía tu plan" verde de abajo.
//
// QUÉ SE PINTA EN CADA ESTADO (conseguido, sin fecha, vencido, hoy, días,
// meses y días) lo decide lib/diplomaCalendario.dibujoDe, que es puro y tiene
// tests; el cálculo del plazo, lib/diplomaPlazo. Aquí solo se pinta lo que
// devuelven: hojas, leyenda, texto del enlace y la frase del lector de pantalla.
//
// YA NO HAY HUECO RESERVADO NI CIERRE ANIMADO. La cuenta atrás sale de
// `assignments.start_date`, que la ficha tiene desde el primer render, así que
// se pinta de inmediato. Lo único que aporta el LMS (lib/lmsDiploma, hasta
// 5-6 s en frío) es saber si el diploma ya está CONSEGUIDO; mientras no
// contesta —o si no contesta— se enseña la cuenta por fecha, y si contesta
// "conseguido" la hoja cambia sin que cambie la altura de la fila: las hojas
// miden lo mismo en todos los estados, y lo de abajo no se mueve. Con el LMS
// en "sin curso" también se enseña la cuenta: el plazo es una regla de la
// academia (seis meses desde que empezó con su profesor), no del LMS.
//
// Va DENTRO de la tarjeta `.pg-hero` de components/ProgresoFicha (la ruta se lo
// pasa por `diplomaSlot`), así que la medición de altura para el iframe de Mi
// cuenta (components/ProgresoAltura) lo incluye sin más.
//
// Textos en español de España con tuteo, como el resto de la ficha.

import { use, useEffect, useState } from 'react';
import type { Diploma } from '@/lib/diplomaTypes';
import { dibujoDe, type DiplomaEstadoSlot } from '@/lib/diplomaCalendario';
import { madridToday } from '@/lib/subscriptionAccess';

/** A dónde lleva el enlace: el inicio del LMS, que resuelve la sesión. */
export const LMS_PUBLIC_URL = 'https://drc-lms.vercel.app';

export type { DiplomaEstadoSlot } from '@/lib/diplomaCalendario';

// ─── Cómo llega el dato del LMS a cada ruta ──────────────────────────────────

/** Ficha embebida (/progreso-cuenta): el servidor pasa la promesa sin esperarla. */
export function DiplomaFromPromise({ promise, startDate = null }: { promise: Promise<Diploma | null>; startDate?: string | null }) {
  const diploma = use(promise);
  return <DiplomaCalendario diploma={diploma} startDate={startDate} />;
}

/**
 * Ficha pública (/progreso/[token]): se pide a /api/progreso/diploma desde el
 * navegador. Con `token` null (tokens viejos que solo guardaron el nombre y no
 * tienen cruce posible con el LMS) no se pide nada: la cuenta por fecha basta.
 */
export function DiplomaFromToken({ token, startDate = null }: { token: string | null; startDate?: string | null }) {
  const [diploma, setDiploma] = useState<DiplomaEstadoSlot>(token ? 'cargando' : null);

  useEffect(() => {
    if (!token) return;
    let cancelado = false;
    const ctrl = new AbortController();
    // El servidor ya corta a los 8 s; esto solo cubre que la propia ruta se
    // quede colgada. Pasado el plazo, se queda la cuenta por fecha.
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

  return <DiplomaCalendario diploma={diploma} startDate={startDate} />;
}

// ─── El dibujo ───────────────────────────────────────────────────────────────

/** El calendario con su leyenda y su enlace. Se pinta desde el primer render. */
export function DiplomaCalendario({ diploma, startDate = null }: { diploma: DiplomaEstadoSlot; startDate?: string | null }) {
  // El "hoy" es el de Madrid, como todos los plazos de la academia: el mismo
  // alumno ve el mismo número desde cualquier país.
  const { hojas, leyenda, enlace, frase } = dibujoDe(diploma, startDate, madridToday());

  return (
    <div className="pg-cal">
      {hojas.length > 0 && (
        <div className="pg-cal-cuenta" role="img" aria-label={frase ?? undefined}>
          <div className="pg-cal-hojas">
            {hojas.map(h => (
              <div key={h.rotulo} className={`pg-cal-hoja${h.palabra ? ' is-ancha' : ''}`}>
                {h.sello ? (
                  <span className="pg-cal-sello">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                ) : (
                  <span className={`pg-cal-num${h.palabra ? ' is-palabra' : h.corta ? ' is-corta' : ''}`}>{h.valor}</span>
                )}
                <span className="pg-cal-rotulo">{h.rotulo}</span>
              </div>
            ))}
          </div>
          {leyenda && <p className="pg-cal-leyenda">{leyenda}</p>}
        </div>
      )}
      <a className="pg-cal-link" href={LMS_PUBLIC_URL} target="_blank" rel="noopener">{enlace}</a>
    </div>
  );
}

// ─── Estilos, en la hoja de la ficha ─────────────────────────────────────────
//
// Se concatenan a PROGRESO_CSS en ProgresoStyles. Colores: las variables de la
// ficha. La franja de arriba de cada hoja (el "lomo" del calendario de
// sobremesa) es el mismo tinte verde de los peldaños superados de la escalera.
//
// MEDIDAS FIJAS: cada hoja mide 72 × 76 px en escritorio y 64 × 68 en el móvil,
// pase lo que pase dentro (un número de dos cifras, "Hoy" o el sello). La única
// que se ensancha es la de "¡Retoma!" (`is-ancha`: ancho al contenido, nunca
// menos de 72), porque a un cuerpo legible la palabra no cabe en 72 px; la
// ALTURA es la misma en todas. Así la fila mide lo mismo en todos los estados,
// y cuando el LMS contesta "conseguido" y la hoja cambia, nada de lo de abajo
// se mueve.
//
// El rótulo lleva line-height holgado a propósito: con line-height 1 y el
// overflow oculto, el acento de "DÍAS" se recortaba por arriba.
//
// LA FILA ENVUELVE. En escritorio caben las hojas, la leyenda y el enlace en
// una línea; en un móvil de 360 px el enlace no entra y pasa solo a la línea
// siguiente, pegado a la derecha (`margin-left: auto`), que es donde está
// también cuando cabe. Sin calendario (sin fecha de inicio) queda solo el
// enlace, en el mismo sitio.
//
// OJO al escribir comentarios aquí dentro: es un template literal, un acento
// grave rompe el build.

export const CALENDARIO_CSS = `
.pg-cal {
  display: flex; align-items: center; flex-wrap: wrap; gap: 12px 14px;
  border-top: 1px solid var(--pg-line); padding-top: 18px;
}
.pg-cal-cuenta { display: flex; align-items: center; gap: 14px; min-width: 0; }
.pg-cal-hojas { display: flex; gap: 8px; flex-shrink: 0; }
.pg-cal-hoja {
  position: relative; box-sizing: border-box; overflow: hidden;
  width: 72px; height: 76px; padding-top: 8px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  border: 1.5px solid #DCE7DE; border-radius: 12px; background: var(--pg-surface);
}
/* El lomo del calendario: una franja fina arriba. */
.pg-cal-hoja::before {
  content: ""; position: absolute; top: 0; left: 0; right: 0; height: 8px;
  background: var(--pg-green-tint); border-bottom: 1px solid #DCE7DE;
}
.pg-cal-num {
  display: block; max-width: 100%; padding: 0 4px; box-sizing: border-box;
  font-size: 28px; font-weight: 700; letter-spacing: -0.03em; line-height: 1;
  color: var(--pg-green); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* Una palabra en vez de un número ("Hoy", "¡Retoma!"): cuerpo menor, misma altura de línea. */
.pg-cal-num.is-palabra { font-size: 14px; letter-spacing: -0.01em; line-height: 28px; }
.pg-cal-num.is-corta { font-size: 21px; letter-spacing: -0.02em; line-height: 28px; }
.pg-cal-hoja.is-ancha { width: auto; min-width: 72px; padding-left: 12px; padding-right: 12px; }
.pg-cal-sello { display: flex; align-items: center; justify-content: center; height: 28px; color: var(--pg-green); }
.pg-cal-rotulo {
  display: block; max-width: 100%; padding: 0 3px; box-sizing: border-box;
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; line-height: 1.3; text-transform: uppercase;
  color: var(--pg-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pg-cal-leyenda { margin: 0; font-size: 13.5px; line-height: 1.3; color: var(--pg-muted); }
.pg-cal-link {
  margin-left: auto; flex-shrink: 0; white-space: nowrap;
  font-size: 13.5px; font-weight: 600; color: var(--pg-green-dark); text-decoration: none;
  transition: color 0.16s ease;
}
.pg-cal-link:hover { text-decoration: underline; }
.pg-cal-link:focus-visible { outline: 2px solid var(--pg-green); outline-offset: 3px; border-radius: 4px; }

@media (max-width: 720px) {
  .pg-cal { padding-top: 16px; gap: 10px 12px; }
  .pg-cal-cuenta { gap: 12px; }
  .pg-cal-hoja { width: 64px; height: 68px; border-radius: 10px; padding-top: 7px; }
  .pg-cal-hoja::before { height: 7px; }
  .pg-cal-num { font-size: 25px; }
  .pg-cal-num.is-palabra { font-size: 13px; line-height: 25px; }
  .pg-cal-num.is-corta { font-size: 19px; line-height: 25px; }
  .pg-cal-hoja.is-ancha { min-width: 64px; padding-left: 10px; padding-right: 10px; }
  .pg-cal-sello { height: 25px; }
  .pg-cal-sello svg { width: 23px; height: 23px; }
  .pg-cal-rotulo { font-size: 9px; letter-spacing: 0.07em; }
  .pg-cal-leyenda { font-size: 13px; }
  .pg-cal-link { font-size: 13px; }
}

@media (prefers-reduced-motion: reduce) {
  .pg-cal-link { transition: none; }
}
`;
