'use client';

// ── El calendario de cuenta atrás del diploma, dentro de la tarjeta "Tu nivel" ─
//
// Sustituye (18/09/2026) al banner ancho de tres renglones que iba en su propia
// tarjeta ("TU CAMINO AL DIPLOMA / Te quedan 5 meses y 21 días"). Facundo lo
// veía demasiado ancho y ocupando demasiado; el sitio se le da ahora al banner
// de "Amplía tu plan", que sube. La cuenta atrás no desaparece: se queda en la
// tarjeta de la escalera. Del 18 al 21/09/2026 fue debajo de la tira de
// niveles, donde antes iba la fila de cifras (clases hechas, nivel, horas,
// próximo hito), que se quitó entera; desde el 21/09/2026 es lo PRIMERO de la
// tarjeta, y la tira va debajo, tras una raya fina (components/ProgresoFicha).
//
// EL DIBUJO: una fila baja. A la izquierda, dos hojas de calendario de
// sobremesa, una al lado de la otra —número grande arriba, rótulo en
// mayúsculas pequeñas debajo, una franja verde fina arriba que las hace
// parecer calendario—, "1 / MES" y "9 / DÍAS". Al lado, en gris, dos líneas:
// "para tu diploma" y debajo, más pequeño, "38 de 168 lecciones". A la derecha
// del todo el enlace ("Ir a la plataforma →", "Empezar mi curso →" con cero
// lecciones, "Continuar mi curso →" en vencido; el mismo destino que tenía el
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
// se pinta de inmediato. Lo que aporta el LMS (lib/lmsDiploma, hasta 5-6 s en
// frío) llega después: la línea de lecciones, el enlace de "Empezar" y saber si
// el diploma ya está CONSEGUIDO. Mientras no contesta —o si no contesta— se
// enseña la cuenta por fecha con la línea de lecciones vacía (su sitio queda
// reservado), y cuando contesta nada cambia de altura: las hojas miden lo
// mismo en todos los estados y lo de abajo no se mueve. Con el LMS en "sin
// curso" también se enseña la cuenta: el plazo es una regla de la academia
// (seis meses desde que empezó con su profesor), no del LMS.
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

