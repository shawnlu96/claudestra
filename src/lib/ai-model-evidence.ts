/**
 * 「实际接的是哪个模型」的证据（T91；tests/ai-model-evidence.test.ts）：从最近的会话记录里数最近 N 次响应的模型分布。
 *   Claude Code  assistant 行的 message.model——接口返回的模型名；接了 DeepSeek 之类的第三方，这里写的就是对方回的名字
 *   Pi           assistant 行的 provider/model
 *   Codex        rollout 不记响应模型：token_usage_record（老版本退回 token_count）按 turn_id 归到那一回合 turn_context.model，
 *                标 request_model，不冒充响应模型
 * 同一次响应在多行 / fork 出的文件里重复出现，按响应 id 去重。只读文件尾部，不解析全文。
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { codexRolloutRootOrSkip } from "./codex-home.js";
import { listRecentJsonl } from "./machine-usage.js";
import { piAgentDir } from "./pi-session.js";
import { claudeProjectsRoot } from "./runtimes/claude-code.js";

export type EvidenceRuntime = "claude-code" | "codex" | "pi";

export interface ModelHit {
  /** 去重键（响应 id）；拿不到 = null，不参与去重 */
  id: string | null;
  ts: number;
  model: string;
}

export interface ModelEvidence {
  source: "response_model" | "request_model";
  /** 实际数到的响应次数（≤ limit）；0 = 没有可用记录，models 为空 */
  sample: number;
  limit: number;
  from: number | null;
  to: number | null;
  models: { model: string; count: number; share: number }[];
  filesScanned: number;
}

type AnyRecord = Record<string, any>;

/** 模型名进 API 与网页：只放行短的安全字符，别的记成 unknown（会话文件内容不可信） */
const MODEL_RE = /^[\w.:@/[\]+-]{1,100}$/;
const safeModel = (v: unknown): string | null => (typeof v === "string" && v && v !== "<synthetic>" ? (MODEL_RE.test(v) ? v : "unknown") : null);

function parse(line: string): AnyRecord | null {
  try { return JSON.parse(line); } catch { return null; } // 尾读窗口的半截首行 / 写到一半的末行：丢掉这一条
}

export function claudeHits(lines: string[]): ModelHit[] {
  const out: ModelHit[] = [];
  for (const line of lines) {
    if (!line.includes('"assistant"')) continue;
    const e = parse(line);
    if (e?.type !== "assistant") continue;
    const model = safeModel(e.message?.model);
    if (!model) continue;
    out.push({ id: typeof e.message.id === "string" ? `cc:${e.message.id}` : null, ts: Date.parse(e.timestamp), model });
  }
  return out;
}

export function piHits(lines: string[]): ModelHit[] {
  const out: ModelHit[] = [];
  for (const line of lines) {
    if (!line.includes('"assistant"')) continue;
    const e = parse(line);
    const m = e?.type === "message" ? e.message : null;
    if (m?.role !== "assistant") continue;
    const model = safeModel(m.model);
    if (!model) continue;
    const provider = safeModel(m.provider);
    out.push({ id: typeof e!.id === "string" ? `pi:${e!.id}` : null, ts: Date.parse(e!.timestamp), model: provider ? `${provider}/${model}` : model });
  }
  return out;
}

/** 有 token_usage_record 的 rollout 按它计（一次请求一条），否则退回带 info 的 token_count */
export function codexHits(lines: string[]): ModelHit[] {
  const byTurn = new Map<string, string>();
  let current: string | null = null;
  const records: ModelHit[] = [];
  const counts: ModelHit[] = [];
  for (const line of lines) {
    if (!/"(turn_context|token_usage_record|token_count)"/.test(line)) continue;
    const e = parse(line);
    const p: AnyRecord = e?.payload && typeof e.payload === "object" ? e.payload : {};
    const ts = Date.parse(e?.timestamp);
    if (e?.type === "turn_context") {
      const m = safeModel(p.model ?? p.collaboration_mode?.settings?.model);
      if (m) {
        current = m;
        if (typeof p.turn_id === "string") byTurn.set(p.turn_id, m);
      }
    } else if (e?.type === "token_usage_record") {
      const m = (typeof p.turn_id === "string" && byTurn.get(p.turn_id)) || current;
      if (m) records.push({ id: typeof p.response_id === "string" ? `codex:${p.response_id}` : null, ts, model: m });
    } else if (e?.type === "event_msg" && p.type === "token_count" && p.info && current) {
      counts.push({ id: null, ts, model: current });
    }
  }
  return records.length ? records : counts;
}

