/**
 * A handed-over review is stashed only for a trusted handoffPeer, a strict repo+PR+full-SHA wire, and a unique matching card
 * whose PM is the addressee. Old wires without repo/full SHA always go through ordinary PM delivery, including resends.
 * An ambiguous P1 with the new identity is booked only and every copy still reaches PM normally. Other accepted wires get
 * one mirror and HTTP 202; any failed intake check falls through to ordinary delivery. tests/remote-review-intake-hook.test.ts.
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
  const task = matchRemoteCard(db, projects, review);
  if (!task || !getMeta(db, task.project).pms.includes(input.agent)) return null;
  const key = { taskId: task.id, ...review };
  return { taskId: task.id, peer, review, duplicate: !!getEventByDedup(db, remoteReviewKey(task.id, review)) || deps.waiting(key) };
}

/** A resend of a report id + head already booked or still waiting answers duplicate: nothing stashed, nothing mirrored. */
export async function interceptRemoteReview(input: IntakeInput, mirror: (line: string) => Promise<void>, deps: IntakeDeps = live): Promise<Response | null> {
  let hit: Claim | null;
  try {
    hit = claim(input, deps);
    if (!hit) return null;
    const r = hit.review;
    const key = { taskId: hit.taskId, ...r };
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
