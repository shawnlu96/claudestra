/**
 * v2.23.2+ Claude Code 自己的进程登记：`~/.claude/sessions/<pid>.json`
 *   { pid, sessionId, cwd, startedAt, tmux: "master:@1111.%1111", name, status, … }
 *
 * 用途：**不靠 jsonl 落盘**就拿到一个窗口里 Claude Code 的真实 sessionId。
 * `resume --fork` / restart 的 fork 自愈原先靠「就绪后 diff projects 目录里新出现的
 * jsonl」——但 fork 出的会话文件要到**第一条消息**才创建（master 2026-09-18 实报：
 * TUI 就绪 32s 后 jsonl 才出现，20s 探测窗口错过，registry 暂记源 id，两个频道渲染同
 * 一份 transcript）。而这份登记在进程启动那一刻就写好了 sessionId。
 *
 * 匹配优先级：窗口 shell 的直接子进程 pid 命中 > 登记里 tmux 字段的 pane id 命中；
 * 都要 pid 存活；fork 场景排除源 id；多个候选取 cwd 一致、startedAt 最新的。
 * Pi 没有这份登记（它的会话文件 manager 另有 waitForPiReady 路径），调用方按 runtime 分流。
 */
import { readdir, readFile } from "fs/promises";
import { realpathSync } from "fs";
import { join } from "path";
import { tmuxRaw, windowTarget, windowChildPids, pidAlive } from "./tmux-helper.js";

export interface CcSessionEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  /** "master:@1111.%1111"（session:window.pane） */
  tmux?: string;
  startedAt?: number;
  name?: string;
}

export function ccSessionsDir(): string {
  return join(process.env.HOME || "~", ".claude", "sessions");
}

/** 解析一个登记文件的内容（纯函数，坏 JSON / 缺字段 → null） */
export function parseCcSessionEntry(raw: string): CcSessionEntry | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const pid = typeof j.pid === "number" ? j.pid : Number(j.pid);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (typeof j.sessionId !== "string" || !j.sessionId) return null;
    return {
      pid,
      sessionId: j.sessionId,
      cwd: typeof j.cwd === "string" ? j.cwd : "",
      ...(typeof j.tmux === "string" ? { tmux: j.tmux } : {}),
      ...(typeof j.startedAt === "number" ? { startedAt: j.startedAt } : {}),
      ...(typeof j.name === "string" ? { name: j.name } : {}),
    };
  } catch {
    return null;
  }
}

export async function readCcSessionEntries(dir = ccSessionsDir()): Promise<CcSessionEntry[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out: CcSessionEntry[] = [];
  for (const f of files) {
    const e = parseCcSessionEntry(await readFile(join(dir, f), "utf8").catch(() => ""));
    if (e) out.push(e);
  }
  return out;
}

/**
 * 从登记里挑出属于某个窗口的那条（纯函数，tests/cc-sessions.test.ts）。
 * childPids：窗口 shell 的直接子进程；paneId：窗口 pane 的 `%N`；cwd 已 realpath 归一。
 */
export function pickCcSessionForWindow(
  entries: CcSessionEntry[],
  opts: { childPids: number[]; paneId?: string | null; cwd?: string; exclude?: string },
): CcSessionEntry | null {
  const byPid = entries.filter((e) => opts.childPids.includes(e.pid));
  const byPane = opts.paneId
    ? entries.filter((e) => !byPid.includes(e) && e.tmux?.endsWith(`.${opts.paneId}`))
    : [];
  const cands = [...byPid, ...byPane].filter((e) => e.sessionId !== opts.exclude);
  if (!cands.length) return null;
  const cwdMatch = opts.cwd ? cands.filter((e) => e.cwd === opts.cwd) : cands;
  const pool = cwdMatch.length ? cwdMatch : cands;
  return [...pool].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 某个 agent 窗口里 Claude Code 的真实 sessionId。登记在进程启动时就写好，
 * 默认最多等 5s（覆盖 ready 判定与文件落盘之间的毫秒级间隙）；找不到返回 null，
 * 调用方退回目录 diff。exclude：fork 场景传源 id，绝不把源 id 当成新 id 确认。
 */
export async function resolveSessionIdForWindow(
  tmuxName: string,
  cwd: string,
  opts: { exclude?: string; timeoutMs?: number } = {},
): Promise<{ sessionId: string; pid: number } | null> {
  const target = windowTarget(tmuxName);
  const cwdReal = safeRealpath(cwd);
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  for (;;) {
    const childPids = await windowChildPids(target).catch(() => [] as number[]);
    const paneId =
      (await tmuxRaw(["display-message", "-p", "-t", target, "#{pane_id}"]).catch(() => "")).trim() || null;
    const entries = (await readCcSessionEntries())
      .filter((e) => pidAlive(e.pid))
      .map((e) => ({ ...e, cwd: safeRealpath(e.cwd) }));
    const hit = pickCcSessionForWindow(entries, { childPids, paneId, cwd: cwdReal, exclude: opts.exclude });
    if (hit) return { sessionId: hit.sessionId, pid: hit.pid };
    if (Date.now() >= deadline) return null;
    await Bun.sleep(500);
  }
}
