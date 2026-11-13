'use strict';
const assert = require('node:assert/strict');
const loadCore = require('./helpers/load_core.js');
const factory = loadCore();
const core = factory(null, false);
const params = { password: new Uint8Array(8).fill(1), salt: new Uint8Array(8).fill(2),
    memoryKiB: 32, passes: 1, parallelism: 1, tagLength: 32 };
const allZero = (bytes) => bytes.every((b) => b === 0);
let checks = 0;
const check = (fn) => { fn(); checks++; };

// 校验必须发生在分配/计算前，不能让小数、无穷或 32 位截断变成另一组参数。
for (const [field, values] of [
    ['passes', [0, -1, 1.5, NaN, Infinity, 0x100000000, '1']],
    ['parallelism', [0, -1, 1.5, NaN, Infinity, 0x1000000, '1']],
    ['memoryKiB', [-1, 32.5, NaN, Infinity, 0x100000000, '32']]
]) {
    for (const value of values) check(() => assert.throws(
        () => core._test.argon2idSync({ ...params, [field]: value }), /ARGON2_INVALID_COST/));
}
for (const value of [0, 1, 3]) check(() => assert.throws(
    () => core._test.argon2idSync({ ...params, tagLength: value }), /ARGON2_TAG_TOO_SHORT/));
for (const value of [4.5, NaN, Infinity, null, 0x100000000, '32']) check(() => assert.throws(
    () => core._test.argon2idSync({ ...params, tagLength: value }), /ARGON2_INVALID_TAG_LENGTH/));
check(() => assert.throws(() => core._test.argon2idSync({ ...params, memoryKiB: 7 }), /ARGON2_MEMORY_TOO_LOW/));
check(() => assert.throws(() => core._test.argon2idSync({ ...params, salt: new Uint8Array(7) }), /ARGON2_SALT_TOO_SHORT/));
for (const field of ['password', 'salt', 'secret', 'ad']) check(() => assert.throws(
    () => core._test.argon2idSync({ ...params, [field]: 'not bytes' }), /ARGON2_INVALID_INPUT/));
// RFC 边界不靠分配天文数字的内存来测试；仅调用参数校验器。
check(() => core._test.validateArgon2Params({ ...params, memoryKiB: 0xffffffff,
    passes: 0xffffffff, parallelism: 0xffffff, tagLength: 0xffffffff }));
check(() => assert.equal(core._test.argon2idSync({ ...params, tagLength: undefined }).length, 32));
check(() => assert.equal(core._test.argon2idSync({ ...params, password: new Uint8Array(0), tagLength: 4 }).length, 4));
{
    const paramReads = { password: 0, salt: 0, secret: 0, ad: 0, memoryKiB: 0, passes: 0, parallelism: 0, tagLength: 0 };
    const getterParams = {
        get password() { paramReads.password++; return params.password; },
        get salt() { paramReads.salt++; return params.salt; },
        get secret() { paramReads.secret++; return undefined; },
        get ad() { paramReads.ad++; return undefined; },
        get memoryKiB() { paramReads.memoryKiB++; return params.memoryKiB; },
        get passes() { paramReads.passes++; return params.passes; },
        get parallelism() { paramReads.parallelism++; return params.parallelism; },
        get tagLength() { paramReads.tagLength++; return params.tagLength; }
    };
    check(() => assert.equal(core._test.argon2idSync(getterParams).length, 32));
    check(() => assert.deepEqual(paramReads, { password: 1, salt: 1, secret: 1, ad: 1, memoryKiB: 1, passes: 1, parallelism: 1, tagLength: 1 }));
}

// 证明默认引擎真的使用原生 WASM 压缩核，而非拿两份纯 JS 做“一致性”比较。
const wasmArena = core._test.getArena(40 * 1024);
check(() => assert.equal(wasmArena.isWasm, true));
check(() => assert.match(Function.prototype.toString.call(wasmArena.compress), /\[native code\]/));
check(() => assert.equal(factory(null, true)._test.getArena(40 * 1024).isWasm, false));

