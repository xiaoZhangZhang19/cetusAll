#!/bin/bash
# QA Dashboard 自动安装脚本
# 使用方法：chmod +x setup.sh && ./setup.sh
#
# 说明：项目已改用注入式钱包（私钥签名），不需要安装任何浏览器扩展，
#      只需要 Node.js 18+ 和 Playwright 自带的 Chromium。

set -e  # 遇到错误立即退出

echo "════════════════════════════════════════════════════════════"
echo "  QA Dashboard 自动安装脚本"
echo "════════════════════════════════════════════════════════════"
echo ""

# ── [1/5] 检查 Node.js ───────────────────────────────────────
echo "🔍 [1/5] 检查 Node.js..."
if ! command -v node &> /dev/null; then
    echo "❌ 未安装 Node.js"
    echo "   请先安装 Node.js 18+ : https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 版本过低（当前: v$NODE_VERSION）"
    echo "   需要 v18 或更高版本"
    exit 1
fi

echo "✓ Node.js $(node -v) 已安装"
echo ""

# ── [2/5] Dashboard ──────────────────────────────────────────
echo "📦 [2/5] 安装 Dashboard 依赖..."
cd dashboard
npm install
cd ..
echo "✓ Dashboard 依赖安装完成"
echo ""

# ── [3/5] Peach（BNB 链）─────────────────────────────────────
echo "📦 [3/5] 安装 Peach 测试依赖 + Chromium..."
cd peach
npm install
npx playwright install chromium
cd ..
echo "✓ Peach 依赖安装完成"
echo ""

# ── [4/5] Cetus（Sui 链）────────────────────────────────────
echo "📦 [4/5] 安装 Cetus 测试依赖 + Chromium..."
cd cetus
npm install
npx playwright install chromium
cd ..
echo "✓ Cetus 依赖安装完成"
echo ""

# ── [5/5] 配置文件 ───────────────────────────────────────────
echo "⚙️  [5/5] 创建配置文件..."

for d in peach cetus dashboard; do
    if [ ! -f "$d/.env" ]; then
        cp "$d/.env.example" "$d/.env"
        echo "✓ 已创建 $d/.env"
    else
        echo "⚠️  $d/.env 已存在（跳过）"
    fi
done
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  ✅ 安装完成！"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "📝 下一步（只需填私钥，无需浏览器插件）："
echo ""
echo "  1. 填 Cetus（Sui）钱包："
echo "     nano cetus/.env        # TEST_WALLET_ADDRESS + WALLET_PRIVATE_KEY"
echo "     cd cetus && npm run check:wallet && cd ..   # 校验地址与私钥是否匹配"
echo ""
echo "  2. 填 Peach（BNB）钱包："
echo "     nano peach/.env        # E2E_PRIVATE_KEY"
echo ""
echo "  3. （可选）Dashboard 余额展示："
echo "     nano dashboard/.env    # WALLET_ADDRESS（Peach 钱包地址）"
echo ""
echo "  4. 启动 Dashboard："
echo "     cd dashboard && npm run dev"
echo "     浏览器访问 http://localhost:3000"
echo ""
echo "📖 详细文档请查看: SETUP.md"
echo "════════════════════════════════════════════════════════════"
