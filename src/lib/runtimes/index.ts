/**
 * 运行时注册表 —— **加一种运行时只改这个文件**（加一个适配器 + 往下面数组里塞一条）。
 *
 * 调用方一律经这里拿适配器，不要再写 `if (runtime === "xxx")`：
 *   - 按 id 拿：`sourceFor(runtime)`
 *   - 按路径认：`sourceForPath(path)`（先按根目录，再按首行嗅探）
 *   - 全部：`allSources()`（会话列表就是把它们的 scanSessions 并起来）
 *   - 要启动 / 退出它：`managedFor(runtime)` / `requireManaged(runtime)`
 *   - bridge 侧策略（打断键、是否抢占、忙闲来源）：`controlFor(runtime, transport)`
 *   - 这个运行时能走哪些 transport：`transportsOf(runtime)`
 */
import { readFirstLineSync, readSidecarRuntime } from "../session-sidecar.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { codexAcpAdapter } from "./codex-acp.js";
import { piAdapter } from "./pi.js";
import { DEFAULT_TRANSPORT, isManaged, normalizeTransport, type ManagedRuntimeAdapter, type RuntimeControl, type SessionSourceAdapter, type Transport } from "./types.js";

export * from "./types.js";
export { claudeCodeAdapter, codexAdapter, piAdapter };

/** 顺序有意义：sourceForPath 按这个顺序问「这条路径是不是你的」 */
const SOURCES: SessionSourceAdapter[] = [piAdapter, codexAdapter, claudeCodeAdapter];

export const DEFAULT_RUNTIME = "claude-code";

export function allSources(): SessionSourceAdapter[] {
  return SOURCES;
}

/** 未知 / 缺省一律回 Claude Code —— 历史数据没有 runtime 字段，那时只有它 */
export function sourceFor(runtime: string | undefined | null): SessionSourceAdapter {
  return SOURCES.find((s) => s.id === runtime) ?? claudeCodeAdapter;
}

export function isKnownRuntime(runtime: string | undefined | null): boolean {
  return !!runtime && SOURCES.some((s) => s.id === runtime);
}

/** 这个 id 的会话能不能被收编成可对话的 agent */
export function isManageableRuntime(runtime: string | undefined | null): boolean {
  return sourceFor(runtime).manageable;
}

/** transport=acp 时的生命周期适配器（窗口里跑 ACP 宿主）：只有声明了 ACP 段的运行时有 */
const ACP_ADAPTERS: Record<string, ManagedRuntimeAdapter> = { codex: codexAcpAdapter };

/**
 * 可启动的适配器。缺省（undefined / 空串）= Claude Code（历史数据没有 runtime 字段）；
 * 认不出的 id 或只读来源返回 null——**不**像 sourceFor 那样回退，否则拼错的
 * `--runtime` 会被悄悄当成 Claude Code 起。transport=acp 返回 ACP 版，运行时不支持 acp 返回 null。
 */
export function managedFor(runtime: string | undefined | null, transport?: string | null): ManagedRuntimeAdapter | null {
  if (normalizeTransport(transport) === "acp") return ACP_ADAPTERS[runtime || DEFAULT_RUNTIME] ?? null;
  if (!runtime) return claudeCodeAdapter;
  const s = SOURCES.find((x) => x.id === runtime);
  return s && isManaged(s) ? s : null;
}

/** 所有可启动的运行时 id（报错信息 / API 白名单用） */
export function manageableRuntimeIds(): string[] {
  const ids = SOURCES.filter(isManaged).map((s) => s.id);
  return [DEFAULT_RUNTIME, ...ids.filter((id) => id !== DEFAULT_RUNTIME)];
}

