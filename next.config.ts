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
    ];
  },
};

export default nextConfig;
