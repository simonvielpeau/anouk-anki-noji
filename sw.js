/* Pont — cache hors ligne. Changer VERSION à chaque mise à jour du site. */
const VERSION = 'pont-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'assets/app.css', 'assets/app.js', 'assets/core.js', 'assets/ai.js',
  'vendor/jszip.min.js', 'vendor/fzstd.js', 'vendor/sql-wasm.js', 'vendor/sql-wasm.wasm',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/mammoth.browser.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // page : réseau d'abord (pour recevoir les mises à jour), cache sinon
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./', copy)); return res; }).catch(() => caches.match('./')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
