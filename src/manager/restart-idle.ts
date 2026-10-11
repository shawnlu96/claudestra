/**
 * `manager restart --idle-only <json> -- <名>`（hardening-CCIDLE1）：Claude Code 自动升级重启波专用入口（src/lib/claude-update-restart.ts）。
 * 在该 agent 的重启锁里、开始退出之前，按升级前拍下的身份再核一遍：registry 会话与同名窗口 id 都没换、此刻明确空闲；
 * 忙 / 读不出 / 身份变了一律跳过（不碰窗口，结果带 skipped，launcher 记 pending 等下一轮空闲）。
 * 读法是 身份 → 活动 → 身份 → 活动 → 窗口 → 会话：最后一次活动 / 窗口读取过程中换了会话或窗口也挡得住（最后一步是同步读 registry，
 * 之后 manager 不再 await 就进 gracefulExit）；开了回合由第二次活动读取挡。只认单个名字，不做全员；
 * 不带 --idle-only 什么都不读，人工 restart 语义不变。tests/claude-update-audit-idle-manager.test.ts。
 */
import { windowLooksIdle } from "../lib/busy-windows.js";
import { parseTurns } from "../lib/acp-turn-gate.js";
import { bridgeRequest } from "../lib/bridge-client.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { controlFor, normalizeTransport } from "../lib/runtimes/index.js";
import { listWindowIdsByName, paneIdleVerdict, tmuxRaw } from "../lib/tmux-helper.js";

interface IdleExpect { sessionId: string; windows: string[] }
export type Activity = "idle" | "busy" | "unknown";

export interface IdlePorts {
  /** registry 里此刻的会话；没这条 = undefined；读不了就抛 */
  session(name: string): string | undefined;
  windows(name: string): Promise<string[]>;
  /** 这些窗口（没窗口 = 这个 agent 的 ACP / 不在跑）此刻的活动 */
  activity(name: string, windows: string[]): Promise<Activity>;
}

interface IdleSkip { name: string; ok: false; skipped: string; error: string }

/** 这个进程里复核通过、往下走去碰窗口的目标 */
const passed = new Set<string>();

/** `--` 之前的 `--idle-only <json>`：没带 = undefined；带了却没值、或者没用 `--` 指定名字 = ""（整条拒） */
export function idleOnlyArg(args: string[]): string | undefined {
  const dd = args.indexOf("--");
  const head = dd < 0 ? args : args.slice(0, dd);
  const i = head.indexOf("--idle-only");
  if (i < 0) return undefined;
  return dd < 0 || !args[dd + 1] ? "" : (head[i + 1] ?? "");
}

/** --idle-only 的拒绝原因：--idle-only 只配单个名字，不和 --expect / --restore-expect / --include-master 混用 */
function idleOnlyRefusal(args: string[]): string | null {
  const raw = idleOnlyArg(args);
  if (raw === undefined) return null;
  if (!raw) return "--idle-only 需要身份 JSON，并用 `-- <名>` 指定单个 agent（自动波不做全员重启）";
  const head = args.indexOf("--") < 0 ? args : args.slice(0, args.indexOf("--"));
  return ["--expect", "--restore-expect", "--include-master"].some((f) => head.includes(f)) ? "--idle-only 不能和 --expect / --restore-expect / --include-master 一起用" : null;
}

/** case "restart" 的参数拒绝：--idle-only 的规矩先核，再是 --include-master / 大总管按名字重启（从 manager.ts 原样搬来） */
export function restartArgsRefusal(args: string[], name: string | undefined, includeMaster: boolean, nameIsMaster: boolean): string | null {
  const idle = idleOnlyRefusal(args);
  if (idle || !name || !(includeMaster || nameIsMaster)) return idle;
  return includeMaster ? "--include-master 只能用于全体重启（不要同时指定 agent 名）" : "大总管由 launcher 守护：要重启它用 restart --include-master";
}

function parseIdleExpect(raw: string): IdleExpect | null {
  try {
    const v = JSON.parse(raw) as Partial<IdleExpect>;
    if (typeof v.sessionId !== "string" || !Array.isArray(v.windows) || !v.windows.every((w) => typeof w === "string")) return null;
    return { sessionId: v.sessionId, windows: v.windows };
  } catch {
    return null;
  }
}

