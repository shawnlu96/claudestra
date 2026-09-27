/**
 * 会话归档补上 Dynamic Workflow 的记录。session-archive.ts 只拷主 jsonl 与 subagents/ 下一层的 *.jsonl，
 * workflow 的东西在另外两处，CC 过了 cleanupPeriodDays 会连同会话一起删：
 *   <sid>/workflows/            运行 JSON（wf_*.json）与 scripts/*.js
 *   <sid>/subagents/workflows/  每个运行的 journal 与子 agent 对话
 * 落成与源同构的 <归档>/<agent>/<sid>/workflows/、<sid>/subagents/workflows/。jsonl 追加式按「更大才覆盖」，
 * 其余按「内容变了就镜像、JSON 解析得了才替换」（lib/archive-copy.ts）。失败逐个报出来，不当成「没变化」。
 */
import { existsSync, readdirSync } from "fs";
import { mkdir, readdir } from "fs/promises";
import { join } from "path";
import { copyIfChanged, copyIfLarger } from "./archive-copy.js";

const WORKFLOW_DIRS = ["workflows", join("subagents", "workflows")];

export interface TreeCopyResult {
  copied: string[];
  failed: string[];
}

async function copyTree(src: string, dest: string, out: TreeCopyResult): Promise<void> {
  let entries;
  try {
    entries = await readdir(src, { withFileTypes: true });
  } catch {
    out.failed.push(src); // 读不了目录（权限 / 刚被 CC 清掉）：记失败，下次再试
    return;
  }
  if (!entries.length) return;
  try {
    await mkdir(dest, { recursive: true });
  } catch {
    out.failed.push(dest);
    return;
  }
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) await copyTree(s, d, out);
    else if (e.isFile() && !e.name.includes(".tmp-")) {
      const r = await (e.name.endsWith(".jsonl") ? copyIfLarger(s, d) : copyIfChanged(s, d));
      if (r === "copied") out.copied.push(d);
      else if (r === "failed") out.failed.push(s);
    }
  }
}

/** srcStem = 会话 jsonl 去掉扩展名（<projects>/<slug>/<sid>），destStem = <归档>/<agent>/<sid> */
export async function archiveWorkflowDirs(srcStem: string, destStem: string): Promise<TreeCopyResult> {
  const out: TreeCopyResult = { copied: [], failed: [] };
  for (const rel of WORKFLOW_DIRS) {
    const src = join(srcStem, rel);
    if (existsSync(src)) await copyTree(src, join(destStem, rel), out);
  }
  return out;
}

/** 扫 <projectsRoot>/<slug>/<sid>/ 下带 workflow 目录的会话（不管主 jsonl 还在不在：主记录被清了也要抢救 workflow） */
export function findWorkflowSessions(projectsRoot: string): Array<{ slug: string; sid: string; stem: string }> {
  const out: Array<{ slug: string; sid: string; stem: string }> = [];
  const ls = (d: string) => {
    try {
      return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return []; // 目录不在 / 没权限：当作没有
    }
  };
  for (const slug of ls(projectsRoot)) {
    for (const sid of ls(join(projectsRoot, slug))) {
      const stem = join(projectsRoot, slug, sid);
      if (WORKFLOW_DIRS.some((rel) => existsSync(join(stem, rel)))) out.push({ slug, sid, stem });
    }
  }
  return out;
}
