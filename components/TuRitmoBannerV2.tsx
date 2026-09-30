'use client';

// ── «Tu ritmo», rediseño (variación C: «Elige tu ritmo») ──────────────────────
//
// VISTA PREVIA. Lo monta solo components/ProgresoFichaV2, que solo se ve en
// /progreso-preview/[token]. La ficha de los alumnos sigue con
// components/BannerAmpliar hasta que se apruebe este diseño.
//
// UN SIMULADOR, NO UNA TABLA. Fondo amarillo de marca, un selector con los
// planes (el suyo y las ampliaciones) y, en una tarjeta blanca, la respuesta
// en grande: el mes en que llegaría con el plan elegido. Arranca marcado en el
// plan de más horas, que es la respuesta que el banner quiere enseñar; el
// alumno toca su plan y ve la diferencia.
//
// NO CALCULA NADA. Todo sale de lib/estimacion.construirEstimacion, la misma
// función que usa el banner de producción: mismos meses, misma fecha de
// llegada, mismos estados (`ahorro`, `examen`, `tope`; con `null` no se pinta).
//
// EL BOTÓN es el de producción copiado tal cual (components/BannerAmpliar,
// CtaAmpliar): dentro del iframe de Mi cuenta manda `drc:ampliar-plan` al padre
// y no navega; fuera, lleva a UPSELL_URL. Ver allí por qué no hay target _top.

import { useState } from 'react';
import { etiquetaMeses, type Estimacion, type OpcionPlan } from '@/lib/estimacion';
import { AMPLIAR_MESSAGE_TYPE } from '@/components/BannerAmpliar';
import { ORIGENES_PADRE } from '@/components/ProgresoAltura';

/** Textos del banner según el estado y la meta. Español de España, tuteo. */
function textos(e: Estimacion): { pregunta: string; frase: string } {
  const nivel = e.meta.nivel;
  const nombrada = nivel && (e.meta.origen === 'examen' || e.meta.origen === 'siguiente_nivel');
  const examen = e.meta.origen === 'examen';
  const destino = !nombrada ? null : examen ? `preparado al ${nivel}` : `al ${nivel}`;

  if (e.estado === 'tope') {
    return {
      pregunta: 'Vas al mejor ritmo posible: ya haces el máximo de clases a la semana.',
      frase: destino ? `Llegarás ${destino} en` : 'Conseguirás tu objetivo en',
    };
  }
  return {
    pregunta: destino
      ? `Elige tu ritmo y mira cuándo llegas ${destino}.`
      : 'Elige tu ritmo y mira cuándo consigues tu objetivo.',
    frase: destino ? `Llegarías ${destino} en` : 'Conseguirías tu objetivo en',
  };
}

/** "4 meses · 3 meses antes que con tu plan" · "7 meses · es tu plan actual". */
function detalle(o: OpcionPlan): string {
  if (o.esActual) return `${etiquetaMeses(o.meses)} · es tu plan actual`;
  if (o.mesesAhorrados > 0) return `${etiquetaMeses(o.meses)} · ${etiquetaMeses(o.mesesAhorrados)} antes que con tu plan`;
  return etiquetaMeses(o.meses);
}

export function TuRitmoBannerV2({ estimacion }: { estimacion: Estimacion | null }) {
  const inicial = estimacion?.mejor?.horasSemanales ?? estimacion?.horasSemanalesActuales ?? 0;
  const [elegidas, setElegidas] = useState(inicial);
  if (!estimacion) return null;

  const t = textos(estimacion);
  const actual = estimacion.opciones.find(o => o.esActual) ?? estimacion.opciones[0];
  const elegida = estimacion.opciones.find(o => o.horasSemanales === elegidas) ?? actual;
  // Un punto por mes del plan actual (el más largo), llenos hasta la llegada del elegido.
  const puntos = Array.from({ length: actual.meses }, (_, i) => i < elegida.meses);
  const conBoton = estimacion.estado !== 'tope';

  return (
    <section className="p2-ritmo" aria-labelledby="p2-ritmo-titulo">
      <span className="p2-ritmo-sol" aria-hidden />
      <div className="p2-ritmo-izq">
        <p className="p2-ritmo-kicker">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="13.5" r="7.5" stroke="currentColor" strokeWidth="2" />
            <path d="M12 13.5V10M10 3h4M18.5 6.5l1.5-1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Tu ritmo
        </p>
        <h2 id="p2-ritmo-titulo" className="p2-ritmo-titulo">{t.pregunta}</h2>

        {estimacion.opciones.length > 1 && (
          <div className="p2-seg" role="group" aria-label="Horas de clase a la semana">
            {estimacion.opciones.map(o => {
              const activa = o.horasSemanales === elegida.horasSemanales;
              return (
                <button
                  key={o.horasSemanales}
                  type="button"
                  className={`p2-seg-btn${activa ? ' is-activa' : ''}`}
                  aria-pressed={activa}
                  onClick={() => setElegidas(o.horasSemanales)}
                >
                  {o.horasSemanales} h{o.esActual && <span className="p2-seg-nota"> · tu plan</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="p2-respuesta" aria-live="polite">
        <p className="p2-respuesta-frase">{t.frase}</p>
        <p className="p2-respuesta-fecha">{elegida.llegada}</p>
        <p className="p2-respuesta-detalle">{detalle(elegida)}</p>
        <div className="p2-puntos" aria-hidden>
          {puntos.map((lleno, i) => <span key={i} className={`p2-punto${lleno ? ' is-lleno' : ''}`} />)}
        </div>
        {conBoton && <CtaAmpliarV2 />}
      </div>
    </section>
  );
}

// ─── El botón: copia literal del de producción (BannerAmpliar, CtaAmpliar) ────

/** A dónde lleva "Amplía tu plan" fuera del iframe. Mismo valor que en BannerAmpliar. */
const UPSELL_URL = process.env.NEXT_PUBLIC_UPSELL_URL || 'https://drcacademy.com/mi-cuenta/subscriptions/';

function CtaAmpliarV2() {
  function alPulsar(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    if (window.self !== window.top) {
      for (const origen of ORIGENES_PADRE) {
        try { window.parent.postMessage({ type: AMPLIAR_MESSAGE_TYPE }, origen); } catch { /* origen no permitido: se ignora */ }
      }
      return;   // no navegar nada más: WordPress se encarga
    }
    window.location.href = UPSELL_URL;
  }

  return (
    <button type="button" className="p2-cta" onClick={alPulsar}>
      Amplía tu plan
    </button>
  );
}
