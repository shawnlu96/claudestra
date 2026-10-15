/**
 * Bridge hook on POST /api/v1/agents/:name/messages (RRL-1): a review push from the repository owner on a handed-over PR is stashed
 * for the scheduler instead of starting a PM turn. It is taken only when all three hold — the sender is a peer token whose peer is
 * the project's scheduler.json `handoffPeer`, the text parses strictly (lib/remote-review-parse.ts), and the read-only ledger has
 * exactly one card with that PR number whose PM is the addressee. Then the raw text goes to the inbox, the PM channel gets one
 * mirror line and the peer gets 202. An old-format redelivered P1 (capUnknown: the cap cannot be read) is never taken: every
 * copy returns null, so a retry after a failed PM delivery reaches PM again; only the first is stashed, to be booked. Anything
 * else — including any error on the way — returns null and the message is delivered to PM exactly as before.
 * tests/remote-review-intake-hook.test.ts.
 */
import type { Database } from "bun:sqlite";
import { LedgerReader } from "../lib/ledger-read.js";
import { getEventByDedup, getMeta } from "../lib/ledger-store.js";
import { inInbox, writeInbox, type InboxKey } from "../lib/remote-review-inbox.js";
import { handoffProjects, matchRemoteCard, remoteReviewKey } from "../lib/remote-review-read.js";
import { capUnknown, parseRemoteReview, remoteConclusionText, type RemoteReview } from "../lib/remote-review-parse.js";
import { readSchedulerConfig, type SchedulerConfig } from "../lib/scheduler-config.js";
import { apiJson } from "./api-respond.js";

export interface IntakeDeps {
  config(): SchedulerConfig;
  db(): Database | null;
  stash(entry: { peer: string; agent: string; taskId: string; receivedAt: number; text: string }, key: InboxKey): string;
  /** the same key is already in the inbox, not booked yet */
  waiting(key: InboxKey): boolean;
  now(): number;
}

let reader: LedgerReader | null = null;
const live: IntakeDeps = {
  config: () => readSchedulerConfig(),
  db: () => (reader ??= new LedgerReader()).get(),
  stash: (e, key) => writeInbox(e, key),
  waiting: (key) => inInbox(key),
  now: () => Date.now(),
};

export interface IntakeInput { peer?: string; agent: string; text: string; attachments: number }
interface Claim { taskId: string; peer: string; review: RemoteReview; duplicate: boolean }

/** The card this push belongs to, or null = not ours to take. Pure reads; throws are caught by the caller. */
function claim(input: IntakeInput, deps: IntakeDeps): Claim | null {
  const peer = input.peer;
  if (!peer || input.attachments > 0) return null;
  const projects = handoffProjects(deps.config(), peer);
  if (!projects.length) return null;
  const review = parseRemoteReview(input.text);
  const db = review && deps.db();
  if (!review || !db) return null;
  const task = matchRemoteCard(db, projects, review.number);
  if (!task || !getMeta(db, task.project).pms.includes(input.agent)) return null;
  const key = { taskId: task.id, reportId: review.reportId, head12: review.head12 };
  return { taskId: task.id, peer, review, duplicate: !!getEventByDedup(db, remoteReviewKey(task.id, review)) || deps.waiting(key) };
}

/** A resend of a report id + head already booked or still waiting answers duplicate: nothing stashed, nothing mirrored. */
export async function interceptRemoteReview(input: IntakeInput, mirror: (line: string) => Promise<void>, deps: IntakeDeps = live): Promise<Response | null> {
  let hit: Claim | null;
  try {
    hit = claim(input, deps);
    if (!hit) return null;
    const r = hit.review;
    const key = { taskId: hit.taskId, reportId: r.reportId, head12: r.head12 };
    if (!hit.duplicate) deps.stash({ peer: hit.peer, agent: input.agent, taskId: hit.taskId, receivedAt: deps.now(), text: input.text }, key);
    // PM gets every copy the normal way and decides; the inbox only keeps one for the record
    if (capUnknown(r)) return null;
  } catch (e) {
    console.warn(`⚠️ [remote-review] 拦截判定出错，按原路投给 PM：${(e as Error).message}`);
    return null;
  }
  const r = hit.review;
  if (hit.duplicate) return apiJson(202, { ok: true, accepted: true, duplicate: true, intake: "remote_review", reportId: r.reportId });
  // the mirror is a courtesy copy: the push is already in the inbox, a failed mirror loses nothing
  await mirror(`[🌐 仓库方审查] ${hit.taskId} ${r.reportId}：${remoteConclusionText(r)}，head ${r.head12}，已交调度器入账（PM 不用转）`)
    .catch((e: unknown) => console.warn(`⚠️ [remote-review] PM 频道镜像没发出：${(e as Error).message}`));
  return apiJson(202, { ok: true, accepted: true, intake: "remote_review", reportId: r.reportId });
}
