/**
 * `archive-workflows`：把 ~/.claude/projects 下所有带 Dynamic Workflow 目录的会话补进归档（lib/workflow-archive.ts）。
 * 以前的归档只拷对话 jsonl，workflow 的运行记录、脚本与子 agent 对话都没进来——没归档过的历史会话正是盲区，所以直接扫
 * projects 目录，不只看已归档的。能认出是哪个 agent 的（归档里有同名会话 / registry 当前会话）落到 <归档>/<agent>/<sid>/，
 * 认不出的落到 <归档>/_unassigned/<项目 slug>/<sid>/ 并在输出里列出来，别无声漏掉。幂等，失败逐个报。
 */
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ARCHIVE_ROOT, USER_ARCHIVE_ROOT } from "../lib/session-archive.js";
import { archiveWorkflowDirs, findWorkflowSessions } from "../lib/workflow-archive.js";
import { loadRegistry, output } from "./core.js";

/** sessionId → agent：归档里已有的会话（含用户手动归档区）+ registry 当前会话 */
async function sessionOwners(): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  const scan = (root: string, skip?: string) => {
    if (!existsSync(root)) return;
    for (const agent of readdirSync(root)) {
      const dir = join(root, agent);
      if (dir === skip || agent.startsWith(".") || agent === "_unassigned") continue;
      let files: string[] = [];
      try { files = readdirSync(dir); } catch { continue; } // 散落的文件不是 agent 目录：跳过
      for (const f of files) if (f.endsWith(".jsonl")) owners.set(f.slice(0, -".jsonl".length), agent);
    }
  };
  scan(ARCHIVE_ROOT, USER_ARCHIVE_ROOT);
  scan(USER_ARCHIVE_ROOT);
  for (const [name, a] of Object.entries((await loadRegistry()).agents)) if (a.sessionId) owners.set(a.sessionId, name);
  return owners;
}

export async function cmdArchiveWorkflows(): Promise<void> {
  const owners = await sessionOwners();
  const unassigned: string[] = [];
  const failed: string[] = [];
  let sessions = 0;
  let files = 0;
  for (const { slug, sid, stem } of findWorkflowSessions(join(homedir(), ".claude", "projects"))) {
    const agent = owners.get(sid);
    const dest = agent ? join(ARCHIVE_ROOT, agent, sid) : join(ARCHIVE_ROOT, "_unassigned", slug, sid);
    if (!agent) unassigned.push(`${slug}/${sid}`);
    const r = await archiveWorkflowDirs(stem, dest);
    failed.push(...r.failed);
    if (r.copied.length) sessions++, (files += r.copied.length);
  }
  output({
    ok: failed.length === 0,
    sessions,
    files,
    failed,
    unassigned,
    note: `补进归档：${sessions} 个会话、${files} 个文件${unassigned.length ? `；${unassigned.length} 个会话认不出属于哪个 agent，放在 _unassigned/` : ""}${failed.length ? `；${failed.length} 个没拷上，重跑即可` : ""}`,
  });
}
