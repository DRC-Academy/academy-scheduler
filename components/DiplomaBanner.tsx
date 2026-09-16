'use client';

// ── El banner del diploma en la ficha de progreso ────────────────────────────
//
// Es el diploma del LMS (components/BannerDiploma.tsx allí) contado en la ficha,
// portado al sistema de estilos de aquí (clases pg-*, hoja inline, sin Tailwind).
// Ya no es una barra suelta: es un banner compacto de tres renglones, con un
// rótulo verde arriba al estilo de los de la ficha, la cifra de protagonista y
// el carril fino debajo.
//
// ES UNA TARJETA MÁS (`pg-card`), entre la caja "Tu nivel" y el banner de ritmo:
// mismo fondo, borde y radio que sus vecinas, y la separación la pone el `gap`
// de `.pg-main` (por eso no lleva margen propio). Un poco más ancha que las
// otras donde hay margen lateral para ello, para que resalte; y con menos aire
// arriba y abajo que ellas, que es un bloque de tres renglones y no una sección.
//
// LLEGA TARDE Y NO PUEDE MOVER NADA DE LO DE ABAJO. El dato lo da el LMS
// (lib/lmsDiploma.ts), que tarda hasta 5-6 s en frío, así que la ficha se pinta
// entera sin él y esta tarjeta se rellena después. Para que el banner de ritmo
// no se desplace, el hueco queda reservado desde el primer render con la MISMA
// altura que tendrá la tarjeta (`min-height` del contenido = la altura del
// estado más alto; los tres estados están medidos para dar exactamente esa
// altura), con un esqueleto tenue dentro. Si no hay nada que enseñar —sin
// curso, o el LMS no contestó— la tarjeta entera se cierra con una transición
// (altura, padding, borde y el hueco del gap) y desaparece: no queda una caja
// blanca vacía.
//
// Va DENTRO de `.pg-page` (es hijo de `.pg-main`): así la medición de altura
// para el iframe de Mi cuenta (components/ProgresoAltura.tsx) lo incluye, y
// su ResizeObserver avisa al padre cuando el bloque cambia.
//
// LOS TRES ESTADOS QUE SE PINTAN:
//   · en curso  → "TU CAMINO AL DIPLOMA", la cifra de lecciones restantes en
//                 grande, "N de M" a la derecha, y el carril con el relleno;
//   · sin empezar (en curso con cero lecciones; el LMS enseña la barra vacía y
//                 "0 de 187", que no invita a nada) → "TU CURSO TE ESPERA", una
//                 frase y un enlace al LMS en PESTAÑA NUEVA: la ficha vive
//                 embebida en Mi cuenta y no hay que sacar al alumno del iframe.
//                 Sin carril y sin contador. El enlace es un botón secundario a
//                 propósito: el CTA principal de la página sigue siendo el
//                 "Amplía tu plan" del banner de abajo, y no compiten;
//   · conseguido → "DIPLOMA CONSEGUIDO", el carril lleno con el sello ✓ y
//                 "M de M" a la derecha. Sin cifra de restantes.
//
// SIEMPRE "LECCIONES", NUNCA "CLASES". La caja de "Tu nivel" cuenta CLASES con
// el profesor ("18 clases hechas", "Clase 30, próximo hito"); esto cuenta
// lecciones del LMS, que son otra cosa. La palabra es la única pista que tiene
// el alumno para no mezclar los dos números.
//
// Textos en español de España con tuteo, como el resto de la ficha.

import { use, useEffect, useState } from 'react';
import type { Diploma } from '@/lib/diplomaTypes';

/** A dónde lleva "Ir a la plataforma": el inicio del LMS, que resuelve la sesión. */
export const LMS_PUBLIC_URL = 'https://drc-lms.vercel.app';

/** 'cargando' mientras se espera al LMS; null cuando no hay nada que enseñar. */
export type DiplomaEstadoSlot = Diploma | null | 'cargando';

// ─── Textos ──────────────────────────────────────────────────────────────────

