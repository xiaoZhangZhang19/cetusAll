'use client';

import { useEffect } from 'react';

export function ErrorFilter() {
  useEffect(() => {
    // 隐藏 Next.js 开发模式的错误提示框
    const hideNextErrorOverlay = () => {
      const style = document.createElement('style');
      style.id = 'hide-extension-errors';
      style.textContent = `
        /* 隐藏 Next.js 错误覆盖层中的扩展错误 */
        [data-nextjs-dialog-overlay],
        [data-nextjs-toast],
        nextjs-portal {
          display: none !important;
        }
        
        /* 隐藏左下角的错误提示 */
        button[data-nextjs-errors] {
          display: none !important;
        }
      `;
      
      if (!document.getElementById('hide-extension-errors')) {
        document.head.appendChild(style);
      }

      // 监听并移除错误提示元素
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              // 检查是否包含扩展相关错误
              const text = node.textContent || '';
              if (
                text.includes('chrome-extension://') ||
                text.includes('tronlinkParams') ||
                text.includes('injected.js') ||
                text.includes('trap returned falsish')
              ) {
                // 移除包含扩展错误的元素
                const overlay = node.closest('[data-nextjs-dialog-overlay]') ||
                                node.closest('[data-nextjs-toast]') ||
                                node.closest('nextjs-portal');
                if (overlay) {
                  overlay.remove();
                }
                
                const errorButton = document.querySelector('button[data-nextjs-errors]');
                if (errorButton) {
                  errorButton.remove();
                }
              }
            }
          });
        });
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      return () => observer.disconnect();
    };

    const cleanup = hideNextErrorOverlay();
    
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  return null;
}
