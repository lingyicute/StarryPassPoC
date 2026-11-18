// Pages stamps this with the deployed commit. Bump it for other releases.
const CACHE_REVISION = "1793680003";
const APP_ROOT = new URL("./", self.location.href);
const SHELL_URL = new URL("./index.html", APP_ROOT).href;
const SHELL_PATH = new URL(SHELL_URL).pathname;
// CacheStorage 按 origin 共享；只管理本应用路径的命名空间，不能删除其他应用的缓存。
const CACHE_PREFIX = "spv2:" + APP_ROOT.pathname + ":";
const VERSION = CACHE_PREFIX + "precache-v" + CACHE_REVISION;
const RUNTIME = CACHE_PREFIX + "runtime-v" + CACHE_REVISION;
const PRECACHE_URLS = [
    "./",
    "./index.html",
    "./manifest.webmanifest",
    "./favicon.ico",
    "./assets/img/icons/apple.png",
    "./assets/img/icons/192.png",
    "./assets/img/icons/512.png",
    "./assets/js/spv2-core.js",
    "./assets/js/spv2-worker.js"
];
const NETWORK_TIMEOUT_MS = 3000;
const NETWORK_ONLY_CACHE_MODES = new Set(["no-store", "only-if-cached", "force-cache"]);
const REQUEST_PRECONDITIONS = ["Range", "If-Range", "If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since"];
const STATIC_URLS = new Set(PRECACHE_URLS.map((url) => new URL(url, APP_ROOT).href));

async function precache() {
    const cache = await caches.open(VERSION);
    // "./" 与 "./index.html" 是同一份首页，只下载后者；根路径离线时同样回退到它。
    const requests = PRECACHE_URLS.filter((url) => url !== "./").map((url) =>
        new Request(new URL(url, APP_ROOT), { cache: "reload" }));
    await cache.addAll(requests);
    // addAll 会原样保存重定向得到的响应；带 redirected 标记的 shell 在离线导航（redirect: manual）
    // 时会被浏览器拒收，因此用同一正文与头部重建响应以去掉该标记。
    await Promise.all(requests.map(async (request) => {
        const response = await cache.match(request);
        if (!response || !response.redirected) return;
        const body = await response.blob();
        await cache.put(request, new Response(body, {
            status: response.status, statusText: response.statusText, headers: response.headers
        }));
    }));
}

