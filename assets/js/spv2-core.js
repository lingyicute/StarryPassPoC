/* StarryPass v2 cryptographic core
 * Argon2id (RFC 9106) + HKDF-SHA-256 (RFC 5869) + unbiased rejection sampling.
 * WASM i64 G-block compressor with pure-JS fallback. Zero third-party deps.
 */
(function (root) {
'use strict';
function spv2CoreFactory(workerGlobal, forcePureJs) {
    'use strict';

    var LOWER  = 'abcdefghijklmnopqrstuvwxyz';
    var UPPER  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    var DIGIT  = '0123456789';
    var SYMBOL = '!@#$%^&*()-_=+?';

    var MODES = {
        full:  { id: 1, pool: LOWER + UPPER + DIGIT + SYMBOL, req: [LOWER, UPPER, DIGIT, SYMBOL] },
        alnum: { id: 2, pool: LOWER + UPPER + DIGIT,          req: [LOWER, UPPER, DIGIT] },
        pin:   { id: 3, pool: DIGIT,                          req: [DIGIT] }
    };

    var TIERS = {
        standard: { id: 1, memoryKiB: 65536,  passes: 3, parallelism: 4 },
        paranoid: { id: 2, memoryKiB: 262144, passes: 4, parallelism: 4 }
    };

    var encoder = new TextEncoder();

    function asciiBytes(str) {
        var out = new Uint8Array(str.length);
        for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0x7f;
        return out;
    }

    var DOMAIN_SALT    = asciiBytes('StarryPass-v2:salt\x00');
    var DOMAIN_AD      = asciiBytes('StarryPass-v2:argon2id-ad:v1');
    var DOMAIN_EXTRACT = asciiBytes('StarryPass-v2:hkdf-extract:v1');
    var DOMAIN_EXPAND  = asciiBytes('StarryPass-v2:hkdf-expand:v1\x00');
    var DOMAIN_CACHE   = asciiBytes('StarryPass-v2:session-cache-tag:v1\x00');

    function zeroize(buf) {
        if (buf && typeof buf.fill === 'function') buf.fill(0);
    }

    function constantTimeEqual(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        var diff = 0;
        for (var i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]);
        return diff === 0;
    }

    function writeLE32(out, offset, val) {
        out[offset]     = val & 0xff;
        out[offset + 1] = (val >>> 8) & 0xff;
        out[offset + 2] = (val >>> 16) & 0xff;
        out[offset + 3] = (val >>> 24) & 0xff;
    }

    function writeLE16(out, offset, val) {
        out[offset]     = val & 0xff;
        out[offset + 1] = (val >>> 8) & 0xff;
    }

    function concatBytes(arrays) {
        var total = 0, i, pos = 0;
        for (i = 0; i < arrays.length; i++) total += arrays[i].length;
        var out = new Uint8Array(total);
        for (i = 0; i < arrays.length; i++) {
            out.set(arrays[i], pos);
            pos += arrays[i].length;
        }
        return out;
    }

    function lenPrefixed(bytes) {
        var out = new Uint8Array(4 + bytes.length);
        writeLE32(out, 0, bytes.length);
        out.set(bytes, 4);
        return out;
    }

    /* ---------- SHA-256 / HMAC-SHA-256 / HKDF-SHA-256 (RFC 6234 / 2104 / 5869) ---------- */
    var SHA256_K = new Int32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);
    var SHA256_W = new Int32Array(64);

    function sha256(msg) {
        var h0 = 0x6a09e667 | 0, h1 = 0xbb67ae85 | 0, h2 = 0x3c6ef372 | 0, h3 = 0xa54ff53a | 0;
        var h4 = 0x510e527f | 0, h5 = 0x9b05688c | 0, h6 = 0x1f83d9ab | 0, h7 = 0x5be0cd19 | 0;
        var len = msg.length;
        var bitLenHi = Math.floor(len / 0x20000000) | 0;
        var bitLenLo = (len << 3) | 0;
        var padLen = (len + 9 + 63) & ~63;
        var padded = new Uint8Array(padLen);
        padded.set(msg);
        padded[len] = 0x80;
        padded[padLen - 8] = (bitLenHi >>> 24) & 0xff;
        padded[padLen - 7] = (bitLenHi >>> 16) & 0xff;
        padded[padLen - 6] = (bitLenHi >>> 8) & 0xff;
        padded[padLen - 5] = bitLenHi & 0xff;
        padded[padLen - 4] = (bitLenLo >>> 24) & 0xff;
        padded[padLen - 3] = (bitLenLo >>> 16) & 0xff;
        padded[padLen - 2] = (bitLenLo >>> 8) & 0xff;
        padded[padLen - 1] = bitLenLo & 0xff;

        for (var off = 0; off < padLen; off += 64) {
            for (var i = 0; i < 16; i++) {
                var bi = off + (i << 2);
                SHA256_W[i] = ((padded[bi] << 24) | (padded[bi + 1] << 16) | (padded[bi + 2] << 8) | padded[bi + 3]) | 0;
            }
            for (var j = 16; j < 64; j++) {
                var w15 = SHA256_W[j - 15], w2 = SHA256_W[j - 2];
                var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
                var s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
                SHA256_W[j] = (SHA256_W[j - 16] + s0 + SHA256_W[j - 7] + s1) | 0;
            }
            var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
            for (var r = 0; r < 64; r++) {
                var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
                var ch = (e & f) ^ (~e & g);
                var t1 = (h + S1 + ch + SHA256_K[r] + SHA256_W[r]) | 0;
                var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
                var maj = (a & b) ^ (a & c) ^ (b & c);
                var t2 = (S0 + maj) | 0;
                h = g; g = f; f = e; e = (d + t1) | 0;
                d = c; c = b; b = a; a = (t1 + t2) | 0;
            }
            h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
            h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
        }
        zeroize(padded);
        zeroize(SHA256_W);
        var out = new Uint8Array(32);
        var hs = [h0, h1, h2, h3, h4, h5, h6, h7];
        for (var k = 0; k < 8; k++) {
            out[k * 4]     = (hs[k] >>> 24) & 0xff;
            out[k * 4 + 1] = (hs[k] >>> 16) & 0xff;
            out[k * 4 + 2] = (hs[k] >>> 8) & 0xff;
            out[k * 4 + 3] = hs[k] & 0xff;
        }
        return out;
    }

    function hmacSha256(key, data) {
        var k = key.length > 64 ? sha256(key) : key;
        var ipad = new Uint8Array(64 + data.length);
        var opad = new Uint8Array(64 + 32);
        for (var i = 0; i < 64; i++) {
            var b = i < k.length ? k[i] : 0;
            ipad[i] = b ^ 0x36;
            opad[i] = b ^ 0x5c;
        }
        ipad.set(data, 64);
        var inner = sha256(ipad);
        zeroize(ipad);
        opad.set(inner, 64);
        zeroize(inner);
        var mac = sha256(opad);
        zeroize(opad);
        if (k !== key) zeroize(k);
        return mac;
    }

    /* ---------- BLAKE2b (RFC 7693) ---------- */
    var BLAKE2B_IV = new Int32Array([
        0xf3bcc908 | 0, 0x6a09e667 | 0, 0x84caa73b | 0, 0xbb67ae85 | 0,
        0xfe94f82b | 0, 0x3c6ef372 | 0, 0x5f1d36f1 | 0, 0xa54ff53a | 0,
        0xade682d1 | 0, 0x510e527f | 0, 0x2b3e6c1f | 0, 0x9b05688c | 0,
        0xfb41bd6b | 0, 0x1f83d9ab | 0, 0x137e2179 | 0, 0x5be0cd19 | 0
    ]);
    var BLAKE2B_SIGMA = new Uint8Array([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
        14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
        11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
        7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
        9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
        2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
        12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
        13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
        6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
        10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
        14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3
    ]);
    var B2B_V = new Int32Array(32), B2B_M = new Int32Array(32);

    function b2bG(v, a, b, c, d, ix, iy, m) {
        var alo = v[a], ahi = v[a + 1], blo = v[b], bhi = v[b + 1], clo = v[c], chi = v[c + 1], dlo = v[d], dhi = v[d + 1];
        var s0 = (alo >>> 0) + (blo >>> 0) + (m[ix] >>> 0);
        alo = s0 | 0; ahi = (ahi + bhi + m[ix + 1] + (s0 > 0xffffffff ? Math.floor(s0 / 4294967296) : 0)) | 0;
        var xlo = dlo ^ alo, xhi = dhi ^ ahi; dlo = xhi; dhi = xlo;
        s0 = (clo >>> 0) + (dlo >>> 0); clo = s0 | 0; chi = (chi + dhi + (s0 > 0xffffffff ? 1 : 0)) | 0;
        xlo = blo ^ clo; xhi = bhi ^ chi; blo = (xlo >>> 24) | (xhi << 8); bhi = (xhi >>> 24) | (xlo << 8);
        s0 = (alo >>> 0) + (blo >>> 0) + (m[iy] >>> 0);
        alo = s0 | 0; ahi = (ahi + bhi + m[iy + 1] + (s0 > 0xffffffff ? Math.floor(s0 / 4294967296) : 0)) | 0;
        xlo = dlo ^ alo; xhi = dhi ^ ahi; dlo = (xlo >>> 16) | (xhi << 16); dhi = (xhi >>> 16) | (xlo << 16);
        s0 = (clo >>> 0) + (dlo >>> 0); clo = s0 | 0; chi = (chi + dhi + (s0 > 0xffffffff ? 1 : 0)) | 0;
        xlo = blo ^ clo; xhi = bhi ^ chi; blo = (xlo << 1) | (xhi >>> 31); bhi = (xhi << 1) | (xlo >>> 31);
        v[a] = alo; v[a + 1] = ahi; v[b] = blo; v[b + 1] = bhi; v[c] = clo; v[c + 1] = chi; v[d] = dlo; v[d + 1] = dhi;
    }

    function b2bCompress(h, block, offset, tLo, tHi, last) {
        var i, j, sOff;
        for (i = 0; i < 16; i++) { B2B_V[i] = h[i]; B2B_V[i + 16] = BLAKE2B_IV[i]; }
        B2B_V[24] ^= tLo; B2B_V[25] ^= tHi;
        if (last) { B2B_V[28] = ~B2B_V[28]; B2B_V[29] = ~B2B_V[29]; }
        for (i = 0; i < 32; i++) { j = offset + (i << 2); B2B_M[i] = (block[j] | (block[j + 1] << 8) | (block[j + 2] << 16) | (block[j + 3] << 24)) | 0; }
        for (i = 0; i < 12; i++) {
            sOff = i << 4;
            b2bG(B2B_V, 0,  8, 16, 24, BLAKE2B_SIGMA[sOff +  0] << 1, BLAKE2B_SIGMA[sOff +  1] << 1, B2B_M);
            b2bG(B2B_V, 2, 10, 18, 26, BLAKE2B_SIGMA[sOff +  2] << 1, BLAKE2B_SIGMA[sOff +  3] << 1, B2B_M);
            b2bG(B2B_V, 4, 12, 20, 28, BLAKE2B_SIGMA[sOff +  4] << 1, BLAKE2B_SIGMA[sOff +  5] << 1, B2B_M);
            b2bG(B2B_V, 6, 14, 22, 30, BLAKE2B_SIGMA[sOff +  6] << 1, BLAKE2B_SIGMA[sOff +  7] << 1, B2B_M);
            b2bG(B2B_V, 0, 10, 20, 30, BLAKE2B_SIGMA[sOff +  8] << 1, BLAKE2B_SIGMA[sOff +  9] << 1, B2B_M);
            b2bG(B2B_V, 2, 12, 22, 24, BLAKE2B_SIGMA[sOff + 10] << 1, BLAKE2B_SIGMA[sOff + 11] << 1, B2B_M);
            b2bG(B2B_V, 4, 14, 16, 26, BLAKE2B_SIGMA[sOff + 12] << 1, BLAKE2B_SIGMA[sOff + 13] << 1, B2B_M);
            b2bG(B2B_V, 6,  8, 18, 28, BLAKE2B_SIGMA[sOff + 14] << 1, BLAKE2B_SIGMA[sOff + 15] << 1, B2B_M);
        }
        for (i = 0; i < 16; i++) h[i] ^= B2B_V[i] ^ B2B_V[i + 16];
    }

    function blake2b(input, outlen, key) {
        outlen = outlen || 64;
        var keylen = key ? key.length : 0;
        var h = new Int32Array(BLAKE2B_IV);
        h[0] ^= 0x01010000 ^ (keylen << 8) ^ outlen;
        var buf = new Uint8Array(128), buflen = 0, tLo = 0, tHi = 0;
        function addCount(inc) { var s = (tLo >>> 0) + inc; tLo = s | 0; if (s > 0xffffffff) tHi = (tHi + 1) | 0; }
        if (keylen > 0) { buf.set(key); buflen = 128; }
        var pos = 0, len = input.length;
        if (len > 0) {
            if (buflen > 0 && buflen + len > 128) {
                var fill = 128 - buflen;
                buf.set(input.subarray(0, fill), buflen);
                addCount(128); b2bCompress(h, buf, 0, tLo, tHi, false);
                buflen = 0; pos = fill;
            }
            while (pos + 128 < len) {
                addCount(128); b2bCompress(h, input, pos, tLo, tHi, false);
                pos += 128;
            }
            buf.set(input.subarray(pos, len), buflen);
            buflen += (len - pos);
        }
        for (var k = buflen; k < 128; k++) buf[k] = 0;
        addCount(buflen); b2bCompress(h, buf, 0, tLo, tHi, true);
        var out = new Uint8Array(outlen);
        for (var i = 0; i < outlen; i++) out[i] = (h[i >> 2] >>> ((i & 3) << 3)) & 0xff;
        zeroize(buf); zeroize(h); zeroize(B2B_V); zeroize(B2B_M);
        return out;
    }

    /* ---------- Argon2id v1.3 (RFC 9106) ---------- */
    function argon2HashPrime(input, tagLen) {
        var msg = new Uint8Array(4 + input.length);
        writeLE32(msg, 0, tagLen);
        msg.set(input, 4);
        if (tagLen <= 64) { var res = blake2b(msg, tagLen); zeroize(msg); return res; }
        var out = new Uint8Array(tagLen);
        var V = blake2b(msg, 64); zeroize(msg);
        out.set(V.subarray(0, 32), 0);
        var r = Math.ceil(tagLen / 32) - 2, pos = 32;
        for (var i = 1; i < r; i++) {
            var nextV = blake2b(V, 64); zeroize(V); V = nextV;
            out.set(V.subarray(0, 32), pos); pos += 32;
        }
        var finalV = blake2b(V, tagLen - 32 * r); zeroize(V);
        out.set(finalV, pos); zeroize(finalV);
        return out;
    }

    function mulHi32(a, b) {
        var a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
        var p0 = Math.imul(a0, b0) >>> 0, p1 = Math.imul(a0, b1) >>> 0, p2 = Math.imul(a1, b0) >>> 0, p3 = Math.imul(a1, b1) >>> 0;
        var mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
        return (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16)) >>> 0;
    }

    function indexAlpha(pass, lane, slice, lanes, sliceLen, laneLen, indexInSlice, j1, j2) {
        var refLane = (pass === 0 && slice === 0) ? lane : ((j2 >>> 0) % lanes);
        var sameLane = refLane === lane;
        var refAreaSize = pass === 0
            ? (slice === 0 ? indexInSlice - 1 : (sameLane ? slice * sliceLen + indexInSlice - 1 : slice * sliceLen - (indexInSlice === 0 ? 1 : 0)))
            : (sameLane ? laneLen - sliceLen + indexInSlice - 1 : laneLen - sliceLen - (indexInSlice === 0 ? 1 : 0));
        var x = mulHi32(j1 >>> 0, j1 >>> 0);
        var y = mulHi32(refAreaSize >>> 0, x);
        var relPos = refAreaSize - 1 - y;
        var startPos = (pass !== 0 && slice !== 3) ? (slice + 1) * sliceLen : 0;
        return refLane * laneLen + ((startPos + relPos) % laneLen);
    }

    /* Pure-JS G-block compressor fallback (for environments without WebAssembly, e.g. Lockdown Mode) */
    var JS_R = new Int32Array(256), JS_Z = new Int32Array(256);
    function jsGRound(Z, a, b, c, d) {
        var alo = Z[a], ahi = Z[a + 1], blo = Z[b], bhi = Z[b + 1], clo = Z[c], chi = Z[c + 1], dlo = Z[d], dhi = Z[d + 1];
        var a0, a1, b0, b1, p0, p1, p2, p3, mid, mlo, mhi, s1, s2, xlo, xhi;

        a0 = alo & 0xffff; a1 = alo >>> 16; b0 = blo & 0xffff; b1 = blo >>> 16;
        p0 = Math.imul(a0, b0); p1 = Math.imul(a0, b1); p2 = Math.imul(a1, b0); p3 = Math.imul(a1, b1);
        mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
        mlo = (mid << 16) | (p0 & 0xffff); mhi = p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16);
        mhi = (mhi << 1) | (mlo >>> 31); mlo = mlo << 1;
        s1 = (alo >>> 0) + (blo >>> 0); s2 = (s1 >>> 0) + (mlo >>> 0);
        alo = s2 | 0; ahi = (ahi + bhi + mhi + (s1 > 0xffffffff ? 1 : 0) + (s2 > 0xffffffff ? 1 : 0)) | 0;
        xlo = dlo ^ alo; xhi = dhi ^ ahi; dlo = xhi; dhi = xlo;

        a0 = clo & 0xffff; a1 = clo >>> 16; b0 = dlo & 0xffff; b1 = dlo >>> 16;
        p0 = Math.imul(a0, b0); p1 = Math.imul(a0, b1); p2 = Math.imul(a1, b0); p3 = Math.imul(a1, b1);
        mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
        mlo = (mid << 16) | (p0 & 0xffff); mhi = p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16);
        mhi = (mhi << 1) | (mlo >>> 31); mlo = mlo << 1;
        s1 = (clo >>> 0) + (dlo >>> 0); s2 = (s1 >>> 0) + (mlo >>> 0);
        clo = s2 | 0; chi = (chi + dhi + mhi + (s1 > 0xffffffff ? 1 : 0) + (s2 > 0xffffffff ? 1 : 0)) | 0;
        xlo = blo ^ clo; xhi = bhi ^ chi; blo = (xlo >>> 24) | (xhi << 8); bhi = (xhi >>> 24) | (xlo << 8);

        a0 = alo & 0xffff; a1 = alo >>> 16; b0 = blo & 0xffff; b1 = blo >>> 16;
        p0 = Math.imul(a0, b0); p1 = Math.imul(a0, b1); p2 = Math.imul(a1, b0); p3 = Math.imul(a1, b1);
        mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
        mlo = (mid << 16) | (p0 & 0xffff); mhi = p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16);
        mhi = (mhi << 1) | (mlo >>> 31); mlo = mlo << 1;
        s1 = (alo >>> 0) + (blo >>> 0); s2 = (s1 >>> 0) + (mlo >>> 0);
        alo = s2 | 0; ahi = (ahi + bhi + mhi + (s1 > 0xffffffff ? 1 : 0) + (s2 > 0xffffffff ? 1 : 0)) | 0;
        xlo = dlo ^ alo; xhi = dhi ^ ahi; dlo = (xlo >>> 16) | (xhi << 16); dhi = (xhi >>> 16) | (xlo << 16);

        a0 = clo & 0xffff; a1 = clo >>> 16; b0 = dlo & 0xffff; b1 = dlo >>> 16;
        p0 = Math.imul(a0, b0); p1 = Math.imul(a0, b1); p2 = Math.imul(a1, b0); p3 = Math.imul(a1, b1);
        mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
        mlo = (mid << 16) | (p0 & 0xffff); mhi = p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16);
        mhi = (mhi << 1) | (mlo >>> 31); mlo = mlo << 1;
        s1 = (clo >>> 0) + (dlo >>> 0); s2 = (s1 >>> 0) + (mlo >>> 0);
        clo = s2 | 0; chi = (chi + dhi + mhi + (s1 > 0xffffffff ? 1 : 0) + (s2 > 0xffffffff ? 1 : 0)) | 0;
        xlo = blo ^ clo; xhi = bhi ^ chi; blo = (xlo << 1) | (xhi >>> 31); bhi = (xhi << 1) | (xlo >>> 31);

        Z[a] = alo; Z[a + 1] = ahi; Z[b] = blo; Z[b + 1] = bhi; Z[c] = clo; Z[c + 1] = chi; Z[d] = dlo; Z[d + 1] = dhi;
    }

    function jsPermuteP(Z, w0, w1, w2, w3, w4, w5, w6, w7, w8, w9, w10, w11, w12, w13, w14, w15) {
        jsGRound(Z, w0, w4,  w8, w12); jsGRound(Z, w1, w5,  w9, w13);
        jsGRound(Z, w2, w6, w10, w14); jsGRound(Z, w3, w7, w11, w15);
        jsGRound(Z, w0, w5, w10, w15); jsGRound(Z, w1, w6, w11, w12);
        jsGRound(Z, w2, w7,  w8, w13); jsGRound(Z, w3, w4,  w9, w14);
    }

    function jsCompress(memI32, byteOffX, byteOffY, byteOffOut, xorFlag) {
        var offX = byteOffX >> 2, offY = byteOffY >> 2, offOut = byteOffOut >> 2, i, base;
        for (i = 0; i < 256; i++) { var r = memI32[offX + i] ^ memI32[offY + i]; JS_R[i] = r; JS_Z[i] = r; }
        for (i = 0; i < 8; i++) {
            base = i << 5;
            jsPermuteP(JS_Z, base, base + 2, base + 4, base + 6, base + 8, base + 10, base + 12, base + 14,
                       base + 16, base + 18, base + 20, base + 22, base + 24, base + 26, base + 28, base + 30);
        }
        for (i = 0; i < 8; i++) {
            base = i << 2;
            jsPermuteP(JS_Z, base, base + 2, base + 32, base + 34, base + 64, base + 66, base + 96, base + 98,
                       base + 128, base + 130, base + 160, base + 162, base + 192, base + 194, base + 224, base + 226);
        }
        if (xorFlag) {
            for (i = 0; i < 256; i++) memI32[offOut + i] ^= JS_Z[i] ^ JS_R[i];
        } else {
            for (i = 0; i < 256; i++) memI32[offOut + i] = JS_Z[i] ^ JS_R[i];
        }
    }

    /* Transparent symbolic WASM i64 G-block compressor (reusable bounded linear memory) */
    var wasmState = null;

    function buildWasmModule() {
        function uleb(n) { var o = []; do { var b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; }
        function sleb(n) {
            var o = [], more = true;
            while (more) {
                var b = n & 0x7f; n >>= 7;
                if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false;
                else b |= 0x80;
                o.push(b);
            }
            return o;
        }
        function sec(id, body) { return [id].concat(uleb(body.length), body); }
        var OP = {
            LOOP: 0x03, IF: 0x04, END: 0x0b, BR_IF: 0x0d, CALL: 0x10,
            LGET: 0x20, LSET: 0x21, LTEE: 0x22, I64_LD: 0x29, I64_ST: 0x37,
            I32_C: 0x41, I64_C: 0x42, I32_LTU: 0x49, I32_ADD: 0x6a, I32_SHL: 0x74,
            I64_ADD: 0x7c, I64_MUL: 0x7e, I64_AND: 0x83, I64_XOR: 0x85, I64_SHL: 0x86, I64_ROTR: 0x8a
        };
        var A = 5, B = 6, C = 7, D = 8, MASK = 9, PA = 10, PB = 11, PC = 12, PD = 13;
        function step(X, Y, Z, R) {
            return [
                OP.LGET, X, OP.LGET, Y, OP.I64_ADD,
                OP.LGET, X, OP.LGET, MASK, OP.I64_AND,
                OP.LGET, Y, OP.LGET, MASK, OP.I64_AND,
                OP.I64_MUL, OP.I64_C, 1, OP.I64_SHL,
                OP.I64_ADD, OP.LTEE, X,
                OP.LGET, Z, OP.I64_XOR, OP.I64_C, R, OP.I64_ROTR, OP.LSET, Z
            ];
        }
        var fn0 = [
            2, 5, 0x7e, 4, 0x7f,
            OP.I64_C, 0xff, 0xff, 0xff, 0xff, 0x0f, OP.LSET, MASK,
            OP.LGET, 0, OP.LGET, 1, OP.I32_ADD, OP.LTEE, PA, OP.I64_LD, 3, 0, OP.LSET, A,
            OP.LGET, 0, OP.LGET, 2, OP.I32_ADD, OP.LTEE, PB, OP.I64_LD, 3, 0, OP.LSET, B,
            OP.LGET, 0, OP.LGET, 3, OP.I32_ADD, OP.LTEE, PC, OP.I64_LD, 3, 0, OP.LSET, C,
            OP.LGET, 0, OP.LGET, 4, OP.I32_ADD, OP.LTEE, PD, OP.I64_LD, 3, 0, OP.LSET, D
        ].concat(
            step(A, B, D, 32), step(C, D, B, 24), step(A, B, D, 16), step(C, D, B, 63),
            [
                OP.LGET, PA, OP.LGET, A, OP.I64_ST, 3, 0,
                OP.LGET, PB, OP.LGET, B, OP.I64_ST, 3, 0,
                OP.LGET, PC, OP.LGET, C, OP.I64_ST, 3, 0,
                OP.LGET, PD, OP.LGET, D, OP.I64_ST, 3, 0, OP.END
            ]
        );
        var I = 5, BASE = 6, ZPTR = 7, T64 = 8;
        function callG(a, b, c, d) {
            return [OP.LGET, BASE, OP.I32_C].concat(sleb(a * 8), [OP.I32_C], sleb(b * 8), [OP.I32_C], sleb(c * 8), [OP.I32_C], sleb(d * 8), [OP.CALL, 0]);
        }
        var rowCalls = [].concat(callG(0,4,8,12),callG(1,5,9,13),callG(2,6,10,14),callG(3,7,11,15),callG(0,5,10,15),callG(1,6,11,12),callG(2,7,8,13),callG(3,4,9,14));
        var colCalls = [].concat(callG(0,32,64,96),callG(1,33,65,97),callG(16,48,80,112),callG(17,49,81,113),callG(0,33,80,113),callG(1,48,81,96),callG(16,49,64,97),callG(17,32,65,112));
        var fn1 = [
            2, 3, 0x7f, 1, 0x7e,
            OP.LGET, 4, OP.I32_C].concat(sleb(1024), [OP.I32_ADD, OP.LSET, ZPTR,
            OP.I32_C, 0, OP.LSET, I,
            OP.LOOP, 0x40,
                OP.LGET, 4, OP.LGET, I, OP.I32_ADD,
                OP.LGET, 0, OP.LGET, I, OP.I32_ADD, OP.I64_LD, 3, 0,
                OP.LGET, 1, OP.LGET, I, OP.I32_ADD, OP.I64_LD, 3, 0,
                OP.I64_XOR, OP.LTEE, T64, OP.I64_ST, 3, 0,
                OP.LGET, ZPTR, OP.LGET, I, OP.I32_ADD, OP.LGET, T64, OP.I64_ST, 3, 0,
                OP.LGET, I, OP.I32_C, 8, OP.I32_ADD, OP.LTEE, I,
                OP.I32_C], sleb(1024), [OP.I32_LTU, OP.BR_IF, 0,
            OP.END,
            OP.I32_C, 0, OP.LSET, I,
            OP.LOOP, 0x40,
                OP.LGET, ZPTR, OP.LGET, I, OP.I32_C, 7, OP.I32_SHL, OP.I32_ADD, OP.LSET, BASE],
                rowCalls, [
                OP.LGET, I, OP.I32_C, 1, OP.I32_ADD, OP.LTEE, I, OP.I32_C, 8, OP.I32_LTU, OP.BR_IF, 0,
            OP.END,
            OP.I32_C, 0, OP.LSET, I,
            OP.LOOP, 0x40,
                OP.LGET, ZPTR, OP.LGET, I, OP.I32_C, 4, OP.I32_SHL, OP.I32_ADD, OP.LSET, BASE],
                colCalls, [
                OP.LGET, I, OP.I32_C, 1, OP.I32_ADD, OP.LTEE, I, OP.I32_C, 8, OP.I32_LTU, OP.BR_IF, 0,
            OP.END,
            OP.I32_C, 0, OP.LSET, I,
            OP.LOOP, 0x40,
                OP.LGET, 4, OP.LGET, I, OP.I32_ADD, OP.I64_LD, 3, 0,
                OP.LGET, ZPTR, OP.LGET, I, OP.I32_ADD, OP.I64_LD, 3, 0,
                OP.I64_XOR, OP.LSET, T64,
                OP.LGET, 3, OP.IF, 0x40,
                    OP.LGET, 2, OP.LGET, I, OP.I32_ADD, OP.I64_LD, 3, 0,
                    OP.LGET, T64, OP.I64_XOR, OP.LSET, T64,
                OP.END,
                OP.LGET, 2, OP.LGET, I, OP.I32_ADD, OP.LGET, T64, OP.I64_ST, 3, 0,
                OP.LGET, I, OP.I32_C, 8, OP.I32_ADD, OP.LTEE, I,
                OP.I32_C], sleb(1024), [OP.I32_LTU, OP.BR_IF, 0,
            OP.END, OP.END
        ]);
        var wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00].concat(
            sec(1, [2, 0x60, 5, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0, 0x60, 5, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0]),
            sec(2, [1, 1, 0x65, 1, 0x6d, 0x02, 0x00, 1]),
            sec(3, [2, 0, 1]),
            sec(7, [1, 1, 0x63, 0x00, 1]),
            sec(10, [2].concat(uleb(fn0.length), fn0, uleb(fn1.length), fn1))
        ));
        return new WebAssembly.Module(wasmBytes);
    }

    function getArena(requiredBytes) {
        if (!forcePureJs && typeof WebAssembly === 'object' && typeof WebAssembly.Module === 'function') {
            try {
                var neededPages = Math.ceil(requiredBytes / 65536);
                if (!wasmState) {
                    var mod = buildWasmModule();
                    var initPages = Math.max(neededPages, 2);
                    var mem;
                    try {
                        mem = new WebAssembly.Memory({ initial: initPages, maximum: 4100 });
                    } catch (e) {
                        mem = new WebAssembly.Memory({ initial: initPages, maximum: initPages });
                    }
                    var inst = new WebAssembly.Instance(mod, { e: { m: mem } });
                    wasmState = { mod: mod, mem: mem, pages: initPages, fn: inst.exports.c };
                } else if (wasmState.pages < neededPages) {
                    wasmState.mem.grow(neededPages - wasmState.pages);
                    wasmState.pages = neededPages;
                }
                return {
                    u8: new Uint8Array(wasmState.mem.buffer),
                    i32: new Int32Array(wasmState.mem.buffer),
                    compress: wasmState.fn,
                    isWasm: true
                };
            } catch (err) {
                if (wasmState && wasmState.pages < Math.ceil(requiredBytes / 65536)
                        && requiredBytes >= 100 * 1048576) throw new Error('MEMORY_LIMIT');
                if (typeof console === 'object' && typeof console.warn === 'function') {
                    console.warn('[spv2] WASM 不可用，本次回退纯 JS：' + (err && err.message ? err.message : err));
                }
            }
        }
        var buf;
        try {
            buf = new ArrayBuffer(requiredBytes);
        } catch (err) {
            if (err instanceof RangeError) throw new Error('MEMORY_LIMIT');
            throw err;
        }
        var i32 = new Int32Array(buf);
        return {
            u8: new Uint8Array(buf),
            i32: i32,
            compress: function (offX, offY, offOut, xorFlag) { jsCompress(i32, offX, offY, offOut, xorFlag); },
            isWasm: false
        };
    }

    function initArgon2Ctx(params) {
        var P = params.password, S = params.salt;
        var K = params.secret || new Uint8Array(0), X = params.ad || new Uint8Array(0);
        var m = params.memoryKiB, t = params.passes, p = params.parallelism;
        var T = params.tagLength === undefined ? 32 : params.tagLength;
        var yType = 2, version = 0x13;
        var headerFixed = new Uint8Array(24), fields, h0Input, H0, seedBuf, blkBytes, arena;
        try {
            writeLE32(headerFixed, 0, p); writeLE32(headerFixed, 4, T); writeLE32(headerFixed, 8, m);
            writeLE32(headerFixed, 12, t); writeLE32(headerFixed, 16, version); writeLE32(headerFixed, 20, yType);
            fields = [headerFixed, lenPrefixed(P), lenPrefixed(S), lenPrefixed(K), lenPrefixed(X)];
            h0Input = concatBytes(fields);
            H0 = blake2b(h0Input, 64);
            zeroize(h0Input);

            var totalBlocks = 4 * p * Math.floor(m / (4 * p));
            var laneLen = totalBlocks / p, sliceLen = laneLen / 4;
            var baseScratch = totalBlocks * 1024;
            arena = getArena(baseScratch + 6144);
            var memU8 = arena.u8;
            memU8.fill(0, baseScratch, baseScratch + 6144);

            seedBuf = new Uint8Array(72);
            seedBuf.set(H0, 0);
            for (var lane = 0; lane < p; lane++) {
                for (var jb = 0; jb < 2; jb++) {
                    writeLE32(seedBuf, 64, jb); writeLE32(seedBuf, 68, lane);
                    blkBytes = argon2HashPrime(seedBuf, 1024);
                    memU8.set(blkBytes, (lane * laneLen + jb) * 1024);
                    zeroize(blkBytes);
                }
            }
            return {
                t: t, p: p, T: T, yType: yType,
                totalBlocks: totalBlocks, laneLen: laneLen, sliceLen: sliceLen,
                baseScratch: baseScratch, arena: arena
            };
        } catch (err) {
            if (arena) zeroize(arena.u8);
            throw err;
        } finally {
            if (fields) for (var f = 0; f < fields.length; f++) zeroize(fields[f]);
            zeroize(headerFixed); zeroize(h0Input); zeroize(H0);
            zeroize(seedBuf); zeroize(blkBytes);
        }
    }

    function runArgon2Slice(ctx, pass, slice) {
        var p = ctx.p, t = ctx.t, laneLen = ctx.laneLen, sliceLen = ctx.sliceLen;
        var baseScratch = ctx.baseScratch;
        var zeroPtr = baseScratch, inputPtr = baseScratch + 1024, tmpPtr = baseScratch + 2048;
        var addrPtr = baseScratch + 3072, rzPtr = baseScratch + 4096;
        var memI32 = ctx.arena.i32, compress = ctx.arena.compress;
        var inputI32Off = inputPtr >> 2, addrI32Off = addrPtr >> 2;
        var xorFlag = pass > 0 ? 1 : 0;
        var dataIndep = (pass === 0 && slice < 2);

        for (var l = 0; l < p; l++) {
            var addrCounter = 0;
            if (dataIndep) {
                memI32.fill(0, inputI32Off, inputI32Off + 256);
                memI32[inputI32Off + 0]  = pass;
                memI32[inputI32Off + 2]  = l;
                memI32[inputI32Off + 4]  = slice;
                memI32[inputI32Off + 6]  = ctx.totalBlocks;
                memI32[inputI32Off + 8]  = t;
                memI32[inputI32Off + 10] = ctx.yType;
            }
            var startIdx = (pass === 0 && slice === 0) ? 2 : 0;
            for (var idx = startIdx; idx < sliceLen; idx++) {
                var j1, j2;
                if (dataIndep) {
                    var subIdx = idx & 127;
                    if (subIdx === 0 || idx === startIdx) {
                        addrCounter++;
                        memI32[inputI32Off + 12] = addrCounter;
                        compress(zeroPtr, inputPtr, tmpPtr, 0, rzPtr);
                        compress(zeroPtr, tmpPtr, addrPtr, 0, rzPtr);
                    }
                    j1 = memI32[addrI32Off + subIdx * 2];
                    j2 = memI32[addrI32Off + subIdx * 2 + 1];
                } else {
                    var prevInLane = (slice * sliceLen + idx - 1 + laneLen) % laneLen;
                    var prevI32 = (l * laneLen + prevInLane) * 256;
                    j1 = memI32[prevI32];
                    j2 = memI32[prevI32 + 1];
                }
                var curInLane = slice * sliceLen + idx;
                var prevIdx = (curInLane - 1 + laneLen) % laneLen;
                var refBlock = indexAlpha(pass, l, slice, p, sliceLen, laneLen, idx, j1, j2);
                compress(
                    (l * laneLen + prevIdx) * 1024,
                    refBlock * 1024,
                    (l * laneLen + curInLane) * 1024,
                    xorFlag,
                    rzPtr
                );
            }
        }
    }

    function finalizeArgon2Ctx(ctx) {
        var finalBytes = new Uint8Array(1024);
        var memU8 = ctx.arena.u8;
        try {
            for (var fl = 0; fl < ctx.p; fl++) {
                var lastByteOff = (fl * ctx.laneLen + ctx.laneLen - 1) * 1024;
                for (var fb = 0; fb < 1024; fb++) finalBytes[fb] ^= memU8[lastByteOff + fb];
            }
            return argon2HashPrime(finalBytes, ctx.T);
        } finally {
            zeroize(finalBytes);
        }
    }

    function validateArgon2Params(params) {
        if (!params) throw new Error('ARGON2_INVALID_INPUT');
        var fields = ['password', 'salt', 'secret', 'ad'];
        for (var i = 0; i < fields.length; i++) {
            var value = params[fields[i]];
            if (i >= 2 && value == null) continue;
            if (!(value instanceof Uint8Array)) throw new Error('ARGON2_INVALID_INPUT');
            if (value.length > 0xffffffff) throw new Error('ARGON2_INPUT_TOO_LONG');
        }
        var m = params.memoryKiB, t = params.passes, p = params.parallelism;
        var T = params.tagLength === undefined ? 32 : params.tagLength;
        if (params.salt.length < 8) throw new Error('ARGON2_SALT_TOO_SHORT');
        if (!Number.isInteger(p) || p < 1 || p > 0xffffff
                || !Number.isInteger(t) || t < 1 || t > 0xffffffff
                || !Number.isInteger(m) || m < 0 || m > 0xffffffff) throw new Error('ARGON2_INVALID_COST');
        if (m < 8 * p) throw new Error('ARGON2_MEMORY_TOO_LOW');
        if (!Number.isInteger(T) || T > 0xffffffff) throw new Error('ARGON2_INVALID_TAG_LENGTH');
        if (T < 4) throw new Error('ARGON2_TAG_TOO_SHORT');
    }

    function argon2idSync(params) {
        validateArgon2Params(params);
        var ctx;
        try {
            ctx = initArgon2Ctx(params);
            for (var pass = 0; pass < ctx.t; pass++) {
                for (var slice = 0; slice < 4; slice++) {
                    runArgon2Slice(ctx, pass, slice);
                }
            }
            return finalizeArgon2Ctx(ctx);
        } finally {
            // 覆盖整个 arena（包括增长后的尾部），异常路径也必须执行；不代表归还内存。
            if (ctx) zeroize(ctx.arena.u8);
            zeroize(JS_R); zeroize(JS_Z);
        }
    }

    /* ---------- Stage 2 & Stage 3: HKDF-SHA-256 + Zero-Bias Rejection Synthesis ---------- */
    function synthesizePassword(sk, codeBytes, counter, length, modeName) {
        var modeSpec = MODES[modeName] || MODES.full;
        var prk = hmacSha256(DOMAIN_EXTRACT, sk);

        var meta = new Uint8Array(7);
        writeLE32(meta, 0, counter >>> 0);
        writeLE16(meta, 4, length & 0xffff);
        meta[6] = modeSpec.id;
        var info = concatBytes([DOMAIN_EXPAND, meta, lenPrefixed(codeBytes)]);

        var blockIdx = 0;
        var prev = new Uint8Array(0);
        var streamBuf = new Uint8Array(32);
        var streamPos = 32;

        function nextByte() {
            if (streamPos >= streamBuf.length) {
                blockIdx++;
                if (blockIdx > 255) throw new Error('HKDF_EXHAUSTED');
                var inBlk = new Uint8Array(prev.length + info.length + 1);
                inBlk.set(prev, 0);
                inBlk.set(info, prev.length);
                inBlk[prev.length + info.length] = blockIdx;
                var next = hmacSha256(prk, inBlk);
                zeroize(inBlk);
                zeroize(prev);
                prev = next;
                streamBuf.set(prev);
                streamPos = 0;
            }
            return streamBuf[streamPos++];
        }

        function uniformInt(n) {
            var limit = 256 - (256 % n);
            for (;;) {
                var b = nextByte();
                if (b < limit) return b % n;
            }
        }

        var pool = modeSpec.pool;
        var reqClasses = length >= modeSpec.req.length ? modeSpec.req : [];
        var result = null;

        for (var attempt = 0; attempt < 128; attempt++) {
            var chars = new Array(length);
            for (var i = 0; i < length; i++) chars[i] = pool.charAt(uniformInt(pool.length));
            var candidate = chars.join('');
            var ok = true;
            for (var c = 0; c < reqClasses.length; c++) {
                var cls = reqClasses[c], found = false;
                for (var k = 0; k < candidate.length; k++) {
                    if (cls.indexOf(candidate.charAt(k)) !== -1) { found = true; break; }
                }
                if (!found) { ok = false; break; }
            }
            if (ok) { result = candidate; break; }
        }

        if (!result) {
            var arr = [];
            for (var r = 0; r < reqClasses.length; r++) {
                arr.push(reqClasses[r].charAt(uniformInt(reqClasses[r].length)));
            }
            while (arr.length < length) arr.push(pool.charAt(uniformInt(pool.length)));
            for (var s = length - 1; s > 0; s--) {
                var j = uniformInt(s + 1);
                var tmp = arr[s]; arr[s] = arr[j]; arr[j] = tmp;
            }
            result = arr.join('');
        }

        zeroize(prk);
        zeroize(info);
        zeroize(prev);
        zeroize(streamBuf);
        return result;
    }

    /* ---------- FIPS 140-3 Style Power-On Self-Test (KAT) ---------- */
    var selfTestPassed = false;
    function runSelfTest() {
        if (selfTestPassed) return;
        // 1. RFC 9106 §5.3 Argon2id KAT
        var p = new Uint8Array(32).fill(1), s = new Uint8Array(16).fill(2);
        var k = new Uint8Array(8).fill(3), x = new Uint8Array(12).fill(4);
        var tag = argon2idSync({ password: p, salt: s, secret: k, ad: x, memoryKiB: 32, passes: 3, parallelism: 4, tagLength: 32 });
        var expectedA2 = [
            0x0d,0x64,0x0d,0xf5,0x8d,0x78,0x76,0x6c,0x08,0xc0,0x37,0xa3,0x4a,0x8b,0x53,0xc9,
            0xd0,0x1e,0xf0,0x45,0x2d,0x75,0xb6,0x5e,0xb5,0x25,0x20,0xe9,0x6b,0x01,0xe6,0x59
        ];
        for (var i = 0; i < 32; i++) {
            if (tag[i] !== expectedA2[i]) throw new Error('KAT_ARGON2ID_FAILED');
        }
        zeroize(tag);

        // 2. RFC 5869 TC1 HMAC/SHA-256 KAT (first 8 bytes of PRK = 077709362c2e32df)
        var tcSalt = new Uint8Array([0,1,2,3,4,5,6,7,8,9,10,11,12]);
        var tcIkm = new Uint8Array(22).fill(0x0b);
        var prk = hmacSha256(tcSalt, tcIkm);
        var expectedPrk8 = [0x07, 0x77, 0x09, 0x36, 0x2c, 0x2e, 0x32, 0xdf];
        for (var j = 0; j < 8; j++) {
            if (prk[j] !== expectedPrk8[j]) throw new Error('KAT_SHA256_FAILED');
        }
        zeroize(prk);
        selfTestPassed = true;
    }

    /* ---------- Ephemeral Single-Slot Session Key Cache (Zeroized on Wipe/Change) ---------- */
    var sessionNonce = null;
    var sessionNonceUnavailable = false;
    function getSessionNonce() {
        if (sessionNonceUnavailable) return null;
        if (!sessionNonce) {
            var nonce = new Uint8Array(32);
            try {
                if (typeof crypto !== 'object' || typeof crypto.getRandomValues !== 'function') {
                    throw new Error('NO_CSPRNG');
                }
                crypto.getRandomValues(nonce);
                sessionNonce = nonce;
            } catch (err) {
                // 缺失或失败时均关闭缓存，不留下可预测的全零 nonce。
                zeroize(nonce);
                sessionNonceUnavailable = true;
                return null;
            }
        }
        return sessionNonce;
    }

    var cachedTag = null;
    var cachedSk  = null;

    function wipeSession() {
        if (cachedTag) { zeroize(cachedTag); cachedTag = null; }
        if (cachedSk)  { zeroize(cachedSk);  cachedSk  = null; }
        if (sessionNonce) { zeroize(sessionNonce); sessionNonce = null; }
        if (wasmState && wasmState.mem) {
            new Uint8Array(wasmState.mem.buffer).fill(0);
        }
    }

    function computeSessionTag(masterBytes, codeBytes, tierId) {
        var nonce = getSessionNonce();
        if (!nonce) return null;
        var tierByte = new Uint8Array([tierId]);
        var masterField = lenPrefixed(masterBytes), codeField = lenPrefixed(codeBytes), msg;
        try {
            msg = concatBytes([DOMAIN_CACHE, masterField, codeField, tierByte]);
            return hmacSha256(nonce, msg);
        } finally {
            zeroize(masterField); zeroize(codeField); zeroize(msg);
        }
    }

    function buildSalt(codeBytes, tierId) {
        var tierByte = new Uint8Array([tierId]);
        var saltIn = concatBytes([DOMAIN_SALT, lenPrefixed(codeBytes), tierByte]);
        var s = sha256(saltIn);
        zeroize(saltIn);
        return s;
    }

    function canonicalizeInputs(req) {
        if (!req || typeof req !== 'object') throw new Error('INVALID_REQUEST');
        // 保留省略参数时的原有默认值，但显式未知值不能静默降级。
        var tier = req.tier === undefined ? 'standard' : req.tier;
        var mode = req.mode === undefined ? 'full' : req.mode;
        if (typeof tier !== 'string' || !Object.prototype.hasOwnProperty.call(TIERS, tier)) throw new Error('INVALID_TIER');
        if (typeof mode !== 'string' || !Object.prototype.hasOwnProperty.call(MODES, mode)) throw new Error('INVALID_MODE');
        var masterNorm = String(req.master || '').normalize('NFC');
        var codeNorm   = String(req.code || '').trim().normalize('NFC');
        var masterBytes = encoder.encode(masterNorm);
        var codeBytes   = encoder.encode(codeNorm);
        var tierSpec = TIERS[tier];
        var counter = Math.max(1, Math.min(9999, parseInt(req.counter, 10) || 1));
        var length  = Math.max(4, Math.min(64, parseInt(req.length, 10) || 16));
        return {
            masterBytes: masterBytes,
            codeBytes: codeBytes,
            tierSpec: tierSpec,
            counter: counter,
            length: length,
            mode: mode
        };
    }

    function deriveSync(req) {
        runSelfTest();
        var inp = canonicalizeInputs(req);
        var reqTag = null, salt = null, sk = null, usedCache = false;
        try {
            if (!inp.masterBytes.length || !inp.codeBytes.length) throw new Error('EMPTY_INPUT');
            reqTag = computeSessionTag(inp.masterBytes, inp.codeBytes, inp.tierSpec.id);
            if (reqTag && cachedTag && cachedSk && constantTimeEqual(reqTag, cachedTag)) {
                usedCache = true;
                sk = cachedSk;
            } else {
                zeroize(cachedTag); cachedTag = null;
                zeroize(cachedSk); cachedSk = null;
                salt = buildSalt(inp.codeBytes, inp.tierSpec.id);
                sk = argon2idSync({
                    password: inp.masterBytes,
                    salt: salt,
                    ad: DOMAIN_AD,
                    memoryKiB: inp.tierSpec.memoryKiB,
                    passes: inp.tierSpec.passes,
                    parallelism: inp.tierSpec.parallelism,
                    tagLength: 32
                });
                if (reqTag) {
                    cachedTag = reqTag; reqTag = null;
                    cachedSk = sk;
                }
            }
            return {
                password: synthesizePassword(sk, inp.codeBytes, inp.counter, inp.length, inp.mode),
                cached: usedCache
            };
        } finally {
            zeroize(inp.masterBytes); zeroize(inp.codeBytes);
            zeroize(reqTag); zeroize(salt);
            // 没有安全 nonce 时，派生密钥只用一次，不保留不可复用的“缓存”。
            if (sk !== cachedSk) zeroize(sk);
        }
    }

    if (workerGlobal && typeof workerGlobal.postMessage === 'function') {
        workerGlobal.onmessage = function (ev) {
            var data = ev.data || {};
            if (data.type === 'wipe') {
                wipeSession();
                workerGlobal.postMessage({ id: data.id, type: 'wiped' });
                return;
            }
            if (data.type === 'derive') {
                try {
                    var res = deriveSync(data);
                    workerGlobal.postMessage({ id: data.id, ok: true, password: res.password, cached: res.cached });
                } catch (err) {
                    workerGlobal.postMessage({ id: data.id, ok: false, error: err && err.message ? err.message : 'DERIVE_ERROR' });
                }
            }
        };
    }

    return {
        deriveSync: deriveSync,
        wipeSession: wipeSession
    };
}

if (typeof module === 'object' && module.exports) {
    module.exports = { spv2CoreFactory: spv2CoreFactory };
} else {
    root.spv2CoreFactory = spv2CoreFactory;
}
if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    spv2CoreFactory(root, false);
}
})(typeof self !== 'undefined' ? self : this);
