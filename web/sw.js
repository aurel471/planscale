// Service Worker: hält die App offline verfügbar. Online wird immer die neueste Version geladen,
// CACHE muss deshalb bei Veröffentlichungen nicht hochgezählt werden.
const CACHE = "planscale-v1";
const CORE = [
  "./", "index.html", "manifest.webmanifest", "js/app.js", "js/engine.js",
  "vendor/pdfjs/pdf.min.mjs", "vendor/pdfjs/pdf.worker.min.mjs", "vendor/pdf-lib/pdf-lib.esm.min.js",
  "icons/icon.svg", "icons/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function fromNetwork(req) {
  return fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  });
}
// App-Dateien: erst Netz, offline aus dem Cache. Bibliotheken (vendor/) ändern sich kaum: erst Cache,
// sonst Netz; Schriften, CMaps und WASM werden so beim ersten Bedarf nachgeladen und gemerkt.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const cached = () => caches.match(e.request, { ignoreSearch: true });
  e.respondWith(url.pathname.includes("/vendor/")
    ? cached().then((hit) => hit || fromNetwork(e.request))
    : fromNetwork(e.request).catch(() => cached().then((hit) => hit || Response.error())));
});
