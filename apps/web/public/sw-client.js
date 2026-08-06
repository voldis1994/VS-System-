/* VS Client PWA — icons only; never cache-first HTML (breaks after deploy) */
const CACHE = "vs-client-v3-neon";
const PRECACHE = [
  "/manifest-client.webmanifest",
  "/client-icons/icon-192.png",
  "/client-icons/icon-512.png",
  "/client-icons/icon-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never cache API / Next chunks — always live
  if (
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/_next") ||
    url.port === "4000"
  ) {
    return;
  }

  // Client HTML: network-first so neon/EMA updates load immediately
  if (url.pathname === "/client" || url.pathname.startsWith("/client/")) {
    event.respondWith(
      fetch(req)
        .then((res) => res)
        .catch(() => caches.match(req).then((c) => c || Response.error())),
    );
    return;
  }

  // Icons / manifest: cache-first, refresh in background
  if (url.pathname.startsWith("/client-icons") || url.pathname.endsWith(".webmanifest")) {
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
