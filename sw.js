// Service worker for the Bitmark Wallet PWA. Network-first for HTML (so a deploy is
// picked up immediately, with an offline fallback), cache-first for everything else
// same-origin (the module graph + schemas → instant loads, works offline after the
// first visit). Cross-origin (WebTorrent CDN, signaling) is never intercepted, and
// OPFS data isn't fetched so the UTXO set is untouched.
const CACHE = 'btm-wallet-v1';
const PRECACHE = ['./wallet-app.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './qrcode.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // leave CDN / signaling alone
  const isHTML = req.mode === 'navigate' || url.pathname.endsWith('.html');
  if (isHTML) {
    e.respondWith(fetch(req).then((res) => { const c = res.clone(); caches.open(CACHE).then((ca) => ca.put(req, c)); return res; }).catch(() => caches.match(req)));
  } else {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') { const c = res.clone(); caches.open(CACHE).then((ca) => ca.put(req, c)); }
      return res;
    })));
  }
});
