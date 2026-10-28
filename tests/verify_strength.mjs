/* Exercise the actual inline UI estimator, without a second implementation.
 * Weak-root fixture: StarryPassPoC commit ab373e8fb57d0f24f2bad48253ef8ea3e20430e4.
 * No DOM/crypto is needed: evaluate only the declarations preceding UI setup.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1]).filter((script) => script.trim());
for (const script of inlineScripts) new vm.Script(script);
const script = inlineScripts.find((source) => source.includes('var WEAK_ROOTS ='));
assert.ok(script, 'inline strength estimator exists');
const start = script.indexOf('var WEAK_ROOTS =');
const end = script.indexOf("var masterInput = document.getElementById('master-input');");
assert.ok(end > start, 'estimator extraction boundary exists');
const context = vm.createContext({});
vm.runInContext(script.slice(start, end), context);
const estimate = (master, code = 'unique-site-code', tier = 'standard', mode = 'full', length = 16) =>
    JSON.parse(JSON.stringify(context.estimateCrackResistance(master, code, tier, mode, length)));
const weak = { level: 1, label: '弱 · 含常见弱口令', bits: 18 };
const { roots } = JSON.parse(fs.readFileSync(new URL('./weak-roots.json', import.meta.url), 'utf8'));
const entries = [...script.slice(start, script.indexOf('var KB_ROWS')).matchAll(/'([^']+)':1/g)]
    .map((match) => match[1]);
assert.equal(new Set(entries).size, entries.length, 'no duplicate roots');
assert.deepEqual(entries.slice().sort(), roots.slice().sort(), 'exactly matches all reference roots');

let checks = 0;
function expectWeak(value) {
    assert.deepEqual(estimate(value), weak, `expected common-password warning: ${JSON.stringify(value)}`);
    checks++;
}
// Every reference entry, case folding, and suffix boundaries, including numeric roots.
for (const root of roots) {
    for (const variant of [root, root.toUpperCase(), root + '!', root + '2026!', root + '!@#$%^&*']) {
        expectWeak(variant);
    }
}
for (const value of [
    'P@ssw0rd', 'p4ssword', 'pa$$word', 'pa55word', 'p@55w0rd',
    'adm1n', 'adm!n', 'adm|n', 'l3tm31n', 's3cr3t', 'r00t', '7es7',
    'Password123!', 'P@ssw0rd2026!', 'admin12345678', 'abc123!',
    '1q2w3e4r5t2026!', '12345678910!', 'trustno1!', '1234562026!'
]) expectWeak(value);
// Every supported suffix character; never broaden to letters, spaces, or Unicode.
for (const ch of '0123456789!@#$%^&*()_+-=[]{};:"\\|,.<>/?~`') expectWeak('flowerpassword' + ch);
for (const value of [
    '', '__proto__', 'constructor', 'tostring', 'hasownproperty',
    '__definegetter__', '__lookupgetter__', 'valueof', 'isprototypeof',
    'propertyisenumerable', 'prototype', 'constructor!', '__proto__123!',
    'flowerpassword!!!!!!!!!', 'flowerpassword123456789',
    'flowerpasswordX', 'flowerpassword ', 'flowerpassword。',
    'prefixpassword', 'password-long-unrelated-phrase',
    'Cobalt lanterns drift beyond the violet horizon 82!',
    '星河轻拂远山，今夜仍有微光。', 'Étoiles brillantes au-dessus du jardin 🌠'
]) {
    assert.equal(context.hasWeakRoot(value.toLowerCase()), false, `false positive: ${JSON.stringify(value)}`);
    assert.notEqual(estimate(value).label, weak.label, `false warning: ${JSON.stringify(value)}`);
    checks++;
}
// No inherited properties, even if a name happens to become a valid candidate.
vm.runInContext('Object.prototype.unlistedweakroot = 1', context);
assert.equal(context.hasWeakRoot('unlistedweakroot'), false);
vm.runInContext('delete Object.prototype.unlistedweakroot', context);

// Earlier guards and existing strength/PIN branches retain their priority.
assert.deepEqual(estimate('', 'site'), { level: 0, label: '—', bits: 0 });
assert.deepEqual(estimate('password', '   '), { level: 0, label: '—', bits: 0 });
assert.deepEqual(estimate('password', 'password'), { level: 1, label: '弱 · 主密码勿含代号', bits: 16 });
assert.deepEqual(estimate('20000101'), { level: 1, label: '弱 · 勿用纯日期', bits: 15 });
const long = 'Cobalt lanterns drift beyond the violet horizon 82!';
const standard = estimate(long);
assert.equal(standard.level, 4);
// 输出空间上界封顶（并非精确熵）：16 × log2(77) ≈ 100.27 → 100
assert.equal(standard.bits, Math.round(16 * Math.log2(77)), 'output entropy caps the master estimate');
// 输出空间必须约束评级（回归：PIN/短输出曾被标成"极强"）
assert.equal(estimate('correct horse battery staple', 'unique-site-code', 'standard', 'full', 6).label,
    '弱 · 建议加长主密码', '6-char full output must not be rated strong');
assert.equal(estimate('correct horse battery staple', 'unique-site-code', 'standard', 'pin', 8).level, 2);
assert.equal(estimate('correct horse battery staple', 'unique-site-code', 'standard', 'pin', 8).bits, Math.round(8 * Math.log2(10)));
// 弱主密码分支也不能报告高于短 PIN 输出空间的比特数。
for (const master of ['X9!', 'password', '20000101']) {
    assert.ok(estimate(master, 'unique-site-code', 'standard', 'pin', 4).bits <= Math.round(4 * Math.log2(10)));
}
assert.equal(estimate(long, 'unique-site-code', 'standard', 'pin', 6).bits, Math.round(6 * Math.log2(10)));
// 强度档加成只在"主密码是瓶颈"时体现；被封顶时不再额外加分
const binding = 'tidal basin at dawn';
assert.equal(estimate(binding, 'unique-site-code', 'paranoid').bits,
    estimate(binding, 'unique-site-code', 'standard').bits + 3, 'tier bonus applies below the output cap');
assert.equal(estimate(long, 'unique-site-code', 'paranoid').bits, standard.bits, 'tier bonus must not exceed the output cap');
assert.equal(estimate(long, 'unique-site-code', 'standard', 'pin', 8).label, 'PIN · 依赖终端限次');
assert.equal(estimate('X9!', 'unique-site-code', 'standard', 'pin', 8).label, '弱 · 主密码过短');
assert.deepEqual(estimate('Cafe\u0301 long random phrase 82!'), estimate('Café long random phrase 82!'));
// Weak roots must not be promoted by tier, output mode, or output length.
for (const tier of ['standard', 'paranoid']) {
    for (const mode of ['full', 'pin']) {
        for (const length of [6, 8, 16, 32]) {
            assert.deepEqual(estimate('P@ssw0rd2026!', 'unique-site-code', tier, mode, length), weak);
            checks++;
        }
    }
}
console.log(`PASS inline script syntax, ${roots.length} reference roots, ${checks} weak-root cases, guard/PIN/NFC regressions`);
