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
- **域分离盐**（长度按 UTF-8 字节数计算，不是 JS 字符串长度）：
  ```text
  C = UTF8(NFC(trim(code)))
  salt = SHA-256(ASCII("StarryPass-v2:salt") ‖ 0x00 ‖ LE32(|C|) ‖ C ‖ U8(tier_id))
  ```
  - `tier_id`：标准档为 1，极高档为 2。**切换档位会生成不同口令**：盐和 Argon2 成本参数都会变化；仅把 tier 移出盐并不能保持口令不变。
- **展开**：HKDF-SHA-256（RFC 5869）绑定轮换序号、长度、字符集与代号
- **口令合成**：常规路径为无偏拒绝采样，最多重试 128 次后沿用原有兜底构造；默认保证大小写 + 数字 + 符号各至少一枚。未把统计检验等同于全分布均匀性证明。
- **实现**：透明符号汇编的 WASM i64 压缩核 + 纯 JS 回退。首次派生时自检 RFC 9106 §5.3 的 Argon2id tag，以及 RFC 5869 TC1 的 PRK 前 8 字节；失败即拒绝派生。
- **敏感数据不持久化**：主密码和会话密钥仅驻留内存；静态资源缓存与主题偏好不包含这些敏感数据。
  - 会话密钥是单槽缓存，在后续有效派生更换主密码/代号/档位时替换，或由 `wipeSession()` 清理。没有可用 CSPRNG 时不保留缓存密钥。
  - 可控字节缓冲区尽最大努力清零（best-effort）；JS 字符串、消息克隆体与 GC/浏览器内部副本无法保证清除。整段 WASM arena 清零也**不等于归还内存容量**。

## 兼容性与边界

- 合法输入沿用 v2 派生协议；不修改盐、KDF 成本、HKDF、字符集和采样策略。UI 保留原有 **6 位 PIN**，切回 full/alnum 时恢复先前选择的长度。
- 旧 UI 状态错误可能曾生成 6 位 full 或 8 位 PIN；需按当时的实际参数通过核心 API 复现，修复版不再重现这些错误操作路径。
- 主密码做 NFC，不 trim、不截断；代号仅 trim + NFC，仍区分大小写。更改这些规则需要迁移方案。
- 强度提示仍是启发式主密码评分，只额外用 `实际长度 × log2(字符池大小)` 封顶；这是输出空间的理论上界，**不是实际熵或破解时间的保证**。未替换评估模型或调整其位置/文案。
- 复制功能不承诺定时清除系统剪贴板；浏览器权限、剪贴板历史和跨设备同步不受页面可靠控制，请在使用后自行清理。
- 离线缓存仅保存列明的应用资源。联网时重新验证 HTML 和核心脚本，失败时回退缓存；旧版 SW 需要先完成一次脚本更新，新策略才会生效。
- CSP 仅为纵深防御，不能抵御同源恶意脚本或页面被篡改。此修复不改变本项目的 PoC / 禁止生产使用定位。

## 测试

无需运行时第三方依赖的 Node 测试（CI 使用 Node 24）：

```bash
node tests/verify_spv2.js        # 已知答案与纯 JS 回退
node tests/verify_core.js        # 参数边界、真实引擎、缓存与异常清理
node tests/verify_parity.js      # 原版兼容向量 + WASM / 纯 JS 一致性
node tests/verify_strength.mjs   # 实际内联强度评估器
node tests/verify_sw.js          # 更新、离线兜底、缓存命名空间及 waitUntil 生命周期
```

浏览器回归（仅测试依赖；需 Python、OpenSSL 与 Chromium 所需系统库）：

```bash
python -m pip install playwright==1.64.1
python -m playwright install --with-deps chromium
python tests/verify_browser.py
```

测试在临时 HTTPS 站点运行，不修改仓库源文件；覆盖队列/超时/清空竞态、Worker 降级、CSP 下的 WASM、长主密码兼容、复制反馈及离线更新。
`.github/workflows/test.yml` 配置 PR、手动与可复用测试；Pages 工作流在全部检查通过后才部署。测试未构成正式安全认证。

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
