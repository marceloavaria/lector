// Service worker: guarda la app para abrirla sin internet (en el auto, en un túnel).
// Los modelos de voz no pasan por aquí: los guarda supertonic.js en su propio caché.

const VERSION = 'lector-app-v14';
const ARCHIVOS = [
  './',
  './index.html',
  './main.js?v=13',
  './db.js?v=1',
  './texto.js?v=1',
  './importar.js?v=2',
  './lectura.js?v=11',
  './registro.js?v=4',
  './sync.js?v=1',
  './voz.js?v=6',
  './numeros.js?v=1',
  './manifest.webmanifest',
  '../supertonic.js?v=5',
  '../icon-180.png',
  '../icon-192.png',
  '../icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const nombre of await caches.keys()) {
      if (nombre.startsWith('lector-app-') && nombre !== VERSION) await caches.delete(nombre);
    }
    await self.clients.claim();
  })());
});

// Archivos de la app: primero la red (para recibir actualizaciones) y, sin conexión, el caché.
async function redPrimero(req) {
  const cache = await caches.open(VERSION);
  try {
    const ctrl = new AbortController();
    const plazo = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(req, { signal: ctrl.signal });
    clearTimeout(plazo);
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch (e) {
    const guardada = await cache.match(req) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    if (guardada) return guardada;
    throw e;
  }
}

// Librerías del CDN: van con versión fija, así que el caché siempre sirve.
async function cachePrimero(req) {
  const cache = await caches.open(VERSION);
  const guardada = await cache.match(req);
  if (guardada) return guardada;
  const resp = await fetch(req);
  if (resp.ok) cache.put(req, resp.clone());
  return resp;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(redPrimero(req));
  else if (url.hostname === 'cdn.jsdelivr.net') e.respondWith(cachePrimero(req));
});
