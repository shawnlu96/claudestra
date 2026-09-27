/**
 * 会话归档补上 Dynamic Workflow 的记录。session-archive.ts 只拷主 jsonl 与 subagents/ 下一层的 *.jsonl，
 * workflow 的东西在另外两处，CC 过了 cleanupPeriodDays 会连同会话一起删：
 *   <sid>/workflows/            运行 JSON（wf_*.json）与 scripts/*.js
 *   <sid>/subagents/workflows/  每个运行的 journal 与子 agent 对话
 * 落成与源同构的 <归档>/<agent>/<sid>/workflows/、<sid>/subagents/workflows/。jsonl 追加式按「更大才覆盖」，
 * 其余（运行 JSON 跑的过程中会被整个重写）按「源更新就覆盖」。
 */
import { existsSync } from "fs";
import { mkdir, readdir } from "fs/promises";
import { join } from "path";
import { copyIfLarger, copyIfNewer } from "./archive-copy.js";

const WORKFLOW_DIRS = ["workflows", join("subagents", "workflows")];

async function copyTree(src: string, dest: string, out: string[]): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true }).catch(() => []); // 目录被 CC 清掉了：没东西可拷
  if (entries.length) await mkdir(dest, { recursive: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) await copyTree(s, d, out);
    else if (e.isFile() && (await (e.name.endsWith(".jsonl") ? copyIfLarger(s, d) : copyIfNewer(s, d)))) out.push(d);
  }
}

/** srcStem = 会话 jsonl 去掉扩展名（<projects>/<slug>/<sid>），destStem = <归档>/<agent>/<sid>；返回新拷的文件 */
export async function archiveWorkflowDirs(srcStem: string, destStem: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of WORKFLOW_DIRS) {
    const src = join(srcStem, rel);
    if (existsSync(src)) await copyTree(src, join(destStem, rel), out);
  }
  return out;
}
