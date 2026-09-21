# 快速上手

---

## 前置要求

| 项目 | 要求 |
|------|------|
| Node.js | 18+（`node -v` 检查） |
| Chrome | 已安装 |
| Peach | 专用 BNB 测试钱包（注入式，无需装插件） |
| Cetus | 专用 SUI 测试钱包私钥（注入式，无需装插件） |

---

## 1. 获取代码

```bash
git clone <你的仓库地址>
cd ceutsAll
```

后续更新：`git pull`

---

## 2. 安装依赖

### macOS / Linux — 一键脚本

```bash
chmod +x setup.sh
./setup.sh
```

脚本会自动：安装 `dashboard` / `peach` / `cetus` 依赖、安装 Playwright Chromium、从 `.env.example` 生成 `.env`。

---

### Windows — 手动安装

Windows 不支持直接运行 `.sh` 脚本，请按以下步骤逐一完成。

**① 安装 Dashboard 依赖**

```powershell
cd dashboard
npm install
npm run build
cd ..
```

**② 安装 Peach 依赖 + Playwright**

```powershell
cd peach
npm install
npx playwright install chromium
cd ..
```

**③ 安装 Cetus 依赖 + Playwright**

```powershell
cd cetus
npm install
npx playwright install chromium
cd ..
```

**④ 生成 `.env` 配置文件**

在项目根目录下的 PowerShell 中执行（若文件已存在会跳过）：

```powershell
if (!(Test-Path "peach\.env"))    { Copy-Item "peach\.env.example"      "peach\.env" }
if (!(Test-Path "cetus\.env"))    { Copy-Item "cetus\.env.example"       "cetus\.env" }
if (!(Test-Path "dashboard\.env")){ Copy-Item "dashboard\.env.example"   "dashboard\.env" }
```

也可以直接在文件管理器里复制并重命名这三个 `.env.example` 文件。

---

## 3. 钱包方式：注入式，无需浏览器插件

两个项目都已改用注入式钱包，不再需要安装 MetaMask / Slush，也不需要配置扩展路径或持久化 Profile：

- **Peach**：页面加载前注入 EIP-1193 / EIP-6963 provider（显示为 `E2E Wallet`），签名与广播由 Node 侧 ethers 用 `E2E_PRIVATE_KEY` 完成。
- **Cetus**：页面加载前注入符合 Sui Wallet Standard 的钱包（在连接弹窗里显示为 `Suiet`），签名由 Node 侧用 `WALLET_PRIVATE_KEY` 完成。

因此没有解锁密码、没有审批弹窗，换测试域名也不需要重新授权。`HEADLESS=true` 可以真正无头运行。

> 只需要准备好**专用测试钱包的私钥**，填进各自的 `.env` 即可。

---

## 4. 填写 `.env`

**macOS / Linux**

```bash
nano peach/.env
nano cetus/.env
```

**Windows** — 用记事本或 VS Code 打开编辑：

```powershell
notepad peach\.env
notepad cetus\.env
```

或直接在 VS Code 中点击文件打开。

### `peach/.env`（Peach / BNB 链）

| 变量 | 说明 |
|------|------|
| `APP_URL` | 测试目标地址，链前缀需与 `E2E_CHAIN_ID` 一致 |
| `E2E_PRIVATE_KEY` | BNB 测试钱包私钥（`0x` + 64 位十六进制） |
| `E2E_RPC_URL` | RPC 节点，读链 / 估 gas / 广播 / 查回执共用 |
| `E2E_CHAIN_ID` | 链 ID：BSC `56`、ARC Testnet `5042002` |

> `EXECUTE_SWAP` 默认 `false`（只验报价）。Dashboard 可切换「发送真实交易」。

### `cetus/.env`（Cetus / Sui 链）

| 变量 | 说明 |
|------|------|
| `APP_URL` | 测试目标地址，需与 `SUI_NETWORK` 对应的网络一致 |
| `SUI_NETWORK` | `mainnet` / `testnet` / `devnet` / `localnet` |
| `TEST_WALLET_ADDRESS` | Sui 测试钱包地址（`0x` 开头） |
| `WALLET_PRIVATE_KEY` | 同一钱包的私钥（`suiprivkey1...` bech32 格式） |

地址与私钥必须属于同一个钱包，否则节点会拒绝交易。校验命令：`cd cetus && npm run check:wallet`。

> `WALLET_DRY_RUN=true` 只签名 + dryRun，不广播上链，适合验证前端构建的 PTB。

其余 Swap / Limit / CLMM 等参数有默认值，一般无需改；详见 `cetus/.env.example`。

---

## 5. 启动 Dashboard

```bash
cd dashboard
npm run dev
```

浏览器打开：**http://localhost:3000**

1. 选 Peach / Cetus 模块  
2. 配置参数（路由、代币数量等）  
3. 点 **运行测试**，看每条用例的 ✅ / ❌ 状态  
4. 需要细节时点 **查看日志**

---

## 常用命令（命令行直跑，可选）

```bash
# Peach
cd peach
npm run report:e2e               # Playwright HTML 报告

# Cetus
cd cetus
npm run report:e2e               # Playwright HTML 报告
```