# 快速上手

---

## 前置要求

| 项目 | 要求 |
|------|------|
| Node.js | 18+（`node -v` 检查） |
| Chrome | 已安装 |
| Peach | 安装 **MetaMask**，专用 BNB 测试钱包 |
| Cetus | 安装 **Slush**（Sui 钱包），专用 SUI 测试钱包 |

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

## 3. 配置浏览器插件路径

Chrome 打开 `chrome://version/`，复制「个人资料路径」，进入其下的 `Extensions/` 目录，找到对应插件的**最新版本号文件夹**（路径末尾带 `_0`）。

### Peach — MetaMask

```
.../Extensions/nkbihfbeogaeaoehlefnkodbefgpgknn/<版本号>_0
```

→ 填入 `peach/.env` 的 `WALLET_EXTENSION_PATH`

### Cetus — Slush

```
.../Extensions/opcgpfmipidbgpenhmajoajpbobppdil/<版本号>_0
```

→ 填入 `cetus/.env` 的 `WALLET_EXTENSION_PATH`

> 两个项目各用独立 Profile（`peach/.playwright-wallet-profile`、`cetus/.playwright-wallet-profile`），互不影响。

#### Windows 路径示例

Windows 下「个人资料路径」通常为：

```
C:\Users\<用户名>\AppData\Local\Google\Chrome\User Data\Default
```

因此插件完整路径类似：

```
C:\Users\<用户名>\AppData\Local\Google\Chrome\User Data\Default\Extensions\nkbihfbeogaeaoehlefnkodbefgpgknn\<版本号>_0
```

填入 `.env` 时使用**反斜杠 `\`** 或**正斜杠 `/`** 均可，但路径中有空格时需用引号括起。

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
| `WALLET_EXTENSION_PATH` | MetaMask 扩展目录（见上） |
| `WALLET_PASSWORD` | MetaMask 解锁密码 |
| `WALLET_ADDRESS` | BNB 测试钱包地址 |
| `WALLET_SEED_PHRASE` | **仅首次**：导入钱包用，导入后可删 |

> `EXECUTE_SWAP` 默认 `false`（只验报价）。Dashboard 可切换「发送真实交易」。

### `cetus/.env`（Cetus / Sui 链）

| 变量 | 说明 |
|------|------|
| `WALLET_MODE` | 保持 `extension`（推荐） |
| `WALLET_EXTENSION_PATH` | Slush 扩展目录（见上） |
| `WALLET_PASSWORD` | Slush 解锁密码 |
| `TEST_WALLET_ADDRESS` | Sui 测试钱包地址（`0x` 开头） |

`WALLET_MODE=injected` 时可改用 `WALLET_PRIVATE_KEY`（无需装 Slush，适合 CI），本地调试建议用 extension。

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
npm run report:allure            # Allure 报告

# Cetus
cd cetus
npm run report:allure            # Allure 报告
```