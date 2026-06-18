import GrpcParser from '@/components/GrpcParser';

export const metadata = {
  title: 'GRPC Parser · Tools',
  description: '解析 application/grpc-web-text+proto 响应，提取 Protobuf 字段',
};

export default function GrpcParserPage() {
  return (
    <div className="min-h-screen px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <header className="mb-8">
          <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
            <a href="/" className="transition hover:text-slate-300">
              Dashboard
            </a>
            <span>/</span>
            <span>Tools</span>
            <span>/</span>
            <span className="text-slate-300">GRPC Parser</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">GRPC Parser</h1>
          <p className="mt-1 text-sm text-slate-400">
            解析{' '}
            <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-sky-400">
              application/grpc-web-text+proto
            </code>{' '}
            响应，支持双层 base64 解码、Protobuf 字段提取与嵌套消息展开。<br></br>
            找到对应接口-》右键-》Copy-》Copy Response 获取响应内容，粘贴到输入框中。
          </p>

          {/* Protocol notes */}
          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/40 px-4 py-3 text-xs text-slate-500">
            <p className="mb-1 font-semibold text-slate-400">响应格式说明</p>
            <pre className="leading-relaxed">
              {`原始 base64 字符串
  └─ base64 解码 → ASCII 文本（两段 base64 拼接）
       ├─ 数据帧 b64  → [5 字节帧头 (flags=0x00)] + [Protobuf payload]
       └─ Trailer b64 → [5 字节帧头 (flags=0x80)] + [grpc-status:0\\r\\n...]`}
            </pre>
          </div>
        </header>

        {/* Main tool */}
        <GrpcParser />

        {/* Footer */}
        <footer className="mt-10 border-t border-slate-800 pt-4 text-center text-xs text-slate-700">
          GRPC Parser · Dashboard Tools
        </footer>
      </div>
    </div>
  );
}
