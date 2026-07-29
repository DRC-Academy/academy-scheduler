// Service worker de DRC Gestión.
//
// CORREGIDO EL 29/07/2026 — antes rompía la app en cada despliegue con
// "This page couldn't load". Dos causas, las dos arregladas aquí:
//
//   1. CACHE_NAME era la constante 'drc-gestion-v1'. El `activate` borra las
//      cachés cuyo nombre no coincide, así que al no cambiar nunca, la caché
//      anterior NO se purgaba jamás. Ahora el nombre lleva el id del despliegue
//      (el ?v= con el que lo registra components/ServiceWorkerRegister).
//
//   2. Se cacheaba el HTML y se servía como respaldo ante cualquier fallo de red
//      (`.catch(() => caches.match(request))`). Tras un despliegue eso devolvía
//      el HTML VIEJO, que apunta a chunks de JS del build anterior; Vercel ya no
//      los sirve y el App Router mostraba el error. El HTML ya no se cachea.
//
// Los chunks de Next llevan hash en el nombre, así que cache-first sobre ellos
// es seguro: un build nuevo produce nombres nuevos y los viejos se purgan al
// activar el SW siguiente.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_NAME = `drc-gestion-${VERSION}`;

const STATIC_EXTENSIONS = [
  '.css', '.js', '.woff', '.woff2', '.ttf', '.otf', '.ico', '.png', '.jpg', '.jpeg', '.svg', '.webp',
];

function isStaticAsset(url) {
  const pathname = new URL(url).pathname;
  return STATIC_EXTENSIONS.some(ext => pathname.endsWith(ext));
}

function isSupabaseRequest(url) {
  return url.includes('supabase.co');
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      // Purga TODO lo que no sea la caché de este despliegue. Con el nombre
      // versionado esto sí limpia de verdad, y además cura a los clientes que
      // quedaron con la caché envenenada del SW anterior.
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // Supabase nunca se cachea: siempre red, sin respaldo.
  if (isSupabaseRequest(url)) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.method !== 'GET') return;

  // El HTML y las rutas de API van SIEMPRE a la red, sin cachear ni servir
  // respaldo. Es lo que evita que un despliegue nuevo quede servido con el
  // documento del anterior. Si no hay red, falla como fallaría sin SW.
  if (!isStaticAsset(url)) return;

  // Estáticos con hash en el nombre: cache-first.
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response && response.status === 200) {
            cache.put(request, response.clone());
          }
          return response;
        });
      }),
    ),
  );
});
