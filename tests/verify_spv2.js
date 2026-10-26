'use strict';
const fs = require('fs');
const path = require('path');
const { spv2CoreFactory } = require('../assets/js/spv2-core.js');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors.json'), 'utf8'));
const wasm = spv2CoreFactory(null, false);
const js = spv2CoreFactory(null, true);

for (const v of vectors) {
    const [master, code, tier, counter, length, mode] = v.args;
    const out = wasm.deriveSync({ master, code, tier, counter, length, mode });
    if (out.password !== v.pwd) {
        console.error('FAIL', v.args, out.password, v.pwd);
        process.exit(1);
    }
    console.log('PASS', code.trim(), mode, out.password);
}

const v0 = vectors[0];
const jsOut = js.deriveSync({
    master: v0.args[0], code: v0.args[1], tier: v0.args[2],
    counter: v0.args[3], length: v0.args[4], mode: v0.args[5]
});
if (jsOut.password !== v0.pwd) {
    console.error('JS fallback mismatch');
    process.exit(1);
}
console.log('Pure-JS fallback OK');
console.log('ALL TESTS PASSED');
