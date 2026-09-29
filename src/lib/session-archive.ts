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

import { ARCHIVE_ROOT as STATE_ARCHIVE_ROOT } from "./paths.js";
import { agentRuntime } from "./registry.js";
import { findSessionJsonlBySessionId, sessionJsonlPath } from "./session-source.js";
import { existsSync, readdirSync, realpathSync } from "fs";
import { mkdir, readdir } from "fs/promises";
import { basename, dirname, join, resolve, sep } from "path";
import { projectsSlug } from "./jsonl-cost.js";
import { copyIfLarger } from "./archive-copy.js";
import { archiveWorkflowDirs } from "./workflow-archive.js";

export const ARCHIVE_ROOT = STATE_ARCHIVE_ROOT;

/**
 * 某个 agent 的归档目录。名字拼出来不是归档根下的单层目录（带 /、..、绝对路径——URL 里的 %2F 解码后就是 /）→ null。
 * 历史端点的 agent 名直接来自请求，这是最后一道根目录校验：放过去就能读到任意目录下的会话正文（tests/session-gates.test.ts）。
 * 目录已存在时再按真实路径核一遍：它得真的是根下的「这个名字」——链接指到根外面、或指到别的 agent 的归档目录 → null。
 */
export function agentArchiveDir(agentName: string, root: string = ARCHIVE_ROOT): string | null {
  const base = resolve(root);
  const dir = resolve(base, agentName);
  if (dirname(dir) !== base || basename(dir) !== agentName) return null;
  if (!existsSync(dir)) return dir;
  try {
    return realpathSync(dir) === join(realpathSync(base), agentName) ? dir : null;
  } catch {
    return null; // 读不了真实路径（没权限）就不读：同 realpathWithin
  }
}

/** p 的真实路径（解开所有符号链接）在 root 的真实路径之下。读不了（悬空链接、没权限）→ false，调用方当它不在根下跳过 */
export function realpathWithin(p: string, root: string): boolean {
  try {
    return realpathSync(p).startsWith(realpathSync(root) + sep);
  } catch {
    return false; // 判不了就不读：这里只决定要不要读归档，漏读一个文件比读到根外面的文件安全
  }
}

/**
 * 「归档」类别区（v2.23+）—— 网页侧栏那份列表的唯一来源。
 *
 * 与 ARCHIVE_ROOT 的区别（owner 2026-09-14 纠正两次后定的）：
 *   - ARCHIVE_ROOT/<agent>/     自动快照：每日兜底给**在跑** agent 做的安全副本、
 *                               kill/fork/adopt 退役时的快照 —— 防丢机制，不进「归档」栏
 *   - ARCHIVE_ROOT/archived/    **用户手动归档**的会话本体：归档 = 把会话移进来，
 *                               它从此不在工作列表/未纳管列表；内容照旧可读
 * 归档是**类别**不是台账：目录里的文件本身就是记录，没有额外索引。
 */
export const USER_ARCHIVE_ROOT = `${ARCHIVE_ROOT}/archived`;

export interface ArchiveResult {
  ok: boolean;
  archived: string[]; // 归档产物的绝对路径
  note: string;
}

/** Pi 的子代理产物：<stem>/<runId>/run-N/session.jsonl → 归档用的 id 与路径 */
function listPiSubagentJsonls(mainPath: string): Array<{ id: string; path: string }> {
  const stem = mainPath.replace(/\.jsonl$/, "");
  const out: Array<{ id: string; path: string }> = [];
  let runIds: string[];
  try {
    runIds = readdirSync(stem).filter((n) => !n.startsWith("."));
  } catch {
    return out;
  }
  for (const runId of runIds) {
    let runs: string[];
    try {
      runs = readdirSync(join(stem, runId)).filter((n) => n.startsWith("run-"));
    } catch {
      continue; // subagent-artifacts 之类的扁平产物目录，跳过
    }
    for (const run of runs.sort()) {
      const p = join(stem, runId, run, "session.jsonl");
      if (!existsSync(p)) continue;
      // ⚠ 同一 runId 可能有 run-0/run-1…：id 带上 run 序号，避免互相覆盖
      out.push({ id: runs.length > 1 ? `${runId}-${run}` : runId, path: p });
    }
  }
  return out;
}

/** 找不到源文件时的说明：写明去哪找过，Codex / Pi 不能再报成「被 CC 清理」 */
function missingSourceNote(runtime: string, sessionId: string): string {
  if (runtime === "codex") return `Codex 会话记录不存在：~/.codex/sessions 下找不到 thread ${sessionId} 的 rollout`;
  if (runtime === "pi") return `Pi 会话文件不存在：~/.pi/agent/sessions 下找不到 ${sessionId}`;
  return "源 jsonl 不存在（可能已被 CC 清理）";
}

