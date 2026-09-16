'use client';

// ── El banner de ampliación de plan ───────────────────────────────────────────
//
// La misma distancia recorrida a dos o tres velocidades, con la fecha de llegada
// de cada una. La fecha es lo que convence: "7 meses" es abstracto, "abril de
// 2027" se entiende de golpe.
//
// NO CALCULA NADA. Todo lo decide lib/estimacion: si el banner se pinta, cuál de
// los cuatro estados es, qué planes se ofrecen y cuánto se ahorra. Aquí solo se
// elige el texto y se dibuja. Es lo que permite cambiar los números que ve el
// alumno tocando cinco constantes y nada más.
//
// LOS TEXTOS VIVEN EN UN DICCIONARIO (`TEXTOS`), uno por estado. Cambiar el tono
// o la promesa es editar ese objeto: no hay una sola frase suelta en el JSX.
//
// PLANO Y SIN ANIMACIONES. Las barras son CSS puro (un div con `width` en
// porcentaje) y se pintan ya en su sitio: antes crecían desde 0 al montar, y el
// diseño nuevo pide quieto y limpio. Esta tarjeta tampoco lleva la entrada
// escalonada (`pg-rise`) del resto de la ficha: nada se mueve en el banner.
//
// TRES FILAS, TRES PESOS. El plan actual es el punto de partida (gris, sin
// borde); los planes superiores van en claro con borde suave; el de MÁS horas
// (`estimacion.mejor`, el último de la lista) lleva además el distintivo
// "Recomendado" y un borde verde algo más marcado, sin cambiar de tamaño ni
// de altura respecto a los otros. La etiqueta amarilla del ahorro sigue siendo
// lo que más salta; el distintivo es secundario.

import { useEffect, useRef } from 'react';
import {
  etiquetaMeses, type Estimacion, type EstadoBanner,
} from '@/lib/estimacion';
import { ORIGENES_PADRE } from '@/components/ProgresoAltura';

type EstadoVisible = Exclude<EstadoBanner, 'sin_datos'>;

interface Textos {
  /** Titular. */
  titulo: (e: Estimacion) => string;
  /** Frase de entrada. */
  entrada: (e: Estimacion) => string;
  /** Texto del botón. null = sin botón. */
  cta: string | null;
}

/**
 * TODO el texto del banner, por estado. Español de España, tuteo.
 *
 * · `ahorro`  El caso normal: se le enseña lo que gana yendo más rápido.
 * · `examen`  Su meta es un examen concreto y el texto lo nombra: quien prepara
 *             el First no quiere "subir de nivel", quiere aprobar.
 * · `tope`    Ya hace el máximo. No se le vende nada: se le reconoce el ritmo.
 *             Un banner que empuja a quien ya va al máximo solo molesta.
 */
export const TEXTOS: Record<EstadoVisible, Textos> = {
  ahorro: {
    titulo: () => '¡Puedes llegar antes de lo que crees!',
    entrada: () => '¿Cuánto tardarías en conseguir tu objetivo con otros planes?',
    cta: 'Amplía tu plan',
  },
  examen: {
    titulo: () => '¡Puedes llegar preparado antes!',
    entrada: e => `¿Cuánto tardarías en llegar al ${e.meta.nivel} con otros planes?`,
    cta: 'Amplía tu plan',
  },
  // Sin ampliación que ofrecer, la pregunta del LMS ("¿con otros planes?") no
  // tiene respuesta: ya está en el más alto. Se le enseña su previsión y se le
  // reconoce el ritmo, que es lo único honesto que se le puede decir.
  tope: {
    titulo: () => '¡Vas al mejor ritmo posible!',
    entrada: () => 'Ya haces el máximo de clases a la semana. Esto es lo que tardarías en conseguir tu objetivo.',
    cta: null,
  },
};

/**
 * El banner. `estimacion` es null en el estado `sin_datos` (no hay nivel, no hay
 * horas, o no hay meta por encima): entonces no se pinta nada y el resto de la
 * ficha sigue igual.
 */
export function BannerAmpliar({ estimacion }: { estimacion: Estimacion | null }) {
  if (!estimacion) return null;
  const t = TEXTOS[estimacion.estado];

  return (
    <section className="pg-card pg-pace">
      <h2 className="pg-pace-title">{t.titulo(estimacion)}</h2>
      <p className="pg-pace-lede">{t.entrada(estimacion)}</p>

      <ol className="pg-bars">
        {estimacion.opciones.map(o => {
          const esMejor = !o.esActual && estimacion.mejor?.horasSemanales === o.horasSemanales;
          return (
          <li key={o.horasSemanales} className={`pg-bar-row${o.esActual ? ' is-current' : ''}${esMejor ? ' is-best' : ''}`}>
            {/*
              Cada tarjeta, de arriba abajo: plan (+ "Tu plan" o "Recomendado") ·
              hueco del ahorro · meses en grande · barra · fecha. En escritorio las
              tres van en columnas y comparten las filas de la rejilla (subgrid),
              así el hueco del ahorro de la primera —que no lo tiene— mide lo mismo
              que la etiqueta amarilla de las otras y las barras arrancan a la misma
              altura. En móvil se apilan en versión compacta: los meses suben a la
              línea del plan y la barra ocupa todo el ancho.

              El distintivo dice una de dos cosas y nunca las dos: en el plan que ya
              tiene, "Tu plan"; en los de arriba, lo que se ahorraría, en amarillo.
            */}
            <div className="pg-bar-head">
              <span className="pg-bar-plan">{o.horasSemanales} h a la semana</span>
              {o.esActual && <span className="pg-chip">Tu plan</span>}
              {/* Dentro de la cabecera (no en posición absoluta) para que en 360 px
                  nunca se monte sobre "4 h a la semana": si no cabe, baja de línea. */}
              {esMejor && <span className="pg-badge-best">Recomendado</span>}
            </div>

            {/* El hueco existe SIEMPRE, con etiqueta o vacío: es lo que mantiene las
                tres tarjetas cuadradas entre sí. */}
            <div className="pg-save-slot">
              {!o.esActual && o.mesesAhorrados > 0 && (
                <span className="pg-save">{etiquetaMeses(o.mesesAhorrados)} antes</span>
              )}
            </div>

            <span className="pg-bar-months">{etiquetaMeses(o.meses)}</span>

            <div className="pg-track">
              <div className="pg-fill" style={{ width: `${o.anchoPct}%` }} aria-hidden />
            </div>

            <p className="pg-bar-date">Llegarías en {o.llegada}</p>
          </li>
          );
        })}
      </ol>

      {t.cta && (
        <div className="pg-cta-block">
          <CtaAmpliar texto={t.cta} />
        </div>
      )}
    </section>
  );
}