/** El calendario con su leyenda, sus lecciones y su enlace. Se pinta desde el primer render. */
export function DiplomaCalendario({ diploma, startDate = null }: { diploma: DiplomaEstadoSlot; startDate?: string | null }) {
  // El "hoy" es el de Madrid, como todos los plazos de la academia: el mismo
  // alumno ve el mismo número desde cualquier país.
  const { hojas, leyenda, lecciones, enlace, frase } = dibujoDe(diploma, startDate, madridToday());
  const conHojas = hojas.length > 0;

  return (
    <div className="pg-cal">
      {(conHojas || lecciones) && (
        <div className="pg-cal-cuenta" role="img" aria-label={frase ?? undefined}>
          {conHojas && (
            <div className="pg-cal-hojas">
              {hojas.map(h => (
                <div key={h.rotulo} className={`pg-cal-hoja${h.palabra ? ' is-ancha' : ''}`}>
                  {h.sello ? (
                    <span className="pg-cal-sello">
                      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
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
          )}
          {/* Sin hojas (sin fecha de inicio) la línea de lecciones sube a la
              primera línea, al cuerpo de la leyenda: es lo único que hay. */}
          <div className="pg-cal-texto">
            {leyenda && <p className="pg-cal-leyenda">{leyenda}</p>}
            <p className={leyenda ? 'pg-cal-lecciones' : 'pg-cal-leyenda'}>{lecciones}</p>
          </div>
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
// sobremesa) es el verde de marca, fino.
//
// MEDIDAS FIJAS: cada hoja mide 60 × 56 px pase lo que pase dentro (un número
// de dos cifras, "Hoy" o el sello). La única que se ensancha es la de
// "¡Retoma!" (`is-ancha`: ancho al contenido, nunca menos de 60), porque a un
// cuerpo legible la palabra no cabe en 60 px; la ALTURA es la misma en todas.
// La fila mide lo que las hojas (56 px) en todos los estados, así que cuando
// el LMS contesta y cambia la hoja, la línea de lecciones o el enlace, nada de
// lo de abajo se mueve. La línea de lecciones tiene su altura reservada aunque
// esté vacía, por lo mismo.
//
// El rótulo lleva line-height holgado a propósito: con line-height 1 y el
// overflow oculto, el acento de "DÍAS" se recortaba por arriba.
//
// LA FILA ENVUELVE. En escritorio caben las hojas, el texto y el enlace en una
// línea; en el móvil el enlace va SIEMPRE en la segunda línea, pegado a la
// derecha (`margin-left: auto`), que es donde está también cuando cabe. Sin
// calendario ni lecciones queda solo el enlace, en el mismo sitio.
//
// OJO al escribir comentarios aquí dentro: es un template literal, un acento
// grave rompe el build.

export const CALENDARIO_CSS = `
.pg-cal { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; min-height: 56px; }
.pg-cal-cuenta { display: flex; align-items: center; gap: 12px; min-width: 0; }
.pg-cal-hojas { display: flex; gap: 6px; flex-shrink: 0; }
.pg-cal-hoja {
  position: relative; box-sizing: border-box; overflow: hidden;
  width: 60px; height: 56px; padding-top: 5px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  border: 1px solid #D9E4DC; border-radius: 10px; background: var(--pg-surface);
}
/* El lomo del calendario: una franja fina verde arriba. */
.pg-cal-hoja::before {
  content: ""; position: absolute; top: 0; left: 0; right: 0; height: 5px;
  background: var(--pg-green);
}
.pg-cal-hoja.is-ancha { width: auto; min-width: 60px; padding-left: 10px; padding-right: 10px; }
.pg-cal-num {
  display: block; max-width: 100%; padding: 0 3px; box-sizing: border-box;
  font-size: 26px; font-weight: 700; letter-spacing: -0.03em; line-height: 26px;
  color: var(--pg-green); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* Una palabra en vez de un número ("¡Retoma!"): cuerpo menor, misma altura de línea. */
.pg-cal-num.is-palabra { font-size: 13px; letter-spacing: -0.01em; }
/* "Hoy": una palabra corta que cabe en la hoja de siempre. */
.pg-cal-num.is-corta { font-size: 19px; letter-spacing: -0.02em; }
.pg-cal-sello { display: flex; align-items: center; justify-content: center; height: 26px; color: var(--pg-green); }
.pg-cal-rotulo {
  display: block; max-width: 100%; padding: 0 2px; box-sizing: border-box;
  font-size: 9px; font-weight: 700; letter-spacing: 0.07em; line-height: 12px; text-transform: uppercase;
  color: var(--pg-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* El texto de al lado: dos líneas de altura fija. La segunda existe aunque
   esté vacía (el LMS aún no dijo cuántas lecciones). */
.pg-cal-texto { display: flex; flex-direction: column; justify-content: center; gap: 3px; min-width: 0; }
.pg-cal-leyenda { margin: 0; font-size: 13px; line-height: 17px; color: var(--pg-muted); white-space: nowrap; }
.pg-cal-lecciones { margin: 0; font-size: 11px; line-height: 14px; color: var(--pg-faint); white-space: nowrap; min-height: 14px; }
.pg-cal-link {
  margin-left: auto; flex-shrink: 0; white-space: nowrap;
  font-size: 13px; font-weight: 600; color: var(--pg-green-dark); text-decoration: none;
}
.pg-cal-link:hover { text-decoration: underline; }
.pg-cal-link:focus-visible { outline: 2px solid var(--pg-green); outline-offset: 3px; border-radius: 4px; }

@media (max-width: 720px) {
  /* Dos líneas siempre: hojas y texto arriba, el enlace debajo a la derecha. */
  .pg-cal { gap: 8px 12px; min-height: 0; }
  .pg-cal-link { flex-basis: 100%; text-align: right; }
}
`;