// 增长后再执行小参数：连同本次未使用的尾部都必须清零（容量并不会归还）。
core._test.argon2idSync({ ...params, memoryKiB: 512 });
const memory = core._test.state().wasmState.mem;
const grownBytes = memory.buffer.byteLength;
new Uint8Array(memory.buffer).fill(0xa5);
core._test.argon2idSync(params);
check(() => assert.equal(memory.buffer.byteLength, grownBytes));
check(() => assert.ok(allZero(new Uint8Array(memory.buffer)), 'entire grown arena is wiped'));
// 会话结束后允许回收大 arena；之后的小请求应使用较小的新内存，且复用编译模块。
const compiledModule = core._test.state().wasmState.mod;
new Uint8Array(memory.buffer).fill(0xa5);
core.wipeSession();
check(() => assert.ok(allZero(new Uint8Array(memory.buffer)), 'released arena is wiped before dropping it'));
check(() => assert.equal(core._test.state().wasmState, null, 'wiped engine no longer retains the arena'));
const smallerArena = core._test.getArena(40 * 1024);
check(() => assert.notEqual(smallerArena.u8.buffer, memory.buffer, 'a fresh arena is allocated after wipe'));
check(() => assert.ok(smallerArena.u8.byteLength < grownBytes, 'fresh small request does not retain peak capacity'));
check(() => assert.equal(core._test.state().wasmState.mod, compiledModule, 'compiled module is reused'));

// 压缩阶段异常同样走 finally 清理，且不能继续持有被替换的缓存密钥。
const request = { master: 'correct horse battery staple', code: 'github', tier: 'standard',
    counter: 1, length: 16, mode: 'full' };
const cachedCore = factory(null, false);
check(() => assert.equal(cachedCore.deriveSync(request).password, 'WueNKY^SRHRh4!DL'));
check(() => assert.equal(cachedCore.deriveSync(request).cached, true));
const oldState = cachedCore._test.state();
const originalCompress = oldState.wasmState.fn;
oldState.wasmState.fn = () => { throw new Error('INJECTED_COMPRESS_FAILURE'); };
check(() => assert.throws(() => cachedCore.deriveSync({ ...request, master: 'different master' }), /INJECTED_COMPRESS_FAILURE/));
check(() => assert.ok(allZero(oldState.cachedSk) && allZero(oldState.cachedTag)));
check(() => assert.equal(cachedCore._test.state().cachedSk, null));
check(() => assert.equal(cachedCore._test.state().cachedTag, null));
check(() => assert.ok(allZero(new Uint8Array(oldState.wasmState.mem.buffer))));
check(() => assert.ok(allZero(oldState.JS_R) && allZero(oldState.JS_Z)));
oldState.wasmState.fn = originalCompress;
check(() => assert.equal(cachedCore.deriveSync(request).password, 'WueNKY^SRHRh4!DL'));
const beforeWipe = cachedCore._test.state();
beforeWipe.SHA256_W.fill(7); beforeWipe.B2B_V.fill(7); beforeWipe.B2B_M.fill(7);
cachedCore.wipeSession();
check(() => assert.ok(allZero(beforeWipe.cachedSk) && allZero(beforeWipe.cachedTag) && allZero(beforeWipe.sessionNonce)));
check(() => assert.ok(allZero(beforeWipe.SHA256_W) && allZero(beforeWipe.B2B_V) && allZero(beforeWipe.B2B_M)));
check(() => assert.equal(cachedCore._test.state().wasmState, null, 'normal session wipe drops its arena'));
const afterWipe = cachedCore.deriveSync(request);
check(() => assert.equal(afterWipe.password, 'WueNKY^SRHRh4!DL', 'recreated arena preserves the password'));
check(() => assert.equal(afterWipe.cached, false, 'recreated session does not reuse the old key'));
check(() => assert.equal(cachedCore._test.state().wasmState.mod, beforeWipe.wasmState.mod, 'recreated engine reuses module'));

// 没有 CSPRNG、或 CSPRNG 抛异常：派生仍确定且正确，但既不复用也不保留密钥缓存。
for (const crypto of [undefined, { getRandomValues() { throw new Error('RNG_UNAVAILABLE'); } }]) {
    const engine = loadCore({ crypto })(null, false);
    for (let i = 0; i < 2; i++) {
        const out = engine.deriveSync(request);
        check(() => assert.equal(out.password, 'WueNKY^SRHRh4!DL'));
        check(() => assert.equal(out.cached, false));
        const state = engine._test.state();
        check(() => assert.equal(state.cachedSk, null));
        check(() => assert.equal(state.cachedTag, null));
        check(() => assert.equal(state.sessionNonce, null));
    }
}
// 瞬时 CSPRNG 故障恢复后，后续派生应重新建立随机 nonce 并恢复会话缓存。
{
    let failRng = true;
    const partialBuffers = [];
    const flakyCrypto = {
        getRandomValues(buf) {
            partialBuffers.push(buf);
            if (failRng) { buf[0] = 0x7f; throw new Error('TRANSIENT_RNG'); }
            for (let i = 0; i < buf.length; i++) buf[i] = i + 1;
            return buf;
        }
    };
    const engine = loadCore({ crypto: flakyCrypto })(null, false);
    check(() => assert.equal(engine.deriveSync(request).cached, false));
    check(() => assert.ok(allZero(partialBuffers[0]), 'transient RNG failure zeroes partial nonce'));
    failRng = false;
    check(() => assert.equal(engine.deriveSync(request).cached, false));
    check(() => assert.equal(engine.deriveSync(request).cached, true, 'cache recovers after transient RNG failure'));
    engine.wipeSession();
}

