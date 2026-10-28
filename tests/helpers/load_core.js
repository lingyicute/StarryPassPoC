'use strict';
// 仅在测试源码副本中注入探针，不增加生产文件的公开 API。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../../assets/js/spv2-core.js'), 'utf8');
const anchor = '        deriveSync: deriveSync,\n        wipeSession: wipeSession';
assert.equal(source.split(anchor).length, 2, 'core probe boundary must match exactly once');
const instrumented = source.replace(anchor, `${anchor},
        _test: {
            argon2idSync: argon2idSync,
            validateArgon2Params: validateArgon2Params,
            getArena: getArena,
            state: function () {
                return { wasmState: wasmState, cachedTag: cachedTag, cachedSk: cachedSk,
                    sessionNonce: sessionNonce, JS_R: JS_R, JS_Z: JS_Z };
            }
        }`);
module.exports = function loadCore(overrides = {}) {
    const context = {
        module: { exports: {} }, TextEncoder, Uint8Array, Int32Array, ArrayBuffer, RangeError,
        WebAssembly, crypto: webcrypto, console, ...overrides
    };
    // 在当前 realm 编译，以免 VM 全局代理使纯 JS Argon2 热循环慢数十倍。
    const build = vm.compileFunction(instrumented + '\nreturn module.exports.spv2CoreFactory;',
        Object.keys(context), { filename: 'spv2-core.test-probe.js' });
    return build(...Object.values(context));
};
