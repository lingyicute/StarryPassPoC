const TIMESTAMP = "1793008800";
const VERSION = "spv2-precache-v" + TIMESTAMP;
const RUNTIME = "spv2-runtime-v" + TIMESTAMP;
const PRECACHE_URLS = [
    "./",
    "./index.html",
    "./assets/js/spv2-core.js",
    "./assets/js/spv2-worker.js"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(VERSION)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    const keep = [VERSION, RUNTIME];
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => !keep.includes(key)).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET" || !event.request.url.startsWith(self.location.origin)) return;
    event.respondWith(
        caches.match(event.request).then((cached) => (
            cached || caches.open(RUNTIME).then((cache) => (
                fetch(event.request).then((response) => {
                    if (response && response.status === 200) {
                        cache.put(event.request, response.clone());
                    }
                    return response;
                })
            ))
        ))
    );
});