self.addEventListener("install", (event) => {
    event.waitUntil(precache().then(() => self.skipWaiting()));
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

function managedCacheKey(request) {
    if (STATIC_URLS.has(request.url)) return request.url === APP_ROOT.href ? SHELL_URL : request.url;
    if (request.mode !== "navigate") return null;
    const url = new URL(request.url);
    return url.origin === APP_ROOT.origin && (url.pathname === APP_ROOT.pathname || url.pathname === SHELL_PATH)
        ? SHELL_URL : null;
}

async function matchCached(name, request) {
    try {
        // 只读取指定名称的缓存：不创建它，也不让一处存储故障掩盖另一缓存里可用的副本。
        return await caches.match(request, { cacheName: name });
    } catch (err) {
        return undefined;
    }
}

// Cache matching compares Vary against the stored request headers. Keep them
// when canonicalising shell URLs; a bare URL silently discards content negotiation.
function cacheKeyRequest(request, url) {
    return request.url === url ? request : new Request(url, { headers: request.headers });
}

async function cachedResponse(request, key) {
    if (key !== SHELL_URL) {
        return (await matchCached(RUNTIME, request)) || (await matchCached(VERSION, request));
    }
    // 首页的 /、/index.html 和查询参数共用最新 shell，避免换入口后退回安装时的旧 HTML。
    const shellRequest = cacheKeyRequest(request, SHELL_URL);
    const rootRequest = cacheKeyRequest(request, APP_ROOT.href);
    const distinctReq = request.url !== SHELL_URL && request.url !== APP_ROOT.href;
    return (await matchCached(RUNTIME, shellRequest)) || (distinctReq && await matchCached(RUNTIME, request))
        || (await matchCached(RUNTIME, rootRequest)) || (distinctReq && await matchCached(VERSION, request))
        || (await matchCached(VERSION, shellRequest)) || (await matchCached(VERSION, rootRequest));
}

function cancelBody(response) {
    if (response && response.body && typeof response.body.cancel === "function") {
        response.body.cancel().catch(() => {});
    }
}

function putInRuntimeCache(request, response, key) {
    // 重定向响应写入运行时缓存会导致离线 navigate 请求（redirect: manual）被浏览器拒收。
    if (response.status !== 200 || response.type === "opaque" || response.redirected) return Promise.resolve();
    // CacheStorage does not apply HTTP cache directives automatically.
    const cacheControl = response.headers.get("Cache-Control");
    if (cacheControl && /(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)) return Promise.resolve();
    const copy = response.clone();
    return caches.open(RUNTIME).then((cache) => cache.put(cacheKeyRequest(request, key), copy)).catch((err) => {
        cancelBody(copy);
        throw err;
    });
}

// 截止时间覆盖响应头及应用资源的完整正文，避免半开连接阻塞缓存兜底。
async function fetchWithTimeout(request) {
    const controller = new AbortController();
    let timer, rawResponse = null, probeResponse = null, probeReader = null;
    const cancelPending = () => {
        const reader = probeReader, probe = probeResponse, raw = rawResponse;
        probeReader = null;
        probeResponse = null;
        rawResponse = null;
        if (reader) reader.cancel().catch(() => {});
        else cancelBody(probe);
        cancelBody(raw);
    };
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            cancelPending();
            reject(new Error("NETWORK_TIMEOUT"));
            controller.abort();
        }, NETWORK_TIMEOUT_MS);
    });
    try {
        const transfer = Promise.resolve().then(async () => {
            const response = await fetch(request, { cache: "no-cache", signal: controller.signal });
            rawResponse = response;
            try {
                if (controller.signal.aborted) throw new Error("NETWORK_TIMEOUT");
                if (response.status === 200 && response.type !== "opaque") {
                    // 预读应用资源；不改变 Response 的 URL、类型或头部。
                    // 原响应仍可供浏览器和缓存各自消费，不提前耗尽原始 body。
                    probeResponse = response.clone();
                    if (probeResponse.body && typeof probeResponse.body.getReader === "function") {
                        const reader = probeResponse.body.getReader();
                        probeReader = reader;
                        try {
                            while (!(await reader.read()).done) {}
                        } finally {
                            if (probeReader === reader) probeReader = null;
                            reader.releaseLock();
                        }
                    } else {
                        await probeResponse.arrayBuffer();
                    }
                    probeResponse = null;
                    if (controller.signal.aborted) throw new Error("NETWORK_TIMEOUT");
                }
                rawResponse = null;
                return response;
            } catch (err) {
                cancelPending();
                throw err;
            }
        });
        // 即使传输未响应 abort，也结束网络阶段；缓存自身的 I/O 不受此截止时间约束。
        return await Promise.race([transfer, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

self.addEventListener("fetch", (event) => {
    const request = event.request;
    // Our offline copies cannot evaluate HTTP preconditions or serve byte ranges.
    // Leave explicit browser cache modes intact rather than forcing revalidation.
    if (request.method !== "GET" || NETWORK_ONLY_CACHE_MODES.has(request.cache)
            || REQUEST_PRECONDITIONS.some((name) => request.headers.has(name))) return;
    // 未列出的路由由浏览器正常处理，离线时不把无关页面或 API 伪装成首页。
    const key = managedCacheKey(request);
    if (!key) return;
    // HTML 与脚本都重新验证，不能只更新 HTML 却继续执行旧的加密核心。
    const network = fetchWithTimeout(request);
    // 在 fetch 事件中同步登记，并返回真正的写入 Promise，而不是 undefined。
    event.waitUntil(network.then((response) => putInRuntimeCache(request, response, key)).catch(() => {}));
    event.respondWith(
        network.then(async (response) => {
            if (response.status >= 500) {
                const cached = await cachedResponse(request, key);
                if (cached) {
                    cancelBody(response);
                    return cached;
                }
            }
            return response;
        }).catch(async () => (await cachedResponse(request, key)) || Response.error())
    );
});
