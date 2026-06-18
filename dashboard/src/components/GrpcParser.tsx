'use client';

import { useState, useCallback, useMemo } from 'react';
import {
  parseGrpcWebText,
  fieldsToJsonObject,
  type GrpcWebParseResult,
} from '@/lib/grpc-web-parser';

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: number | null }) {
  if (status === null)
    return <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-400">—</span>;
  const ok = status === 0;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
        ok ? 'bg-emerald-900 text-emerald-300' : 'bg-red-900 text-red-300'
      }`}
    >
      {ok ? `${status} OK` : `${status} ERR`}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="rounded px-2 py-0.5 text-xs text-slate-500 transition hover:bg-slate-700 hover:text-slate-300"
    >
      {copied ? '已复制' : '复制'}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON syntax highlighting
// ─────────────────────────────────────────────────────────────────────────────

function JsonView({ json }: { json: string }) {
  const highlighted = useMemo(() => {
    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^"\\])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'text-amber-300'; // number
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'text-sky-400' : 'text-emerald-300'; // key or string
        } else if (/true|false/.test(match)) {
          cls = 'text-violet-400';
        } else if (/null/.test(match)) {
          cls = 'text-slate-500';
        }
        return `<span class="${cls}">${match}</span>`;
      },
    );
  }, [json]);

  return (
    <pre
      className="max-h-[520px] overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-xs leading-relaxed whitespace-pre"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo data
// ─────────────────────────────────────────────────────────────────────────────

const DEMO_INPUT =
  'data:application/grpc-web-text+proto;base64,QUFBQUE1TUt5UU1TUWpCNE9XUTNPVGsxTjJObU1qRTRNbVZpWm1NMk1tWTRNRE5tTW1FMlpEazVZVFkzTVdObU9UTXdaV1ZtWkRneFpqaGlZekpsWlRCbU5EZGxNR0kwTXpZNVpCaTR4WlczQXlJc05uQmthMEkwZEcweWRuQlNjV1ZCTTJKSWNXUkdlWGRtYTFGaFpXUm9NWGxHZHpSbVFVUlRhWEZtTlcwcVJnZ0JFa0l3ZURjMU1XRmpPVE0yWW1GaE9HUTBaVEZpWmpoaU1ESTBNakF5TkdZNE4yUmlZMkkzTURGbFpEUTVNVFU1T1RjME5UVmlOamhpWlRWbFlqRmlOakZrTWpZeW9BRXdlREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREk2T21OdmFXNDZPa052YVc0OE1IZ3lPREl3WW1FMVlUTTBObVExTVdabE0yRTNZams1TXpJMFkyWXhNbVJtTUdNd1kyVTFOV1JqTkdNeE1tRmhNR0ZoTVdaaE5EZ3lNVGM0TUdReVpHUTNPanBvZFhOa1l6bzZTRlZUUkVNK29nWmpLbUVLRXdvSFltRnNZVzVqWlJJSUdnWTROamsyTlRjS1Nnb0NhV1FTUkJwQ01IZzVaRGM1T1RVM1kyWXlNVGd5WldKbVl6WXlaamd3TTJZeVlUWmtPVGxoTmpjeFkyWTVNekJsWldaa09ERm1PR0pqTW1WbE1HWTBOMlV3WWpRek5qbGtDc1FERWtJd2VETXpNRFptTTJJME16ZG1Oek5rT0dWaU1UYzROemM1TURSaE1qVmpaalU0TkRaaE56YzNNMkkzTmpZNE1UbGhNalk0TURjeU1tWXlNakJqTjJNelpEVVl0TGVWdHdNaUxESjZXVUZMZWtSUmIxVkdZbWRYYUhGeldVMUtOMDU2Y2xaemVURlpaWGQwU0dWaWJYcHViMHBtYjJGUktrWUlBUkpDTUhnM05URmhZemt6Tm1KaFlUaGtOR1V4WW1ZNFlqQXlOREl3TWpSbU9EZGtZbU5pTnpBeFpXUTBPVEUxT1RrM05EVTFZalk0WW1VMVpXSXhZall4WkRJMk1xQUJNSGd3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF5T2pwamIybHVPanBEYjJsdVBEQjRNamd5TUdKaE5XRXpORFprTlRGbVpUTmhOMkk1T1RNeU5HTm1NVEprWmpCak1HTmxOVFZrWXpSak1USmhZVEJoWVRGbVlUUTRNakUzT0RCa01tUmtOem82YUhWelpHTTZPa2hWVTBSRFBxSUdYaXBjQ2c0S0IySmhiR0Z1WTJVU0F4b0JNUXBLQ2dKcFpCSkVHa0l3ZURNek1EWm1NMkkwTXpkbU56TmtPR1ZpTVRjNE56YzVNRFJoTWpWalpqVTRORFpoTnpjM00ySTNOalk0TVRsaE1qWTRNRGN5TW1ZeU1qQmpOMk16WkRVPWdBQUFBQTluY25CakxYTjBZWFIxY3pvd0RRbz0=';

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function GrpcParser() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<GrpcWebParseResult | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [fieldsJson, setFieldsJson] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'fields' | 'hex' | 'trailers'>('fields');

  const handleParse = useCallback(
    (value?: string) => {
      const src = (value ?? input).trim();
      if (!src) return;
      setError(null);
      try {
        const parsed = parseGrpcWebText(src);
        const json = fieldsToJsonObject(parsed.protobufRaw);
        setResult(parsed);
        setFieldsJson(json);
        setActiveTab('fields');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setResult(null);
        setFieldsJson(null);
      }
    },
    [input],
  );

  const handleDemo = useCallback(() => {
    setInput(DEMO_INPUT);
    handleParse(DEMO_INPUT);
  }, [handleParse]);

  const handleClear = useCallback(() => {
    setInput('');
    setResult(null);
    setFieldsJson(null);
    setError(null);
  }, []);

  const fieldsJsonStr = useMemo(
    () => (fieldsJson ? JSON.stringify(fieldsJson, null, 2) : ''),
    [fieldsJson],
  );

  return (
    <div className="flex flex-col gap-6">
      {/* ── Input area ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
        <div className="mb-2 flex items-center justify-between">
          <label className="text-xs font-semibold text-slate-400">
            粘贴 gRPC-Web 响应（支持 data: URI 或纯 base64）
          </label>
          <div className="flex gap-2">
            <button
              onClick={handleDemo}
              className="rounded-lg border border-slate-600 px-3 py-1 text-xs text-slate-400 transition hover:border-sky-600 hover:text-sky-400"
            >
              载入示例
            </button>
            <button
              onClick={handleClear}
              className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-500 transition hover:border-red-800 hover:text-red-400"
            >
              清空
            </button>
          </div>
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="data:application/grpc-web-text+proto;base64,AAAA..."
          rows={5}
          className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-sky-700"
          spellCheck={false}
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-slate-600">
            {input.length > 0 ? `${input.length} 字符` : ''}
          </span>
          <button
            onClick={() => handleParse()}
            disabled={!input.trim()}
            className="rounded-lg bg-sky-700 px-5 py-1.5 text-sm font-semibold text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            解析
          </button>
        </div>
      </div>

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {error && (
        <div className="rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── Result ────────────────────────────────────────────────────────── */}
      {result && (
        <div className="flex flex-col gap-4">
          {/* Summary row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3">
              <p className="mb-1 text-xs text-slate-500">gRPC Status</p>
              <StatusBadge status={result.grpcStatus} />
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3">
              <p className="mb-1 text-xs text-slate-500">Data Flags</p>
              <span className="font-mono text-sm text-sky-400">{result.dataFlags}</span>
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3">
              <p className="mb-1 text-xs text-slate-500">Protobuf 大小</p>
              <span className="font-mono text-sm text-slate-200">
                {result.protobufRaw.length} 字节
              </span>
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3">
              <p className="mb-1 text-xs text-slate-500">顶层字段数</p>
              <span className="font-mono text-sm text-slate-200">
                {Object.keys(result.fields).length}
              </span>
            </div>
          </div>

          {/* Tabs */}
          <div className="rounded-xl border border-slate-700 bg-slate-900/60">
            {/* Tab bar */}
            <div className="flex border-b border-slate-700">
              {(['fields', 'hex', 'trailers'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2.5 text-sm font-medium transition ${
                    activeTab === tab
                      ? 'border-b-2 border-sky-500 text-sky-400'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {tab === 'fields' ? 'Protobuf 字段' : tab === 'hex' ? 'Hex 数据' : 'Trailers'}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="p-4">
              {activeTab === 'fields' && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs text-slate-500">
                      递归解析结果（嵌套消息已展开）
                    </span>
                    <CopyButton text={fieldsJsonStr} />
                  </div>
                  {fieldsJsonStr ? (
                    <JsonView json={fieldsJsonStr} />
                  ) : (
                    <p className="text-sm text-slate-500">未解析出字段</p>
                  )}
                </div>
              )}

              {activeTab === 'hex' && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs text-slate-500">
                      Protobuf payload（{result.protobufRaw.length} 字节）
                    </span>
                    <CopyButton text={result.protobufHex} />
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-300 break-all whitespace-pre-wrap">
                    {result.protobufHex}
                  </pre>
                </div>
              )}

              {activeTab === 'trailers' && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs text-slate-500">Trailer 帧内容</span>
                    <CopyButton text={result.trailers} />
                  </div>
                  <pre className="rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-300 whitespace-pre-wrap">
                    {result.trailers}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
