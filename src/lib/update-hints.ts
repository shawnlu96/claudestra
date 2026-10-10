/**
 * 会话级「该更新 / 该重启了」提示（网页 composer 横幅 + 侧栏小标）。
 *
 * - Claude Code：原生安装器在后台自更新，但**已在跑的会话**仍是旧版，直到重启。进程启动时的
 *   版本登记在 ~/.claude/sessions/<pid>.json，和磁盘上 `claude --version` 一比就知道。
 * - Pi：不自更新，要人跑 `pi update`。最新版问 pi.dev（与 Pi 启动时自己的检查同一个端点）；
 *   运行版本由 claudestra 扩展写进 pi-env 快照（Pi 的 VERSION 常量）。
 * - Codex：同 Pi，最新版问 npm registry；已装 / 运行版本 / 能否替人 npm 更新见 lib/codex-version.ts。
 */
import { probeClaudeVersion } from "./claude-binary.js";
import { readCcSessionEntries } from "./cc-sessions.js";
import { defaultRunner } from "./codex-thread.js";
import { resolveLoginBinary } from "./login-binary.js";
import { fetchLatestCodex, probeCodexInstall, readCodexRunning } from "./codex-version.js";
import { currentCodexAcp, type AdapterNow } from "./acp/install.js";
import { fetchAcpReleases, pickAdapterFor, rangeAllows, type AcpRelease } from "./acp/resolve.js";
import { adapterFor, readAdapterChoice } from "./acp/codex-compat-switch.js";
import { piBinName, readPiRuntimeSnapshot } from "./pi-env.js";
import { pidAlive } from "./tmux-helper.js";

export type UpdateHint =
  | { kind: "restart"; running: string; installed: string; adapterPairs?: string }
  | { kind: "pi-update"; installed: string; latest: string }
  /** npm：是 npm 全局安装，网页才给「更新并重启」按钮（否则只有文字） */
  | { kind: "codex-update"; installed: string; latest: string; npm: boolean; adapterPairs?: string };
/*
 * adapterPairs（只有 Codex 会带）：目标版本既不在当前 codex-acp 的配套范围里、npm 上也找不到能配它的适配器，值是当前范围
 * （如 ^0.158.0）。网页只给文字、不给按钮，端点也拒。找得到能配的适配器时照常给按钮：端点 / restart 会先换上它
 * （docs/runtimes/codex-acp.md「Codex 升级」）。
 */

/** a 比 b 新（逐段数字比较）。任一方解析不出 x.y.z → false：拿不准就不打扰人。 */
export function isNewerVersion(a?: string, b?: string): boolean {
  const pa = a?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const pb = b?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! > pb[i]!;
  return false;
}

/** 正式版 x.y.z（不带 -alpha 之类的后缀）：codex 只提示升到正式版，端点也只装正式版 */
export const isStableVersion = (v?: string): boolean => !!v && /^\d+\.\d+\.\d+$/.test(v);

/**
 * 该给哪条提示。Pi / Codex 有新版时先提示更新——更新完重启一次，「运行版本落后」也一并解决。
 * Codex 的新版不配套当前适配器、npm 上也没有能配它的适配器时，能直接点的「重启生效」优先；都不能点才给那条只有文字的。
 * codex 是整机一份，所以「更新」对 tmux agent 也拦；「重启」只拦 ACP agent（tmux 的 TUI 不经适配器；ACP 的 restart 走
 * readiness 自动换适配器，所以找得到能配的也放行）。npm latest 是预发布版时 codex 不提示更新。tests/update-hints.test.ts。
 * adapter：当前适配器（null = 没装，没有要配的；"broken" = 指针 / 标记坏了，一律只给文字，端点也拒）；
 * releases：registry 上的适配器正式版（缓存，冷缓存时是空的）。
 * self：全局选的是自研适配器。那时升级闸只认 app-server 协议判定（lib/codex-auto-update-gate.ts），上游的 codexRange 不作数：
 * 一律给能点的按钮，判不兼容由端点回 409 说原因（列表请求不能等一次临时 npm 安装去判协议）。
 */