// ─── El botón, y a dónde lleva ───────────────────────────────────────────────
//
// EL DESTINO DE VERDAD ES EL CAMBIO DE PLAN DE WOOCOMMERCE: la misma URL que el
// botón "Aumentar o Disminuir Plan" de la pestaña Suscripción de Mi cuenta
// (/producto/…/?switch-subscription=…&item=…&_wcsnonce=…). Esa URL SOLO la puede
// generar WordPress, porque lleva un nonce de la sesión del usuario: aquí no se
// construye ni se adivina.
//
// Así que el botón tiene dos comportamientos según dónde viva la ficha:
//
//   · DENTRO DEL IFRAME DE MI CUENTA (lo normal): no navega. Le manda al padre
//     un mensaje `drc:ampliar-plan` y es WordPress —con el snippet de
//     docs/progreso-wordpress.md— quien lleva la VENTANA PRINCIPAL a la URL del
//     cambio de plan. Al padre solo se le habla en los orígenes de la academia,
//     como hace ProgresoAltura con la altura.
//
//   · COMO PÁGINA SUELTA (/progreso/[token], o si alguien abre /progreso-cuenta
//     a pelo): es un enlace normal a la lista de suscripciones de Mi cuenta.
//
// RED DE SEGURIDAD. Si el padre no tiene el snippet (o todavía no lo tiene), el
// mensaje cae en el vacío y el botón parecería muerto. Por eso el padre contesta
// `drc:ampliar-plan-ok` ANTES de navegar; si en 1,2 s no ha llegado ni la
// respuesta ni la descarga del iframe, el botón lleva la ventana principal a la
// lista de suscripciones, que es el destino de reserva. Con el snippet puesto
// ese temporizador nunca llega a saltar.

/** A dónde lleva "Amplía tu plan" fuera del iframe, y de reserva dentro. Configurable sin tocar código. */
const UPSELL_URL = process.env.NEXT_PUBLIC_UPSELL_URL || 'https://drcacademy.com/mi-cuenta/subscriptions/';
/** Lo que se le pide al padre, y lo que contesta él cuando se hace cargo. */
export const AMPLIAR_MESSAGE_TYPE = 'drc:ampliar-plan';
export const AMPLIAR_OK_MESSAGE_TYPE = 'drc:ampliar-plan-ok';
const ESPERA_RESPUESTA_MS = 1200;

function CtaAmpliar({ texto }: { texto: string }) {
  const reserva = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (window.self === window.top) return;   // no está dentro de un iframe
    function alContestar(e: MessageEvent) {
      if (!ORIGENES_PADRE.includes(e.origin)) return;
      if (!e.data || e.data.type !== AMPLIAR_OK_MESSAGE_TYPE) return;
      // El padre se hace cargo: la reserva ya no hace falta.
      if (reserva.current) { clearTimeout(reserva.current); reserva.current = null; }
    }
    window.addEventListener('message', alContestar);
    return () => {
      window.removeEventListener('message', alContestar);
      if (reserva.current) clearTimeout(reserva.current);
    };
  }, []);

  function alPulsar(e: React.MouseEvent<HTMLAnchorElement>) {
    if (window.self === window.top) return;   // página suelta: el enlace hace lo suyo
    e.preventDefault();
    for (const origen of ORIGENES_PADRE) {
      try { window.parent.postMessage({ type: AMPLIAR_MESSAGE_TYPE }, origen); } catch { /* origen no permitido: se ignora */ }
    }
    if (reserva.current) clearTimeout(reserva.current);
    reserva.current = setTimeout(() => {
      reserva.current = null;
      // La ventana principal, no el recuadro: la tienda dentro de un marco de
      // 900 px es justo lo que se quiere evitar. La activación del clic sigue
      // vigente, así que el navegador lo permite.
      try { window.top!.location.href = UPSELL_URL; } catch { window.location.href = UPSELL_URL; }
    }, ESPERA_RESPUESTA_MS);
  }

  // `target="_top"` y no `_blank`: fuera del iframe da igual, y dentro es lo que
  // haría el enlace sin JavaScript: sacar la tienda a la ventana principal.
  return (
    <a className="pg-cta" href={UPSELL_URL} target="_top" rel="noopener noreferrer" onClick={alPulsar}>
      {texto}
      <span className="pg-cta-arrow" aria-hidden>→</span>
    </a>
  );
}
