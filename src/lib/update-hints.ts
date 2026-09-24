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
import { readPiRuntimeSnapshot } from "./pi-env.js";
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

// 网页每 15s 轮询一次列表；版本号变得很慢，缓存住，别每次都起进程 / 打外网
const INSTALLED_TTL_MS = 2 * 60_000; // 跑完 `pi update` / CC 自更新后，横幅要在几分钟内翻成「重启生效」
const LATEST_TTL_MS = 6 * 3600_000;
const cache = new Map<string, { at: number; v?: string }>();

async function cached(key: string, ttl: number, load: () => Promise<string | undefined>): Promise<string | undefined> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const v = await load().catch(() => undefined); // 探不到 = 这一轮不提示，下个 TTL 再试
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** 与 tmux 里 agent 同一口径：登录 shell 的 PATH 解析出的那个二进制的版本 */
function installedVersion(bin: "claude" | "pi"): Promise<string | undefined> {
  return cached(`installed:${bin}`, INSTALLED_TTL_MS, async () => {
    const b = await resolveLoginBinary(defaultRunner, bin);
    return (b && (await probeClaudeVersion(defaultRunner, b.real))) || undefined;
  });
}

function latestPiVersion(): Promise<string | undefined> {
  return cached("latest:pi", LATEST_TTL_MS, async () => {
    const r = await fetch("https://pi.dev/api/latest-version", { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { version?: unknown };
    return r.ok && typeof j.version === "string" ? j.version.trim() : undefined;
  });
}

/** sessionId → 该会话**活着的**进程启动时的版本（同一 session 被重启过多次时取最新那次） */
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

/** 给 /api/v1/agents 的列表项挂 updateHint（只看 active 的 Claude Code / Pi 会话；master 不在 registry 里，不提示） */
export async function attachUpdateHints(agents: ListedAgent[], regs: Map<string, RegInfo>): Promise<void> {
  const live = agents.filter((a) => a.status === "active" && regs.get(a.name));
  const isPi = (a: ListedAgent) => regs.get(a.name)?.runtime === "pi";
  const isCc = (a: ListedAgent) => !regs.get(a.name)?.runtime || regs.get(a.name)?.runtime === "claude-code";
  const hasCc = live.some(isCc);
  const hasPi = live.some(isPi);
  const [ccInstalled, ccRunning, piInstalled, piLatest] = await Promise.all([
    hasCc ? installedVersion("claude") : undefined,
    hasCc ? ccRunningVersions() : new Map<string, string>(),
    hasPi ? installedVersion("pi") : undefined,
    hasPi ? latestPiVersion() : undefined,
  ]);
  for (const a of live) {
    const r = regs.get(a.name)!;
    if (isCc(a)) a.updateHint = pickUpdateHint("claude-code", { running: r.sessionId ? ccRunning.get(r.sessionId) : undefined, installed: ccInstalled });
    else if (isPi(a)) a.updateHint = pickUpdateHint("pi", { running: readPiRuntimeSnapshot(a.name)?.piVersion, installed: piInstalled, latest: piLatest });
  }
}
