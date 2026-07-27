/* VS Client PWA — cache shell for offline open */
const CACHE = "vs-client-v1";
const PRECACHE = [
  "/client",
  "/manifest-client.webmanifest",
  "/client-icons/icon-192.png",
  "/client-icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never cache API calls
  if (url.pathname.startsWith("/api") || url.port === "4000") return;

  if (url.pathname.startsWith("/client") || url.pathname.startsWith("/client-icons")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