/** 最近 limit 次（按时间倒序、按 id 去重）的模型分布；share 保留两位小数 */
export function modelDistribution(hits: ModelHit[], limit: number, source: ModelEvidence["source"], filesScanned: number): ModelEvidence {
  const seen = new Set<string>();
  const picked: ModelHit[] = [];
  for (const h of [...hits].filter((x) => Number.isFinite(x.ts)).sort((a, b) => b.ts - a.ts)) {
    if (h.id) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
    }
    picked.push(h);
    if (picked.length >= limit) break;
  }
  const counts = new Map<string, number>();
  for (const h of picked) counts.set(h.model, (counts.get(h.model) ?? 0) + 1);
  const models = [...counts].map(([model, count]) => ({ model, count, share: Math.round((count / picked.length) * 100) / 100 }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
  return {
    source, sample: picked.length, limit, models, filesScanned,
    from: picked.length ? picked[picked.length - 1]!.ts : null,
    to: picked.length ? picked[0]!.ts : null,
  };
}

// ── 读文件 ───────────────────────────────────────────────────────────────

const TAIL_BYTES = 1024 * 1024;
const MAX_FILES = 40;
const LOOKBACK_MS = 14 * 24 * 3600_000;
export const EVIDENCE_LIMIT = 200;

async function tailLines(path: string): Promise<string[]> {
  try {
    const size = statSync(path).size;
    return (await Bun.file(path).slice(Math.max(0, size - TAIL_BYTES)).text()).split("\n");
  } catch (e) {
    console.error(`[ai-inventory] 读会话记录失败（跳过这个文件）: ${(e as Error).message}`);
    return [];
  }
}

const mtimeOf = (p: string) => {
  try { return statSync(p).mtimeMs; } catch { return 0; } // 扫描途中被删：排到最后，不会被读
};

/**
 * 按 mtime 从新到旧读尾部：已攒够 limit 条、且下一个文件最后写入都早于已攒到的第 limit 新的那条时停——
 * 它和更旧的文件里不可能再有更新的响应。
 */
export async function scanEvidence(
  roots: string[], extract: (lines: string[]) => ModelHit[], source: ModelEvidence["source"], limit = EVIDENCE_LIMIT, now = Date.now(),
): Promise<ModelEvidence> {
  const files = listRecentJsonl(roots, now - LOOKBACK_MS).map((p) => ({ p, m: mtimeOf(p) })).sort((a, b) => b.m - a.m);
  const hits: ModelHit[] = [];
  let scanned = 0;
  for (const f of files) {
    if (scanned >= MAX_FILES) break;
    if (hits.length >= limit) {
      const nth = hits.map((h) => h.ts).sort((a, b) => b - a)[limit - 1]!;
      if (f.m < nth) break;
    }
    scanned++;
    hits.push(...extract(await tailLines(f.p)));
  }
  return modelDistribution(hits, limit, source, scanned);
}

export async function collectModelEvidence(limit = EVIDENCE_LIMIT): Promise<Record<EvidenceRuntime, ModelEvidence>> {
  const codexRoot = codexRolloutRootOrSkip("AI 能力清单的 Codex 模型证据");
  const [cc, codex, pi] = await Promise.all([
    scanEvidence([claudeProjectsRoot()], claudeHits, "response_model", limit),
    scanEvidence(codexRoot ? [codexRoot] : [], codexHits, "request_model", limit),
    scanEvidence([join(piAgentDir(), "sessions")], piHits, "response_model", limit),
  ]);
  return { "claude-code": cc, codex, pi };
}
