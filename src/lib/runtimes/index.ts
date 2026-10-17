/**
 * 运行时注册表 —— **加一种运行时只改这个文件的 RUNTIMES 一行**（外加 runtimes/ 下它自己的适配器文件；清单见
 * docs/runtimes/adding-a-runtime.md）。走 ACP 的运行时在那一行挂 acp（runtimes/contract.ts AcpRuntimeSpec）。
 *
 * 调用方一律经这里拿适配器，不要再写 `if (runtime === "xxx")`（guard 的 pattern:runtime-literal 拦新增）：
 *   - 按 id 拿：`sourceFor(runtime)`；按路径认：`sourceForPath(path)`；全部：`allSources()`
 *   - 要启动 / 退出它：`managedFor(runtime, transport)` / `requireManaged(runtime, transport)`
 *   - bridge 侧策略（打断键、是否抢占、忙闲来源）：`controlFor(runtime, transport)`；能走哪些 transport：`transportsOf(runtime)`
 *   - ACP 段：`acpSpecFor(runtime)`（就绪闸 / 按 agent 拦 / 目录探测）、`acpHostFor(id)`（宿主描述）、`checkAcpReadyFor`
 */
import { closeSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import type { AcpReady, AcpReadyDeps } from "../acp/readiness.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { CODEX_ACP } from "./codex-acp.js";
import type { AcpHostRuntime, AcpRuntimeSpec } from "./contract.js";
import { opencodeAcpAdapter, OPENCODE_ACP } from "./opencode-acp.js";
import { piAdapter } from "./pi.js";
import { PI_ACP } from "./pi-acp.js";
import {
  DEFAULT_TRANSPORT, isManaged, normalizeTransport, type ManagedRuntimeAdapter, type RuntimeControl, type RuntimeEntry, type SessionSourceAdapter, type Transport,
} from "./types.js";

export * from "./types.js";
export { claudeCodeAdapter, codexAdapter, piAdapter };

/** 顺序有意义：sourceForPath 按这个顺序问「这条路径是不是你的」 */
const RUNTIMES: RuntimeEntry[] = [
  { source: piAdapter, acp: PI_ACP },
  { source: codexAdapter, acp: CODEX_ACP },
  { source: opencodeAcpAdapter, acp: OPENCODE_ACP },
  { source: claudeCodeAdapter },
];

export const DEFAULT_RUNTIME = "claude-code";

const entryOf = (runtime: string | undefined | null): RuntimeEntry | undefined => (runtime ? RUNTIMES.find((e) => e.source.id === runtime) : undefined);
/** 只有 ACP 版（source 就是 ACP 版适配器，或是只读来源）：transport 没得选 */
const acpOnly = (e: RuntimeEntry | undefined) => !!e?.acp && (e.source === e.acp.managed || !isManaged(e.source));

/** 只给测试：临时登记一个运行时（假运行时证明契约够用，tests/runtime-contract-fake.test.ts），返回撤销函数 */
export function registerRuntimeForTest(entry: RuntimeEntry): () => void {
  RUNTIMES.unshift(entry);
  return () => void RUNTIMES.splice(RUNTIMES.indexOf(entry), 1);
}

export function allSources(): SessionSourceAdapter[] {
  return RUNTIMES.map((e) => e.source);
}

/** 未知 / 缺省一律回 Claude Code —— 历史数据没有 runtime 字段，那时只有它 */
export function sourceFor(runtime: string | undefined | null): SessionSourceAdapter {
  return entryOf(runtime)?.source ?? claudeCodeAdapter;
}

export function isKnownRuntime(runtime: string | undefined | null): boolean {
  return !!entryOf(runtime);
}

/** 这个 id 的会话能不能被收编成可对话的 agent */
export function isManageableRuntime(runtime: string | undefined | null): boolean {
  const e = entryOf(runtime);
  return e ? e.source.manageable || !!e.acp : claudeCodeAdapter.manageable;
}

/** 走 ACP 的运行时 id（报错信息用） */
export function acpRuntimeIds(): string[] {
  return RUNTIMES.filter((e) => e.acp).map((e) => e.source.id);
}

/** 运行时的 ACP 段；没声明返回 undefined（只能走 tmux） */
export function acpSpecFor(runtime: string | undefined | null): AcpRuntimeSpec | undefined {
  return entryOf(runtime)?.acp;
}

/** 宿主进程里的运行时描述（lib/acp/host-runtime.ts acpRuntime 读它） */
export function acpHostFor(id: string): AcpHostRuntime | undefined {
  return entryOf(id)?.acp?.host;
}

/**
 * 可启动的适配器。缺省（undefined / 空串）= Claude Code（历史数据没有 runtime 字段）；
 * 认不出的 id 或只读来源返回 null——**不**像 sourceFor 那样回退，否则拼错的
 * `--runtime` 会被悄悄当成 Claude Code 起。transport=acp 返回 ACP 版，运行时不支持 acp 返回 null。
 * 只有 ACP 版的运行时没点名 transport 时给 ACP 版（建 agent 的 API 校验、运行时目录只问「能不能起」）；source 是只读来源的点名 tmux 给 null，
 * source 就是 ACP 版（OpenCode）的点名 tmux 也给它（清单 / 可用性查询不分 transport）。
 */
export function managedFor(runtime: string | undefined | null, transport?: string | null): ManagedRuntimeAdapter | null {
  if (normalizeTransport(transport) === "acp") return entryOf(runtime || DEFAULT_RUNTIME)?.acp?.managed ?? null;
  if (!runtime) return claudeCodeAdapter;
  const e = entryOf(runtime);
  if (e && isManaged(e.source)) return e.source;
  return acpOnly(e) && !transport ? e!.acp!.managed : null;
}

/** 所有可启动的运行时 id（报错信息 / API 白名单用） */
export function manageableRuntimeIds(): string[] {
  const ids = RUNTIMES.filter((e) => isManaged(e.source) || e.acp).map((e) => e.source.id);
  return [DEFAULT_RUNTIME, ...ids.filter((id) => id !== DEFAULT_RUNTIME)];
}

/** 同 managedFor，拿不到就抛出能直接给人看的错误 */
export function requireManaged(runtime: string | undefined | null, transport?: string | null): ManagedRuntimeAdapter {
  const m = managedFor(runtime, transport);
  if (m) return m;
  if (normalizeTransport(transport) === "acp") throw new Error(`runtime "${runtime || DEFAULT_RUNTIME}" 不支持 transport=acp（目前只有 ${acpRuntimeIds().join(" / ")}）`);
  const e = entryOf(runtime);
  const avail = manageableRuntimeIds().join(", ");
  if (acpOnly(e)) throw new Error(`${e!.source.label} 只能走 transport=acp`);
  throw new Error(
    e
      ? `${e.source.label} 目前是只读会话来源，不能建 agent。可用: ${avail}`
      : `未知的 runtime: "${runtime}"。可用: ${avail}`,
  );
}

/**
 * 运行时策略。registry 里的 agent 一定是可启动的运行时，所以这里对未知 / 缺省
 * 回退 Claude Code 的策略（历史行为）；只读来源若自己声明了策略就用它的。
 * transport=acp（或只有 ACP 版）且声明了 ACP 段 → 用 ACP 版适配器的策略；不传 / tmux / 没声明 ACP → 原来那份（缺省行为逐字不变）。
 */
export function controlFor(runtime: string | undefined | null, transport: Transport = DEFAULT_TRANSPORT): RuntimeControl {
  const e = entryOf(runtime);
  const acp = transport === "acp" || acpOnly(e) ? e?.acp?.managed.control : undefined;
  return acp ?? e?.source.control ?? claudeCodeAdapter.control;
}

/**
 * 切 / 建 acp 前的就绪闸，按运行时描述（AcpRuntimeSpec.ready）。没有 ACP 段的放行：transportRefusal 会按「不支持 acp」拒，
 * 这里不替它去探（也不替 Claude Code agent 装 codex-acp）。
 */
export function checkAcpReadyFor(runtime: string | undefined, autoInstall = false, deps: AcpReadyDeps = {}): Promise<AcpReady> {
  const spec = acpSpecFor(runtime);
  return spec ? spec.ready(autoInstall, deps) : Promise.resolve({ ok: true });
}

/**
 * 能敲 Claude Code 专属 TUI 命令（用量抓取的 /status）的 agent 窗口：只认 registry 里登记为 CC 的。
 * Codex 的 /status 不是 CC 的额度表（T63）；Pi 没有这张表，敲进去的 /status + 回车会变成一条发给它的输入；
 * registry 里查不到的窗口不知道在跑什么，也不碰。tests/runtime-bridge-gates.test.ts
 */
export function claudeCodeWindows(windowNames: string[], agents: { name: string; runtime?: string }[]): string[] {
  const cc = new Set(agents.filter((a) => (a.runtime || DEFAULT_RUNTIME) === DEFAULT_RUNTIME).map((a) => a.name));
  return windowNames.filter((w) => w.startsWith("agent-") && cc.has(w));
}

/** --effort 交给这个运行时之前过一道：没有推理强度的（noEffort，OpenCode）提示后丢掉、不进 registry；其余原样（create / resume / set-claude 共用） */
export function keepEffort(runtime: string | undefined | null, effort: string | undefined): string | undefined {
  const m = managedFor(runtime);
  if (!effort || !m?.noEffort) return effort;
  console.error(`⚠️ ${m.label} 不支持 --effort，已忽略（${effort}）`);
  return undefined;
}

/** 能以哪些 transport 启动：tmux 除了只有 ACP 版的人人都有，acp 要运行时声明 ACP 段（manager 切 transport 前据此拒绝） */
export function transportsOf(runtime: string | undefined | null): Transport[] {
  const e = entryOf(runtime || DEFAULT_RUNTIME);
  return [...(acpOnly(e) ? [] : [DEFAULT_TRANSPORT]), ...(e?.acp ? (["acp"] as const) : [])];
}

const headSniffCache = new Map<string, string | undefined>();

/**
 * 路径 → runtime id。
 *
 * 先按根目录判（零 I/O）；**归档副本**的路径两头都不沾（它躺在
 * ~/.claude-orchestrator/archive/ 下），只能读首行让各家自己认。结果按路径缓存。
 * 认不出返回 undefined —— 调用方按 Claude Code 处理（历史行为）。
 */
export function sourceIdForPath(path: string | undefined | null): string | undefined {
  if (!path) return undefined;
  for (const s of allSources()) if (s.ownsPath(path)) return s.id === DEFAULT_RUNTIME ? undefined : s.id;
  const byId = allSources().find((s) => s.ownsSessionId?.(basename(path, ".jsonl"))); // 归档副本 <id>.jsonl：id 形状独一份就不读文件
  if (byId) return byId.id;
  if (headSniffCache.has(path)) return headSniffCache.get(path);
  let hit: string | undefined;
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(256 * 1024); // 首行得整行读到：OpenCode 首条带宿主前言、Codex 的 session_meta 都远超 512 字节，读半截解析失败就被当成 CC
    let n = 0;
    try { n = readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
    const rec = JSON.parse(buf.toString("utf8", 0, n).split("\n")[0]);
    hit = allSources().find((s) => s.sniffFirstLine?.(rec))?.id;
  } catch {
    hit = undefined;
  }
  headSniffCache.set(path, hit);
  return hit;
}
