/**
 * 每周记忆卫生清单（设计稿 docs/design/project-memory.md §4.3）：**只报告**——列出该 PM 看一眼的记忆，处置（retract / supersede / confirm）由 PM 决定。
 * 本模块不写库：不追加 mark、不写事件（同 mem0 卫生的「只报告」红线，lib/memory-hygiene.ts）。tests/memory-metrics-hygiene.test.ts。
 * 三条理由（一条记忆可同时中几条）：
 * - not_pushed_90d：建了满 90 天，近 90 天没被任何单子推出（scheduler 事件 memoryIds）；
 * - files_gone：files 在当前 HEAD 一个都不存在（给了 HEAD 文件列表才判）；
 * - family_quiet_60d：带 family 的坑建了满 60 天，近 60 天本项目没再出现同 family 的 P1。
 * 只看还会进单子的状态（candidate / open / fixing）；fixed / retracted / superseded 已经不推了，不进清单。
 */
import type { MemoryStatus } from "./ledger-memory-fold.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { p1Hits, pushedItems, type MetricsMemory } from "./memory-metrics.js";
import { normalizedFamily } from "./scheduler-review.js";

const DAY_MS = 86_400_000;
const HYGIENE_STALE_DAYS = 90;
const HYGIENE_QUIET_DAYS = 60;
const LIVE: readonly MemoryStatus[] = ["candidate", "open", "fixing"];

type HygieneReason = "not_pushed_90d" | "files_gone" | "family_quiet_60d";

export interface HygieneMemory extends MetricsMemory { title: string; status: MemoryStatus; disputed: boolean }

export interface HygieneRow { id: string; kind: MetricsMemory["kind"]; status: MemoryStatus; disputed: boolean; title: string;
  reasons: HygieneReason[]; lastPushedAt: number | null }

export interface HygieneInput {
  memories: readonly HygieneMemory[];
  /** 本项目全部事件 */
  events: readonly LedgerEvent[];
  /** 当前 HEAD 的文件列表；null = 拿不到，不判 files_gone */
  headFiles: readonly string[] | null;
  now: number;
}

const isGlob = (p: string) => /[*?[{]/.test(p);
const present = (f: string, head: readonly string[]) => (isGlob(f) ? head.some((h) => new Bun.Glob(f).match(h)) : head.includes(f));

export function hygieneReport(input: HygieneInput): HygieneRow[] {
  const last = new Map<string, number>();
  for (const p of pushedItems(input.events)) last.set(p.id, Math.max(last.get(p.id) ?? 0, p.ts));
  const quietSince = input.now - HYGIENE_QUIET_DAYS * DAY_MS, staleSince = input.now - HYGIENE_STALE_DAYS * DAY_MS;
  const loud = new Set(p1Hits(input.events).filter((h) => h.ts >= quietSince).map((h) => h.family));
  const rows: HygieneRow[] = [];
  for (const m of input.memories) {
    if (!LIVE.includes(m.status)) continue;
    const reasons: HygieneReason[] = [];
    const lastPushedAt = last.get(m.id) ?? null;
    if (m.createdAt <= staleSince && (lastPushedAt ?? 0) < staleSince) reasons.push("not_pushed_90d");
    if (input.headFiles && m.files.length && !m.files.some((f) => present(f, input.headFiles!))) reasons.push("files_gone");
    const family = m.kind === "pitfall" && m.family ? normalizedFamily(m.family) : "";
    if (family && m.createdAt <= quietSince && !loud.has(family)) reasons.push("family_quiet_60d");
    if (reasons.length) rows.push({ id: m.id, kind: m.kind, status: m.status, disputed: m.disputed, title: m.title, reasons, lastPushedAt });
  }
  return rows.sort((a, b) => b.reasons.length - a.reasons.length || a.id.localeCompare(b.id));
}

const REASON_TEXT: Record<HygieneReason, string> = {
  not_pushed_90d: `${HYGIENE_STALE_DAYS} 天没被单子选中`, files_gone: "文件在 HEAD 全没了", family_quiet_60d: `同 family ${HYGIENE_QUIET_DAYS} 天没再出 P1`,
};

/** 给 PM 的清单正文：只列、只建议，不执行 */
export function hygieneText(project: string, rows: readonly HygieneRow[], headKnown: boolean): string {
  const head = `项目记忆卫生清单（${project}，只报告，处置由 PM 决定：memory-mark retract / supersede / confirm）`;
  const note = headKnown ? [] : ["（没拿到 HEAD 文件列表，本次不判「文件全没了」）"];
  if (!rows.length) return [head, ...note, "无需处理的记忆。"].join("\n");
  return [head, ...note, ...rows.map((r) =>
    `- ${r.id} [${r.kind} · ${r.status}${r.disputed ? " · 争议" : ""}] ${r.title}：${r.reasons.map((x) => REASON_TEXT[x]).join("；")}`)].join("\n");
}
