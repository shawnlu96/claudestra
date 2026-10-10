/**
 * 账号用量的手动探测：只在网页用户点刷新时、经 lib/account-usage-refresh.ts 的闸调用。
 * 自己起一个**独立、临时、隐藏**的 tmux 会话（不在 master 里、不借任何 agent / owner / PM / worker 窗口），
 * 里面跑一个干净启动的 Claude Code（env -i 白名单环境、状态 / 运行目录指向临时目录、strict MCP 空表、
 * 不读 user/project 设置、关 hooks 与自动记忆、禁全部工具、不给 prompt），敲 /status 读 Usage tab，读完关掉。
 * 回收只认自己建出来的那份记录（session id + 名字双核）——永不 kill 别的会话 / 进程，也不向别的窗口发键。
 * 起不来（没有 claude、要确认 bypass、要登录、超时、abort）就明确失败，由闸记 30 分钟退避；绝不降级去抓用户窗口。
 * bridge 退出（exit / SIGINT / SIGTERM / SIGHUP，含更新重启）时 async finally 跑不到：在途探测登记在 liveProbes，
 * 退出钩子同步收掉（同样 id + 名字双核）；kill -9 拦不住的，下次启动按闸的落盘记录清扫（recoverInterruptedRefresh）。
 * 单测 tests/account-usage-probe.test.ts（假 tmux，零真实模型调用）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { shellEscape } from "../lib/claude-launch.js";
import { envIPrefix, workerPrivateDirs } from "../lib/runtimes/clean-env.js";
import { runtimePath } from "../lib/paths.js";
import { detectBypassConsentPrompt, isClaudeReady, sandboxTmuxArgv, TMUX_SOCK, tmuxRaw, tmuxRawStrict } from "../lib/tmux-helper.js";
import {
  implausibleSessionReset, parseUsagePanel, typedRecheckOk, usagePanelVisible, type AccountUsage,
} from "../lib/account-usage-panel.js";
import type { ProbeResource, ProbeResult, ProbeRunner } from "../lib/account-usage-refresh.js";

export const PROBE_SESSION_PREFIX = "cstra-usage-probe-";
const PROBE_TOOLS_DENY = "Bash Edit Write MultiEdit NotebookEdit Read Glob Grep WebFetch WebSearch Task Agent TodoWrite Skill";

/** 探测只用到的 tmux 动作；目标一律是自己建的 session id（$N） */
export interface ProbeTmux {
  newSession(name: string, dir: string, command: string): Promise<string>;
  capture(id: string): Promise<string>;
  sendLiteral(id: string, text: string): Promise<void>;
  sendKey(id: string, key: "Enter" | "Escape" | "Right" | "BSpace"): Promise<void>;
  /** 该 id 此刻的会话名；不存在返回 null */
  nameOf(id: string): Promise<string | null>;
  kill(id: string): Promise<void>;
  /** 退出钩子用的同步版（进程要没了，等不了 Promise）：同 nameOf / kill */
  nameOfSync?(id: string): string | null;
  killSync?(id: string): void;
}

export interface ProbeDeps {
  tmux?: ProbeTmux;
  claudeBin?: () => string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  makeDir?: () => string;
  removeDir?: (dir: string) => void;
  /** 等就绪的上限 */
  timeoutMs?: number;
  /** 整次探测的硬上限（默认等就绪上限 + 30 秒），到点判失败并收掉自己 */
  hardTimeoutMs?: number;
  /** 取消：abort 即判失败（probe_aborted）并收掉自己 */
  signal?: AbortSignal;
}

/** 同 tmuxRaw 的 socket / 沙箱闸，同步执行（只给退出钩子用） */
function tmuxSync(args: string[]) {
  const argv = sandboxTmuxArgv(["tmux", "-f", "/dev/null", "-S", TMUX_SOCK, ...args]);
  return spawnSync(argv[0]!, argv.slice(1), { timeout: 3000, encoding: "utf8" });
}

const realTmux: ProbeTmux = {
  newSession: async (name, dir, command) =>
    (await tmuxRawStrict(["new-session", "-d", "-P", "-F", "#{session_id}", "-s", name, "-x", "160", "-y", "50", "-c", dir, command])).trim(),
  capture: (id) => tmuxRaw(["capture-pane", "-t", id, "-p"]),
  sendLiteral: async (id, text) => void (await tmuxRaw(["send-keys", "-t", id, "-l", text])),
  sendKey: async (id, key) => void (await tmuxRaw(["send-keys", "-t", id, key])),
  nameOf: async (id) => (await tmuxRaw(["display-message", "-p", "-t", id, "#{session_name}"])) || null,
  kill: async (id) => void (await tmuxRaw(["kill-session", "-t", id])),
  nameOfSync: (id) => {
    const r = tmuxSync(["display-message", "-p", "-t", id, "#{session_name}"]);
    return r.status === 0 ? String(r.stdout).trim() || null : null;
  },
  killSync: (id) => void tmuxSync(["kill-session", "-t", id]),
};

