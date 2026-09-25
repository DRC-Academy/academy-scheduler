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
// En el MÓVIL (≤ 720 px, que es lo que ve el iframe de Mi cuenta en un
// teléfono aunque la pantalla mida 360) el banner es UNA SOLA LÍNEA de 48 px:
// "5 MESES · 21 DÍAS" (o el titular; en ≤ 480 en corto: "¡Retoma tu curso!")
// y el botón a la derecha, que se reduce a una flecha en círculo si no entra;
// "para tu diploma" y las lecciones no se pintan. Las dos versiones del
// titular van en el HTML y las alterna el CSS (.pg-solo-ancho /
// .pg-solo-movil, de la hoja de la ficha): la que no toca va con display none,
// así que el lector de pantalla oye una sola.
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

import { use, useEffect, useRef, useState } from 'react';
import type { Diploma } from '@/lib/diplomaTypes';
import { bannerDe, type DiplomaEstadoSlot } from '@/lib/diplomaCalendario';
import { madridToday } from '@/lib/subscriptionAccess';
// A dónde lleva el botón: el inicio del LMS, que resuelve la sesión.
import { LMS_PUBLIC_URL } from '@/lib/lmsUrl';

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

/** El móvil, para el botón compacto: el mismo corte que la hoja de abajo (≤ 720). */
const MOVIL = '(max-width: 720px)';

/**
 * El banner con sus cifras (o su titular), sus lecciones y su botón. Null si
 * no toca enseñarlo.
 *
 * EL BOTÓN COMPACTO DEL MÓVIL. En ≤ 720 px el banner es una sola línea de
 * 48 px y el botón de texto va al lado de las cifras. Si NO ENTRA (cifras +
 * hueco + botón más anchos que el banner), el botón se reduce a una flecha en
 * un círculo blanco de 32 px y las cifras se quedan solas a la izquierda; el
 * banner nunca baja el botón a una segunda línea ni pasa de 48 px. "¿Entra?"
 * solo lo sabe el navegador (los textos cambian por estado y por alumno), así
 * que se mide con un ResizeObserver y se marca con la clase `is-compacto`;
 * el botón de texto sigue en el HTML, invisible y fuera de flujo, para poder
 * medirlo también cuando ya se cambió por la flecha. Antes de la primera
 * medida (servidor, hidratación) va el botón de texto: en 360 px o más es lo
 * que toca casi siempre, y el overflow oculto del banner tapa el resto.
 */
