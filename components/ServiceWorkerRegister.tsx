'use client';
import { useEffect } from 'react';

// El `?v=` es lo que hace que cada despliegue tenga su propia caché: public/sw.js
// deriva de ahí el nombre, y su `activate` borra todas las demás. Sin esto el
// nombre era la constante 'drc-gestion-v1' y la caché vieja no se purgaba nunca.
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || 'dev';

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      // updateViaCache 'none': el navegador revalida sw.js SIEMPRE, sin pasar por
      // la caché HTTP. La cabecera no-store de next.config ya apunta a lo mismo;
      // esto lo garantiza también para el propio chequeo de actualización del SW.
      .register(`/sw.js?v=${BUILD_ID}`, { updateViaCache: 'none' })
      .catch(() => {});
  }, []);

  return null;
}