export function pickUpdateHint(
  runtime: string,
  v: { running?: string; installed?: string; latest?: string; npm?: boolean; acp?: boolean; adapter?: AdapterNow; releases?: AcpRelease[]; self?: boolean },
): UpdateHint | null {
  const a = v.adapter;
  const followable = (x: string) => !!v.self || a !== "broken" && (!a || rangeAllows(a.codexRange, x) || !!pickAdapterFor(v.releases ?? [], x));
  const pairs = a === "broken" ? "未知（适配器指针或标记坏了，先跑 acp-install）" : a?.codexRange ?? "";
  let parked: UpdateHint | null = null;
  if (v.installed && v.latest && isNewerVersion(v.latest, v.installed)) {
    if (runtime === "pi") return { kind: "pi-update", installed: v.installed, latest: v.latest };
    if (runtime === "codex" && isStableVersion(v.latest)) {
      const hint = { kind: "codex-update" as const, installed: v.installed, latest: v.latest, npm: !!v.npm };
      if (followable(v.latest)) return hint;
      parked = { ...hint, adapterPairs: pairs };
    }
  }
  if (v.running && v.installed && isNewerVersion(v.installed, v.running)) {
    const hint = { kind: "restart" as const, running: v.running, installed: v.installed };
    if (!(runtime === "codex" && v.acp && !followable(v.installed))) return hint;
    parked ??= { ...hint, adapterPairs: pairs };
  }
  return parked;
}

// 探测要起进程（登录 shell 15s + --version 20s）或打外网（10s），而列表请求的调用方（web BFF）5s 就放弃
// → 列表请求只读缓存、绝不等探测；过期项交给后台刷新，下一轮轮询（网页 15s 一次）自然带上。
const INSTALLED_TTL_MS = 2 * 60_000; // 跑完 `pi update` / CC 自更新后，横幅要在几分钟内翻成「重启生效」
const LATEST_TTL_MS = 6 * 3600_000;

export interface VersionProbe {
  key: string;
  ttl: number;
  load: () => Promise<string | undefined>;
}
export interface VersionCache {
  get(key: string): string | undefined;
  /** 后台重探过期项；同一时刻最多一轮（共享 in-flight，不会并发重复起进程/打外网）。永不 reject */
  refresh(probes: VersionProbe[]): Promise<void>;
  /** 丢掉一项，下一轮列表请求就会重探（刚装了新版本时用，不必等 TTL） */
  forget(key: string): void;
}

export function makeVersionCache(now: () => number = Date.now): VersionCache {
  const cache = new Map<string, { at: number; v?: string }>();
  let inflight: Promise<void> | null = null;
  const run = async (p: VersionProbe) => {
    let v: string | undefined;
    try {
      v = await p.load();
    } catch (e) {
      console.warn(`⚠️ [update-hints] 探测 ${p.key} 失败（这一轮不提示，TTL 到了再试）:`, e);
    }
    cache.set(p.key, { at: now(), v }); // 失败也记一笔：否则每次轮询都重打一遍
  };
  return {
    get: (key) => cache.get(key)?.v,
    forget: (key) => void cache.delete(key),
    refresh(probes) {
      if (inflight) return inflight;
      const due = probes.filter((p) => {
        const hit = cache.get(p.key);
        return !hit || now() - hit.at >= p.ttl;
      });
      if (!due.length) return Promise.resolve();
      inflight = Promise.all(due.map(run)).then(() => { inflight = null; });
      return inflight;
    },
  };
}

/** 与 tmux 里 agent 同一口径：裸名按登录 shell 的 PATH 解析；PI_BIN 给的是路径就直接探它 */
export async function probeInstalled(bin: string): Promise<string | undefined> {
  const real = bin.includes("/") ? bin : (await resolveLoginBinary(defaultRunner, bin))?.real;
  return (real && (await probeClaudeVersion(defaultRunner, real))) || undefined;
}

async function fetchLatestPi(): Promise<string | undefined> {
  const r = await fetch("https://pi.dev/api/latest-version", { signal: AbortSignal.timeout(10_000) });
  const j = (await r.json()) as { version?: unknown };
  return r.ok && typeof j.version === "string" ? j.version.trim() : undefined;
}

const PROBE_CC: VersionProbe = { key: "installed:claude", ttl: INSTALLED_TTL_MS, load: () => probeInstalled("claude") };
const PROBE_PI: VersionProbe = { key: "installed:pi", ttl: INSTALLED_TTL_MS, load: () => probeInstalled(piBinName()) };
const PROBE_PI_LATEST: VersionProbe = { key: "latest:pi", ttl: LATEST_TTL_MS, load: fetchLatestPi };
let codexNpm = false; // 与 installed:codex 同一次探测得出（缓存只存字符串）
const PROBE_CODEX: VersionProbe = {
  key: "installed:codex",
  ttl: INSTALLED_TTL_MS,
  load: async () => {
    const i = await probeCodexInstall();
    codexNpm = !!i?.npm;
    return i?.version;
  },
};
const PROBE_CODEX_LATEST: VersionProbe = { key: "latest:codex", ttl: LATEST_TTL_MS, load: fetchLatestCodex };
let acpReleases: AcpRelease[] = []; // 与 releases:codex-acp 同一次探测得出（缓存只存字符串，存的是最高版本号）
const PROBE_ACP_RELEASES: VersionProbe = {
  key: "releases:codex-acp",
  ttl: LATEST_TTL_MS,
  load: async () => (acpReleases = await fetchAcpReleases()).at(-1)?.version,
};
const versions = makeVersionCache();