export function DiplomaCalendario({ diploma, startDate = null }: { diploma: DiplomaEstadoSlot; startDate?: string | null }) {
  // El "hoy" es el de Madrid, como todos los plazos de la academia: el mismo
  // alumno ve el mismo número desde cualquier país.
  const b = bannerDe(diploma, startDate, madridToday());
  const ref = useRef<HTMLElement>(null);
  const [compacto, setCompacto] = useState(false);
  // Lo que cambia el ancho del botón o de la izquierda: se vuelve a medir.
  const firma = b ? `${b.tipo}|${b.enlace}|${b.cifras.map(c => c.valor + c.unidad).join(',')}` : null;

  useEffect(() => {
    const el = ref.current;
    if (!el || !firma) return;
    const medir = () => {
      if (!window.matchMedia(MOVIL).matches) { setCompacto(false); return; }
      const izq = el.querySelector<HTMLElement>('.pg-dip-izq');
      const boton = el.querySelector<HTMLElement>('.pg-dip-btn');
      if (!izq || !boton) return;
      const cs = getComputedStyle(el);
      const disponible = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      // scrollWidth y no offsetWidth: la izquierda puede estar encogida por el
      // flex y lo que importa es lo que NECESITA.
      const necesario = izq.scrollWidth + (parseFloat(cs.columnGap) || 0) + boton.offsetWidth;
      setCompacto(necesario > disponible);
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [firma]);

  if (!b) return null;
  const conCifras = b.tipo === 'cuenta' || b.tipo === 'hoy';

  return (
    <section ref={ref} className={`pg-dip is-${b.tipo}${compacto ? ' is-compacto' : ''}`} aria-label="Tu diploma">
      {/* La izquierda, agrupada: es lo que se mide contra el botón en el teléfono. */}
      <div className="pg-dip-izq">
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
            : b.titularCorto
              ? <p className="pg-dip-titular"><span className="pg-solo-ancho">{b.titular}</span><span className="pg-solo-movil">{b.titularCorto}</span></p>
              : <p className="pg-dip-titular">{b.titular}</p>}
          {/* Existe aunque esté vacía (el LMS aún no dijo cuántas lecciones):
              así nada se mueve cuando contesta. */}
          <p className="pg-dip-lecciones">{b.lecciones}</p>
        </div>
      </div>
      <div className="pg-dip-accion">
        <a className="pg-dip-btn" href={LMS_PUBLIC_URL} target="_blank" rel="noopener" tabIndex={compacto ? -1 : undefined}>{b.enlace}</a>
        {/* La flecha sola: mismo destino, y el texto del botón (sin la flecha)
            como nombre accesible. Solo se pinta en compacto (CSS). */}
        <a className="pg-dip-ico" href={LMS_PUBLIC_URL} target="_blank" rel="noopener" aria-label={b.enlace.replace(/\s*→\s*$/, '')}>→</a>
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
/* La izquierda (cifras + texto) va agrupada para poder medirla de una vez en
   el teléfono; en el dibujo no se nota: mismo hueco que entre los demás. */
.pg-dip-izq { display: flex; align-items: center; gap: 16px; min-width: 0; }
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
/* La flecha en círculo del modo compacto: fuera de él no existe. */
.pg-dip-ico { display: none; }
.pg-dip.is-compacto .pg-dip-accion { position: relative; }
/* El botón de texto se queda en el HTML, invisible y fuera de flujo (hacia la
   izquierda, dentro del banner), solo para poder medirlo. */
.pg-dip.is-compacto .pg-dip-btn { position: absolute; top: 0; right: 0; visibility: hidden; pointer-events: none; }
.pg-dip.is-compacto .pg-dip-ico {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 50%; background: #FFFFFF; color: var(--pg-green-dark);
  font-size: 17px; font-weight: 700; line-height: 1; text-decoration: none;
}
.pg-dip.is-compacto .pg-dip-ico:hover { background: #F0FAF2; }
.pg-dip.is-compacto .pg-dip-ico:focus-visible { outline: 2px solid #FFFFFF; outline-offset: 3px; }

/* MÓVIL (todo lo que no es escritorio, ≤ 720 px): UNA SOLA LÍNEA de 48 px.
   Fila flex sin salto posible: cifras "5 MESES · 21 DÍAS" (dígitos 20,
   unidades 10, un punto entre grupos) o el titular a 14 a la izquierda, y el
   botón a la derecha en la misma línea (12 px, padding 6 10, nowrap). Sin
   "para tu diploma" ni lecciones; en el estado "hoy" se deja "es el día de tu
   diploma", que sin él HOY no se entiende. Padding 0 14.

   Vale desde 720 y no desde 480 a propósito: dentro del iframe de Mi cuenta el
   ancho que ve la ficha es el del contenedor de WordPress, no el de la
   pantalla, y en un teléfono puede pasar de 480. Hasta el 21/09/2026 el tramo
   481-720 bajaba el botón a una segunda línea (banner de 100 px): era lo que
   se veía en el teléfono. Ahora ningún ancho móvil tiene segunda línea. */
@media (max-width: 720px) {
  /* Altura FIJA de 48 y overflow oculto: ni una segunda línea ni un botón que
     asome antes de que el navegador mida si entra. */
  .pg-dip { flex-wrap: nowrap; align-items: center; height: 48px; min-height: 0; padding: 0 14px; gap: 10px; overflow: hidden; }
  .pg-dip-izq { gap: 10px; flex-shrink: 1; }
  .pg-dip-cifras { gap: 6px; white-space: nowrap; }
  .pg-dip-cifra { gap: 4px; }
  .pg-dip-cifra + .pg-dip-cifra::before { content: "·"; font-size: 14px; font-weight: 700; margin-right: 6px; opacity: 0.75; }
  .pg-dip-num { font-size: 20px; line-height: 24px; letter-spacing: -0.02em; }
  .pg-dip-unidad { font-size: 10px; letter-spacing: 0.06em; }
  .pg-dip-leyenda, .pg-dip-lecciones { display: none; }
  .pg-dip.is-hoy .pg-dip-leyenda { display: block; font-size: 12px; line-height: 16px; white-space: nowrap; }
  .pg-dip-titular { font-size: 14px; line-height: 18px; white-space: nowrap; }
  .pg-dip-accion { margin-left: auto; flex-shrink: 0; }
  .pg-dip-btn { font-size: 12px; line-height: 14px; padding: 6px 10px; border-radius: 7px; white-space: nowrap; }
}
`;
