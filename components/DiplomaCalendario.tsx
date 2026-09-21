'use client';

// ── El banner de cuenta atrás del diploma, primera pieza de la ficha ──────────
//
// Desde el 21/09/2026 es una FRANJA VERDE de ancho completo que va ANTES de la
// tarjeta "Tu nivel": lo primero que ve el alumno es cuánto le queda. (El
// nombre del archivo viene de la versión anterior, del 18 al 21/09, en la que
// eran dos hojas de calendario de sobremesa dentro de la tarjeta de la
// escalera; antes aún fue un banner ancho de tres renglones en tarjeta propia.)
//
// EL DIBUJO, de izquierda a derecha, en una sola línea de 64 px en escritorio:
//   · las CIFRAS en línea, dígitos grandes en blanco con la unidad en
//     mayúsculas pequeñas al lado: "4 MESES  6 DÍAS"; con menos de 31 días solo
//     los días; a 0 días la palabra HOY;
//   · pegado, el TEXTO: "para tu diploma" y debajo, más pequeño y al 80 %,
//     "38 de 168 lecciones";
//   · a la derecha, el BOTÓN blanco con el texto en verde: "Ir a la plataforma
//     →" (o "Empezar mi curso →" con cero lecciones). Mismo destino de siempre.
// Vencido: en vez de cifras, un titular ("¡Retoma tu curso y consigue tu
// diploma!") y el botón "Continuar mi curso →". Conseguido: "Diploma conseguido
// ✓" y "Ver mi curso →". Sin fecha de inicio: el banner no se pinta.
// En el móvil las cifras y el texto van en una línea y el botón debajo, a la
// derecha; la altura es la que pida el contenido.
//
// QUÉ SE PINTA EN CADA ESTADO lo decide lib/diplomaCalendario.bannerDe, que es
// puro y tiene tests; el cálculo del plazo, lib/diplomaPlazo. Aquí solo se
// pinta lo que devuelven.
//
// SIN HUECO RESERVADO NI CIERRE ANIMADO. La cuenta atrás sale de
// `assignments.start_date`, que la ficha tiene desde el primer render, así que
// se pinta de inmediato. Lo que aporta el LMS (lib/lmsDiploma, hasta 5-6 s en
// frío) llega después: la línea de lecciones, el botón de "Empezar" y saber si
// el diploma ya está CONSEGUIDO. Mientras no contesta —o si no contesta— se
// enseña la cuenta por fecha con la línea de lecciones vacía (su sitio queda
// reservado), y cuando contesta nada cambia de altura: en escritorio la franja
// mide 64 px fijos y en el móvil la línea reservada evita el salto. Con el LMS
// en "sin curso" también se enseña la cuenta: el plazo es una regla de la
// academia (seis meses desde que empezó con su profesor), no del LMS.
//
// Lo monta components/ProgresoFicha por `diplomaSlot`, antes de la tarjeta
// "Tu nivel", así que la medición de altura para el iframe de Mi cuenta
// (components/ProgresoAltura) lo incluye sin más. Sin animación de entrada a
// propósito: en /progreso-cuenta el Suspense cambia el nodo cuando contesta el
// LMS y una animación se repetiría a mitad de página.
//
// Textos en español de España con tuteo, como el resto de la ficha.

import { use, useEffect, useState } from 'react';
import type { Diploma } from '@/lib/diplomaTypes';
import { bannerDe, type DiplomaEstadoSlot } from '@/lib/diplomaCalendario';
import { madridToday } from '@/lib/subscriptionAccess';

/** A dónde lleva el botón: el inicio del LMS, que resuelve la sesión. */
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

