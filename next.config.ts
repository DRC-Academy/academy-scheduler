import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Identificador del despliegue, inyectado en build. Nombra la caché del service
  // worker para que cada deploy purgue la anterior (ver public/sw.js).
  // VERCEL_GIT_COMMIT_SHA existe en el build de Vercel sin necesidad de activar
  // las "System Environment Variables"; en local cae a un timestamp, que cambia
  // en cada `next build` y sirve igual.
  env: {
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA || `dev-${Date.now()}`,
  },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript' },
          { key: 'Service-Worker-Allowed', value: '/' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
      {
        source: '/manifest.json',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json' },
          { key: 'Cache-Control', value: 'public, max-age=86400' },
        ],
      },

      // ── Quién puede meter esta app en un iframe ─────────────────────────────
      //
      // Hasta septiembre de 2026 no se enviaba NINGUNA cabecera de este tipo, así
      // que cualquier web podía incrustar cualquier pantalla — incluido el panel
      // del profesor y el del admin— y montar un clickjacking encima.
      //
      // OJO: en `headers()` se aplican TODAS las reglas que coinciden (no gana la
      // primera, como en redirects). Por eso el DENY general lleva un `source` que
      // EXCLUYE /progreso-cuenta con un negative lookahead: si simplemente fuera
      // `/:path*`, la ficha se llevaría el DENY además de su frame-ancestors y no
      // se podría incrustar. Comprobado con `next start` y curl en las dos rutas.

      {
        // La ficha del alumno vive dentro del Escritorio de "Mi cuenta" de
        // WooCommerce. `frame-ancestors` es lo que sustituye a X-Frame-Options
        // cuando hay que permitir un dominio concreto (XFO solo entiende "nadie" o
        // "el mismo sitio"), y por eso esta ruta NO lleva XFO: enviar los dos
        // deja el resultado a merced de cuál respete cada navegador.
        source: '/progreso-cuenta',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' https://drcacademy.com https://www.drcacademy.com",
          },
          // Es la ficha de UN alumno, firmada y con caducidad: no se guarda en
          // ninguna caché intermedia.
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
      {
        // Todo lo demás: nadie la incrusta. Se comprobó que hoy no hay ninguna
        // página de esta app embebida en otro sitio — el dashboard financiero
        // externo consume /api/external/* servidor a servidor con una cabecera
        // secreta, y el iframe de lib/classDoc.ts (imprimir una clase) es interno,
        // se crea con document.write y sin `src`, así que no le afecta.
        source: '/:path((?!progreso-cuenta$).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
