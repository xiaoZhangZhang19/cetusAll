import type { Metadata } from 'next';
import './globals.css';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ErrorFilter } from '@/components/ErrorFilter';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'One-click E2E test runner for Cetus DEX & Peach Protocol',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32', type: 'image/x-icon' },
      { url: '/favicon.png', sizes: '32x32', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    apple: '/favicon.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="dark">
      <body className="min-h-screen text-slate-100 antialiased">
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // 过滤浏览器扩展引起的错误 - 必须在任何其他脚本之前执行
              (function() {
                const originalConsoleError = console.error;
                console.error = function(...args) {
                  const errorStr = args.join(' ');
                  if (
                    errorStr.includes('chrome-extension://') ||
                    errorStr.includes('tronlinkParams') ||
                    errorStr.includes('injected.js') ||
                    errorStr.includes('trap returned falsish')
                  ) {
                    console.debug('[Filtered Console Error]:', errorStr.substring(0, 100));
                    return;
                  }
                  originalConsoleError.apply(console, args);
                };

                // 捕获全局错误
                window.addEventListener('error', function(event) {
                  const errorSource = (event.error?.stack || event.message || '').toString();
                  if (
                    errorSource.includes('chrome-extension://') ||
                    errorSource.includes('tronlinkParams') ||
                    errorSource.includes('injected.js') ||
                    errorSource.includes('trap returned falsish')
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    console.debug('[Filtered Error]:', event.message);
                    return false;
                  }
                }, true);

                // 捕获 Promise rejection
                window.addEventListener('unhandledrejection', function(event) {
                  const errorMessage = (event.reason?.message || event.reason || '').toString();
                  if (
                    errorMessage.includes('chrome-extension://') ||
                    errorMessage.includes('tronlinkParams') ||
                    errorMessage.includes('injected.js') ||
                    errorMessage.includes('trap returned falsish')
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    console.debug('[Filtered Rejection]:', errorMessage.substring(0, 100));
                    return false;
                  }
                }, true);

                // 拦截 Next.js 错误覆盖层
                if (typeof window !== 'undefined') {
                  const origDefineProperty = Object.defineProperty;
                  Object.defineProperty = function(obj, prop, descriptor) {
                    if (prop === '__NEXT_DATA__' || prop === 'next' || prop === '__nextDevTools') {
                      return origDefineProperty.call(Object, obj, prop, descriptor);
                    }
                    return origDefineProperty.call(Object, obj, prop, descriptor);
                  };
                }
              })();
            `,
          }}
        />
        <div className="aurora-blob-1" aria-hidden="true" />
        <div className="aurora-blob-2" aria-hidden="true" />
        <div className="aurora-blob-3" aria-hidden="true" />
        <ErrorFilter />
        <ErrorBoundary>
          <div className="aurora-content">{children}</div>
        </ErrorBoundary>
      </body>
    </html>
  );
}
