# StarryPass (星愿令) v2 — Proof of Concept

[简体中文](README.md) | **English**

## Made with love ❤️

> [!important]
> ⚠️ SECURITY NOTICE ⚠️
>
> This repository contains a hand-rolled implementation of the Argon2id algorithm. It was created as an intellectual exercise and a Proof of Concept (PoC) to understand how the algorithm works under the hood.
>
> DO NOT USE THIS IN PRODUCTION. It has not been audited and violates the golden rule of "don't roll your own crypto".
>
> 👉 For the production-ready version that uses standard, battle-tested cryptographic libraries, please visit: [StarryPass](https://github.com/lingyicute/StarryPass)

### A deterministic password manager that is simple, convenient and hard to crack

The same master password + a site code always produce the same high-entropy password, computed locally.

![image](https://raw.githubusercontent.com/lingyicute/StarryPassPoC/main/banner.jpg)

## Cryptography

- **KDF**: Argon2id v1.3 (RFC 9106)
  - standard tier: 64 MiB / t=3 / p=4
  - paranoid tier: 256 MiB / t=4 / p=4
- **Domain-separated salt** (the length counts UTF-8 bytes, not JavaScript string length):
  ```text
  C = UTF8(NFC(trim(code)))
  salt = SHA-256(ASCII("StarryPass-v2:salt") ‖ 0x00 ‖ LE32(|C|) ‖ C ‖ U8(tier_id))
  ```
  - `tier_id`: 1 for the standard tier, 2 for the paranoid tier. **Switching tier produces a different password**: both the salt and the Argon2 cost parameters change.
- **Expansion**: HKDF-SHA-256 (RFC 5869), binding the counter, length, character set and code.
- **Password synthesis**: unbiased rejection sampling with at most 128 retries, followed by a deterministic fallback construction; by default at least one upper-case letter, one lower-case letter, one digit and one symbol are guaranteed.
- **Implementation**: a WASM i64 compression kernel written in transparent symbolic assembly, plus a pure-JS fallback. On the first derivation it self-tests the RFC 9106 §5.3 Argon2id tag and the first 8 bytes of the RFC 5869 TC1 PRK; derivation is refused on failure. If a later derivation degrades from WASM to pure JS, the pure-JS kernel is self-tested before its result is used.
- **Zero persistent storage**: the master password and session key live only in memory; the static-asset cache and theme preference contain no sensitive data.
  - The session key uses a single-slot cache. A hit is decided by an HMAC tag keyed with a CSPRNG nonce, so the cache never stores the master password. The cached key is replaced automatically when a later successful derivation changes the master password / code / tier, or cleared by `wipeSession()`; when no CSPRNG is available, no session key is retained.
  - Controlled sensitive byte buffers and the WASM linear-memory workspace are overwritten with zeros in `finally` blocks after use and on error paths.

## Protocol details and runtime behaviour

- **Protocol consistency**: strictly follows the v2 derivation protocol (salt, KDF cost, HKDF, character sets and sampling policy are constant). In the UI, PIN mode is fixed at **6 digits** and the previously selected length is restored when you switch back to full/alnum; the core API also accepts explicit length parameters.
- **Input normalisation**: the master password is NFC-normalised (no trimming, no truncation); the site code is trimmed and NFC-normalised, and is strictly case-sensitive.
- **Strength estimation**: a built-in heuristic master-password scorer, capped by the theoretical upper bound of the output space (`actual length × log2(pool size)`).
- **Clipboard and input privacy**: only responds to an explicit user copy action and never reads the clipboard automatically; the master-password field uses `autocomplete="off"`.
- **Offline caching**: the Service Worker only precaches controlled application assets; when online it revalidates the HTML and core script, and falls back smoothly to the local cache on failure.
- **Content Security Policy**: a strict CSP restricts external resource loading and unauthorised script execution, so the whole computation stays local.

## Tests

Node tests with no third-party runtime dependencies (CI uses Node 24):

```bash
node tests/verify_spv2.js        # known answers and the pure-JS fallback
node tests/verify_core.js        # parameter bounds, the real engine, cache and error cleanup
node tests/verify_parity.js      # original-compatible vectors + WASM / pure-JS parity
node tests/verify_strength.mjs   # the actual inline strength estimator
node tests/verify_sw.js          # update, offline fallback, cache namespace and waitUntil lifetime
```

Browser regressions (test dependencies only; require Python, OpenSSL and the system libraries Chromium needs):

```bash
python -m pip install playwright==1.64.1
python -m playwright install --with-deps chromium
python tests/verify_browser.py
```

The tests run on a temporary HTTPS site and do not modify repository files; they cover queue/timeout/reset races, Worker degradation, WASM under CSP, long-master-password compatibility, copy feedback and offline updates.
`.github/workflows/test.yml` runs the tests for pull requests, manually, and as a reusable workflow; the Pages workflow deploys automatically once all checks pass.

## 🌟 See also

[Android version](https://github.com/lingyicute/StarryPassAndroid)

## 🗂️ License

StarryPass is released under the GNU Affero General Public License v3.0 (AGPLv3).

Copyright (C) 2024-2026 lingyicute.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see https://www.gnu.org/licenses.
