/**
 * v2.8+ 会话归档 —— 对抗 Claude Code 的 cleanupPeriodDays 定期清理。
 *
 * 权威对话历史在 ~/.claude/projects/<slug>/<sessionId>.jsonl（+ 同名目录下的
 * subagents/*.jsonl），但 CC 会按 cleanupPeriodDays 清老文件。想长期保留聊天
 * 记录，唯一可靠的办法是在会话「退役」时（kill / fork 换代 / adopt 替换）把
 * jsonl 快照一份到我们自己的地盘。
 *
 * 设计（2026-07-10 owner 拍板）：文件级复制、不入库、不改格式 —— 归档就是
 * 原样的 jsonl，将来 Web UI / 全文索引都从这里读。同 session 重复归档时只在
 * 源文件更大（内容更多）时覆盖，缩水/丢失不回写。
 */

import { existsSync } from "fs";
import { copyFile, mkdir, readdir, stat } from "fs/promises";
import { join } from "path";
import { projectJsonlPath, findJsonlBySessionId, projectsSlug } from "./jsonl-cost.js";

export const ARCHIVE_ROOT = join(
  process.env.HOME || "~", ".claude-orchestrator", "archive",
);

export interface ArchiveResult {
  ok: boolean;
  archived: string[]; // 归档产物的绝对路径
  note: string;
}

/** 源比已有归档大才复制（追加式 jsonl：更大 = 更全） */
async function copyIfLarger(src: string, dest: string): Promise<boolean> {
  try {
    const s = await stat(src);
    if (existsSync(dest)) {
      const d = await stat(dest);
      if (d.size >= s.size) return false;
    }
    await copyFile(src, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * 归档一个 agent 的某个 session：主 jsonl + subagents/*.jsonl。
 * 落点 ~/.claude-orchestrator/archive/<agent>/<sessionId>[.jsonl|/subagents/]。
 * 源不存在（已被 CC 清理）→ ok:false 但不抛错，调用方 best-effort。
 */
export async function archiveSession(
  agentName: string,
  cwd: string | undefined,
  sessionId: string,
  opts: { archiveRoot?: string; srcPath?: string } = {},
): Promise<ArchiveResult> {
  // typeof 守卫(peer 2026-08-09):调用方把非字符串(如误传 opts 对象)落到
  // sessionId 位时,下面的路径拼接会得到必不存在的路径 → 误报「源已被 CC 清理」,
  // 一个和真实原因完全无关、还很吓人的诊断。类型不对就直说类型不对。
  if (typeof sessionId !== "string" || !sessionId) {
    return { ok: false, archived: [], note: `无效 sessionId（期望字符串，实得 ${typeof sessionId}）` };
  }
  let src = opts.srcPath ?? (cwd ? projectJsonlPath(cwd, sessionId) : "");
  if (!src || !existsSync(src)) src = findJsonlBySessionId(sessionId) ?? "";
  if (!src || !existsSync(src)) {
    return { ok: false, archived: [], note: "源 jsonl 不存在（可能已被 CC 清理）" };
  }

  const dir = join(opts.archiveRoot ?? ARCHIVE_ROOT, agentName);
  await mkdir(dir, { recursive: true });
  const archived: string[] = [];

  const destMain = join(dir, `${sessionId}.jsonl`);
  if (await copyIfLarger(src, destMain)) archived.push(destMain);

  // subagents 对话（与主会话同级的 <sessionId>/subagents/ 目录）
  const subDir = join(src.replace(/\.jsonl$/, ""), "subagents");
  if (existsSync(subDir)) {
    const destSub = join(dir, sessionId, "subagents");
    await mkdir(destSub, { recursive: true });
    try {
      for (const f of await readdir(subDir)) {
        if (!f.endsWith(".jsonl")) continue;
        if (await copyIfLarger(join(subDir, f), join(destSub, f))) {
          archived.push(join(destSub, f));
        }
      }
    } catch { /* best-effort */ }
  }

  return {
    ok: true,
    archived,
    note: archived.length ? `已归档 ${archived.length} 个文件` : "归档已是最新（无变化）",
  };
}

/** 诊断/CLI 用：某 agent 的归档 session 列表 */
export async function listArchivedSessions(agentName: string): Promise<string[]> {
  const dir = join(ARCHIVE_ROOT, agentName);
  if (!existsSync(dir)) return [];
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

// projectsSlug re-export 便于测试同源性（归档与 watcher 用同一套路径规则）
export { projectsSlug };
