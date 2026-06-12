'use client';

import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    // 检查是否为浏览器扩展错误
    const errorString = error.toString() + (error.stack || '');
    if (
      errorString.includes('chrome-extension://') ||
      errorString.includes('tronlinkParams') ||
      errorString.includes('injected.js')
    ) {
      console.debug('[ErrorBoundary] Filtered extension error:', error.message);
      return { hasError: false }; // 不显示错误
    }
    
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // 过滤浏览器扩展错误
    const errorString = error.toString() + (error.stack || '');
    if (
      errorString.includes('chrome-extension://') ||
      errorString.includes('tronlinkParams') ||
      errorString.includes('injected.js')
    ) {
      console.debug('[ErrorBoundary] Caught and filtered extension error');
      this.setState({ hasError: false });
      return;
    }

    console.error('Uncaught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#0a0a0f]">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-red-500 mb-4">页面出现错误</h2>
            <button
              onClick={() => this.setState({ hasError: false })}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              重试
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
