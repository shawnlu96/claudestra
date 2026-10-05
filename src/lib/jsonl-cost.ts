/**
 * JSONL 会话文件 → token 用量 rollup
 *
 * Claude Code 把每轮对话写到 ~/.claude/projects/<slug>/<sessionId>.jsonl。
 * 每条 assistant 消息带 `usage: { input_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens, output_tokens }`。按 model 分类累加。
 */

import { existsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { realpathCached } from "./realpath-cache.js";
import { runtimeForSessionPath, translateSessionLine } from "./session-source.js";

export interface Usage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  requests: number;
}

export interface ModelUsage extends Usage {
  model: string;
}

export function emptyUsage(): Usage {
  return { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, requests: 0 };
}

function addUsage(acc: Usage, u: any): void {
  if (!u) return;
  acc.input += Number(u.input_tokens || 0);
  acc.cacheCreation += Number(u.cache_creation_input_tokens || 0);
  acc.cacheRead += Number(u.cache_read_input_tokens || 0);
  acc.output += Number(u.output_tokens || 0);
  acc.requests += 1;
}

/**
 * 一次 API 响应的去重键。Claude Code 把一个响应的每个内容块（thinking / text / tool_use）各写一行，
 * 每行都带这个响应的 usage；fork / resume 又会把历史行抄进新文件。逐行累加会多算约一倍（2026-09-28 实测
 * 2495 行只有 1209 个响应）。同一响应的几行 usage 不一定相同：流式落盘时先写的行 output_tokens 偏小，
 * **最后写的那行才完整**——两个消费者都取它（倒扫用 firstSeen，正扫用 keepLatest）。
 * 已知缺口：没有 id 的记录逐条计（Pi 由 pi-session 把 entry.id 填进 message.id；老格式没有就算了）；
 * Codex 按文件做累计值差分、不走这里，fork 出来的 rollout 若抄了累计计数器会重复计（本机未见）。
 */
export function usageDedupKey(rec: any): string | null {
  const id = rec?.message?.id;
  if (typeof id !== "string" || !id) return null;
  return `${id}:${typeof rec.requestId === "string" ? rec.requestId : ""}`;
}

/** 从尾往前扫的去重：同一响应第一次遇到（= 最后写的那行）返回 true 计入，之后的返回 false。没有键的一律计 */
export function firstSeen(seen: Set<string>, rec: any): boolean {
  const k = usageDedupKey(rec);
  if (k === null) return true;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
}

/**
 * 从头往后扫的去重：有键的记录先存进 latest（后写的覆盖先写的），扫完再统一计；返回 true = 没有键，当场计。
 * 调用方最后遍历 latest.values()。
 */
function keepLatest(latest: Map<string, any>, rec: any): boolean {
  const k = usageDedupKey(rec);
  if (k === null) return true;
  latest.set(k, rec);
  return false;
}

/**
 * 解析一个 JSONL 文件，按 model 分桶返回用量。
 * 可选 sinceTs（ms）只统计晚于该时间戳的记录。
 */
export async function rollupJsonl(path: string, sinceTs = 0): Promise<ModelUsage[]> {
  if (!existsSync(path)) return [];
  const text = await Bun.file(path).text();
  const buckets = new Map<string, Usage>();
  const latest = new Map<string, any>();
  const add = (rec: any) => {
    const model = rec?.message?.model || "unknown";
    const acc = buckets.get(model) || emptyUsage();
    addUsage(acc, rec.message.usage);
    buckets.set(model, acc);
  };
  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec: any;
    // v2.23+ Pi 的会话行在这里归一成 Claude Code 形状（含 usage 键名），
    // 路径自带判据，不必把 runtime 一路透传
    rec = translateSessionLine(runtimeForSessionPath(path), line);
    if (!rec) continue;
    if (rec.type !== "assistant") continue;
    if (sinceTs > 0) {
      const ts = new Date(rec.timestamp).getTime();
      if (!Number.isFinite(ts) || ts < sinceTs) continue;
    }
    if (!rec?.message?.usage) continue;
    if (keepLatest(latest, rec)) add(rec);
  }
  for (const rec of latest.values()) add(rec);
  return [...buckets.entries()].map(([model, u]) => ({ model, ...u }));
}