const T = {
  // En curso
  caminoAlDiploma: 'Tu camino al diploma',
  leccionesParaTuDiploma: (n: number) => (n === 1 ? 'lección para tu diploma' : 'lecciones para tu diploma'),
  progreso: (hechas: number, total: number) => `${hechas} de ${total}`,
  faltan: (restantes: number, total: number) =>
    `Te ${restantes === 1 ? 'falta' : 'faltan'} ${restantes} de ${total} lecciones para tu diploma`,
  // Sin empezar
  teEspera: 'Tu curso te espera',
  comienza: 'Comienza ahora el camino hacia tu diploma.',
  irALaPlataforma: 'Ir a la plataforma →',
  // Conseguido
  diplomaConseguido: 'Diploma conseguido',
  todasCompletadas: 'Todas las lecciones completadas.',
  cursoCompletado: 'Curso completado',
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
    <section className={clase} aria-label={tituloDe(diploma)}>
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
        <p className="pg-diploma-titulo">{T.diplomaConseguido}</p>
        <div className="pg-diploma-fila pg-diploma-fila-centrada">
          <p className="pg-diploma-texto"><span className="pg-diploma-desc">{T.todasCompletadas}</span></p>
          <span className="pg-diploma-cuenta">{T.progreso(diploma.total, diploma.total)}</span>
        </div>
        <Barra relleno={100} descripcion={T.cursoCompletado} conseguido />
      </>
    );
  }

  // En curso sin empezar: una invitación y el enlace, en vez de una barra vacía.
  if (diploma.completadas === 0) {
    return (
      <>
        <p className="pg-diploma-titulo">{T.teEspera}</p>
        <p className="pg-diploma-frase">{T.comienza}</p>
        <a className="pg-diploma-cta" href={LMS_PUBLIC_URL} target="_blank" rel="noopener">{T.irALaPlataforma}</a>
      </>
    );
  }

  const hechas = Math.min(diploma.completadas, diploma.total);
  const relleno = diploma.total > 0 ? Math.round((hechas / diploma.total) * 100) : 0;
  return (
    <>
      <p className="pg-diploma-titulo">{T.caminoAlDiploma}</p>
      <div className="pg-diploma-fila">
        <p className="pg-diploma-texto">
          <span className="pg-diploma-cifra">{diploma.restantes}</span>
          <span className="pg-diploma-desc">{T.leccionesParaTuDiploma(diploma.restantes)}</span>
        </p>
        <span className="pg-diploma-cuenta">{T.progreso(hechas, diploma.total)}</span>
      </div>
      <Barra relleno={relleno} descripcion={T.faltan(diploma.restantes, diploma.total)} conseguido={false} />
    </>
  );
}

