'use client';

// ── Decirle al padre cuánto mide la ficha ─────────────────────────────────────
//
// Un iframe no crece con su contenido: se queda con la altura que le pusieron y
// saca su propia barra de desplazamiento. Dentro de "Mi cuenta" eso da el doble
// scroll clásico — el de la página y el del recuadro— y es la diferencia entre
// parecer parte de la web y parecer un recuadro pegado.
//
// Así que la ficha mide su alto y se lo manda al padre, que ajusta el iframe. El
// listener de WordPress está en docs/progreso-wordpress.md.
//
// SOLO A LOS ORIGENES DE LA ACADEMIA. `postMessage` con un origen concreto no
// entrega el mensaje a ningún otro sitio, así que si alguien lograra incrustar
// esta página no recibiría nada. Se manda a los dos (con y sin `www`) porque son
// dos orígenes distintos para el navegador y la web responde en los dos: el que no
// coincide descarta el mensaje sin más.

import { useEffect, useRef } from 'react';

const ORIGENES_PADRE = ['https://drcacademy.com', 'https://www.drcacademy.com'];
export const ALTURA_MESSAGE_TYPE = 'drc-progreso-height';

export function ProgresoAltura() {
  // Última altura enviada: sin esto, cada píxel de reflow es un mensaje.
  const ultima = useRef(-1);

  useEffect(() => {
    if (window.parent === window) return;   // no está dentro de un iframe

    function enviar() {
      // `scrollHeight` del <html> es el alto real del contenido, márgenes
      // incluidos; `offsetHeight` del body se queda corto con márgenes colapsados.
      const alto = Math.ceil(document.documentElement.scrollHeight);
      if (!Number.isFinite(alto) || alto <= 0) return;
      // Un píxel arriba o abajo no merece un mensaje (ni el reflow del padre).
      if (Math.abs(alto - ultima.current) < 2) return;
      ultima.current = alto;
      for (const origen of ORIGENES_PADRE) {
        try {
          window.parent.postMessage({ type: ALTURA_MESSAGE_TYPE, height: alto }, origen);
        } catch { /* origen no permitido: se ignora */ }
      }
    }

    enviar();

    // La ficha entra con una animación escalonada (`pg-rise`), así que su alto
    // cambia durante el primer segundo: el observer lo cubre sin poner timeouts.
    const observer = new ResizeObserver(enviar);
    observer.observe(document.documentElement);
    window.addEventListener('load', enviar);
    window.addEventListener('resize', enviar);

    return () => {
      observer.disconnect();
      window.removeEventListener('load', enviar);
      window.removeEventListener('resize', enviar);
    };
  }, []);

  return null;
}
