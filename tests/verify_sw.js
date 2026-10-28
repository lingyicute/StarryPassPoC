'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = 'https://example.test/app/';
const handlers = {}, stores = new Map(), installs = [];
let fetchImpl, putGate = null, putError = null, networkCalls = 0, checks = 0;
const check = (fn) => { fn(); checks++; };
const key = (request) => new URL(typeof request === 'string' ? request : request.url, base).href;
const caches = {
    async open(name) {
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name);
        return {
            async match(request) { const response = store.get(key(request)); return response && response.clone(); },
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
const context = vm.createContext({ URL, Request, Response, Promise, caches,
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
    check(() => assert.ok(installs.some((r) => r.url.endsWith('/assets/img/icons/192.png'))));
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
    fetchImpl = async () => new Response('NEW CORE');
    const core = event('fetch', req('assets/js/spv2-core.js', 'cors'));
    await checkText(core, 'NEW CORE'); await finish(core);
    fetchImpl = offline;
    const offlineCore = event('fetch', req('assets/js/spv2-core.js', 'cors'));
    await checkText(offlineCore, 'NEW CORE'); await finish(offlineCore);

    fetchImpl = async () => new Response('server unavailable', { status: 503 });
    const unavailable = event('fetch', req());
    await checkText(unavailable, 'NEW SHELL'); await finish(unavailable);
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

    putError = new Error('quota exceeded');
    fetchImpl = async () => new Response('ONLINE WITHOUT CACHE');
    const quota = event('fetch', req());
    await checkText(quota, 'ONLINE WITHOUT CACHE'); await finish(quota);
    console.log(`PASS service worker: ${checks} scope, update, offline and lifetime checks`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
