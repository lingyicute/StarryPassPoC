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
cachedCore.wipeSession();
check(() => assert.ok(allZero(beforeWipe.cachedSk) && allZero(beforeWipe.cachedTag) && allZero(beforeWipe.sessionNonce)));

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

// WASM 编译失败是可见的正常降级，不可误报成内存不足。
const warnings = [];
const brokenWasm = { ...WebAssembly, Module: function () { throw new Error('INJECTED_WASM_BLOCK'); } };
const fallback = loadCore({ WebAssembly: brokenWasm, console: { warn: (msg) => warnings.push(msg) } })(null, false);
check(() => assert.equal(fallback._test.getArena(40 * 1024).isWasm, false));
check(() => assert.equal(warnings.length, 1));
check(() => assert.match(warnings[0], /INJECTED_WASM_BLOCK/));
// 纯 JS 分配失败也映射为可识别的内存错误。
const noMemory = loadCore({ ArrayBuffer: function () { throw new RangeError('allocation failed'); } })(null, true);
check(() => assert.throws(() => noMemory._test.getArena(40 * 1024), /MEMORY_LIMIT/));

// 省略可选参数仍按原有默认值；显式非法值（含原型属性名）必须拒绝。
check(() => assert.equal(cachedCore.deriveSync({ master: request.master, code: request.code }).password, 'WueNKY^SRHRh4!DL'));
for (const tier of ['bogus', '__proto__', 'constructor', null, ['standard']]) check(() => assert.throws(
    () => cachedCore.deriveSync({ ...request, tier }), /INVALID_TIER/));
for (const mode of ['bogus', '__proto__', 'constructor', null, ['full']]) check(() => assert.throws(
    () => cachedCore.deriveSync({ ...request, mode }), /INVALID_MODE/));
check(() => assert.throws(() => cachedCore.deriveSync(null), /INVALID_REQUEST/));
console.log(`PASS core: ${checks} parameter, engine, cache and cleanup checks`);
