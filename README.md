# StarryPass 星愿令 v2

**简体中文** | [English](README.en.md)

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

![image](https://raw.githubusercontent.com/lingyicute/StarryPassPoC/main/banner.jpg)

## 密码学

- **KDF**：Argon2id v1.3（RFC 9106）
  - 标准档：64 MiB / t=3 / p=4
  - 极高档：256 MiB / t=4 / p=4
- **域分离盐**（长度按 UTF-8 字节数计算，不是 JS 字符串长度）：
  ```text
  C = UTF8(NFC(trim(code)))
  salt = SHA-256(ASCII("StarryPass-v2:salt") ‖ 0x00 ‖ LE32(|C|) ‖ C ‖ U8(tier_id))
  ```
  - `tier_id`：标准档为 1，极高档为 2。**切换档位会生成不同口令**：盐和 Argon2 成本参数都会变化。
- **展开**：HKDF-SHA-256（RFC 5869）绑定轮换序号、长度、字符集与代号
- **口令合成**：采用无偏拒绝采样，最多重试 128 次后衔接确定性兜底构造；默认保证大小写 + 数字 + 符号各至少一枚。
- **实现**：透明符号汇编的 WASM i64 压缩核 + 纯 JS 回退。首次派生时自检 RFC 9106 §5.3 的 Argon2id tag，以及 RFC 5869 TC1 的 PRK 前 8 字节；失败即拒绝派生。运行期由 WASM 降级为纯 JS 时，会先对纯 JS 压缩核补做同一自检。
- **零持久化存储**：主密码和会话密钥仅驻留内存；静态资源缓存与主题偏好不包含任何敏感数据。
  - 会话密钥采用单槽缓存；命中判定使用以 CSPRNG 随机数为密钥的 HMAC 标签，缓存中不留存主密码。缓存密钥在后续有效派生更换主密码/代号/档位时自动替换，或由 `wipeSession()` 清理；无可用 CSPRNG 时不保留缓存密钥。
  - 受控敏感字节缓冲区与 WASM 线性内存工作区在使用后及异常路径下均通过 `finally` 覆写清零。

## 协议细节与运行机制

- **派生协议一致性**：严格遵循 v2 派生协议（盐、KDF 成本、HKDF、字符集和采样策略保持恒定）。UI 中 PIN 模式固定为 **6 位**，切回 full/alnum 时自动恢复先前选择的长度；核心 API 同时支持按显式长度参数直接调用。
- **输入规范化**：主密码执行 NFC 规范化（不 trim、不截断）；站点代号执行 trim + NFC 规范化，并严格区分大小写。
- **强度评估**：内置启发式主密码强度评分器，并结合输出空间的理论上界（`实际长度 × log2(字符池大小)`）进行封顶计算。
- **剪贴板与输入隐私**：仅响应用户显式复制操作，不自动读取剪贴板；主密码输入框启用 `autocomplete="off"`。
- **离线缓存策略**：Service Worker 仅预缓存受控应用资源；联网时重新验证 HTML 和核心脚本，失败时平滑回退本地缓存。
- **内容安全策略**：启用严格的 CSP 策略限制外部资源加载与未授权脚本执行，确保全部计算在本地闭环完成。

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
`.github/workflows/test.yml` 配置 PR、手动与可复用测试；Pages 工作流在全部检查通过后自动部署。

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
