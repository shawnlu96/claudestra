/**
 * v2.9+ 归档每日兜底 —— session-archive 只在会话退役时触发（kill / fork 换代 /
 * adopt / resume 替换）；这里每天对所有 active agent 补一次快照（copyIfLarger
 * 幂等，无变化零成本），把「bridge 崩溃 / 断电导致退役归档没跑」以及「长寿
 * session 从未退役过」的丢档窗口也堵上。
 *
 * v2.17.2（peer 2026-08-09 P0/P2）遍历源加固：
 *  - **master 特判**：master 不在 registry，retirement 归档和这里此前都遍历不到
 *    它，而 launcher 每次开机给 master 开新 session → 旧 session 从未被归档、
 *    直接随 CC cleanupPeriodDays 丢失（实测 11 个历史会话 13.9MB 不可见）。
 *    MASTER_DIR 是 Claudestra 专用目录，其下所有 jsonl 都是 master 历代 session，
 *    整目录归档安全（区别于普通 agent 的用户项目 cwd）。
 *  - **不单信 registry active**：registry 状态写回可能脱节（agent 实际活着却标
 *    stopped），归档就停在过时快照。遍历源改为「registry active ∪ tmux 实际
 *    存在的窗口」。归档是对冲 CC cleanupPeriodDays 的最后一道防线，漏一个就等于
 *    那个 agent 裸奔。
 */

import { existsSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { ARCHIVE_ROOT, USER_ARCHIVE_ROOT } from "../lib/session-archive.js";
import { DEFAULT_ARCHIVE_RETENTION_DAYS, readConfigSync } from "../lib/config-store.js";
import { readRegistryAgents } from "../lib/registry.js";
import { archiveSession } from "../lib/session-archive.js";
import { CODEX_SUB_IDLE_DAYS, sweepIdleCodexSubSessions } from "../lib/unmanaged-archive.js";
import { projectsSlug } from "../lib/jsonl-cost.js";
import { tmuxRaw, MASTER_SESSION } from "../lib/tmux-helper.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH, MASTER_DIR } from "./config.js";
import { runManagerProcess } from "../lib/run-manager.js";

const SWEEP_MS = 24 * 3600_000;
const FIRST_DELAY_MS = 10 * 60_000; // 启动 10min 后跑首轮，避开 bridge 启动风暴

/**
 * 超期归档清理：**只清用户手动归档区** archive/archived/**（USER_ARCHIVE_ROOT）。绝不走 ARCHIVE_ROOT 整棵树——
 * archive/<agent>/ 是退役快照，被 kill 的 agent 唯一的历史副本（"a killed agent's archives remain readable"）。
 * 按文件 mtime 判龄，days=0 不清理。目录只在这一轮删过文件、删空了才删：agent 归档标记（kind=agent 的 .meta.json 不清，
 * lib/agent-archive-marker.ts）和老的空标记目录都得留着，删了 agent 就回到侧栏。tests/archive-sweeper.test.ts。
 */
export function pruneArchives(days: number, now = Date.now(), root: string = USER_ARCHIVE_ROOT): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  return pruneDir(root, now - days * 86_400_000);
}

function pruneDir(dir: string, cutoff: number): number {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // 根不存在 / 没权限：这一支没东西可清
  }
  const keepMeta = isAgentMarker(dir);
  let removed = 0;
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const n = pruneDir(full, cutoff);
      removed += n;
      try {
        if (n > 0 && readdirSync(full).length === 0) rmdirSync(full);
      } catch {
        /* 删不掉（权限 / 并发写入）就留个空目录，下一轮再说，不影响其余条目 */
      }
    } else if (!(keepMeta && e.name === ".meta.json")) {
      try {
        if (statSync(full).mtimeMs < cutoff) {
          unlinkSync(full);
          removed++;
        }
      } catch {
        /* 单个文件失败不影响其余 */
      }
    }
  }
  return removed;
}

function isAgentMarker(dir: string): boolean {
  try {
    return JSON.parse(readFileSync(join(dir, ".meta.json"), "utf8"))?.kind === "agent";
  } catch {
    return false; // 没有 meta（会话条目 / 老的空标记）或坏 JSON：按会话条目处理；空标记没文件可删，目录照样留着
  }
}

/**
 * Codex 子线程结束 N 天收进归档。缺省关：收进 archived/ 的到归档保留期就被删，等于永久删除，要 owner 自己开
 * （manager codex-sub-archive on）。registry 里全部 agent（含大总管）挂着的会话都算 keep。返回归档条数，没开 = null；
 * 失败只记日志，不挡后面的快照。tests/unmanaged-archive.test.ts。
 */
export async function sweepCodexSubsIfEnabled(
  agents: Array<{ sessionId?: string }>,
  cfg: { autoArchiveCodexSubs?: boolean } = readConfigSync(),
  sweep: typeof sweepIdleCodexSubSessions = sweepIdleCodexSubSessions,
): Promise<number | null> {
  if (cfg.autoArchiveCodexSubs !== true) return null;
  try {
    const r = await sweep({ keep: new Set(agents.map((a) => a.sessionId).filter((s): s is string => !!s)) });
    const mb = (r.bytes / 1048576).toFixed(1);
    if (r.archived > 0) console.log(`🗄 Codex 子会话 / 一次性调用：${r.archived} 个（${mb}MB）超过 ${CODEX_SUB_IDLE_DAYS} 天没写，收进归档区(archived/)`);
    return r.archived;
  } catch (e) {
    console.log(`⚠️ Codex 子会话归档扫描失败: ${(e as Error).message}`);
    return 0;
  }
}

