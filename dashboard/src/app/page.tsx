'use client';

import { useState } from 'react';
import { TEST_GROUPS, PEACH_GROUPS } from '@/lib/tests';
import TestCard from '@/components/TestCard';
import PeachSection from '@/components/PeachSection';
import CetusSwapRouteSection from '@/components/CetusSwapRouteSection';
import CetusVaultSection from '@/components/CetusVaultSection';
import CetusFlowSection from '@/components/CetusFlowSection';

// ── Project meta — all numbers derived from the single source of truth ────
const CETUS_MODULES = TEST_GROUPS.length;
const CETUS_CASES   = TEST_GROUPS.reduce((s, g) => s + g.tests.length, 0);
const PEACH_MODULES = PEACH_GROUPS.length;
const PEACH_CASES   = PEACH_GROUPS.reduce((s, g) => s + g.tests.length, 0);

const PROJECTS = [
  { id: 'cetus', name: 'Cetus DEX',       icon: '🔵', modules: CETUS_MODULES, cases: CETUS_CASES },
  { id: 'peach', name: 'Peach Protocol',  icon: '🍑', modules: PEACH_MODULES, cases: PEACH_CASES },
] as const;

const totalModules = PROJECTS.reduce((s, p) => s + p.modules, 0);
const totalCases   = PROJECTS.reduce((s, p) => s + p.cases,   0);

const DEFAULT_CETUS_URL = 'https://app.cetus.zone';

