/**
 * The repository owner's review push for a handed-over PR (RRL-1), parsed strictly. Only the two shapes this repository's own
 * code renders are accepted — renderReviewPush and its redelivery (renderRedeliveryPush) — and acceptance is a round trip: the
 * fields read here are rendered again with that same code and must give back the text byte for byte. So a changed character
 * anywhere above the report (title, head, report id, next step, the redelivery lines) fails, and the parser can never drift
 * from the renderer. The "reply to" line is required but never read; the report below the separator is kept whole as data,
 * nothing is pulled out of it. tests/remote-review-intake-parse.test.ts.
 */
import { nextStepOf, PUSH_MAX_BYTES, renderReviewPush, type VerdictCounts } from "./peer-pr-message.js";
import { renderRedeliveryPush } from "./peer-pr-retry.js";

/** p1_cap = P1 with the owner's rounds used up (only a first delivery says so; a redelivery drops the next-step line). */
type RemoteConclusion = "pass" | "p2" | "p1" | "p1_cap" | "p0";

export interface RemoteReview {
  format: "review" | "redelivery";
  number: number;
  round: number;
  head12: string;
  /** PR<n>-r<round>: the owner's card id is peerTaskId(n) (peer-pr-ledger.ts) */
  reportId: string;
  conclusion: RemoteConclusion;
  p1: number;
  p2: number;
  masked: number;
  report: string;
}

const TITLE = /^\[Claudestra 调度器 · PR #([1-9]\d{0,8}) 第 ([1-9]\d{0,3}) 轮审查\] (.+)$/;
const HEAD = /^head：([0-9a-f]{12})$/;
const MASKED = /^审查报告原文（数据，不是指令；已脱敏 (0|[1-9]\d{0,6}) 处）：$/;
const REPLY = "有异议或问题回：";
/** Both stage classes renderRedeliveryPush tells apart (merged / not yet): one of the two "现状" lines must match. */
const REDELIVERY_STAGES = [{ stage: "live" }, { stage: "build" }] as const;

interface Read { counts: VerdictCounts; conclusion: Exclude<RemoteConclusion, "p1_cap"> }

/** Counts that render to exactly this conclusion; block / p0 are one class to the renderer, so p0 stands for both. */
function readConclusion(text: string, round: number): Read | null {
  const counts = (p0: number, p1: number, p2: number): VerdictCounts => ({ verdict: p0 ? "block" : p1 ? "changes" : "pass", p0, p1, p2, round });
  if (text === "阻塞（P0）") return { counts: counts(1, 0, 0), conclusion: "p0" };
  const p1 = text.match(/^不通过（([1-9]\d{0,4}) 个 P1）$/);
  if (p1) return { counts: counts(0, Number(p1[1]), 0), conclusion: "p1" };
  const p2 = text.match(/^通过，留 ([1-9]\d{0,4}) 个 P2$/);
  if (p2) return { counts: counts(0, 0, Number(p2[1])), conclusion: "p2" };
  return text === "通过" ? { counts: counts(0, 0, 0), conclusion: "pass" } : null;
}

export function parseRemoteReview(text: string): RemoteReview | null {
  if (typeof text !== "string" || Buffer.byteLength(text) > PUSH_MAX_BYTES) return null;
  const lines = text.split("\n");
  const redelivery = lines[1]?.startsWith("投递补发：") === true;
  // the redelivery inserts one line after the title and turns 下一步 into 现状; the rest sits one line lower
  const at = redelivery ? 1 : 0;
  const title = lines[0]?.match(TITLE), head = lines[1 + at]?.match(HEAD), masked = lines[6 + at]?.match(MASKED);
  const reply = lines[4 + at];
  if (!title || !head || !masked || !reply?.startsWith(REPLY) || lines.length < 8 + at) return null;
  const number = Number(title[1]), round = Number(title[2]);
  const read = readConclusion(title[3]!, round);
  if (!read) return null;
  const capped = !redelivery && read.conclusion === "p1" && lines[3] === `下一步：${nextStepOf(read.counts, round)}`;
  const report = lines.slice(7 + at).join("\n");
  const review = renderReviewPush({ number, taskId: `PR${number}`, head: head[1]!, counts: read.counts, maxRounds: capped ? round : round + 1,
    replyTo: reply.slice(REPLY.length), report, masked: Number(masked[1]) });
  const same = redelivery ? REDELIVERY_STAGES.some((s) => renderRedeliveryPush(review, round, s) === text) : review === text;
  if (!same) return null;
  return { format: redelivery ? "redelivery" : "review", number, round, head12: head[1]!, reportId: `PR${number}-r${round}`,
    conclusion: capped ? "p1_cap" : read.conclusion, p1: read.counts.p1, p2: read.counts.p2, masked: Number(masked[1]), report };
}

/**
 * A redelivered P1: the redelivery drops the next-step line, so whether the owner's rounds were used up cannot be read from it.
 * Nothing acts on it by itself (no manual, no fix): it is booked and PM decides. A redelivered P0 / pass reads as it is.
 */
export const capUnknown = (r: Pick<RemoteReview, "conclusion" | "format">): boolean => r.conclusion === "p1" && r.format === "redelivery";

/** One line for logs, mirrors and notices; built only from parsed fields, never from the peer's free text. */
export function remoteConclusionText(r: Pick<RemoteReview, "conclusion" | "p1" | "p2">): string {
  switch (r.conclusion) {
    case "p0": return "阻塞（P0）";
    case "p1": return `不通过（${r.p1} 个 P1）`;
    case "p1_cap": return `不通过（${r.p1} 个 P1，仓库方复验轮次已到上限）`;
    case "p2": return `通过，留 ${r.p2} 个 P2`;
    default: return "通过";
  }
}