/** 同 managedFor，拿不到就抛出能直接给人看的错误 */
export function requireManaged(runtime: string | undefined | null, transport?: string | null): ManagedRuntimeAdapter {
  const m = managedFor(runtime, transport);
  if (m) return m;
  if (normalizeTransport(transport) === "acp") throw new Error(`runtime "${runtime || DEFAULT_RUNTIME}" 不支持 transport=acp（目前只有 codex）`);
  const s = SOURCES.find((x) => x.id === runtime);
  const avail = manageableRuntimeIds().join(", ");
  throw new Error(
    s
      ? `${s.label} 目前是只读会话来源，不能建 agent。可用: ${avail}`
      : `未知的 runtime: "${runtime}"。可用: ${avail}`,
  );
}

/**
 * 运行时策略。registry 里的 agent 一定是可启动的运行时，所以这里对未知 / 缺省
 * 回退 Claude Code 的策略（历史行为）；只读来源若自己声明了策略就用它的。
 * transport=acp 且运行时声明了 ACP 段 → 用 acp 的策略；不传 / tmux / 没声明 ACP → 原来那份（缺省行为逐字不变）。
 */
export function controlFor(runtime: string | undefined | null, transport: Transport = DEFAULT_TRANSPORT): RuntimeControl {
  const s = runtime ? SOURCES.find((x) => x.id === runtime) : undefined;
  const acp = transport === "acp" && s && isManaged(s) ? s.acp : undefined;
  return acp?.control ?? s?.control ?? claudeCodeAdapter.control;
}

/** 能以哪些 transport 启动：tmux 人人都有，acp 要运行时声明 ACP 段（manager 切 transport 前据此拒绝） */
export function transportsOf(runtime: string | undefined | null): Transport[] {
  const out: Transport[] = [DEFAULT_TRANSPORT];
  if (managedFor(runtime)?.acp) out.push("acp");
  return out;
}

const headSniffCache = new Map<string, string | undefined>();

/**
 * 首行在上限内读不完、或不是 JSON：认不出是谁家的。不能退成 Claude Code——CC 的行翻译会把 Codex / Pi 的记录全丢掉，
 * CC 的来源解包还会把正文里的头当真。这个 id 不属于任何运行时：翻译照 CC 的默认走，但 cc-own-records 把它当非 CC，
 * user 记录原文照登、不认来源（tests/codex-archive-read.test.ts）。
 */
export const UNTRUSTED_RUNTIME = "untrusted";

/**
 * 路径 → runtime id。
 *
 * 先按根目录判（零 I/O）；**归档副本**的路径两头都不沾（它躺在 ~/.claude-orchestrator/archive/ 下）：
 * 先看归档时写下的 sidecar，老归档没有就读完整首行让各家自己认（lib/session-sidecar.ts）。
 * 首行是合法 JSON、没人认领 → undefined（Claude Code，历史行为）；读不全 / 坏 JSON → UNTRUSTED_RUNTIME。
 * 只缓存读到完整首行的结果：文件不存在、还没写完换行时不缓存，免得稍后落盘的归档被永久认错。
 */
export function sourceIdForPath(path: string | undefined | null): string | undefined {
  if (!path) return undefined;
  for (const s of SOURCES) if (s.ownsPath(path)) return s.id === DEFAULT_RUNTIME ? undefined : s.id;
  if (headSniffCache.has(path)) return headSniffCache.get(path);
  const side = readSidecarRuntime(path);
  if (side && isKnownRuntime(side)) return side === DEFAULT_RUNTIME ? undefined : side;
  const head = readFirstLineSync(path);
  if (head.kind === "unreadable") return undefined;
  if (head.kind === "too-long") {
    headSniffCache.set(path, UNTRUSTED_RUNTIME);
    return UNTRUSTED_RUNTIME;
  }
  let hit: string | undefined;
  try {
    const rec = JSON.parse(head.text);
    const id = SOURCES.find((s) => s.sniffFirstLine?.(rec))?.id;
    hit = id === DEFAULT_RUNTIME ? undefined : id;
  } catch {
    hit = UNTRUSTED_RUNTIME;
  }
  if (head.kind === "line") headSniffCache.set(path, hit);
  return hit;
}