export default function Home() {
  const [cetusAppUrl,        setCetusAppUrl]        = useState(DEFAULT_CETUS_URL);
  const [cetusAppUrlApplied, setCetusAppUrlApplied] = useState(DEFAULT_CETUS_URL);

  const handleApplyCetusUrl = async () => {
    if (!cetusAppUrl.trim()) {
      alert('请输入有效的应用地址');
      return;
    }
    const confirmed = confirm(
      `应用新地址将会：\n` +
      `1. 设置测试地址为: ${cetusAppUrl}\n` +
      `2. 删除钱包配置文件夹 (.playwright-wallet-profile)\n` +
      `3. 下次测试时需要重新授权钱包\n\n` +
      `确定要应用吗？`
    );
    if (!confirmed) return;
    try {
      const res = await fetch('/api/wallet-profile', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'cetus' }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(`删除钱包配置失败: ${data.error || '未知错误'}`);
        return;
      }
      setCetusAppUrlApplied(cetusAppUrl);
      alert(`✓ 已应用新地址: ${cetusAppUrl}\n✓ 已删除钱包配置文件\n\n下次测试时会使用新地址并重新授权钱包`);
    } catch (err) {
      alert(`操作失败: ${err}`);
    }
  };

  return (
    <div className="min-h-screen px-4 py-8 sm:px-8">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="mx-auto mb-10 max-w-7xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          {/* Title */}
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">Dashboard</h1>
          </div>

          {/* Per-project stats */}
          <div className="flex flex-col gap-2 sm:items-end">
            {/* Total badge */}
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-400">
                {PROJECTS.length} 个项目
              </span>
              <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-400">
                {totalModules} 模块
              </span>
              <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-400">
                {totalCases} 用例
              </span>
            </div>
            {/* Per-project row */}
            <div className="flex flex-wrap gap-2">
              {PROJECTS.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs"
                >
                  <span>{p.id === 'cetus'
                    ? <img src="https://app.cetus.zone/favicon.ico" alt="Cetus" className="h-4 w-4 rounded-sm object-contain" />
                    : p.icon}</span>
                  <span className="font-medium text-slate-300">{p.name}</span>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-400">{p.modules} 模块</span>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-400">{p.cases} 用例</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">P0</span>
            核心功能
          </span>
          <span className="flex items-center gap-1.5">
            <span className="rounded bg-yellow-600 px-1.5 py-0.5 text-xs font-bold text-white">P1</span>
            重要功能
          </span>
          <span className="flex items-center gap-1.5">
            <span className="rounded bg-slate-600 px-1.5 py-0.5 text-xs font-bold text-slate-200">P2</span>
            边缘用例
          </span>
        </div>
      </header>

      {/* ── Cetus DEX ───────────────────────────────────────────────────── */}
      <main className="mx-auto max-w-7xl space-y-10">

        {/* Cetus project divider */}
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-slate-700" />
          <div className="flex items-center gap-2 rounded-full border border-slate-600 bg-slate-800 px-4 py-1.5">
            <img src="https://app.cetus.zone/favicon.ico" alt="Cetus" className="h-4 w-4 rounded-sm object-contain" />
            <span className="text-sm font-semibold text-slate-200">Cetus</span>
            <span className="text-xs text-slate-500">· {TEST_GROUPS.length} 模块 · {TEST_GROUPS.reduce((s, g) => s + g.tests.length, 0)} 用例</span>
          </div>
          <div className="h-px flex-1 bg-slate-700" />
        </div>

        {/* Cetus App URL Configuration */}
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
          <div className="flex-1">
            <label className="mb-2 block text-sm font-semibold text-slate-300">应用地址配置</label>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={cetusAppUrl}
                onChange={(e) => setCetusAppUrl(e.target.value)}
                placeholder="https://app.cetus.zone"
                className="flex-1 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-sky-500 transition"
              />
              <button
                onClick={handleApplyCetusUrl}
                className="shrink-0 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500"
              >
                应用
              </button>
            </div>
            <div className="mt-2 flex items-center gap-4 text-xs">
              <p className="text-slate-500">
                当前使用: <span className="text-sky-400 font-mono">{cetusAppUrlApplied}</span>
              </p>
              {cetusAppUrl !== cetusAppUrlApplied && (
                <span className="text-yellow-400">⚠ 配置已修改，点击"应用"生效</span>
              )}
            </div>
          </div>
        </div>

        {/* 串联执行：独立区块，可自由编排已有功能的执行顺序 */}
        <CetusFlowSection appUrl={cetusAppUrlApplied} />

        {TEST_GROUPS.map((group) => (
          <section key={group.id}>
            <div className={`mb-4 flex items-center gap-3 rounded-xl border ${group.borderColor} ${group.color} px-5 py-3`}>
              <span className="text-2xl">{group.icon}</span>
              <div>
                <h3 className="text-lg font-bold text-white">{group.name}</h3>
                <p className="text-xs text-slate-400">{group.tests.length} 个测试用例</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {/* vault 分组由 CetusVaultSection 全权渲染，跳过 TestCard */}
              {group.id !== 'vault' && group.tests.map((test) => (
                <TestCard key={test.id} test={test} appUrl={cetusAppUrlApplied} />
              ))}
              {/* 多路由兑换卡片内嵌在 Swap 兑换分组末尾，跨满全行 */}
              {group.id === 'swap' && (
                <div className="sm:col-span-2 lg:col-span-3 xl:col-span-4">
                  <CetusSwapRouteSection appUrl={cetusAppUrlApplied} />
                </div>
              )}
              {/* Vault 稳定池卡片内嵌在 vault 分组末尾 */}
              {group.id === 'vault' && <CetusVaultSection />}
            </div>
          </section>
        ))}
      </main>

      {/* ── Peach Protocol ──────────────────────────────────────────────── */}
      <div className="mx-auto mt-16 max-w-7xl">
        <PeachSection />
      </div>

      {/* ── Tools ───────────────────────────────────────────────────────── */}
      <div className="mx-auto mt-16 max-w-7xl">
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-slate-700" />
          <div className="flex items-center gap-2 rounded-full border border-slate-600 bg-slate-800 px-4 py-1.5">
            <span className="text-sm">🔧</span>
            <span className="text-sm font-semibold text-slate-200">Tools</span>
          </div>
          <div className="h-px flex-1 bg-slate-700" />
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <a
            href="/tools/grpc-parser"
            className="group flex flex-col gap-2 rounded-xl border border-slate-700 bg-slate-800/60 p-5 transition hover:border-sky-700 hover:bg-slate-800"
          >
            <div className="flex items-center gap-2">
              <span className="text-xl">📡</span>
              <span className="font-semibold text-slate-200">GRPC Parser</span>
            </div>
            <p className="text-xs text-slate-500 group-hover:text-slate-400">
              解析 application/grpc-web-text+proto 响应，提取 Protobuf 字段与嵌套消息。
              
            </p>
            <span className="mt-auto self-start rounded-full border border-slate-600 px-2 py-0.5 text-xs text-slate-500 group-hover:border-sky-700 group-hover:text-sky-400">
              打开工具 →
            </span>
          </a>
        </div>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="mx-auto mt-16 max-w-7xl border-t border-slate-800 pt-6 text-center text-xs text-slate-600">
        Dashboard · Cetus DEX + Peach Protocol · Powered by Playwright
      </footer>
    </div>
  );
}
