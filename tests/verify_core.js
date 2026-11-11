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
    const deriveEnv = { ...request, id: 101, type: 'derive', get code() { this.id = 999; return request.code; } };
    worker.onmessage({ data: deriveEnv });
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
}
console.log(`PASS core: ${checks} parameter, engine, cache and cleanup checks`);
