/** Claude Code scratch directories: derive the single child from cwd, then fail closed on every filesystem boundary. */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Stage } from "./ledger-stages.js";
import { isMasterAgent } from "./registry.js";
import { RETIRE_STAGES, type SchedulerSession } from "./scheduler-sessions.js";
import type { LiveAgent } from "./scheduler-retire.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

/** Pure relative directory name, not a path supplied by a caller. Claude's scratch slug differs from its project-history slug. */
export function claudeTmpDirFor(cwd: string): string {
  if (!isAbsolute(cwd) || cwd === "/" || cwd.includes("\0")) throw new Error("会话 cwd 不是有效的绝对目录");
  return cwd.replace(/[/.]/g, "-");
}

/** Conservatively protect aliases on case-insensitive / Unicode-normalizing filesystems too. */
export const claudeTmpSameSlug = (a: string, b: string): boolean =>
  claudeTmpDirFor(a).normalize("NFC").toLowerCase() === claudeTmpDirFor(b).normalize("NFC").toLowerCase();

/** Shared with worktree retirement: stopped + a pending operation or surviving window is not a completed kill. */
export const retireAgentStopped = (a: LiveAgent): boolean => a.status === "stopped" && !a.pending && !a.window;

/** No agent is exempt from the slug check, including this card's worker and PM; other stopped owners are protected too. */
export function claudeTmpBlocker(stage: Stage, row: SchedulerSession, cwd: string, agents: readonly LiveAgent[]): string | null {
  if (!RETIRE_STAGES.includes(stage)) return "卡尚未收尾";
  if (row.transport === "peer") return "peer 会话不在本机";
  if (row.state !== "retired" || !row.killReceipt) return "会话尚未确认停止";
  claudeTmpDirFor(cwd); // validate even if every agent is already absent
  for (const a of agents) {
    const own = a.name === row.agent;
    if (own && (isMasterAgent(a.name) || a.kind === "main" || a.role === "pm")) return "主会话不能清理";
    if (own && (!retireAgentStopped(a) || (a.sessionId && a.sessionId !== row.sessionId))) return "本卡 agent 未停止或已换会话";
    if (own && a.cwd && a.cwd !== cwd) return "会话 cwd 不是本卡 worktree（旧手工卡不回填）";
    if (!a.cwd) {
      if (!retireAgentStopped(a)) return `${a.name} 的 cwd 不明，无法排除占用`;
      continue;
    }
    if (claudeTmpSameSlug(a.cwd, cwd) && (!own || !retireAgentStopped(a))) return `${a.name} 仍占用同一临时目录`;
  }
  return null;
}

export interface TmpRemoval { ok: boolean; detail: string }
/** The production implementation takes cwd only; this syscall seam lets tests stay entirely in their own sandbox. */
export interface ClaudeTmpFs {
  tmpdir(): string;
  uid(): number;
  realpath: typeof realpathSync;
  lstat: typeof lstatSync;
  readdir: typeof readdirSync;
  rm: typeof rm;
}
const systemFs: ClaudeTmpFs = {
  tmpdir, uid: () => { if (!process.getuid) throw new Error("无法确定当前 uid"); return process.getuid(); },
  realpath: realpathSync, lstat: lstatSync, readdir: readdirSync, rm,
};
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT";

/** A pure containment check on already-resolved paths: never the root, a sibling, or a grandchild. */
export function claudeTmpDirectChild(root: string, child: string): boolean {
  return isAbsolute(root) && isAbsolute(child) && resolve(root) === root && resolve(child) === child && child !== root && dirname(child) === root;
}

function checkedDirectory(fs: ClaudeTmpFs, path: string): boolean {
  let st;
  try { st = fs.lstat(path); } catch (e) { if (missing(e)) return false; throw e; }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`不是普通目录（不跟随、不删除符号链接）：${path}`);
  if (fs.realpath(path) !== path) throw new Error(`目录真实路径发生变化：${path}`);
  return true;
}

/** Reject nested links as well: recursive rm must not even unlink a scratch symlink. */
function checkContents(fs: ClaudeTmpFs, dir: string): void {
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop()!;
    if (!checkedDirectory(fs, current)) throw new Error(`遍历期间目录消失：${current}`);
    for (const name of fs.readdir(current) as string[]) {
      const path = join(current, name);
      const st = fs.lstat(path);
      if (st.isSymbolicLink()) throw new Error(`临时目录内含符号链接：${path}`);
      if (st.isDirectory()) pending.push(path);
    }
  }
}

/** No path argument for the root or removal target: both are derived here, with an ownership check immediately before rm. */
export async function removeClaudeTmp(cwd: string, active: () => void, fs: ClaudeTmpFs = systemFs): Promise<TmpRemoval> {
  try {
    active();
    const root = join(String(fs.realpath(fs.tmpdir())), `claude-${fs.uid()}`), dir = join(root, claudeTmpDirFor(cwd));
    if (!claudeTmpDirectChild(root, dir)) throw new Error("临时目录不在根的下一层");
    if (!checkedDirectory(fs, root) || !checkedDirectory(fs, dir)) return { ok: true, detail: "目录已不在" };
    checkContents(fs, dir);
    // Recheck the root as well as the child after the walk: a swapped root must not redirect recursive deletion.
    if (!checkedDirectory(fs, root) || !checkedDirectory(fs, dir)) return { ok: true, detail: "目录已不在" };
    active();
    try { await fs.rm(dir, { recursive: true, force: false, maxRetries: 0 }); }
    catch (e) { if (!missing(e) || checkedDirectory(fs, dir)) throw e; /* concurrent disappearance of this exact directory is success */ }
    active();
    return { ok: true, detail: "目录已删除" };
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return { ok: false, detail: String((e as Error).message) };
  }
}
