/**
 * 会话级「该更新 / 该重启了」提示（网页 composer 横幅 + 侧栏小标）。
 *
 * - Claude Code：原生安装器在后台自更新，但**已在跑的会话**仍是旧版，直到重启。进程启动时的
 *   版本登记在 ~/.claude/sessions/<pid>.json，和磁盘上 `claude --version` 一比就知道。
 * - Pi：不自更新，要人跑 `pi update`。最新版问 pi.dev（与 Pi 启动时自己的检查同一个端点）；
 *   运行版本由 claudestra 扩展写进 pi-env 快照（Pi 的 VERSION 常量）。
 */
import { probeClaudeVersion } from "./claude-binary.js";
import { readCcSessionEntries } from "./cc-sessions.js";
import { defaultRunner } from "./codex-thread.js";
import { resolveLoginBinary } from "./login-binary.js";
import { piBinName, readPiRuntimeSnapshot } from "./pi-env.js";
import { pidAlive } from "./tmux-helper.js";

export type UpdateHint =
  | { kind: "restart"; running: string; installed: string }
  | { kind: "pi-update"; installed: string; latest: string };

/** a 比 b 新（逐段数字比较）。任一方解析不出 x.y.z → false：拿不准就不打扰人。 */
export function isNewerVersion(a?: string, b?: string): boolean {
  const pa = a?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const pb = b?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! > pb[i]!;
  return false;
}

/** 该给哪条提示。Pi 有新版时先让人 `pi update`——更新完重启一次，「运行版本落后」也一并解决。 */
export function pickUpdateHint(runtime: string, v: { running?: string; installed?: string; latest?: string }): UpdateHint | null {
  if (runtime === "pi" && v.installed && v.latest && isNewerVersion(v.latest, v.installed))
    return { kind: "pi-update", installed: v.installed, latest: v.latest };
  if (v.running && v.installed && isNewerVersion(v.installed, v.running))
    return { kind: "restart", running: v.running, installed: v.installed };
  return null;
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
async function probeInstalled(bin: string): Promise<string | undefined> {
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
const versions = makeVersionCache();

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
type RegInfo = { runtime?: string; sessionId?: string };

/**
 * 给 /api/v1/agents 的列表项挂 updateHint（只看 active 的 Claude Code / Pi 会话；master 不在 registry 里，不提示）。
 * 不等任何进程/外网探测：冷缓存时这一轮不带提示（undefined），后台刷新完下一轮带上。
 */
export async function attachUpdateHints(agents: ListedAgent[], regs: Map<string, RegInfo>, cache: VersionCache = versions): Promise<void> {
  const live = agents.filter((a) => a.status === "active" && regs.get(a.name));
  const isPi = (a: ListedAgent) => regs.get(a.name)?.runtime === "pi";
  const isCc = (a: ListedAgent) => !regs.get(a.name)?.runtime || regs.get(a.name)?.runtime === "claude-code";
  const hasCc = live.some(isCc);
  const hasPi = live.some(isPi);
  void cache.refresh([...(hasCc ? [PROBE_CC] : []), ...(hasPi ? [PROBE_PI, PROBE_PI_LATEST] : [])]);
  const ccRunning = hasCc ? await ccRunningVersions() : new Map<string, string>();
  const [ccInstalled, piInstalled, piLatest] = [cache.get(PROBE_CC.key), cache.get(PROBE_PI.key), cache.get(PROBE_PI_LATEST.key)];
  for (const a of live) {
    const r = regs.get(a.name)!;
    if (isCc(a)) a.updateHint = pickUpdateHint("claude-code", { running: r.sessionId ? ccRunning.get(r.sessionId) : undefined, installed: ccInstalled });
    else if (isPi(a)) a.updateHint = pickUpdateHint("pi", { running: readPiRuntimeSnapshot(a.name)?.piVersion, installed: piInstalled, latest: piLatest });
  }
}