/** El banner con sus cifras (o su titular), sus lecciones y su botón. Null si no toca enseñarlo. */
export function DiplomaCalendario({ diploma, startDate = null }: { diploma: DiplomaEstadoSlot; startDate?: string | null }) {
  // El "hoy" es el de Madrid, como todos los plazos de la academia: el mismo
  // alumno ve el mismo número desde cualquier país.
  const b = bannerDe(diploma, startDate, madridToday());
  if (!b) return null;
  const conCifras = b.tipo === 'cuenta' || b.tipo === 'hoy';

  return (
    <section className={`pg-dip is-${b.tipo}`} aria-label="Tu diploma">
      {conCifras && (
        // Las cifras sueltas ("4 MESES 6 DÍAS") se leen mal: el lector de
        // pantalla recibe la frase entera en su lugar.
        <div className="pg-dip-cifras" role="img" aria-label={b.frase ?? undefined}>
          {b.tipo === 'hoy' ? (
            <span className="pg-dip-num">{b.titular}</span>
          ) : (
            b.cifras.map(c => (
              <span key={c.unidad} className="pg-dip-cifra">
                <span className="pg-dip-num">{c.valor}</span>
                <span className="pg-dip-unidad">{c.unidad}</span>
              </span>
            ))
          )}
        </div>
      )}
      <div className="pg-dip-texto">
        {conCifras
          ? <p className="pg-dip-leyenda">{b.leyenda}</p>
          : <p className="pg-dip-titular">{b.titular}</p>}
        {/* Existe aunque esté vacía (el LMS aún no dijo cuántas lecciones):
            así nada se mueve cuando contesta. */}
        <p className="pg-dip-lecciones">{b.lecciones}</p>
      </div>
      <div className="pg-dip-accion">
        <a className="pg-dip-btn" href={LMS_PUBLIC_URL} target="_blank" rel="noopener">{b.enlace}</a>
      </div>
    </section>
  );
}

// ─── Estilos, en la hoja de la ficha ─────────────────────────────────────────
//
// Se concatenan a PROGRESO_CSS en ProgresoStyles. El verde del degradado es el
// de marca (--pg-green) hacia uno más oscuro; el texto, blanco; el botón, blanco
// con el verde oscuro de la ficha. Sin borde ni sombra: la franja es de color.
//
// MEDIDAS: 64 px de alto en escritorio (min-height: si un titular se partiera
// en dos líneas crecería en vez de recortarse), padding 0 20; en el móvil 72 px
// como mínimo y la altura que pida el contenido, con 12 px arriba y abajo
// porque el botón baja a su propia línea. Dígitos 32/700, unidad 11 en
// mayúsculas, 16 px entre grupos de cifras y 16 hasta el texto; leyenda 14,
// lecciones 11 al 80 %; titular 18/600; botón 13/600 con padding 8 14 y radio 8.
//
// LA LÍNEA DE LECCIONES tiene altura reservada aunque esté vacía, por lo mismo
// que en la versión anterior: cuando el LMS contesta, nada salta.
//
// EL BOTÓN va en un envoltorio (.pg-dip-accion) para que en el móvil pueda
// ocupar una línea entera y alinearse a la derecha sin estirar el fondo blanco.
//
// OJO al escribir comentarios aquí dentro: es un template literal, un acento
// grave rompe el build.

export const CALENDARIO_CSS = `
.pg-dip {
  display: flex; align-items: center; gap: 16px;
  min-height: 64px; padding: 0 20px; box-sizing: border-box;
  border-radius: 12px; color: #FFFFFF;
  background: linear-gradient(90deg, var(--pg-green) 0%, #167A2C 100%);
}
.pg-dip-cifras { display: flex; align-items: baseline; gap: 16px; flex-shrink: 0; }
.pg-dip-cifra { display: inline-flex; align-items: baseline; gap: 5px; white-space: nowrap; }
.pg-dip-num { font-size: 32px; font-weight: 700; line-height: 32px; letter-spacing: -0.03em; text-transform: uppercase; }
.pg-dip-unidad { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.pg-dip-texto { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pg-dip-leyenda { margin: 0; font-size: 14px; line-height: 18px; white-space: nowrap; }
.pg-dip-titular { margin: 0; font-size: 18px; font-weight: 600; line-height: 22px; letter-spacing: -0.01em; }
.pg-dip-lecciones { margin: 0; font-size: 11px; line-height: 14px; min-height: 14px; opacity: 0.8; white-space: nowrap; }
.pg-dip-accion { margin-left: auto; flex-shrink: 0; }
.pg-dip-btn {
  display: inline-block; padding: 8px 14px; border-radius: 8px; white-space: nowrap;
  background: #FFFFFF; color: var(--pg-green-dark); font-size: 13px; font-weight: 600; line-height: 16px;
  text-decoration: none;
}
.pg-dip-btn:hover { background: #F0FAF2; }
.pg-dip-btn:focus-visible { outline: 2px solid #FFFFFF; outline-offset: 3px; }

@media (max-width: 720px) {
  /* Cifras y texto en una línea; el botón en la siguiente, a la derecha. */
  .pg-dip { flex-wrap: wrap; min-height: 72px; padding: 12px 20px; gap: 10px 16px; }
  .pg-dip-accion { flex-basis: 100%; display: flex; justify-content: flex-end; }
}
`;