/** 网页刚替用户跑完 `pi update`：马上重探已装版本，横幅立刻翻成「重启生效」，不用等 2 分钟 TTL */
export function forgetInstalledPi(): void {
  versions.forget(PROBE_PI.key);
}
export function forgetInstalledCodex(): void {
  versions.forget(PROBE_CODEX.key);
}

/** sessionId → 该会话**活着的**进程启动时的版本（同一 session 被重启过多次时取最新那次）。只读本地文件，重启后提示立刻消失 */
async function ccRunningVersions(): Promise<Map<string, string>> {
  const out = new Map<string, { at: number; v: string }>();
  for (const e of await readCcSessionEntries()) {
    if (!e.version || !pidAlive(e.pid)) continue;
    const prev = out.get(e.sessionId);
    if (!prev || (e.startedAt ?? 0) > prev.at) out.set(e.sessionId, { at: e.startedAt ?? 0, v: e.version });
  }
  return new Map([...out].map(([k, x]) => [k, x.v]));
}

type ListedAgent = { name: string; status?: string; updateHint?: UpdateHint | null };
type RegInfo = { runtime?: string; sessionId?: string; transport?: string };

/**
 * 给 /api/v1/agents 的列表项挂 updateHint（只看 active 的 Claude Code / Pi / Codex 会话；master 不在 registry 里，不提示）。
 * 不等任何进程/外网探测：冷缓存时这一轮不带提示（undefined），后台刷新完下一轮带上。
 */
export async function attachUpdateHints(agents: ListedAgent[], regs: Map<string, RegInfo>, cache: VersionCache = versions): Promise<void> {
  const live = agents.filter((a) => a.status === "active" && regs.get(a.name));
  const isPi = (a: ListedAgent) => regs.get(a.name)?.runtime === "pi";
  const isCc = (a: ListedAgent) => !regs.get(a.name)?.runtime || regs.get(a.name)?.runtime === "claude-code";
  const hasCc = live.some(isCc);
  const hasPi = live.some(isPi);
  const isCodex = (a: ListedAgent) => regs.get(a.name)?.runtime === "codex";
  const hasCodex = live.some(isCodex);
  void cache.refresh([
    ...(hasCc ? [PROBE_CC] : []),
    ...(hasPi ? [PROBE_PI, PROBE_PI_LATEST] : []),
    ...(hasCodex ? [PROBE_CODEX, PROBE_CODEX_LATEST, PROBE_ACP_RELEASES] : []),
  ]);
  const ccRunning = hasCc ? await ccRunningVersions() : new Map<string, string>();
  const [ccInstalled, piInstalled, piLatest] = [cache.get(PROBE_CC.key), cache.get(PROBE_PI.key), cache.get(PROBE_PI_LATEST.key)];
  const adapter = hasCodex ? currentCodexAcp() : null;
  const selfAdapter = hasCodex && adapterFor(readAdapterChoice()) === "self"; // 和升级闸同一个依据：全局选择（prepareCodexUpdate 的 selected()）
  for (const a of live) {
    const r = regs.get(a.name)!;
    if (isCc(a)) a.updateHint = pickUpdateHint("claude-code", { running: r.sessionId ? ccRunning.get(r.sessionId) : undefined, installed: ccInstalled });
    else if (isPi(a)) a.updateHint = pickUpdateHint("pi", { running: readPiRuntimeSnapshot(a.name)?.piVersion, installed: piInstalled, latest: piLatest });
    else if (isCodex(a)) {
      const v = {
        running: readCodexRunning(a.name), installed: cache.get(PROBE_CODEX.key), latest: cache.get(PROBE_CODEX_LATEST.key),
        npm: codexNpm, acp: r.transport === "acp", adapter, releases: acpReleases, self: selfAdapter,
      };
      a.updateHint = pickUpdateHint("codex", v);
    }
  }
}
