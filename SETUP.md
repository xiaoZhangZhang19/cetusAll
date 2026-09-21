# 快速上手

**一句话：装依赖 → 在 `.env` 里填测试钱包私钥 → 启动 Dashboard 点运行。**

不需要安装 MetaMask / Slush 等任何浏览器插件，也不需要解锁密码、扩展路径、持久化 Profile。

---

## 0. 钱包方式：注入式，只要私钥

两个项目都在页面加载前注入一个假钱包，签名和广播都在 Node 侧用私钥完成，私钥永远不进页面：

| 项目 | 链 | 注入的钱包名 | 用到的私钥变量 |
|------|-----|--------------|----------------|
| Cetus | Sui | `Suiet`（连接弹窗里显示） | `WALLET_PRIVATE_KEY` |
| Peach | BNB | `E2E Wallet` | `E2E_PRIVATE_KEY` |

因此：没有审批弹窗、换测试域名不用重新授权、`HEADLESS=true` 可以真正无头跑。

> ⚠️ 没有人工确认环节，主网上就是真钱。**只用专用测试钱包，只放最小必要金额。**

---

## 1. 前置要求

| 项目 | 要求 |
|------|------|
| Node.js | 18+（`node -v` 检查） |
| Chromium | 由 `npx playwright install chromium` 自动装，无需自己装 Chrome |
| Cetus 钱包 | 专用 Sui 测试钱包的地址 + 私钥（`suiprivkey1...`） |
| Peach 钱包 | 专用 BNB 测试钱包的私钥（`0x` + 64 位十六进制） |

---

## 2. 获取代码

```bash
git clone <你的仓库地址>
cd ceutsAll
```

后续更新：`git pull`

---

## 3. 安装依赖

### macOS / Linux — 一键脚本

```bash
chmod +x setup.sh
./setup.sh
```

脚本会安装 `dashboard` / `peach` / `cetus` 三处依赖、装 Playwright Chromium，并从 `.env.example` 生成 `.env`（已存在则跳过）。

### Windows — 手动三步

Windows 不能直接跑 `.sh`，在项目根目录的 PowerShell 里依次执行：

```powershell
cd dashboard; npm install; cd ..
cd peach;     npm install; npx playwright install chromium; cd ..
cd cetus;     npm install; npx playwright install chromium; cd ..
```

生成 `.env`（已存在会跳过）：

```powershell
if (!(Test-Path "cetus\.env"))    { Copy-Item "cetus\.env.example"     "cetus\.env" }
if (!(Test-Path "peach\.env"))    { Copy-Item "peach\.env.example"     "peach\.env" }
if (!(Test-Path "dashboard\.env")){ Copy-Item "dashboard\.env.example" "dashboard\.env" }
```

---

## 4. 填 `.env`（唯一的必做配置）

编辑：`nano cetus/.env` / `nano peach/.env`（Windows 用 `notepad` 或 VS Code 直接打开）。

### `cetus/.env` — 必填两项

| 变量 | 说明 |
|------|------|
| `TEST_WALLET_ADDRESS` | Sui 测试钱包地址（`0x` 开头） |
| `WALLET_PRIVATE_KEY` | 同一钱包的私钥（`suiprivkey1...` bech32） |

地址和私钥必须属于同一钱包，否则节点会报 `Required Signature ... is absent`。填完校验：

```bash
cd cetus && npm run check:wallet     # 校验私钥与地址匹配
cd cetus && npm run check:env        # 校验必填变量齐全
```

按需可调（都有默认值）：`APP_URL` 测试地址、`SUI_NETWORK` 网络、`HEADLESS` 是否显示浏览器、`WALLET_DRY_RUN=true` 只签名 dryRun 不上链。其余 Swap / Limit / CLMM / DLMM 参数见 `cetus/.env.example`。

### `peach/.env` — 必填一项

| 变量 | 说明 |
|------|------|
| `E2E_PRIVATE_KEY` | BNB 测试钱包私钥（`0x` + 64 位十六进制） |

`WALLET_ADDRESS` 留空会自动从私钥推导。`APP_URL` 的链前缀必须与 `E2E_CHAIN_ID` 一致（BSC `56` / ARC Testnet `5042002`），不一致时页面只显示 "Switch to ..." 连不上钱包。`EXECUTE_SWAP` 默认 `false` 只验报价，Dashboard 上的「发送真实交易」开关会覆盖它。

### `dashboard/.env` — 可选

只用于首页余额展示：`WALLET_ADDRESS`（Peach 钱包地址）+ `BSC_RPC_URL`。不填不影响跑测试。

---

## 5. 启动 Dashboard（主要入口）

```bash
cd dashboard
npm run dev
```

打开 **http://localhost:3000**：

1. 顶部「应用地址配置」可临时切换 Cetus 测试域名，点「应用」生效（不用重新授权钱包）
2. 选 Cetus 或 Peach 模块，配置参数（路由、代币数量等）
3. 点 **运行测试**，看每条用例的 ✅ / ❌
4. 需要细节点 **查看日志**

---

## 6. 命令行直跑（可选）

```bash
cd cetus
npm run test:e2e                 # 跑全部 e2e
npm run test:e2e:swap            # 单个用例（其它脚本名见 package.json）
npm run test:e2e:headed          # 显示浏览器
```

串联执行（把多个用例编排成一条流程）：

```bash
cd cetus
npm run flow -- list                       # 列出可编排功能及 id
npm run flow -- run-ids swap,limit-order    # 临时按顺序执行
npm run flow -- check --ids swap,farm-claim # 只做依赖检查，不执行
```

Peach：

```bash
cd peach
npm run test:e2e:swap:execute    # 多路由 swap
npm run test:e2e:limit           # 限价单
npm run test:e2e:terminal        # Top Token 报价验证
```

---

## 7. 常见问题

| 现象 | 原因 / 处理 |
|------|-------------|
| `Required Signature from 0x... is absent` | 地址与私钥不是同一钱包，跑 `npm run check:wallet` |
| Cetus 连接弹窗里找不到钱包 | 注入钱包名固定为 `Suiet`，不要改 `injected-controller.ts` 里的名字 |
| Peach header 显示 "Switch to ..." | `E2E_CHAIN_ID` 与 `APP_URL` 链前缀不一致 |
| 等回执一直卡住 | 换掉 publicnode 类 RPC，用 `https://bsc-dataseed.bnbchain.org` |
| 用例报交易没成功但设了 dryRun | `WALLET_DRY_RUN=true` 时交易不广播，依赖成功提示的用例会失败 |
| 余额相关用例失败 | 测试钱包资产不足，各用例的资产要求写在 Dashboard 卡片描述里 |

