/**
 * 台账巡检认「审查员在跑」：扫 agent 会话的 subagents，按 description 认出审的是哪个任务（规则在 ledger-audit.ts）。
 * description 约定见 ledger/docs/07c-dispatch.md（`Review <T> r<N>` / `Adversarial review <T> r<N>`），实际写法更散：
 * 中文「审查 / 复验」、`round N`、`Recheck T8b P1 fixes`、`Review T8h+T11a r1`（一次审两个）。所以只认「像审查」的关键词，
 * 再把里面所有像任务号的词都拿出来（小写），由规则去跟台账 id 比——对不上的词（r1、P1）自然被忽略。
 * 只有「目录不存在」算没派过；别的读失败都返回 error，让依赖它的规则进 skipped，而不是误报「没有审查员」。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { subagentsDir } from "./jsonl-cost.js";
import type { RegistryAgent } from "./registry.js";
import { EMPTY_PROGRESS, nextProgress, subagentEndStatus, type SubagentMeta } from "./subagent-progress.js";

/** 与 bg-activity-watcher 的 SUBAGENT_SILENT_LIMIT_MS 同口径：30 分钟一行不写的 subagent 当已结束 */
const SUBAGENT_SILENT_MS = 30 * 60_000;
const REVIEW_WORD_RE = /(?:^|[^a-z])(?:re-?)?(?:review|recheck)(?![a-z])|审查|复验|复核|复审/i;
const TASK_TOKEN_RE = /(?<![A-Za-z0-9])[A-Za-z]{1,2}\d+[A-Za-z0-9]*(?![A-Za-z0-9])/g;
const ROUND_RE = /(?<![A-Za-z0-9])r(\d+)(?![A-Za-z0-9])|round\s*(\d+)|第\s*(\d+)\s*轮/i;

export type ReviewerRef = { taskId: string; round: number | null };

/** 一条 description 审的任务（小写的候选任务号）；不像审查 = 空 */
export function parseReviewDescription(desc: string): ReviewerRef[] {
  if (!REVIEW_WORD_RE.test(desc)) return [];
  const m = desc.match(ROUND_RE);
  const round = m ? Number(m[1] ?? m[2] ?? m[3]) : null;
  const tokens = (desc.match(TASK_TOKEN_RE) ?? []).map((t) => t.toLowerCase()).filter((t) => !/^r\d+$/.test(t)); // r1 是轮次不是任务号
  return [...new Set(tokens)].map((taskId) => ({ taskId, round }));
}

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

function readMeta(path: string): SubagentMeta | string {
  const metaPath = path.replace(/\.jsonl$/, ".meta.json");
  try {
    const j = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
    return { description: typeof j.description === "string" ? j.description : undefined, stoppedByUser: j.stoppedByUser === true };
  } catch (e) {
    return isEnoent(e) ? `${metaPath} 不存在` : `${metaPath} 读不了：${(e as Error).message}`;
  }
}

function stillRunning(path: string, meta: SubagentMeta, mtime: number, now: number): boolean {
  let p = EMPTY_PROGRESS;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      p = nextProgress(p, JSON.parse(line));
    } catch {
      // 末行写到一半：跳过这一行，按已读到的判
    }
  }
  return subagentEndStatus(p, meta, now - mtime, SUBAGENT_SILENT_MS) === null;
}

/** 某个 agent 的 subagents 里还在跑的审查员；读失败返回 { error } */
export function runningReviewers(agent: RegistryAgent, now: number): ReviewerRef[] | { error: string } {
  if (!agent.cwd || !agent.sessionId) return { error: `${agent.name} 在 registry 里缺 cwd / sessionId，看不到它派的审查员` };
  const dir = subagentsDir(agent.cwd, agent.sessionId);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch (e) {
    return isEnoent(e) ? [] : { error: `${dir} 读不了：${(e as Error).message}` };
  }
  const out: ReviewerRef[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const mtime = statSync(path).mtimeMs;
      if (now - mtime > SUBAGENT_SILENT_MS) continue; // 早结束的不用读 meta
      const meta = readMeta(path);
      if (typeof meta === "string") return { error: meta };
      const refs = parseReviewDescription(meta.description ?? "");
      if (refs.length && stillRunning(path, meta, mtime, now)) out.push(...refs);
    } catch (e) {
      if (isEnoent(e)) continue; // 扫描途中被清理：它已经不在跑了
      return { error: `${path} 读不了：${(e as Error).message}` };
    }
  }
  return out;
}