// WASM 编译失败是可见的正常降级，不可误报成内存不足，且后续派生不再重复尝试编译或刷屏告警。
const warnings = [];
const brokenWasm = { ...WebAssembly, Module: function () { throw new Error('INJECTED_WASM_BLOCK'); } };
const fallback = loadCore({ WebAssembly: brokenWasm, console: { warn: (msg) => warnings.push(msg) } })(null, false);
check(() => assert.equal(fallback._test.getArena(40 * 1024).isWasm, false));
check(() => assert.equal(fallback.deriveSync(request).password, 'WueNKY^SRHRh4!DL'));
check(() => assert.equal(warnings.length, 1));
check(() => assert.match(warnings[0], /INJECTED_WASM_BLOCK/));
fallback.wipeSession();

// 极高档的超大 WASM 内存被拒（RangeError）只影响该次请求；之后的标准档仍应使用 WASM，而不是永久退回纯 JS。
{
    let denyLarge = true;
    const flakyWasm = {
        Module: WebAssembly.Module,
        Instance: WebAssembly.Instance,
        Memory: function (descriptor) {
            if (denyLarge && descriptor.initial > 2000) throw new RangeError('WASM memory denied');
            const mem = new WebAssembly.Memory(descriptor);
            const origGrow = mem.grow.bind(mem);
            mem.grow = function (delta) {
                if (denyLarge && delta > 2000) throw new RangeError('WASM grow denied');
                return origGrow(delta);
            };
            return mem;
        }
    };
    const flakyWarnings = [];
    const flaky = loadCore({ WebAssembly: flakyWasm, console: { warn: (msg) => flakyWarnings.push(msg) } })(null, false);
    check(() => assert.equal(flaky._test.getArena(140 * 1048576).isWasm, false, 'denied large initial request degrades this time'));
    const smallArena = flaky._test.getArena(40 * 1024);
    check(() => assert.equal(smallArena.isWasm, true, 'later small request still uses WASM'));
    smallArena.u8.fill(0x5a);
    check(() => assert.equal(flaky._test.getArena(140 * 1048576).isWasm, false, 'denied large grow after small arena also degrades to pure JS'));
    check(() => assert.ok(allZero(smallArena.u8), 'previous WASM arena is wiped when grow fails'));
    check(() => assert.equal(flaky._test.getArena(40 * 1024).isWasm, true, 'small request after denied grow recreates WASM arena'));
    check(() => assert.equal(flakyWarnings.length, 2));
    flaky.wipeSession();
}

// 标准档大小的 WASM 内存被拒同样只影响该次请求：内存恢复后重新启用 WASM。
// 但自检本身落在纯 JS 上时，未经自检的 WASM 不得在之后启用。
{
    let deny = true;
    const tightWasm = {
        Module: WebAssembly.Module,
        Instance: WebAssembly.Instance,
        Memory: function (descriptor) {
            if (deny) throw new RangeError('WASM memory denied');
            return new WebAssembly.Memory(descriptor);
        }
    };
    const standardBytes = 65536 * 1024 + 6144;
    const tight = loadCore({ WebAssembly: tightWasm, console: { warn() {} } })(null, false);
    check(() => assert.equal(tight._test.getArena(standardBytes).isWasm, false, 'denied standard-tier request degrades this time'));
    deny = false;
    check(() => assert.equal(tight._test.getArena(standardBytes).isWasm, true, 'standard-tier WASM recovers once memory is available'));
    tight.wipeSession();

    deny = true;
    const untested = loadCore({ WebAssembly: tightWasm, console: { warn() {} } })(null, false);
    check(() => assert.equal(untested.deriveSync(request).password, 'WueNKY^SRHRh4!DL'));
    deny = false;
    check(() => assert.equal(untested._test.getArena(40 * 1024).isWasm, false, 'WASM that never passed the KAT stays disabled'));
    untested.wipeSession();
}

