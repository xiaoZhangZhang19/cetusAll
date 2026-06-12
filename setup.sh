#!/bin/bash
# QA Dashboard 自动安装脚本
# 使用方法：chmod +x setup.sh && ./setup.sh

set -e  # 遇到错误立即退出

echo "════════════════════════════════════════════════════════════"
echo "  QA Dashboard 自动安装脚本"
echo "════════════════════════════════════════════════════════════"
echo ""

# 检查 Node.js
echo "🔍 [1/6] 检查 Node.js..."
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

# 检查 Chrome
echo "🔍 [2/6] 检查 Chrome 浏览器..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    CHROME_PATH="/Applications/Google Chrome.app"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    CHROME_PATH="/usr/bin/google-chrome"
else
    CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
fi

if [ ! -e "$CHROME_PATH" ]; then
    echo "⚠️  未检测到 Chrome（跳过，稍后手动配置）"
else
    echo "✓ Chrome 已安装"
fi
echo ""

# 安装 Dashboard 依赖
echo "📦 [3/6] 安装 Dashboard 依赖..."
cd dashboard
npm install
npm run build
cd ..
echo "✓ Dashboard 依赖安装完成"
echo ""

# 安装 Peach 依赖
echo "📦 [4/6] 安装 Peach 测试依赖..."
cd peach
npm install
npx playwright install chromium
cd ..
echo "✓ Peach 依赖安装完成"
echo ""

# 安装 Cetus 依赖
echo "📦 [5/6] 安装 Cetus 测试依赖..."
cd cetus
npm install
echo "📥 安装 Cetus Playwright 浏览器..."
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 npx playwright install chromium --dry-run 2>/dev/null || true
npx playwright install chromium
cd ..
echo "✓ Cetus 依赖安装完成"
echo ""

# 创建配置文件
echo "⚙️  [6/6] 创建配置文件..."

if [ ! -f "peach/.env" ]; then
    cp peach/.env.example peach/.env
    echo "✓ 已创建 peach/.env（请手动编辑填写钱包信息）"
else
    echo "⚠️  peach/.env 已存在（跳过）"
fi

if [ ! -f "cetus/.env" ]; then
    cp cetus/.env.example cetus/.env
    echo "✓ 已创建 cetus/.env（请手动编辑填写钱包信息）"
else
    echo "⚠️  cetus/.env 已存在（跳过）"
fi

if [ ! -f "dashboard/.env" ]; then
    cp dashboard/.env.example dashboard/.env
    echo "✓ 已创建 dashboard/.env（请手动编辑填写钱包信息）"
else
    echo "⚠️  dashboard/.env 已存在（跳过）"
fi
echo ""

echo "════════════════════════════════════════════════════════════"
echo "  ✅ 安装完成！"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "📝 下一步操作："
echo ""
echo "  1. 配置 /peach/.env、/cetus/.env、/dashboard/.env 文件："
echo "     nano peach/.env"
echo "     nano cetus/.env"
echo "     nano dashboard/.env"
echo ""
echo "  2. 启动 Dashboard："
echo "     cd dashboard && npm run dev"
echo ""
echo "  3. 浏览器访问："
echo "     http://localhost:3000"
echo ""
echo "📖 详细文档请查看: SETUP.md"
echo "════════════════════════════════════════════════════════════"
