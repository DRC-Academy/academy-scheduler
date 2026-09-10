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
// diseño nuevo pide quieto y limpio. Lo único que se mueve es la entrada de la
// tarjeta (`pg-rise`), que comparten todas las secciones de la ficha.

import {
  etiquetaMeses, type Estimacion, type EstadoBanner,
} from '@/lib/estimacion';

/** A dónde lleva "Amplía tu plan". Configurable sin tocar código. */
const UPSELL_URL = process.env.NEXT_PUBLIC_UPSELL_URL || 'https://drcacademy.com/mi-cuenta';

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
    <section className="pg-card pg-pace pg-rise" style={{ animationDelay: '180ms' }}>
      <h2 className="pg-pace-title">{t.titulo(estimacion)}</h2>
      <p className="pg-pace-lede">{t.entrada(estimacion)}</p>

      <ol className="pg-bars">
        {estimacion.opciones.map(o => (
          <li key={o.horasSemanales} className={`pg-bar-row${o.esActual ? ' is-current' : ''}`}>
            {/*
              Orden de la fila: plan · distintivo · barra+meses · fecha.
              El distintivo dice una de dos cosas y nunca las dos: en el plan que ya
              tiene, "Tu plan" en gris y pequeño; en los de arriba, lo que se
              ahorraría, en amarillo y grande. En el plan actual no hay ahorro que
              enseñar, y en los otros la etiqueta gris solo restaría.
            */}
            <div className="pg-bar-head">
              <span className="pg-bar-plan">{o.horasSemanales} h a la semana</span>
              {o.esActual && <span className="pg-chip">Tu plan</span>}
            </div>

            {!o.esActual && o.mesesAhorrados > 0 && (
              <span className="pg-save">{etiquetaMeses(o.mesesAhorrados)} antes</span>
            )}

            {/* La barra y los meses van juntos: el hueco de los meses es fijo, así
                las tres barras arrancan y acaban en el mismo sitio. */}
            <div className="pg-bar-line">
              <div className="pg-track">
                <div className="pg-fill" style={{ width: `${o.anchoPct}%` }} aria-hidden />
              </div>
              <span className="pg-bar-months">{etiquetaMeses(o.meses)}</span>
            </div>

            <p className="pg-bar-date">Llegarías en {o.llegada}</p>
          </li>
        ))}
      </ol>

      {t.cta && (
        <div className="pg-cta-block">
          {/*
            `target="_top"` y no `_blank`: esta ficha vive dentro de un iframe en
            "Mi cuenta". Con `_blank` se abría una pestaña nueva y con el destino
            por defecto la tienda se cargaría DENTRO del recuadro, atrapada en un
            marco de 900 px. `_top` la saca a la ventana principal, que es donde
            el alumno espera acabar.
          */}
          <a className="pg-cta" href={UPSELL_URL} target="_top" rel="noopener noreferrer">
            {t.cta}
            <span className="pg-cta-arrow" aria-hidden>→</span>
          </a>
        </div>
      )}
    </section>
  );
}