/** El rótulo que lleva la tarjeta en cada estado; es lo que anuncia el lector de pantalla. */
function tituloDe(diploma: Diploma): string {
  if (diploma.estado === 'conseguido') return T.diplomaConseguido;
  return diploma.completadas === 0 ? T.teEspera : T.caminoAlDiploma;
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

/** Lo que se ve mientras se espera al LMS: la silueta de los tres renglones, en tenue. */
function Esqueleto() {
  return (
    <div className="pg-diploma-skel">
      <div className="pg-diploma-skel-titulo" />
      <div className="pg-diploma-skel-cifra" />
      <div className="pg-diploma-skel-barra" />
    </div>
  );
}

// ─── Estilos, en la hoja de la ficha ─────────────────────────────────────────
//
// Se concatenan a PROGRESO_CSS en ProgresoStyles. Colores: las variables de la
// ficha son la misma familia que las `marca.*` del LMS (verde #1E9E3A, verde
// oscuro #14722A, tinta, gris medio, gris tenue); el carril (#E8EEE9) y la punta
// (#6FD98A) van literales, como allí.
//
// LA ALTURA RESERVADA: 78 px de contenido, y los tres estados dan EXACTAMENTE
// esos 78 px con alturas fijas por renglón (un renglón con dos cuerpos distintos
// y align-items baseline crecía medio píxel y desbarataba la cuenta):
//   · en curso / conseguido: rótulo 14 + 8 · fila de la cifra 32 + 12 · carril 12
//   · sin empezar:           rótulo 14 + 8 · frase 22 + 6 · enlace 28
// El esqueleto mide igual. Con el padding de la tarjeta (20 px arriba y abajo,
// 16 en móvil) y el borde, la tarjeta mide lo mismo en los tres estados y
// mientras carga: nada de lo de abajo se mueve.
//
// EL RÓTULO es el de los rótulos de la ficha ("TU NIVEL", "TU OBJETIVO") pero
// en verde oscuro, que a ese cuerpo es el verde que pasa el contraste, y con los
// números del rótulo de la ficha del LMS (11,5 px, espaciado 0.14em) para que
// las dos pantallas sean idénticas.
//
// EL CIERRE: se animan a cero la altura, el padding, el borde y, con un margen
// negativo, el `gap` que `.pg-main` deja después de la tarjeta (18 px, 14 en
// móvil). Al terminar, el slot la desmonta: no hay salto residual.

export const DIPLOMA_CSS = `
.pg-diploma {
  box-sizing: border-box;
  /* Menos aire vertical que las otras tarjetas (24 px): son tres renglones. */
  padding: 20px 26px;
  max-height: 220px;
  opacity: 1;
  overflow: hidden;
  transition: max-height 300ms ease, padding 300ms ease, border-width 300ms ease, margin 300ms ease, opacity 200ms ease;
}
.pg-diploma-in { min-height: 78px; }
.pg-diploma.pg-diploma-cerrando {
  max-height: 0; opacity: 0;
  padding-top: 0; padding-bottom: 0; border-top-width: 0; border-bottom-width: 0;
  margin-bottom: -18px;
}
/* Un poco más ancha que sus vecinas, comiéndose 12 px del margen lateral de
   .pg-main a cada lado. Solo donde ese margen existe: en el móvil es de 14 px y
   dentro de Mi cuenta (.pg-embed) es cero, y ahí una tarjeta más ancha que la
   página se recorta. */
@media (min-width: 721px) { .pg-diploma { margin-left: -12px; margin-right: -12px; } }
@media (max-width: 720px) {
  .pg-diploma { padding: 16px 18px; }
  .pg-diploma.pg-diploma-cerrando { margin-bottom: -14px; }
}
.pg-embed .pg-diploma { margin-left: 0; margin-right: 0; }
/* El contenido entra con un fundido; la tarjeta no se mueve. */
.pg-diploma-llega { animation: pg-diploma-llega 220ms ease-out both; }
@keyframes pg-diploma-llega { from { opacity: 0; } to { opacity: 1; } }

/* Renglón 1: el rótulo. */
.pg-diploma-titulo {
  height: 14px; line-height: 14px; margin: 0 0 8px;
  font-size: 11.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--pg-green-dark);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Renglón 2 (en curso y conseguido): la cifra a la izquierda, el recuento al
   extremo derecho. Altura FIJA. */
.pg-diploma-fila { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; height: 32px; margin-bottom: 12px; }
/* Conseguido: sin cifra grande, la frase se centra en el renglón para no quedar
   pegada al rótulo con aire debajo. */
.pg-diploma-fila-centrada { align-items: center; }
.pg-diploma-texto { display: flex; align-items: baseline; gap: 7px; min-width: 0; margin: 0; }
.pg-diploma-cifra {
  flex-shrink: 0; font-size: 26px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.1;
  color: var(--pg-ink);
}
.pg-diploma-desc {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 15px; line-height: 1.25; color: var(--pg-muted);
}
.pg-diploma-cuenta { flex-shrink: 0; white-space: nowrap; font-size: 12.5px; line-height: 1; color: var(--pg-faint); }
/* Teléfonos estrechos (360 px): "176 lecciones para tu diploma · 15 de 191" no
   entra en los 294 px de contenido y el texto se cortaba con puntos suspensivos.
   Un cuerpo un punto menor lo hace caber; las alturas fijas no cambian. */
@media (max-width: 380px) {
  .pg-diploma-fila { gap: 10px; }
  .pg-diploma-texto { gap: 6px; }
  .pg-diploma-cifra { font-size: 23px; }
  .pg-diploma-desc { font-size: 13.5px; }
}

/* Renglón 3: el carril. */
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

/* Sin empezar: la frase y, debajo, el enlace. 22 + 6 + 28 = los mismos 56 px
   que ocupan la fila de la cifra y el carril. */
.pg-diploma-frase {
  height: 22px; line-height: 22px; margin: 0 0 6px;
  font-size: 15px; color: var(--pg-ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* Botón secundario: píldora con borde, sin relleno ni sombra. Discreto a
   propósito: el "Amplía tu plan" verde macizo de abajo es el CTA de la página
   y este no le compite. En bloque, no inline: un inline-block arrastraba el
   line box del padre. */
.pg-diploma-cta {
  display: flex; align-items: center; width: fit-content; box-sizing: border-box;
  height: 28px; padding: 0 13px; border-radius: 999px;
  border: 1.5px solid #B7DCC0; background: transparent;
  font-size: 13px; line-height: 1; font-weight: 600; color: var(--pg-green-dark);
  text-decoration: none; white-space: nowrap;
  transition: background 0.16s ease, border-color 0.16s ease;
}
.pg-diploma-cta:hover { background: var(--pg-green-tint); border-color: #8FC99E; }
.pg-diploma-cta:focus-visible { outline: 2px solid var(--pg-green); outline-offset: 2px; }

/* El esqueleto: la silueta de los tres renglones, en tenue.
   2 + 10 + 14 + 24 + 16 + 12 = 78 px. Padding y no margen arriba: un margen se
   escapaba del esqueleto y el hueco medía de más. */
.pg-diploma-skel { height: 78px; padding-top: 2px; box-sizing: border-box; }
.pg-diploma-skel-titulo { width: 130px; height: 10px; border-radius: 5px; margin: 0 0 14px; background: var(--pg-grey-tint); }
.pg-diploma-skel-cifra { width: 52%; max-width: 260px; height: 24px; border-radius: 6px; margin: 0 0 16px; background: var(--pg-grey-tint); }
.pg-diploma-skel-barra { height: 12px; border-radius: 6px; background: var(--pg-grey-tint); }
.pg-diploma-skel-titulo, .pg-diploma-skel-cifra, .pg-diploma-skel-barra { animation: pg-diploma-pulso 1.6s ease-in-out infinite; }
@keyframes pg-diploma-pulso { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }

@media (prefers-reduced-motion: reduce) {
  .pg-diploma { transition: none; }
  .pg-diploma-cta { transition: none; }
  .pg-diploma-llega, .pg-diploma-skel-titulo, .pg-diploma-skel-cifra, .pg-diploma-skel-barra { animation: none; }
}
`;