/** 一屏画面的活动：撞墙 / 在跑 = busy；空画面、hook 运行时说不准 = unknown（自动波不在说不准时动手） */
export function paneActivity(runtime: string | undefined, pane: string): Activity {
  if (!pane.trim()) return "unknown";
  if (!windowLooksIdle(runtime, pane)) return "busy";
  if (runtime !== "codex" && controlFor(runtime).idleSource === "hook" && paneIdleVerdict(pane) !== "idle") return "unknown";
  return "idle";
}

const LIVE: IdlePorts = {
  session: (name) => readRegistryAgentsSync().find((a) => a.name === name)?.sessionId,
  windows: listWindowIdsByName,
  async activity(name, windows) {
    const reg = readRegistryAgentsSync().find((a) => a.name === name);
    if (controlFor(reg?.runtime, normalizeTransport(reg?.transport)).idleSource === "acp") {
      // ACP 窗口里是宿主日志：问宿主回合态，只有明确答空闲才算（同升级闸 lib/acp-turn-gate.ts）
      return parseTurns(await bridgeRequest({ type: "turn_status", agents: [name] }, { timeoutMs: 10_000 }), [name])[name];
    }
    let worst: Activity = "idle"; // 没窗口 = 里面没有在跑的回合
    for (const id of windows) {
      const a = paneActivity(reg?.runtime, await tmuxRaw(["capture-pane", "-t", id, "-p"]));
      if (a === "busy") return "busy";
      if (a === "unknown") worst = "unknown";
    }
    return worst;
  },
};

async function recheck(target: string, want: IdleExpect, ports: IdlePorts): Promise<string | null> {
  const session = (): string | null => {
    const s = ports.session(target);
    return s === want.sessionId ? null : `会话换了（${want.sessionId.slice(0, 8) || "无"} → ${s?.slice(0, 8) || "无"}）`;
  };
  const windows = async (): Promise<string | null> => {
    const w = await ports.windows(target);
    return w.join(",") === want.windows.join(",") ? null : `窗口换了（${want.windows.join(",") || "无"} → ${w.join(",") || "无"}）`;
  };
  const identity = async (): Promise<string | null> => session() ?? (await windows());
  const activity = async (): Promise<string | null> => {
    const a = await ports.activity(target, want.windows);
    return a === "idle" ? null : a === "busy" ? "在忙（回合进行中）" : "活动读不出";
  };
  // 收尾先窗口后会话：最后一次 activity()/windows() await 期间换了身份都能看到，返回到动手之间没有 await
  return (await identity()) ?? (await activity()) ?? (await identity()) ?? (await activity()) ?? (await windows()) ?? session();
}

/** cmdRestart 拿到锁后、开始退出前调用：没带 --idle-only = null（照常）；带了就复核，不成立返回跳过条目。读失败一律跳过。 */
export async function idleSkip(target: string, raw: string | undefined, ports: IdlePorts = LIVE): Promise<IdleSkip | null> {
  if (raw === undefined) return null;
  const want = parseIdleExpect(raw);
  let why: string | null;
  try {
    why = want ? await recheck(target, want, ports) : "--idle-only 身份 JSON 不合法";
  } catch (e) {
    why = `复核读失败：${(e as Error).message.slice(0, 200)}`;
  }
  if (!why) return passed.add(target), null;
  passed.delete(target);
  console.error(`[restart] ${target} 按 --idle-only 复核不重启：${why}`);
  return { name: target, ok: false, skipped: why, error: `已跳过（--idle-only 复核）：${why}` };
}

/** 带 --idle-only 时，复核通过之前就被拒的（另一个 restart 拿着锁、做到一半的 create 等）都没碰窗口：改记 skipped，launcher 留 pending */
export function markIdleSkips<T extends { name: string; ok: boolean; error?: string; skipped?: string }>(results: T[], raw: string | undefined): T[] {
  if (raw === undefined) return results;
  return results.map((r) => (r.ok || r.skipped !== undefined || passed.has(r.name) ? r : { ...r, skipped: `复核前已拒：${r.error ?? "没有结果"}` }));
}