// WASM 通过自检后运行期降级为纯 JS：必须先对纯 JS 压缩核补做 KAT，且只补一次。
{
    const katBytes = 32 * 1024 + 6144;
    let jsKats = 0;
    const CountingBuffer = function (bytes) { if (bytes === katBytes) jsKats++; return new ArrayBuffer(bytes); };
    const denyGrowWasm = {
        Module: WebAssembly.Module,
        Instance: WebAssembly.Instance,
        Memory: function (descriptor) {
            const mem = new WebAssembly.Memory(descriptor);
            mem.grow = function () { throw new RangeError('WASM grow denied'); };
            return mem;
        }
    };
    const degraded = loadCore({ WebAssembly: denyGrowWasm, ArrayBuffer: CountingBuffer, console: { warn() {} } })(null, false);
    check(() => assert.equal(degraded.deriveSync(request).password, 'WueNKY^SRHRh4!DL'));
    check(() => assert.equal(jsKats, 1, 'pure-JS fallback is KAT-gated before its first result'));
    check(() => assert.equal(degraded._test.getArena(40 * 1024).isWasm, true));
    check(() => assert.equal(degraded.deriveSync({ ...request, code: 'gitlab' }).cached, false));
    check(() => assert.equal(degraded._test.state().wasmState, null, 'second derivation degraded again'));
    check(() => assert.equal(jsKats, 1, 'pure-JS KAT is not repeated'));
    degraded.wipeSession();
}

// 请求对象的六个字段属性在单次派生中均只读取一次。
{
    const reads = { master: 0, code: 0, tier: 0, mode: 0, counter: 0, length: 0 };
    const getterReq = {
        get master() { reads.master++; return request.master; },
        get code() { reads.code++; return request.code; },
        get tier() { reads.tier++; return request.tier; },
        get mode() { reads.mode++; return request.mode; },
        get counter() { reads.counter++; return request.counter; },
        get length() { reads.length++; return request.length; }
    };
    check(() => assert.equal(cachedCore.deriveSync(getterReq).password, 'WueNKY^SRHRh4!DL'));
    check(() => assert.deepEqual(reads, { master: 1, code: 1, tier: 1, mode: 1, counter: 1, length: 1 }));
}
// 纯 JS 分配失败也映射为可识别的内存错误。
const noMemory = loadCore({ ArrayBuffer: function () { throw new RangeError('allocation failed'); } })(null, true);
check(() => assert.throws(() => noMemory._test.getArena(40 * 1024), /MEMORY_LIMIT/));
const crossRealmOom = loadCore({ WebAssembly: null, console: null, ArrayBuffer: function () { const e = new Error('oom'); e.name = 'RangeError'; throw e; } })(null, false);
check(() => assert.throws(() => crossRealmOom._test.getArena(40 * 1024), /MEMORY_LIMIT/));

// 省略可选参数仍按原有默认值；显式非法值（含原型属性名）必须拒绝。
check(() => assert.equal(cachedCore.deriveSync({ master: request.master, code: request.code }).password, 'WueNKY^SRHRh4!DL'));
for (const tier of ['bogus', '__proto__', 'constructor', null, ['standard']]) check(() => assert.throws(
    () => cachedCore.deriveSync({ ...request, tier }), /INVALID_TIER/));
for (const mode of ['bogus', '__proto__', 'constructor', null, ['full']]) check(() => assert.throws(
    () => cachedCore.deriveSync({ ...request, mode }), /INVALID_MODE/));
for (const badReq of [null, undefined, 123, 'raw-string', true]) {
    check(() => assert.throws(() => cachedCore.deriveSync(badReq), (err) => err instanceof TypeError && err.message === 'INVALID_REQUEST'));
}
check(() => assert.throws(() => cachedCore.deriveSync({ ...request, master: Symbol('m') }), TypeError));
check(() => assert.throws(() => cachedCore.deriveSync({ ...request, code: Symbol('c') }), TypeError));
check(() => assert.throws(() => cachedCore.deriveSync({ ...request, counter: Symbol('n') }), TypeError));
check(() => assert.throws(() => cachedCore.deriveSync({ ...request, length: Symbol('l') }), TypeError));
check(() => assert.equal(cachedCore.deriveSync({ ...request, length: 0 }).password.length, 4));
check(() => assert.equal(cachedCore.deriveSync({ ...request, length: '0' }).password.length, 4));
check(() => assert.equal(cachedCore.deriveSync({ ...request, length: 1e21 }).password.length, 64));
check(() => assert.equal(cachedCore.deriveSync({ ...request, length: '1e2' }).password.length, 64));
check(() => assert.equal(cachedCore.deriveSync({ ...request, length: '1e500' }).password.length, 64));
check(() => assert.equal(cachedCore.deriveSync({ ...request, length: '-1e500' }).password.length, 4));
check(() => assert.equal(cachedCore.deriveSync({ ...request, length: 9e-7 }).password.length, 4));
check(() => assert.equal(
    cachedCore.deriveSync({ ...request, counter: '1e5' }).password,
    cachedCore.deriveSync({ ...request, counter: 9999 }).password));
