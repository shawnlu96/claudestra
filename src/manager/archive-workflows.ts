/**
 * `archive-workflows`：把已经归档过的会话、以及每个 agent 当前会话的 Dynamic Workflow 目录补进归档
 * （lib/workflow-archive.ts）。以前的归档只拷对话 jsonl，workflow 的运行记录、脚本与子 agent 对话都没进来，
 * 这条一次性回填；以后 kill / 换代 / 每日兜底归档时会自动带上。源已被 CC 清掉的会话跳过。幂等，可重复跑。
 */
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { findJsonlBySessionId } from "../lib/jsonl-cost.js";
import { ARCHIVE_ROOT, USER_ARCHIVE_ROOT } from "../lib/session-archive.js";
import { archiveWorkflowDirs } from "../lib/workflow-archive.js";
import { loadRegistry, output } from "./core.js";

/** <归档>/<agent>/<sid>.jsonl 已有的会话 + 注册表里每个 agent 的当前会话（去重） */
async function targets(): Promise<Array<{ agent: string; sid: string }>> {
  const seen = new Set<string>();
  const out: Array<{ agent: string; sid: string }> = [];
  const add = (agent: string, sid: string) => {
    if (!sid || seen.has(`${agent}/${sid}`)) return;
    seen.add(`${agent}/${sid}`);
    out.push({ agent, sid });
  };
  if (existsSync(ARCHIVE_ROOT)) {
    for (const agent of readdirSync(ARCHIVE_ROOT)) {
      const dir = join(ARCHIVE_ROOT, agent);
      if (dir === USER_ARCHIVE_ROOT || agent.startsWith(".")) continue;
      let files: string[] = [];
      try { files = readdirSync(dir); } catch { continue; } // 不是目录（散落的文件）：跳过
      for (const f of files) if (f.endsWith(".jsonl")) add(agent, f.slice(0, -".jsonl".length));
    }
  }
  const reg = await loadRegistry();
  for (const [name, a] of Object.entries(reg.agents)) if (a.sessionId) add(name, a.sessionId);
  return out;
}

export async function cmdArchiveWorkflows(): Promise<void> {
  let sessions = 0;
  let files = 0;
  for (const { agent, sid } of await targets()) {
    const src = findJsonlBySessionId(sid);
    if (!src) continue;
    const copied = await archiveWorkflowDirs(src.replace(/\.jsonl$/, ""), join(ARCHIVE_ROOT, agent, sid));
    if (copied.length) sessions++, (files += copied.length);
  }
  output({ ok: true, sessions, files, note: files ? `补进归档：${sessions} 个会话、${files} 个文件` : "没有需要补的 workflow 记录" });
}
