import { NextResponse } from 'next/server';

/**
 * 已废弃：清除浏览器扩展钱包 Profile 的接口。
 *
 * 这个接口只对「用真实浏览器扩展驱动钱包」的项目有意义 —— 扩展模式下 dApp
 * 的连接授权按域名存在 profile 目录里，换测试地址必须清 profile 重新授权。
 *
 * 现在 peach 和 cetus 都改成了注入式钱包：
 *   - peach：页面加载前注入 EIP-1193 / EIP-6963 provider（"E2E Wallet"）
 *   - cetus：页面加载前注入符合 Sui Wallet Standard 的钱包（显示为 "Suiet"）
 * 签名都在 Node 侧用私钥完成，没有扩展、没有 profile 目录、也没有按域名的
 * 授权状态。切换测试地址只需要改 APP_URL。
 *
 * 保留这个 404 而不是直接删文件：万一还有老页面缓存着调用，明确报错比静默
 * 删目录安全。
 */
export async function DELETE() {
  return NextResponse.json(
    {
      error:
        'peach 与 cetus 均已改用注入式钱包（无浏览器扩展、无持久化 profile），' +
        '不存在需要清除的钱包配置目录。切换测试地址只需修改 APP_URL。',
    },
    { status: 410 },
  );
}