/** 干净启动命令：白名单环境 + 临时状态目录，strict MCP 空表、不读设置源、关 hooks、禁工具、不带 prompt */
export function probeCommand(bin: string, dir: string, base: Record<string, string | undefined> = process.env): string {
  const own = Object.entries({ ...workerPrivateDirs(dir), ENABLE_CLAUDEAI_MCP_SERVERS: "false" }).map(([k, v]) => `${k}=${shellEscape(v)}`);
  const settings = { disableAllHooks: true, autoMemoryEnabled: false };
  const argv = [bin, "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--setting-sources", "",
    "--settings", JSON.stringify(settings), "--dangerously-skip-permissions", "--disallowedTools", PROBE_TOOLS_DENY];
  return `${envIPrefix(base, shellEscape)} ${own.join(" ")} ${argv.map(shellEscape).join(" ")}`;
}

/** 只收自己建的：id 还在且名字仍是记录里那个才 kill，然后删临时目录 */
export async function cleanupProbe(r: ProbeResource, deps: ProbeDeps = {}): Promise<void> {
  const tmux = deps.tmux ?? realTmux;
  if (r.id && r.session.startsWith(PROBE_SESSION_PREFIX) && (await tmux.nameOf(r.id).catch(() => null)) === r.session) {
    await tmux.kill(r.id).catch((e) => console.error(`📊 探测会话 ${r.session} 回收失败:`, (e as Error).message));
  }
  try {
    (deps.removeDir ?? ((d: string) => rmSync(d, { recursive: true, force: true })))(r.dir);
  } catch (e) {
    console.error(`📊 探测临时目录 ${r.dir} 删除失败:`, (e as Error).message); // 只是残留一个空临时目录，不影响下次探测
  }
}

/** 在途探测资源 → 它的 deps：退出钩子按这张表同步回收，探测自己收尾后删掉 */
const liveProbes = new Map<ProbeResource, ProbeDeps>();
const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** 同步收掉一个自己建的探测资源（退出钩子用）：规则同 cleanupProbe——id 还在且名字仍是记录里那个才 kill */
export function cleanupProbeSync(r: ProbeResource, deps: ProbeDeps = {}): void {
  const tmux = deps.tmux ?? realTmux;
  try {
    if (r.id && r.session.startsWith(PROBE_SESSION_PREFIX) && tmux.nameOfSync && tmux.killSync && tmux.nameOfSync(r.id) === r.session) tmux.killSync(r.id);
  } catch (e) {
    console.error(`📊 退出时探测会话 ${r.session} 回收失败:`, (e as Error).message); // 下次启动按落盘记录再收
  }
  try {
    (deps.removeDir ?? ((d: string) => rmSync(d, { recursive: true, force: true })))(r.dir);
  } catch {}
}

function dropLiveProbes(): void {
  for (const [r, deps] of liveProbes) cleanupProbeSync(r, deps);
  liveProbes.clear();
}

/** 信号上只回收、不改退出语义（同 lib/caller-cred.ts）：别的监听者在就交给它；没有 = 本来会被默认动作杀掉，按原信号再杀自己 */
function onExitSignal(sig: NodeJS.Signals): void {
  dropLiveProbes();
  unhookExit();
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}

function unhookExit(): void {
  process.off("exit", dropLiveProbes);
  for (const s of EXIT_SIGNALS) process.off(s, onExitSignal);
}

function trackLive(r: ProbeResource, deps: ProbeDeps): void {
  if (!liveProbes.size) {
    process.on("exit", dropLiveProbes);
    for (const s of EXIT_SIGNALS) process.on(s, onExitSignal);
  }
  liveProbes.set(r, deps);
}

function untrackLive(r: ProbeResource | null): void {
  if (r) liveProbes.delete(r);
  if (!liveProbes.size) unhookExit();
}

/** 测试用：此刻登记着的在途探测数 */
export function liveProbeCount(): number {
  return liveProbes.size;
}

/** 等 Claude Code 就绪；要人确认的框（bypass 首启确认 / 登录 / 信任）直接判失败，不替用户选 */
async function waitReady(tmux: ProbeTmux, id: string, deadline: number, d: Required<Pick<ProbeDeps, "sleep" | "now">>): Promise<string | null> {
  while (d.now() < deadline) {
    const pane = await tmux.capture(id).catch(() => "");
    if (detectBypassConsentPrompt(pane)) return "probe_needs_bypass_consent";
    if (/Select login method|Please run \/login|Do you trust the files/i.test(pane)) return "probe_needs_user_action";
    if (isClaudeReady(pane)) return null;
    await d.sleep(500);
  }
  return "probe_start_timeout";
}

