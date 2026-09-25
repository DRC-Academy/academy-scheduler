'use client';

// La mascota animada de las páginas públicas (formulario inicial y prueba de
// nivel). Es la MISMA del LMS —components/mascota/Geckonoid.tsx es una copia—,
// pero sin la capa global del LMS (CapaMascota, anclas, store): aquí cada
// pantalla pinta la suya en su sitio y la maneja con `useMandoGecko`.
//
//   const gecko = useMandoGecko();
//   <GeckoAnimado mando={gecko} alto={72} altoMovil={54} />
//   gecko.dispara('duda');   // un estado de paso: 2,5 s y vuelve solo a idle
//   gecko.gesto('saludo');   // una pose suelta encima del estado
//
// Respirar, la cola, el parpadeo y los micro-gestos de cada 8–15 s los hace
// Geckonoid solo. Con prefers-reduced-motion no se mueve (lo decide Geckonoid).

import { useCallback, useState, useSyncExternalStore } from 'react';
import Geckonoid from '@/components/mascota/Geckonoid';
import type { EstadoMascota, GestoMascota } from '@/components/mascota/estados';

export interface MandoGecko {
  estado: EstadoMascota;
  disparo: number;
  pose?: { nombre: GestoMascota; n: number };
  dispara: (estado: EstadoMascota) => void;
  gesto: (nombre: GestoMascota) => void;
}

export function useMandoGecko(inicial: EstadoMascota = 'idle'): MandoGecko {
  const [estado, setEstado] = useState<EstadoMascota>(inicial);
  const [disparo, setDisparo] = useState(0);
  const [pose, setPose] = useState<{ nombre: GestoMascota; n: number } | undefined>(undefined);
  // Disparar dos veces el mismo estado vuelve a lanzar la animación: por eso
  // `disparo` cambia siempre, aunque el estado se repita.
  const dispara = useCallback((nuevo: EstadoMascota) => {
    setEstado(nuevo);
    setDisparo(d => d + 1);
  }, []);
  const gesto = useCallback((nombre: GestoMascota) => {
    setPose(p => ({ nombre, n: (p?.n ?? 0) + 1 }));
  }, []);
  return { estado, disparo, pose, dispara, gesto };
}

// Móvil = el mismo corte que usan las páginas (max-width: 767px). Geckonoid
// recibe el alto en píxeles, no en CSS, así que el tamaño se decide aquí.
const MQ = '(max-width: 767px)';
function suscribir(cb: () => void) {
  const m = window.matchMedia(MQ);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}
function useEsMovil(): boolean {
  return useSyncExternalStore(suscribir, () => window.matchMedia(MQ).matches, () => false);
}

export default function GeckoAnimado({ mando, alto, altoMovil, volverAIdle = true, className }: {
  mando: MandoGecko;
  /** Alto del lienzo en píxeles, en escritorio. */
  alto: number;
  /** Alto en el teléfono (por defecto, el mismo). */
  altoMovil?: number;
  /** false: el estado se queda puesto (p. ej. «estudiando» mientras dura una espera). */
  volverAIdle?: boolean;
  className?: string;
}) {
  const movil = useEsMovil();
  const size = movil && altoMovil ? altoMovil : alto;
  return (
    <Geckonoid
      estado={mando.estado}
      disparo={mando.disparo}
      pose={mando.pose}
      size={size}
      volverAIdle={volverAIdle}
      // Decorativa: el texto de al lado ya dice lo que pasa.
      etiqueta={null}
      className={className}
    />
  );
}
