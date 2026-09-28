/**
 * v2.7+ Claude Code background job 清理（2026-07-09 事故实证的配方）。
 *
 * 背景：Claude Code 2.1.x 的 bg daemon 管着 ~/.claude/jobs/<id>/，进程被 kill
 * 后 daemon 会异步写回 state.json（甚至重建刚被移走的 job 目录）；roster 里
 * 记着的 job 会被整个 respawn。实证有效的清理顺序：
 *
 *   1. kill 进程（SIGTERM）
 *   2. 轮询等 daemon 写完退出状态（state.json mtime 稳定 + 无同 id 进程）
 *   3. mv job 目录到 ~/.claude/jobs-quarantine/（不删除，可回滚）
 *   4. 校验重建：若 daemon 又把目录写回来 → 重试 mv（最多 N 轮）
 *   5. respawn 检出 → roster 根治（见 tryRosterCleanup），根治不了才 stubborn
 *
 * v2.9.1 修正（2026-07-10 d170ecbc 分身实测破案）：respawn 的权威依据是
 * ~/.claude/daemon/roster.json 的 workers 花名册 —— 早先"被前台 --fork-session
 * 进程引用而保活"的判断是误判（引用进程死了 daemon 照样 respawn，attempt 计数
 * 一直涨）。根治 = kill worker + daemon supervisor + 从 roster 删条目；daemon
 * 是 --origin transient 按需拉起，杀掉后无 client 不会自动重生。
 * 隔离目录不删除是刻意的：清理错了随时 mv 回来恢复。
 */

import { existsSync } from "fs";
import { mkdir, readFile, rename, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { sandboxDisabled } from "./sandbox.js";

const JOBS_DIR = join(homedir(), ".claude", "jobs");
const QUARANTINE_DIR = join(homedir(), ".claude", "jobs-quarantine");
const ROSTER_PATH = join(homedir(), ".claude", "daemon", "roster.json");

export interface CleanupResult {
  ok: boolean;
  /** daemon 反复重建/respawn，需要用户在官方 TUI 里删 */
  stubborn?: boolean;
  /** 隔离后的目录路径（ok 时有值） */
  quarantinedTo?: string;
  note: string;
}

/**
 * 找出该 bg job 自己的进程 pid。
 *
 * ⚠️ 不能裸用 pgrep -f <bgId>：从这个分身 `--resume <id> --fork-session` 出来的
 * tmux 前台实例，命令行里也含这个 id —— 裸匹配会把正主一起杀掉（清理分身反而
 * 干掉正式 agent）。按命令行白名单过滤：只杀 claude 的 bg 形态进程
 * （--session-id / --resume .jsonl / bg-pty-host），明确排除 --fork-session 引用者。
 */
async function findJobPids(bgId: string): Promise<number[]> {
  const proc = Bun.spawn(["pgrep", "-fl", bgId], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const cmd = m[2];
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    if (!cmd.includes("claude")) continue; // 无关进程碰巧含字符串（grep 等）
    if (cmd.includes("--fork-session")) continue; // fork 引用者是正主，绝不杀
    pids.push(pid);
  }
  return pids;
}

async function mtimeOf(p: string): Promise<number | null> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 等 job 进入静默：无相关进程 + state.json mtime 连续 stableMs 不变。
 * 超时返回 false（daemon 还在动它）。
 */
async function waitJobQuiescent(
  bgId: string,
  jobsDir: string,
  timeoutMs: number,
  stableMs = 6_000,
): Promise<boolean> {
  const statePath = join(jobsDir, bgId, "state.json");
  const deadline = Date.now() + timeoutMs;
  let lastMtime = await mtimeOf(statePath);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await Bun.sleep(1_500);
    const pids = await findJobPids(bgId);
    const m = await mtimeOf(statePath);
    if (m !== lastMtime) {
      lastMtime = m;
      stableSince = Date.now();
      continue;
    }
    if (pids.length === 0 && Date.now() - stableSince >= stableMs) return true;
  }
  return false;
}

/**
 * v2.9.1 顽固分身根治：daemon respawn 的权威依据是 roster.json 的 workers
 * 花名册。条件满足时（roster 里除目标外无其他活 worker，不殃及别的 bg 任务）
 * 点名 kill worker + daemon supervisor，并从 roster 删条目。
 * daemon 是 transient 按需拉起，无 client 不会重生 —— respawn 链就此斩断。
 */