/** 敲 /status → Usage tab → 等真值帧（首帧是进程启动时的缓存快照，等数值相对首帧变化或超时） */
async function readUsageTab(tmux: ProbeTmux, id: string, d: Required<Pick<ProbeDeps, "sleep" | "now">>): Promise<AccountUsage | string> {
  await tmux.sendLiteral(id, "/status");
  await d.sleep(150);
  if (!typedRecheckOk(await tmux.capture(id).catch(() => ""), "/status")) return "probe_input_unexpected";
  await tmux.sendKey(id, "Enter");
  await d.sleep(500);
  let panel = "";
  let found = false;
  for (let i = 0; i < 6 && !found; i++) {
    panel = await tmux.capture(id).catch(() => "");
    if (usagePanelVisible(panel)) found = true;
    else {
      await tmux.sendKey(id, "Right");
      await d.sleep(300);
    }
  }
  if (!found) return "probe_no_usage_tab";
  const first = parseUsagePanel(panel, d.now());
  for (let w = 0; w < 6; w++) {
    await d.sleep(1300);
    const next = await tmux.capture(id).catch(() => "");
    if (!usagePanelVisible(next)) continue;
    panel = next;
    const b = parseUsagePanel(next, d.now());
    if (first.sessionPct !== b.sessionPct || first.weekPct !== b.weekPct || first.sessionResets !== b.sessionResets) break;
  }
  const usage = parseUsagePanel(panel, d.now());
  if (usage.sessionPct === null && usage.weekPct === null) return "probe_unparsed";
  if (implausibleSessionReset(usage.sessionResets, d.now())) return "probe_stale_frame";
  return usage;
}

/** 一次完整探测：建 → 读 → 无论成败（含超时）都收掉自己建的资源 */
export async function runUsageProbe(onCreated: (r: ProbeResource) => void, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const tmux = deps.tmux ?? realTmux;
  const d = { sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))), now: deps.now ?? Date.now };
  const bin = (deps.claudeBin ?? (() => Bun.which("claude")))();
  if (!bin) return { ok: false, reason: "probe_unavailable: claude CLI not found" };
  const dir = (deps.makeDir ?? (() => mkdtempSync(join(runtimePath(), "usage-probe-"))))();
  const session = PROBE_SESSION_PREFIX + randomBytes(4).toString("hex");
  let res: ProbeResource | null = null;
  let abandoned = false;
  const work = async (): Promise<ProbeResult> => {
    const id = await tmux.newSession(session, dir, probeCommand(bin, dir));
    const mine: ProbeResource = { session, id, dir };
    // 超时已判、收尾已跑过才建出来的会话：自己收掉，不再登记给闸（闸已记失败）
    if (abandoned) return cleanupProbe(mine, deps).then(() => ({ ok: false, reason: "probe_timeout" }));
    res = mine;
    trackLive(mine, deps);
    onCreated(mine);
    const notReady = await waitReady(tmux, id, d.now() + (deps.timeoutMs ?? 60_000), d);
    if (notReady) return { ok: false, reason: notReady };
    const out = await readUsageTab(tmux, id, d);
    return typeof out === "string" ? { ok: false, reason: out } : { ok: true, usage: out };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeResult>((r) => { timer = setTimeout(() => r({ ok: false, reason: "probe_timeout" }), deps.hardTimeoutMs ?? (deps.timeoutMs ?? 60_000) + 30_000); });
  const aborted = new Promise<ProbeResult>((r) => {
    if (deps.signal?.aborted) r({ ok: false, reason: "probe_aborted" });
    deps.signal?.addEventListener("abort", () => r({ ok: false, reason: "probe_aborted" }), { once: true });
  });
  try {
    return await Promise.race([work(), timeout, aborted]);
  } catch (e) {
    return { ok: false, reason: `probe_error: ${(e as Error).message}`.slice(0, 200) };
  } finally {
    clearTimeout(timer);
    abandoned = true;
    // 超时后 work() 可能还在跑：会话先被收掉，它后续的发键落在已不存在的 id 上（tmux 的 $N 不复用）
    await cleanupProbe(res ?? { session, id: "", dir }, deps);
    untrackLive(res);
  }
}

export function usageProbeRunner(deps: ProbeDeps = {}): ProbeRunner {
  return { run: (onCreated) => runUsageProbe(onCreated, deps), cleanup: (r) => cleanupProbe(r, deps) };
}