export async function sweepArchives(): Promise<{ agents: number; archived: number }> {
  // 超期清理（默认 90 天，设置里可改；0=不清理）—— 只清 archived/ 手动归档区，快照不碰
  try {
    const days = readConfigSync().archiveRetentionDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS;
    const pruned = pruneArchives(days);
    if (pruned > 0) console.log(`🗄 归档区(archived/)清理：移除 ${pruned} 个超过 ${days} 天的文件`);
  } catch {
    /* 清理失败不阻塞兜底快照 */
  }

  const agents = await readRegistryAgents();

  await sweepCodexSubsIfEnabled(agents);

  // tmux 实际存在的 agent 窗口（P2：registry 标 stopped 但窗口还活着的也要归档）
  const liveWindows = new Set<string>();
  try {
    const out = await tmuxRaw(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_name}"]);
    for (const w of out.split("\n").map((s) => s.trim())) {
      if (w.startsWith("agent-")) liveWindows.add(w);
    }
  } catch { /* tmux 不在（Web-only 等）就只信 registry */ }

  let archived = 0;
  let swept = 0;
  for (const a of agents) {
    if (!a.sessionId) continue;
    const win = a.name.startsWith("agent-") ? a.name : `agent-${a.name}`;
    if (a.status !== "active" && !liveWindows.has(win)) continue;
    swept++;
    const r = await archiveSession(a.name, a.cwd, a.sessionId, { runtime: a.runtime }).catch(() => null);
    if (r?.archived.length) archived += r.archived.length;
  }

  // master 特判（P0）：扫 MASTER_DIR 对应 projects 目录下全部 jsonl，逐个归档到
  // archive/master/。开机换过的旧 session 只要还在 projects 目录（CC 清理前）就
  // 会被这一趟接住——归档目录仍是 listAgentSessions 读取时的权威边界，这里只是
  // 把 master 的历史喂进去。
  let masterCount = 0;
  try {
    const slugDir = `${process.env.HOME}/.claude/projects/${projectsSlug(MASTER_DIR)}`;
    if (existsSync(slugDir)) {
      for (const f of readdirSync(slugDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const sid = f.replace(/\.jsonl$/, "");
        const r = await archiveSession("master", MASTER_DIR, sid).catch(() => null);
        if (r?.archived.length) {
          archived += r.archived.length;
          masterCount++;
        }
      }
    }
  } catch { /* best-effort */ }

  console.log(`🗄 归档兜底扫描: ${swept} agents + master(${masterCount} 会话更新), 新增/更新 ${archived} 个文件`);
  return { agents: swept, archived };
}

const USAGE_INGEST_TIMEOUT_MS = 60 * 60_000;
const USAGE_TICK_MS = 10 * 60_000; // token 视图要当天看得到：增量一趟通常 1 秒内
const USAGE_FIRST_DELAY_MS = 5 * 60_000; // 与首轮归档扫描错开

/**
 * 导 token 账（lib/usage-ingest.ts）。放子进程：首轮要读几个 GB，进 bridge 就是 RSS 棘轮；超时被杀也不丢进度（按文件偏移续读）。
 * 每 10 分钟一趟增量、每天归档扫完一趟带 --prune（清 30 天前明细）；子进程之间靠 usage 库旁的文件锁串行。
 */
async function ingestTokenUsage(prune: boolean): Promise<void> {
  const args = prune ? ["usage", "ingest", "--prune"] : ["usage", "ingest"];
  const r = await runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV_WITH_BUN, timeoutMs: USAGE_INGEST_TIMEOUT_MS });
  if (!r?.ok) console.log(`⚠️ token 账导入失败: ${r?.error ?? "无输出"}`);
  else if (prune && !r.skipped) {
    console.log(`🧮 token 账每日导入: 读 ${r.read} 个文件 ${Math.round(r.bytes / 1048576)}MB，${r.calls} 次调用，清理超期明细 ${r.pruned} 条（${r.ms}ms）`);
  }
}

let usageTickRunning = false;

/** 10 分钟一趟；上一趟（比如首轮全量）还没完就跳过，不叠子进程 */
function usageTick(): void {
  if (usageTickRunning) return;
  usageTickRunning = true;
  void ingestTokenUsage(false)
    .catch((e) => console.log(`⚠️ token 账导入失败: ${(e as Error).message}`))
    .finally(() => { usageTickRunning = false; });
}

function dailySweep(): void {
  void sweepArchives()
    .catch(() => {}) // sweepArchives 内部逐项兜错、各自打日志；这里只保证它失败也照样导 token 账
    .then(() => ingestTokenUsage(true))
    .catch((e) => console.log(`⚠️ token 账导入失败: ${(e as Error).message}`));
}

export function startArchiveSweeper(): void {
  setTimeout(() => {
    dailySweep();
    setInterval(dailySweep, SWEEP_MS);
  }, FIRST_DELAY_MS);
  setTimeout(() => {
    usageTick();
    setInterval(usageTick, USAGE_TICK_MS);
  }, USAGE_FIRST_DELAY_MS);
  console.log("🗄 归档每日兜底启动（首轮 10min 后，此后每 24h）；token 账增量每 10min");
}