export async function tryRosterCleanup(
  bgId: string,
  rosterPath = ROSTER_PATH,
): Promise<{ done: boolean; note: string }> {
  const off = sandboxDisabled("清理 / 收编 bg job"); // 沙箱看不到生产 registry，眼里的「分身」可能是生产会话
  if (off) return { done: false, note: off };
  try {
    if (!existsSync(rosterPath)) return { done: false, note: "无 roster.json" };
    const roster = JSON.parse(await readFile(rosterPath, "utf-8"));
    const workers = roster?.workers;
    if (!workers || typeof workers !== "object") return { done: false, note: "roster 无 workers" };
    const entry = workers[bgId];
    if (!entry) return { done: false, note: "roster 无该 job 条目" };
    const others = Object.keys(workers).filter((k) => k !== bgId);
    if (others.length > 0) {
      return { done: false, note: `daemon 还管着其他 ${others.length} 个 bg 任务，不动 daemon` };
    }
    // 点名 kill：worker 本体 + daemon supervisor + pgrep 扫出的 pty host 等残留
    const targets = new Set<number>(await findJobPids(bgId));
    for (const pid of [entry.pid, roster.supervisorPid]) {
      if (typeof pid === "number" && pid > 1) targets.add(pid);
    }
    targets.delete(process.pid);
    for (const pid of targets) {
      try { process.kill(pid, "SIGTERM"); } catch { /* 已死 / 无权限 */ }
    }
    delete workers[bgId];
    await writeFile(rosterPath, JSON.stringify(roster, null, 2));
    return { done: true, note: "roster 条目已清 + daemon 已停（transient，按需重生）" };
  } catch (e) {
    return { done: false, note: `roster 清理失败: ${(e as Error).message}` };
  }
}

/**
 * 清理一个 bg job。pid 可选（inventory 已知时省一次 pgrep）。
 * kill → 等静默 → mv 隔离 → 防重建校验（最多 maxRounds 轮）→ respawn 时 roster 根治。
 */
export async function cleanupBgJob(
  bgId: string,
  opts: { pid?: number; jobsDir?: string; quarantineDir?: string; maxRounds?: number; rosterPath?: string } = {},
): Promise<CleanupResult> {
  if (!/^[a-z0-9-]+$/i.test(bgId)) {
    return { ok: false, note: `非法 bgId: ${bgId}` };
  }
  const off = sandboxDisabled("清理 / 收编 bg job");
  if (off) return { ok: false, note: off };
  const jobsDir = opts.jobsDir ?? JOBS_DIR;
  const quarantineDir = opts.quarantineDir ?? QUARANTINE_DIR;
  const maxRounds = opts.maxRounds ?? 3;
  const jobPath = join(jobsDir, bgId);

  // 1. 杀进程（显式 pid + pgrep 扫描双保险）
  const pids = new Set<number>(await findJobPids(bgId));
  if (opts.pid) pids.add(opts.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 已死 / 无权限 */
    }
  }

  // 2. 等 daemon 写完退出状态
  await waitJobQuiescent(bgId, jobsDir, 30_000);

  // 3+4. mv 隔离 + 防重建重试
  await mkdir(quarantineDir, { recursive: true });
  for (let round = 1; round <= maxRounds; round++) {
    if (!existsSync(jobPath)) {
      return { ok: true, note: `job 目录已不存在（第 ${round} 轮检查）` };
    }
    const dest = join(quarantineDir, `${bgId}-${Date.now()}`);
    try {
      await rename(jobPath, dest);
    } catch (e) {
      return { ok: false, note: `mv 失败: ${(e as Error).message}` };
    }
    // 观察窗口：daemon 重建 / respawn 检测
    await Bun.sleep(6_000);
    const rebuilt = existsSync(jobPath);
    const respawned = (await findJobPids(bgId)).length > 0;
    if (!rebuilt && !respawned) {
      return { ok: true, quarantinedTo: dest, note: `已清理（第 ${round} 轮）` };
    }
    if (respawned) {
      // v2.9.1: respawn = roster 花名册里还记着它。先试根治（kill worker +
      // daemon + 删 roster 条目），成功则等静默进下一轮 mv/验证；根治不了
      // （daemon 还管着别的 bg 任务等）才交还给官方 TUI。
      const roster = await tryRosterCleanup(bgId, opts.rosterPath);
      if (!roster.done) {
        return {
          ok: false,
          stubborn: true,
          note: `daemon respawn 了该 job（${roster.note}），请在 claude agents TUI 里手动删除`,
        };
      }
      console.log(`[bg-jobs] ${bgId} roster 根治: ${roster.note}`);
      await waitJobQuiescent(bgId, jobsDir, 15_000);
      continue;
    }
    // 只是目录被写回 → 等静默后再试一轮
    await waitJobQuiescent(bgId, jobsDir, 15_000);
  }
  return {
    ok: false,
    stubborn: true,
    note: `daemon 连续 ${maxRounds} 轮重建 job 目录，请在 claude agents TUI 里手动删除`,
  };
}
