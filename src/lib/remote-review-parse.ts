/**
 * Accept only the repo+PR+full-SHA review / redelivery shapes rendered by this repository. Parsing round-trips through the
 * same renderers byte for byte, so changed headers cannot gain automatic authority. The reply line is required but never
 * used as an address; everything below the separator stays report data. Legacy wires without repo/full SHA return null
 * for ordinary PM delivery. tests/remote-review-intake-parse.test.ts.
 */
import { nextStepOf, PUSH_MAX_BYTES, renderReviewPush, type VerdictCounts } from "./peer-pr-message.js";
import { CAP_MARK, renderRedeliveryPush } from "./peer-pr-retry.js";
import { validRemoteRepo } from "./remote-review-identity.js";

/** p1_cap = P1 with the owner's rounds used up (the next-step line of a first delivery, the cap line of a redelivery). */
type RemoteConclusion = "pass" | "p2" | "p1" | "p1_cap" | "p0";

export interface RemoteReview {
  format: "review" | "redelivery";
  /** a redelivered P1 in the format before the cap line: whether the owner's rounds were used up cannot be read (capUnknown) */
  ambiguous: boolean;
  number: number;
  round: number;
  repo: string;
  fullHead: string;
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
const HEAD = /^head：([0-9a-f]{40})$/;
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
  const redelivery = lines[1]?.startsWith("投递补发：") === true, marked = redelivery && lines[5]?.startsWith(CAP_MARK) === true;
  // the redelivery inserts one line after the title, turns 下一步 into 现状 and (a P1) adds the cap line after it
  const hd = redelivery ? 1 : 0, at = hd + (marked ? 1 : 0);
  const title = lines[0]?.match(TITLE), head = lines[1 + hd]?.match(HEAD), masked = lines[7 + at]?.match(MASKED);
  const repo = lines[5 + at]?.startsWith("仓库：") ? lines[5 + at]!.slice("仓库：".length) : "";
  const reply = lines[4 + at];
  if (!title || !head || !validRemoteRepo(repo) || !masked || !reply?.startsWith(REPLY) || lines.length < 9 + at) return null;
  const number = Number(title[1]), round = Number(title[2]);
  const read = readConclusion(title[3]!, round);
  if (!read) return null;
  const capLine = redelivery ? lines[5] : lines[3]?.slice("下一步：".length);
  const capped = read.conclusion === "p1" && capLine === (redelivery ? `${CAP_MARK}已到上限` : nextStepOf(read.counts, round));
  const report = lines.slice(8 + at).join("\n");
  const review = renderReviewPush({ repo, number, taskId: `PR${number}`, head: head[1]!, counts: read.counts, maxRounds: capped ? round : round + 1,
    replyTo: reply.slice(REPLY.length), report, masked: Number(masked[1]) });
  const same = redelivery ? REDELIVERY_STAGES.some((s) => renderRedeliveryPush(review, round, s, !marked) === text) : review === text;
  if (!same) return null;
  return { format: redelivery ? "redelivery" : "review", ambiguous: redelivery && !marked && read.conclusion === "p1", repo, fullHead: head[1]!,
    number, round, head12: head[1]!.slice(0, 12), reportId: `PR${number}-r${round}`,
    conclusion: capped ? "p1_cap" : read.conclusion, p1: read.counts.p1, p2: read.counts.p2, masked: Number(masked[1]), report };
}

/** A P1 redelivered in the format before the cap line (defined with the other lookups in remote-review-current.ts). */
export { capUnknown } from "./remote-review-current.js";

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
