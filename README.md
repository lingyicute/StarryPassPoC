# StarryPass 星愿令 v2

## Made with love ❤️

> [!important]
> ⚠️ SECURITY NOTICE  ⚠️
>
> This repository contains a hand-rolled implementation of the Argon2id algorithm. It was created as an intellectual exercise and a Proof of Concept (PoC) to understand how the algorithm works under the hood.
>
> DO NOT USE THIS IN PRODUCTION. It has not been audited and violates the golden rule of "don't roll your own crypto".
>
> 👉 For the production-ready version that uses standard, battle-tested cryptographic libraries, please visit: [StarryPass](https://github.com/lingyicute/StarryPass)

### 简单方便防破解，不一样的密码管理工具

同一主密码 + 站点代号，本地确定性生成高熵密码。

![image](https://raw.githubusercontent.com/lingyicute/StarryPassAndroidWeb/master/banner.jpg)

## 密码学

- **KDF**：Argon2id v1.3（RFC 9106）
  - 标准档：64 MiB / t=3 / p=4
  - 极高档：256 MiB / t=4 / p=4
- **域分离盐**：`SHA-256("StarryPass-v2:salt" ‖ len(code) ‖ NFC(code) ‖ tier_id)`
- **展开**：HKDF-SHA-256（RFC 5869）绑定轮换序号、长度、字符集与代号
- **口令合成**：无偏拒绝采样；默认保证大小写 + 数字 + 符号各至少一枚
- **实现**：透明符号汇编的 WASM i64 压缩核 + 纯 JS 回退；启动时跑 RFC 9106 / RFC 5869 KAT
- **零存储**：主密码与会话密钥仅驻留内存，离开页面即清零

离线自检：

```bash
node tests/verify_spv2.js
node tests/verify_strength.mjs
```

## 🌟 另请参阅

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