/**
 * cwd → Claude Code projects 目录 slug（"-" + 去掉开头 / 后把 / 换成 -）。
 *
 * ⚠️ 必须先 realpath：Claude Code 是按解析符号链接后的 cwd 算 slug 的。
 * macOS 上 /tmp → /private/tmp，注册 cwd=/tmp 的 agent 实际 jsonl 落在
 * -private-tmp/，不 resolve 的话 watcher 会盯着永远不存在的 -tmp/ 目录
 * （2026-07-09 agent-temp 实例：流式输出全程静默）。
 */
export function projectsSlug(cwd: string): string {
  const resolved = realpathCached(cwd); // 目录已不存在 → 按原样算，让上层走 findJsonlBySessionId 兜底
  // v2.16.1 对齐 Claude Code 的真实 slug 规则:**所有**非字母数字都转 `-`,
  // 不只是 `/`。此前保留 `_` 导致 cwd 含下划线的 agent 整条链路失明——live
  // 历史读不出、归档 sweeper 定位失败(数据丢失风险)、cost 漏计(2026-08-02
  // peer HedeMacBook-Pro 实锤:cwd futures_data → CC 实际目录 futures-data)。
  // 本机双证:.claude-orchestrator 的 `.` 也被 CC 转成 `-`,projects 下无任何
  // 含 `_` 的目录。
  return "-" + resolved.replace(/^\//, "").replace(/[^A-Za-z0-9]/g, "-");
}

/** 旧版 slug(只转 `/`)——projectJsonlPath 的兼容回退用,勿新增调用方。 */
function legacySlug(cwd: string): string {
  const resolved = realpathCached(cwd);
  return "-" + resolved.replace(/^\//, "").replace(/\//g, "-");
}

/**
 * cwd → Claude Code projects 目录（jsonl 落点）。
 * 抽出来是给 runtime 感知的 session-source 用（列目录时不用再拿假 sessionId 推）。
 */
export function projectsDir(cwd: string): string {
  return `${process.env.HOME}/.claude/projects/${projectsSlug(cwd)}`;
}

/**
 * 根据项目 slug 自动推 JSONL 路径（推算落空时按 sessionId 全库找，见函数末尾）。
 * 兼容垫片:新规则路径不存在而旧规则(只转 `/`)路径存在时回退旧路径——
 * 兜住 CC slug 规则与我们推断有出入的任何字符类(如 CJK 路径行为未实证),
 * 存量正常读,不因规则修正引入新盲区。
 */
export function projectJsonlPath(cwd: string, sessionId: string): string {
  const root = `${process.env.HOME}/.claude/projects`;
  const primary = `${root}/${projectsSlug(cwd)}/${sessionId}.jsonl`;
  if (existsSync(primary)) return primary;
  const legacy = `${root}/${legacySlug(cwd)}/${sessionId}.jsonl`;
  if (legacy !== primary && existsSync(legacy)) return legacy;
  // 会话搬家了：Claude Code 的 EnterWorktree 把整个会话文件挪进 worktree 的项目目录（记录里一条 relocated），
  // registry 的 cwd 还是原目录。按 id 找新家；哪都没有（还没生成）才返回推算路径
  return findJsonlBySessionId(sessionId) ?? primary;
}

/** 会话的 subagent 记录目录：跟着会话文件走（进了 worktree 的会话整个搬进新的项目目录，见 projectJsonlPath） */
export function subagentsDir(cwd: string, sessionId: string): string {
  return join(dirname(projectJsonlPath(cwd, sessionId)), sessionId, "subagents");
}

/** 兜底：如果上面的路径不存在，遍历 projects 子目录找 session */
export function findJsonlBySessionId(sessionId: string): string | null {
  const root = `${process.env.HOME}/.claude/projects`;
  if (!existsSync(root)) return null;
  let slugs: string[] = [];
  try { slugs = readdirSync(root); } catch { return null; }
  for (const slug of slugs) {
    const p = `${root}/${slug}/${sessionId}.jsonl`;
    if (existsSync(p)) return p;
  }
  return null;
}

/** 合并多条 ModelUsage（跨 agent sum） */
export function mergeByModel(rows: ModelUsage[]): ModelUsage[] {
  const m = new Map<string, Usage>();
  for (const r of rows) {
    const acc = m.get(r.model) || emptyUsage();
    acc.input += r.input;
    acc.cacheCreation += r.cacheCreation;
    acc.cacheRead += r.cacheRead;
    acc.output += r.output;
    acc.requests += r.requests;
    m.set(r.model, acc);
  }
  return [...m.entries()].map(([model, u]) => ({ model, ...u }));
}
