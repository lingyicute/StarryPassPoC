'use strict';
/* 使用公开派生 API 固定合法输入的兼容性；测试探针仅用于确认实际引擎。 */
const assert = require('node:assert/strict');
const loadCore = require('./helpers/load_core.js');
const spv2CoreFactory = loadCore();
const wasm = spv2CoreFactory(null, false);
const js = spv2CoreFactory(null, true);
assert.equal(wasm._test.getArena(40 * 1024).isWasm, true, 'WASM must really be available');
assert.equal(js._test.getArena(40 * 1024).isWasm, false);

let pass = 0, fail = 0;
function check(name, a, b) {
    if (a === b) { pass++; return; }
    fail++;
    console.error('MISMATCH', name, '\n  wasm=' + a, '\n  js  =' + b);
}

// 1) 仓库自带向量：两条引擎都必须命中（这些向量已与 libargon2 交叉验证）
for (const v of [...require('./vectors.json'), ...require('./compat-vectors.json').vectors]) {
    const [master, code, tier, counter, length, mode] = v.args;
    const req = { master, code, tier, counter, length, mode };
    const a = wasm.deriveSync(req);
    const b = js.deriveSync(req);
    check(`vector ${code.trim()}/${mode}/${length}`, a.password, v.pwd);
    check(`vector ${code.trim()}/${mode}/${length} (js)`, b.password, v.pwd);
}

// 2) 参数组合矩阵：mode × counter × length（使用 standard，避免 CI 过慢；
//    paranoid 已在上面 root-ca 向量中覆盖）
const cases = [];
for (const mode of ['full', 'alnum', 'pin']) {
    for (const length of mode === 'pin' ? [4, 6, 8] : [4, 16, 24, 64]) {
        for (const counter of [1, 9999]) cases.push({ mode, length, counter });
    }
}
for (const c of cases) {
    const req = Object.assign({ master: 'parity master 口令 🔐', code: 'parity-site', tier: 'standard' }, c);
    check(`matrix ${c.mode}/${c.length}/${c.counter}`,
        wasm.deriveSync(req).password, js.deriveSync(req).password);
}

// 3) 归一化边界：NFC 等价、代号 trim、大小写敏感
const norm = [
    ['café-secret', 'proton'], ['cafe\u0301-secret', 'proton'],
    ['  spaced master  ', '  Site Code  '], ['密码管理器主口令', '站点']
];
for (const [master, code] of norm) {
    const req = { master, code, tier: 'standard', counter: 1, length: 20, mode: 'full' };
    check(`norm ${JSON.stringify(code)}`, wasm.deriveSync(req).password, js.deriveSync(req).password);
}

// 4) 非法参数必须被拒绝（fail-closed），而不是静默降级
const bad = [
    [{ master: '', code: 'x' }, 'EMPTY_INPUT'],
    [{ master: 'x', code: '   ' }, 'EMPTY_INPUT'],
    [{ master: 'x', code: 'y', tier: 'bogus' }, 'INVALID_TIER'],
    [{ master: 'x', code: 'y', mode: 'bogus' }, 'INVALID_MODE'],
    [{ tier: '__proto__' }, 'INVALID_TIER'],
    [{ mode: 'constructor' }, 'INVALID_MODE']
];
for (const [over, expected] of bad) {
    const req = Object.assign({ master: 'x', code: 'y', tier: 'standard', counter: 1, length: 16, mode: 'full' }, over);
    for (const [label, eng] of [['wasm', wasm], ['js', js]]) {
        try {
            eng.deriveSync(req);
            fail++; console.error('MISMATCH expected', expected, 'but succeeded:', label, JSON.stringify(over));
        } catch (e) {
            if (e.message === expected) pass++;
            else { fail++; console.error('MISMATCH', label, JSON.stringify(over), 'got', e.message, 'want', expected); }
        }
    }
}

wasm.wipeSession(); js.wipeSession();
if (fail) { console.error(`\nFAILED ${fail} / ${pass + fail}`); process.exit(1); }
console.log(`PASS parity: ${pass} comparisons (wasm === pure-js, incl. fail-closed checks)`);
