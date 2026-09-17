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

import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { ARCHIVE_ROOT, USER_ARCHIVE_ROOT } from "../lib/session-archive.js";
import { DEFAULT_ARCHIVE_RETENTION_DAYS, readConfigSync } from "../lib/config-store.js";
import { readRegistryAgents } from "../lib/registry.js";
import { archiveSession } from "../lib/session-archive.js";
import { projectsSlug } from "../lib/jsonl-cost.js";
import { tmuxRaw, MASTER_SESSION } from "../lib/tmux-helper.js";
import { MASTER_DIR } from "./config.js";

const SWEEP_MS = 24 * 3600_000;
const FIRST_DELAY_MS = 10 * 60_000; // 启动 10min 后跑首轮，避开 bridge 启动风暴

/**
 * 超期归档清理（v2.23+）：**只清用户手动归档区** `archive/archived/**`（USER_ARCHIVE_ROOT）。
 *
 * ⚠ 绝不走 ARCHIVE_ROOT 整棵树：`archive/<agent>/` 是退役快照 —— 被 kill 的 agent 的
 * 唯一历史副本（原件早被 Claude Code cleanupPeriodDays 清掉），CLAUDE.md 的不变量是
 * "a killed agent's archives remain readable"。review #10 时那版按整棵树 mtime 删，
 * 本机当时已有 26 个 >90 天的快照会在合并后第一次 sweep 被静默删掉。
 * 按文件 mtime 判龄；`archiveRetentionDays = 0` 表示不清理。空目录顺手删掉。
 */
export function pruneArchives(days: number, now = Date.now(), root: string = USER_ARCHIVE_ROOT): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = now - days * 86_400_000;
  let removed = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        try {
          if (readdirSync(full).length === 0) rmdirSync(full);
        } catch {
          /* 非空/权限：留着 */
        }
      } else {
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
  };
  walk(root);
  return removed;
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

export function startArchiveSweeper(): void {
  setTimeout(() => {
    void sweepArchives().catch(() => {});
    setInterval(() => void sweepArchives().catch(() => {}), SWEEP_MS);
  }, FIRST_DELAY_MS);
  console.log("🗄 归档每日兜底启动（首轮 10min 后，此后每 24h）");
}
