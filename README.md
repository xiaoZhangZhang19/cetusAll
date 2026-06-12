# QA 自动化测试平台

统一的 QA Dashboard，整合 Cetus 和 Peach Protocol 的自动化测试。

## 🚀 快速开始（3 步上手）

### 第一步：获取代码

```bash
# Git Clone（推荐，方便同步更新）
git clone https://github.com/xiaoZhangZhang19/cetusAll.git
cd ceutsAll
```

### 第二步：一键安装

```bash
# 自动安装所有依赖并创建配置文件
./setup.sh
```

### 第三步：配置钱包并启动

```bash
# 1. 编辑配置文件，填入 cetus/.env peach/.env dashboard/.env 扩展路径和钱包信息
nano peach/.env

# 2. 启动 Dashboard
cd dashboard && npm run dev
```

浏览器访问：**http://localhost:3000**

---

## 📚 上手文档

配置说明、常见问题见：

👉 **[SETUP.md](./SETUP.md)** - 快速上手（5 步）

---

## 📁 项目结构

```
ceutsAll/
├── dashboard/          # 统一 QA Dashboard (Next.js)
│   ├── src/app/       # 页面路由
│   └── src/components/# UI 组件
│
├── peach/             # Peach Protocol 测试
│   ├── tests/e2e/     # E2E 测试用例
│   │   ├── swap-route-execution.spec.ts       # 多路由 Swap
│   │   └── terminal-token-swap.spec.ts        # Terminal 代币路由验证
│   └── src/
│       ├── page-objects/  # 页面对象（Swap/Terminal）
│       └── wallet/        # MetaMask 自动化控制器
│
└── cetus/             # Cetus Protocol 测试
    └── validation-suite/e2e/
        ├── swap*.spec.ts
        ├── limit*.spec.ts
        └── clmm*.spec.ts
```

---

## 🎯 测试模块

### Peach Protocol
- **Swap 兑换**：24 条流动性路由自动化测试（Uniswap、PancakeSwap、Thena...）
- **Terminal**：批量验证 Top N 代币的报价可用性

### Cetus Protocol
- **Swap**：基础兑换、滑点保护、路由选择
- **Limit Order**：限价单创建、取消、历史记录
- **CLMM/DLMM**：流动性开仓、加仓、移除、Zap

---

## 🔐 安全说明

- ⚠️ **使用专用测试钱包**，不要用个人主钱包
- 🔒 `.env` 文件不会被提交到 Git（已加入 .gitignore）
- 🔑 助记词配置完成后建议删除（依赖 `.playwright-wallet-profile` 持久化）

---

## 🔄 更新代码

```bash
# 拉取最新代码
git pull origin main

# 更新依赖
cd dashboard && npm install && cd ..
cd peach && npm install && cd ..
cd cetus && npm install && cd ..
```

---

**License**: MIT
