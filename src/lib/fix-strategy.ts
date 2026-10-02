/** Repeated findings change the repair context before another attempt, without weakening the round-cap safety valve. */
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { normalizedFamily, p1FindingStreak, type ReviewFacts, type ReviewFinding } from "./scheduler-review.js";

export interface FixStrategy {
  mode: "continue" | "fresh_session" | "other_family";
  family: AuthorFamily;
  findings: { finding: ReviewFinding; streak: number }[];
}

/** Unknown review history refuses escalation: an incomplete round cannot authorize stopping a live worker. */
export function fixStrategy(events: readonly LedgerEvent[], facts: ReviewFacts, author: AuthorFamily, minRound = 1): FixStrategy | null {
  const findings: FixStrategy["findings"] = [];
  for (const finding of facts.findings.filter((f) => f.severity === "P1")) {
    const streak = p1FindingStreak(events, finding, facts.round, minRound);
    if (streak === null) return null;
    findings.push({ finding, streak });
  }
  const max = Math.max(0, ...findings.map((f) => f.streak));
  return { mode: max >= 4 ? "other_family" : max >= 2 ? "fresh_session" : "continue",
    family: max >= 4 ? author === "claude" ? "codex" : "claude" : author, findings };
}

export const DISPUTE_RULE = "不同意某条 P1：交付时写 disputes:[{findingId,reason}]（reason ≤1000 字），不要硬改或无视。" +
  "独立跨模型新会话只裁该条：upheld 必须修且不能再次 dispute；overturned 关闭该条。";
export const FIX_STRATEGY_RULE = "同一条 P1 连续 2 轮未修好：新会话修；连续 4 轮：换另一家模型修，审查仍跨模型。" +
  "先把复现写成测试并确认失败，再修到通过；交付说明写「复现测试：<测试名>」及先红后绿结果。第 8 轮安全阀仍生效。";

export interface FixHistoryRound {
  round: number;
  head: string;
  reportPath: string;
  report: string;
  diffSummary: string;
  probes: string[];
}

/** Read report bodies and diffs outside the planner; missing material stops dispatch rather than emitting a partial repair order. */
export async function fixHistory(events: readonly LedgerEvent[], strategy: FixStrategy, readReport: (path: string) => Promise<string>,
  summarizeDiff: (from: string | null, to: string) => Promise<string>): Promise<FixHistoryRound[]> {
  const rows: FixHistoryRound[] = [];
  let previousHead: string | null = null;
  for (const event of events.filter((e) => e.kind === "review")) {
    const data = event.data;
    if (typeof data.head !== "string") continue;
    const findings = Array.isArray(data.findings) ? data.findings as ReviewFinding[] : [];
    const matched = findings.filter((f) => strategy.findings.some((x) => x.finding.findingId === f.findingId || normalizedFamily(x.finding.family) === normalizedFamily(f.family)));
    if (matched.length) {
      if (typeof data.path !== "string" || typeof data.round !== "number") throw new Error("修复历史缺审查报告路径或轮次");
      const report = await readReport(data.path);
      if (!report.trim()) throw new Error(`修复历史报告为空：${data.path}`);
      rows.push({ round: data.round, head: data.head, reportPath: data.path, report,
        diffSummary: await summarizeDiff(previousHead, data.head), probes: matched.map((f) => f.probe) });
    }
    previousHead = data.head;
  }
  return rows;
}
