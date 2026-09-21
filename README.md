# QA 自动化测试平台

统一的 QA Dashboard，整合 Cetus（Sui 链）和 Peach Protocol（BNB 链）的自动化测试。

**无需任何浏览器钱包插件** —— 测试用注入式钱包，在 `.env` 里填测试钱包私钥即可跑真实链上交易。

## 🚀 快速开始（3 步）

```bash
# 1. 获取代码
git clone https://github.com/xiaoZhangZhang19/cetusAll.git
cd ceutsAll

# 2. 一键安装（依赖 + Playwright Chromium + 生成 .env）
chmod +x setup.sh && ./setup.sh

# 3. 填私钥
nano cetus/.env     # TEST_WALLET_ADDRESS + WALLET_PRIVATE_KEY
nano peach/.env     # E2E_PRIVATE_KEY
```

启动：

```bash
cd cetus && npm run check:wallet && cd ..   # 校验私钥与地址匹配（推荐）
cd dashboard && npm run dev
```

浏览器访问 **http://localhost:3000**，选模块 → 配参数 → 点「运行测试」。

Windows 用户 / 详细配置说明 👉 **[SETUP.md](./SETUP.md)**

---

## 🔑 钱包机制（重点）

| 项目 | 链 | 注入钱包名 | 私钥变量 |
|------|-----|-----------|----------|
| Cetus | Sui | `Suiet` | `WALLET_PRIVATE_KEY`（`suiprivkey1...`） |
| Peach | BNB | `E2E Wallet` | `E2E_PRIVATE_KEY`（`0x` + 64 位十六进制） |

页面加载前注入符合标准的 provider（Sui Wallet Standard / EIP-1193），dApp 的签名请求桥接到 Node 侧用私钥签名。

带来的差异：

- 不装插件、没有解锁密码、没有审批弹窗
- 换测试域名不用重新授权，也没有持久化 Profile 要清
- `HEADLESS=true` 可以真正无头运行

---

## 📁 项目结构

```
ceutsAll/
├── setup.sh            # 一键安装脚本
├── dashboard/          # 统一 QA Dashboard (Next.js)
│   └── src/
│       ├── app/api/    # 触发测试 / 读日志 / 串联执行接口
│       ├── components/ # Cetus / Peach 各模块面板
│       └── lib/tests.ts# 用例清单（单一数据源）
│
├── cetus/              # Cetus 测试（Sui）
│   ├── src/
│   │   ├── page-objects/  # 各页面对象
│   │   ├── wallet/        # 注入式 Sui 钱包
│   │   └── chain/         # 链上余额 / 断言
│   └── validation-suite/
│       ├── e2e/           # 用例（swap / limit / dca / clmm / dlmm / farm / margin / vault / deepbook）
│       └── orchestrator/  # 串联执行（flow）
│
└── peach/              # Peach 测试（BNB）
    ├── src/wallet/     # 注入式 EIP-1193 钱包 + ethers 签名
    └── tests/e2e/      # swap / limit / terminal 用例
```

---

## 🎯 测试模块

**Cetus（Sui）**：Swap 兑换、Limit 限价单、DCA 定投、CLMM / DLMM 流动性（开仓/加仓/移除/Zap/领奖/建池）、Margin 杠杆、Farm 质押、Vault 金库、DeepBook。支持多路由兑换与「串联执行」按依赖顺序编排流程。

**Peach（BNB）**：多路由 Swap（Uniswap / PancakeSwap / Thena 等 24+ 路由）、Limit 限价单（价格保护、方向判定、模式联动）、Terminal Top-N 代币报价验证。

---

## 🔐 安全说明

- ⚠️ **只用专用测试钱包**，不要用个人主钱包
- ⚠️ 注入式钱包没有审批弹窗，会直接广播交易 —— 测试钱包只放最小必要金额
- 🔑 私钥只存在 `.env`，由 Node 侧签名，不会传到页面或 Dashboard
- 🔒 `.env` 已在 `.gitignore` 中，不会被提交
- 🧪 只想验证交易有效性：Cetus 设 `WALLET_DRY_RUN=true`（只签名 + dryRun），Peach 设 `EXECUTE_SWAP=false`（只验报价）

---

## 🔄 更新代码

```bash
git pull origin main
cd dashboard && npm install && cd ..
cd peach     && npm install && cd ..
cd cetus     && npm install && cd ..
```

---

**License**: MIT