check(() => assert.equal(
    cachedCore.deriveSync({ ...request, counter: '1e500' }).password,
    cachedCore.deriveSync({ ...request, counter: 9999 }).password));
check(() => assert.equal(
    cachedCore.deriveSync({ ...request, counter: '-1e500' }).password,
    cachedCore.deriveSync({ ...request, counter: 1 }).password));
check(() => assert.equal(
    cachedCore.deriveSync({ ...request, counter: 5e-7 }).password,
    cachedCore.deriveSync({ ...request, counter: 1 }).password));
// 编码阶段部分失败必须清零已编码的主密码；Worker 响应 id 取自收到消息时的快照。
{
    const encoded = [];
    class FaultyEncoder extends TextEncoder {
        encode(value) {
            if (value === request.code) throw new Error('INJECTED_ENCODE_FAILURE');
            const out = super.encode(value);
            encoded.push(out);
            return out;
        }
    }
    const faultyEngine = loadCore({ TextEncoder: FaultyEncoder })(null, false);
    check(() => assert.throws(() => faultyEngine.deriveSync(request), /INJECTED_ENCODE_FAILURE/));
    check(() => assert.equal(encoded.length, 1));
    check(() => assert.ok(allZero(encoded[0]), 'partial canonicalize clears masterBytes'));

    const messages = [];
    const worker = { postMessage(msg) { messages.push(msg); } };
    factory(worker, false);
    const deriveEnv = { ...request, id: 101, type: 'derive', heartbeat: true, get code() { this.id = 999; return request.code; } };
    worker.onmessage({ data: deriveEnv });
    // 结果之前每条 lane 一次进度心跳（标准档 3 轮 × 4 片 × 4 lane），id 同样取自消息快照。
    const beats = messages.splice(0, messages.length - 1);
    check(() => assert.equal(beats.length, 3 * 4 * 4));
    check(() => assert.ok(beats.every((m) => m.id === 101 && m.type === 'progress')));
    check(() => assert.equal(messages[0].id, 101));
    check(() => assert.equal(messages[0].ok, true));
    const wipeEnv = { id: 102, type: 'wipe' };
    worker.onmessage({ data: wipeEnv });
    wipeEnv.id = 998;
    check(() => assert.equal(messages[1].id, 102));
    check(() => assert.equal(messages[1].type, 'wiped'));
    worker.onmessage({ data: { id: 103, get type() { throw new Error('BAD_ENVELOPE'); } } });
    check(() => assert.equal(messages[2].id, 103));
    check(() => assert.equal(messages[2].ok, false));
    check(() => assert.equal(messages[2].error, 'BAD_ENVELOPE'));
    // 心跳发送失败不得中断派生；页面未声明 heartbeat（旧页面）或命中会话缓存时不发心跳。
    const flaky = { sent: [], postMessage(msg) { if (msg.type === 'progress') throw new Error('CHANNEL_BUSY'); this.sent.push(msg); } };
    factory(flaky, false);
    flaky.onmessage({ data: { ...request, id: 201, type: 'derive', heartbeat: true } });
    check(() => assert.deepEqual(flaky.sent, [{ id: 201, ok: true, password: 'WueNKY^SRHRh4!DL', cached: false }]));
    const quiet = { sent: [], postMessage(msg) { this.sent.push(msg); } };
    factory(quiet, false);
    quiet.onmessage({ data: { ...request, id: 301, type: 'derive' } });
    check(() => assert.deepEqual(quiet.sent.map((m) => m.id + ':' + m.ok), ['301:true']));
    quiet.sent.length = 0;
    quiet.onmessage({ data: { ...request, id: 302, type: 'derive', counter: 2, heartbeat: true } });
    check(() => assert.equal(quiet.sent.length, 1));
    check(() => assert.equal(quiet.sent[0].cached, true));
}
console.log(`PASS core: ${checks} parameter, engine, cache and cleanup checks`);