/** registry 条目里归档要用的几项 */
export interface ArchivableAgent {
  cwd?: string;
  sessionId?: string;
  runtime?: string;
}

/**
 * 按 registry 条目归档（manager 的 archive / kill / 换代都走这里）：runtime 跟着条目走，调用方不用记得传。
 * sessionId 缺省取条目当前值；换代时传旧 id。
 */
export function archiveAgentSession(
  agentName: string,
  info: ArchivableAgent,
  sessionId: string | undefined = info.sessionId,
  opts: { archiveRoot?: string } = {},
): Promise<ArchiveResult> {
  return archiveSession(agentName, info.cwd, sessionId ?? "", { runtime: info.runtime, archiveRoot: opts.archiveRoot });
}

/**
 * 归档一个 agent 的某个 session：主 jsonl + subagents/*.jsonl（Pi 的子代理产物会
 * 落成与 Claude Code 同构的布局，见下方 listPiSubagentJsonls）+ workflow 目录（workflow-archive.ts）。
 * 落点 ~/.claude-orchestrator/archive/<agent>/<sessionId>[.jsonl|/subagents/]。
 * 源不存在（已被 CC 清理）→ ok:false 但不抛错，调用方 best-effort。
 */
export async function archiveSession(
  agentName: string,
  cwd: string | undefined,
  sessionId: string,
  opts: { archiveRoot?: string; srcPath?: string; runtime?: string } = {},
): Promise<ArchiveResult> {
  // typeof 守卫(peer 2026-08-09):调用方把非字符串(如误传 opts 对象)落到
  // sessionId 位时,下面的路径拼接会得到必不存在的路径 → 误报「源已被 CC 清理」,
  // 一个和真实原因完全无关、还很吓人的诊断。类型不对就直说类型不对。
  if (typeof sessionId !== "string" || !sessionId) {
    return { ok: false, archived: [], note: `无效 sessionId（期望字符串，实得 ${typeof sessionId}）` };
  }
  // 定位交给运行时适配器：Claude Code 按 cwd 推算，Pi / Codex 的文件名带时间戳推不出（返回 null）→ 按 id 全库找。
  // runtime 不传 = Claude Code：Codex 的 rollout 在 ~/.codex/sessions/ 下，漏传就会被报成「找不到」（tests/session-archive.test.ts）
  const runtime = agentRuntime({ runtime: opts.runtime });
  const piRuntime = runtime === "pi";
  let src = opts.srcPath ?? "";
  if (!src && cwd) src = sessionJsonlPath(runtime, cwd, sessionId) ?? "";
  if (!src || !existsSync(src)) src = findSessionJsonlBySessionId(runtime, sessionId) ?? "";
  if (!src || !existsSync(src)) return { ok: false, archived: [], note: missingSourceNote(runtime, sessionId) };

  const dir = join(opts.archiveRoot ?? ARCHIVE_ROOT, agentName);
  await mkdir(dir, { recursive: true });
  const archived: string[] = [];

  const destMain = join(dir, `${sessionId}.jsonl`);
  if ((await copyIfLarger(src, destMain)) === "copied") archived.push(destMain);

  // subagents 对话（与主会话同级的 <sessionId>/subagents/ 目录）
  // Pi 的子代理产物布局与 CC 不同：<会话 stem>/<runId>/run-N/session.jsonl。
  // 这里把它们**落成与 CC 同构**的 <sid>/subagents/<runId>[-runN].jsonl，好让
  // 历史面板（只扫 *.jsonl）零改动就能读。
  const piSubFiles = piRuntime ? listPiSubagentJsonls(src) : [];
  for (const { id, path: subPath } of piSubFiles) {
    const destSub = join(dir, sessionId, "subagents");
    await mkdir(destSub, { recursive: true });
    const dest = join(destSub, `${id}.jsonl`);
    if ((await copyIfLarger(subPath, dest)) === "copied") archived.push(dest);
  }
  const subDir = join(src.replace(/\.jsonl$/, ""), "subagents");
  if (existsSync(subDir)) {
    const destSub = join(dir, sessionId, "subagents");
    await mkdir(destSub, { recursive: true });
    try {
      for (const f of await readdir(subDir)) {
        if (!f.endsWith(".jsonl")) continue;
        if ((await copyIfLarger(join(subDir, f), join(destSub, f))) === "copied") {
          archived.push(join(destSub, f));
        }
      }
    } catch { /* best-effort */ }
  }
  const wf = await archiveWorkflowDirs(src.replace(/\.jsonl$/, ""), join(dir, sessionId));
  archived.push(...wf.copied);

  return {
    ok: true,
    archived,
    note: (archived.length ? `已归档 ${archived.length} 个文件` : "归档已是最新（无变化）") + (wf.failed.length ? `；workflow 有 ${wf.failed.length} 个文件没拷上（下次再试）` : ""),
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
