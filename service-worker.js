const TIMESTAMP = "1793198950";
const APP_ROOT = new URL("./", self.location.href);
const SHELL_URL = new URL("./index.html", APP_ROOT).href;
// CacheStorage 按 origin 共享；只管理本应用路径的命名空间，不能删除其他应用的缓存。
const CACHE_PREFIX = "spv2:" + APP_ROOT.pathname + ":";
const VERSION = CACHE_PREFIX + "precache-v" + TIMESTAMP;
const RUNTIME = CACHE_PREFIX + "runtime-v" + TIMESTAMP;
const PRECACHE_URLS = [
    "./",
    "./index.html",
    "./manifest.webmanifest",
    "./favicon.ico",
    "./assets/img/icons/192.png",
    "./assets/img/icons/512.png",
    "./assets/js/spv2-core.js",
    "./assets/js/spv2-worker.js"
];
const NETWORK_TIMEOUT_MS = 3000;
const STATIC_URLS = new Set(PRECACHE_URLS.map((url) => new URL(url, APP_ROOT).href));

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(VERSION)
            .then((cache) => cache.addAll(PRECACHE_URLS.map((url) =>
                new Request(new URL(url, APP_ROOT), { cache: "reload" }))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    const keep = [VERSION, RUNTIME];
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key.startsWith(CACHE_PREFIX) && !keep.includes(key))
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

function isAppRequest(request) {
    const url = new URL(request.url);
    return url.origin === APP_ROOT.origin && url.pathname.startsWith(APP_ROOT.pathname);
}

function isShellRequest(request) {
    const path = new URL(request.url).pathname;
    return path === APP_ROOT.pathname || path === new URL(SHELL_URL).pathname;
}

async function cachedResponse(request, navigation) {
    const runtime = await caches.open(RUNTIME);
    const precache = await caches.open(VERSION);
    // 首页的 /、/index.html 和查询参数共用最新 shell，避免换入口后退回安装时的旧 HTML。
    if (navigation && isShellRequest(request)) {
        return (await runtime.match(SHELL_URL)) || (await runtime.match(request))
            || (await precache.match(request)) || (await precache.match(SHELL_URL));
    }
    return (await runtime.match(request))
        || (navigation && await runtime.match(SHELL_URL))
        || (await precache.match(request))
        || (navigation && await precache.match(SHELL_URL));
}

function putInRuntimeCache(request, response, navigation) {
    if (response.status !== 200 || response.type === "opaque") return Promise.resolve();
    const key = navigation && isShellRequest(request) ? SHELL_URL : request.url;
    // 仅缓存明确列出的应用资源；不无限积累带查询参数的 URL 或意外缓存未来 API 的响应。
    if (!STATIC_URLS.has(key)) return Promise.resolve();
    const copy = response.clone();
    return caches.open(RUNTIME).then((cache) => cache.put(key, copy));
}

// 截止时间覆盖响应头及应用资源的完整正文，避免半开连接阻塞缓存兜底。
async function fetchWithTimeout(request, navigation) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error("NETWORK_TIMEOUT"));
            controller.abort();
        }, NETWORK_TIMEOUT_MS);
    });
    try {
        const transfer = Promise.resolve().then(async () => {
            const response = await fetch(request, { cache: "no-cache", signal: controller.signal });
            if (response.status === 200 && response.type !== "opaque"
                    && (navigation || STATIC_URLS.has(request.url))) {
                // 只预读导航与列明的静态资源；不改变 Response 的 URL、类型或头部。
                // 原响应仍可供浏览器和缓存各自消费，不提前耗尽原始 body。
                await response.clone().arrayBuffer();
            }
            return response;
        });
        // 即使底层实现未响应 abort，截止时间也必须结束 respondWith / waitUntil。
        return await Promise.race([transfer, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET" || !isAppRequest(request)) return;
    const navigation = request.mode === "navigate";
    // HTML 与脚本都重新验证，不能只更新 HTML 却继续执行旧的加密核心。
    const network = fetchWithTimeout(request, navigation);
    // 在 fetch 事件中同步登记，并返回真正的写入 Promise，而不是 undefined。
    event.waitUntil(network.then((response) => putInRuntimeCache(request, response, navigation)).catch(() => {}));
    event.respondWith(
        network.then(async (response) => {
            if (response.status >= 500) return (await cachedResponse(request, navigation)) || response;
            return response;
        }).catch(async () => (await cachedResponse(request, navigation)) || Response.error())
    );
});
