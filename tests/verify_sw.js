'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = 'https://example.test/app/';
const handlers = {}, stores = new Map(), installs = [];
let fetchImpl, putGate = null, putError = null, openError = null, matchError = null, networkCalls = 0, checks = 0;
const check = (fn) => { fn(); checks++; };
const key = (request) => new URL(typeof request === 'string' ? request : request.url, base).href;
function cachedMatch(name, request) {
    if (matchError === 'all' || matchError === name) throw new Error('INJECTED_cache_match');
    const response = stores.get(name)?.get(key(request));
    return response && response.clone();
}
const caches = {
    async match(request, options = {}) {
        if (options.cacheName !== undefined) return cachedMatch(options.cacheName, request);
        for (const name of stores.keys()) { const response = cachedMatch(name, request); if (response) return response; }
        return undefined;
    },
    async open(name) {
        if (openError === 'all' || openError === name) throw new Error('INJECTED_cache_open');
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name);
        return {
            async match(request) { return cachedMatch(name, request); },
            async put(request, response) {
                if (putGate) await putGate;
                if (putError) throw putError;
                store.set(key(request), response);
            },
            async addAll(requests) {
                installs.push(...requests);
                for (const request of requests) store.set(key(request), new Response('INSTALLED ' + key(request)));
            }
        };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
};
// 可控截止时间：无需真实等待 3 秒，也可测试完全不理会 abort 的 fetch。
const timers = new Map();
let timerId = 0;
const expireNetwork = () => {
    assert.ok(timers.size > 0, 'network deadline is armed');
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const context = vm.createContext({ URL, Request, Response, Promise, caches, AbortController,
    setTimeout(fn, ms) {
        assert.equal(ms, 3000, 'bounded network wait');
        const id = ++timerId; timers.set(id, fn); return id;
    },
    clearTimeout(id) { timers.delete(id); },
    self: { location: { href: base + 'service-worker.js' },
        addEventListener(type, fn) { handlers[type] = fn; },
        skipWaiting: async () => {}, clients: { claim: async () => {} } },
    fetch: (request, options) => { networkCalls++; return fetchImpl(request, options); }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../service-worker.js'), 'utf8'), context);
const names = vm.runInContext('({ VERSION, RUNTIME, CACHE_PREFIX, SHELL_URL })', context);
function event(type, request) {
    const waits = [];
    let response, closed = false;
    handlers[type]({ request,
        waitUntil(promise) {
            assert.equal(closed, false, 'waitUntil must be registered synchronously');
            assert.equal(typeof promise?.then, 'function', 'waitUntil needs the actual Promise');
            waits.push(promise);
        },
        respondWith(promise) { assert.equal(response, undefined); response = promise; }
    });
    closed = true;
    return { waits, response };
}
const req = (url = 'index.html', mode = 'navigate', method = 'GET') => ({ url: new URL(url, base).href, mode, method });
const offline = async () => { throw new TypeError('offline'); };
async function responseText(e) { return (await e.response).text(); }
async function finish(e) { await Promise.all(e.waits); }
async function checkText(e, expected) {
    const text = await responseText(e); check(() => assert.equal(text, expected));
}
(async () => {
    const install = event('install');
    await finish(install);
    check(() => assert.ok(installs.some((r) => r.url.endsWith('/manifest.webmanifest'))));
    // "./" 与 "./index.html" 是同一份首页：安装时只下载一次。
    check(() => assert.deepEqual(installs.filter((r) => /\/(index\.html)?$/.test(new URL(r.url).pathname))
        .map((r) => new URL(r.url).pathname.split('/').pop()), ['index.html']));
    check(() => assert.ok(installs.some((r) => r.url.endsWith('/assets/img/icons/192.png'))));
    // iOS 添加到主屏幕只认 apple-touch-icon；图标必须声明且随安装预缓存。
    const appleHref = /<link\s+rel="apple-touch-icon"[^>]*\shref="\.\/([^"]+)"/.exec(
        fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'));
    check(() => assert.ok(appleHref, 'index.html declares apple-touch-icon'));
    check(() => assert.ok(installs.some((r) => r.url.endsWith('/' + appleHref[1])), 'apple-touch-icon is precached'));
    check(() => assert.ok(fs.existsSync(path.join(__dirname, '..', appleHref[1]))));
    check(() => assert.ok(installs.every((r) => r.cache === 'reload')));
    for (const name of ['other-app', 'spv2:/other/:precache-v1', 'spv2-precache-vlegacy', names.CACHE_PREFIX + 'precache-vold']) {
        stores.set(name, new Map());
    }
    await finish(event('activate'));
    check(() => assert.ok(!stores.has(names.CACHE_PREFIX + 'precache-vold')));
    for (const name of ['other-app', 'spv2:/other/:precache-v1', 'spv2-precache-vlegacy', names.VERSION]) {
        check(() => assert.ok(stores.has(name), 'do not delete unrelated caches: ' + name));
    }
    for (const request of [req('https://example.test.evil.com/app/'), req('https://example.test:444/app/'),
        req('https://example.test/elsewhere/'), req('index.html', 'navigate', 'POST')]) {
        const before = networkCalls, e = event('fetch', request);
        check(() => assert.equal(e.response, undefined));
        check(() => assert.equal(networkCalls, before));
    }

    let releasePut;
    putGate = new Promise((resolve) => { releasePut = resolve; });
    fetchImpl = async (_, options) => { assert.equal(options.cache, 'no-cache'); return new Response('NEW SHELL'); };
    const update = event('fetch', req('?new=1'));
    check(() => assert.equal(update.waits.length, 1));
    check(() => assert.ok(update.response));
    await checkText(update, 'NEW SHELL');
    let settled = false;
    const waiting = Promise.all(update.waits).then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    check(() => assert.equal(settled, false, 'cache write must keep the event alive'));
    releasePut(); await waiting; putGate = null;
    check(() => assert.equal(settled, true));

    // 不改 SW 版本号，HTML 和核心脚本也都必须更新；离线入口变动不能回退到旧 shell。
    fetchImpl = offline;
    for (const url of ['', 'index.html', '?other=2', 'index.html?third=3']) {
        const e = event('fetch', req(url));
        await checkText(e, 'NEW SHELL');
        await finish(e);
    }
    for (const url of ['', 'index.html']) {
        const e = event('fetch', req(url, 'cors'));
        await checkText(e, 'NEW SHELL');
        await finish(e);
    }
    fetchImpl = async () => new Response('NEW CORE');
    const core = event('fetch', req('assets/js/spv2-core.js', 'cors'));
    await checkText(core, 'NEW CORE'); await finish(core);
    fetchImpl = offline;
    const offlineCore = event('fetch', req('assets/js/spv2-core.js', 'cors'));
    await checkText(offlineCore, 'NEW CORE'); await finish(offlineCore);

    let serverErrorBodyCanceled = false;
    fetchImpl = async () => {
        const resp = new Response('server unavailable', { status: 503 });
        Object.defineProperty(resp, 'body', { value: { cancel: async () => { serverErrorBodyCanceled = true; } } });
        return resp;
    };
    const unavailable = event('fetch', req());
    await checkText(unavailable, 'NEW SHELL'); await finish(unavailable);
    check(() => assert.equal(serverErrorBodyCanceled, true, '5xx fallback to cache cancels unused error body'));
    fetchImpl = async () => new Response('not found', { status: 404 });
    const missing = event('fetch', req());
    const missingResponse = await missing.response;
    check(() => assert.equal(missingResponse.status, 404)); await finish(missing);
    fetchImpl = offline;
    const missingAsset = event('fetch', req('missing.js', 'cors'));
    const missingAssetResponse = await missingAsset.response;
    check(() => assert.equal(missingAssetResponse.type, 'error')); await finish(missingAsset);

    fetchImpl = async () => new Response('DYNAMIC');
    for (const url of ['unlisted.txt', 'assets/js/spv2-core.js?unbounded=1']) {
        const dynamic = event('fetch', req(url, 'cors'));
        await checkText(dynamic, 'DYNAMIC'); await finish(dynamic);
        fetchImpl = offline;
        const uncached = event('fetch', req(url, 'cors'));
        const response = await uncached.response;
        check(() => assert.equal(response.type, 'error', 'unlisted/query resources are not accumulated'));
        await finish(uncached);
        fetchImpl = async () => new Response('DYNAMIC');
    }

    let quotaCopyCanceled = false;
    putError = new Error('quota exceeded');
    fetchImpl = async () => {
        const resp = new Response('ONLINE WITHOUT CACHE');
        const nativeClone = resp.clone.bind(resp);
        let calls = 0;
        resp.clone = () => {
            calls++;
            const copy = nativeClone();
            if (calls === 2) {
                Object.defineProperty(copy, 'body', { value: { cancel: async () => { quotaCopyCanceled = true; } } });
            }
            return copy;
        };
        return resp;
    };
    const quota = event('fetch', req());
    await checkText(quota, 'ONLINE WITHOUT CACHE'); await finish(quota);
    putError = null;
    check(() => assert.equal(quotaCopyCanceled, true, 'failed runtime cache put cancels cloned response body'));
    check(() => assert.equal(timers.size, 0, 'completed transfers clear deadlines'));

    // 连响应头都不返回，且忽略 abort：respondWith 与 waitUntil 仍必须及时结束。
    let signal, resolveLate;
    fetchImpl = (_, options) => {
        signal = options.signal;
        return new Promise((resolve) => { resolveLate = resolve; });
    };
    const stalled = event('fetch', req());
    await tick();
    expireNetwork();
    await checkText(stalled, 'NEW SHELL'); await finish(stalled);
    check(() => assert.equal(signal.aborted, true, 'timeout aborts the underlying request'));
    check(() => assert.equal(timers.size, 0));
    let lateBodyRead = false, lateBodyCanceled = false;
    const lateResp = new Response('LATE SHELL MUST NOT REPLACE CACHE');
    lateResp.clone = () => ({ arrayBuffer: async () => { lateBodyRead = true; return new ArrayBuffer(0); } });
    Object.defineProperty(lateResp, 'body', { value: { cancel: async () => { lateBodyCanceled = true; } } });
    resolveLate(lateResp);
    await tick();
    check(() => assert.equal(lateBodyRead, false, 'late response after timeout does not buffer body'));
    check(() => assert.equal(lateBodyCanceled, true, 'late response after timeout cancels unconsumed body'));
    fetchImpl = offline;
    const stillLatest = event('fetch', req());
    await checkText(stillLatest, 'NEW SHELL'); await finish(stillLatest);

    // 响应头已到，但正文挂起：导航和核心脚本均必须回退已有缓存。
    for (const [url, mode, expected] of [
        ['index.html', 'navigate', 'NEW SHELL'],
        ['assets/js/spv2-core.js', 'cors', 'NEW CORE']
    ]) {
        let bodySignal;
        fetchImpl = (_, options) => {
            bodySignal = options.signal;
            return Promise.resolve(new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('PARTIAL'));
                    bodySignal.addEventListener('abort', () => controller.error(new Error('aborted')));
                }
            })));
        };
        const partial = event('fetch', req(url, mode));
        await tick();
        expireNetwork();
        await checkText(partial, expected); await finish(partial);
        check(() => assert.equal(bodySignal.aborted, true));
    }

    // 即使正文流完全忽略 abort，超时也必须立即取消探测分支与原始响应流。
    {
        let rawCanceled = false, probeCanceled = false;
        fetchImpl = async () => {
            const resp = new Response('STALLED BODY');
            Object.defineProperty(resp, 'body', { value: { cancel: async () => { rawCanceled = true; } } });
            resp.clone = () => ({
                arrayBuffer: () => new Promise(() => {}),
                body: { cancel: async () => { probeCanceled = true; } }
            });
            return resp;
        };
        const hungBody = event('fetch', req());
        await tick();
        expireNetwork();
        await checkText(hungBody, 'NEW SHELL'); await finish(hungBody);
        check(() => assert.equal(rawCanceled, true, 'timeout cancels raw response when body stream ignores abort'));
        check(() => assert.equal(probeCanceled, true, 'timeout cancels probe clone when body stream ignores abort'));
    }

    // 无缓存时返回网络错误，不能留下永不 settle 的响应或后台写入。
    fetchImpl = () => new Promise(() => {});
    const noCache = event('fetch', req('missing.js', 'cors'));
    await tick(); expireNetwork();
    const noCacheResponse = await noCache.response;
    check(() => assert.equal(noCacheResponse.type, 'error'));
    await finish(noCache);

    // 快速网络照常胜出；预读正文不能破坏响应 URL/类型/状态/头部及缓存副本。
    fetchImpl = async () => new Response('FAST CORE', { headers: { 'X-Review': 'preserved' } });
    const fast = event('fetch', req('assets/js/spv2-core.js', 'cors'));
    const fastResponse = await fast.response;
    check(() => assert.equal(fastResponse.headers.get('X-Review'), 'preserved'));
    const fastText = await fastResponse.text();
    check(() => assert.equal(fastText, 'FAST CORE'));
    await finish(fast);
    check(() => assert.equal(timers.size, 0));
    fetchImpl = offline;
    const offlineFast = event('fetch', req('assets/js/spv2-core.js', 'cors'));
    await checkText(offlineFast, 'FAST CORE'); await finish(offlineFast);
    check(() => assert.equal(timers.size, 0));

    // Runtime may not exist and cannot be opened (quota/storage fault), but
    // an installed precache is still usable. Reads must not create new caches.
    putError = null;
    stores.delete(names.RUNTIME);
    openError = names.RUNTIME;
    fetchImpl = offline;
    const noRuntime = event('fetch', req('?runtime-unavailable=1'));
    await checkText(noRuntime, 'INSTALLED ' + names.SHELL_URL); await finish(noRuntime);
    check(() => assert.equal(stores.has(names.RUNTIME), false, 'offline read never needs to create runtime cache'));
    const noRuntimeCore = event('fetch', req('assets/js/spv2-core.js', 'cors'));
    await checkText(noRuntimeCore, 'INSTALLED ' + base + 'assets/js/spv2-core.js'); await finish(noRuntimeCore);

    stores.set(names.RUNTIME, new Map([[names.SHELL_URL, new Response('RUNTIME STILL USABLE')]]));
    openError = null; matchError = names.RUNTIME;
    const failedRuntimeRead = event('fetch', req());
    await checkText(failedRuntimeRead, 'INSTALLED ' + names.SHELL_URL); await finish(failedRuntimeRead);

    // Conversely, inaccessible precache must not hide an intact runtime shell.
    openError = names.VERSION; matchError = names.VERSION;
    const failedPrecacheRead = event('fetch', req());
    await checkText(failedPrecacheRead, 'RUNTIME STILL USABLE'); await finish(failedPrecacheRead);

    // If SHELL_URL is missing in RUNTIME/VERSION, APP_ROOT entry still serves shell requests.
    stores.set(names.RUNTIME, new Map([[base, new Response('RUNTIME ROOT SHELL')]]));
    const rootShellFallback = event('fetch', req('index.html?from-root=1'));
    await checkText(rootShellFallback, 'RUNTIME ROOT SHELL'); await finish(rootShellFallback);

    // Never cross into a different application's cache if both ours fail.
    stores.get('other-app').set(names.SHELL_URL, new Response('FOREIGN CACHE MUST NOT LEAK'));
    openError = 'all'; matchError = 'all';
    const allUnavailable = event('fetch', req());
    const allUnavailableResponse = await allUnavailable.response;
    check(() => assert.equal(allUnavailableResponse.type, 'error')); await finish(allUnavailable);
    // An unscoped caches.match would incorrectly return the foreign shell.
    openError = null; matchError = null;
    const savedPrecache = stores.get(names.VERSION), savedRuntime = stores.get(names.RUNTIME);
    stores.delete(names.VERSION); stores.delete(names.RUNTIME);
    const noOwnedCache = event('fetch', req());
    check(() => assert.equal((stores.has(names.VERSION) || stores.has(names.RUNTIME)), false));
    const noOwnedResponse = await noOwnedCache.response;
    check(() => assert.equal(noOwnedResponse.type, 'error', 'do not read another app cache'));
    await finish(noOwnedCache);
    check(() => assert.equal(stores.has(names.VERSION) || stores.has(names.RUNTIME), false, 'missing caches remain uncreated'));
    stores.set(names.VERSION, savedPrecache); stores.set(names.RUNTIME, savedRuntime);
    openError = 'all'; matchError = 'all';
    fetchImpl = async () => new Response('ORIGINAL SERVER FAILURE', {status:503});
    const serverAndStorage = event('fetch', req());
    check(() => assert.equal(serverAndStorage.waits.length, 1));
    const serverFailureResponse = await serverAndStorage.response;
    check(() => assert.equal(serverFailureResponse.status, 503));
    await checkText(serverAndStorage, 'ORIGINAL SERVER FAILURE'); await finish(serverAndStorage);
    fetchImpl = async () => new Response('ONLINE DESPITE STORAGE FAILURE');
    const onlineStorageFailure = event('fetch', req());
    await checkText(onlineStorageFailure, 'ONLINE DESPITE STORAGE FAILURE'); await finish(onlineStorageFailure);
    openError = null; matchError = null;

    console.log(`PASS service worker: ${checks} scope, update, offline, deadline and lifetime checks`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
