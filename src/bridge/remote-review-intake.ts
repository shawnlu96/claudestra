/**
 * Bridge hook on POST /api/v1/agents/:name/messages (RRL-1): a review push from the repository owner on a handed-over PR is stashed
 * for the scheduler instead of starting a PM turn. It is taken only when all three hold — the sender is a peer token whose peer is
 * the project's scheduler.json `handoffPeer`, the text parses strictly (lib/remote-review-parse.ts), and the read-only ledger has
 * exactly one card with that PR number whose PM is the addressee. Then the raw text goes to the inbox, the PM channel gets one
 * mirror line and the peer gets 202. Anything else — including any error on the way — returns null and the message is delivered
 * to PM exactly as before. tests/remote-review-intake-hook.test.ts.
 */
import type { Database } from "bun:sqlite";
import { LedgerReader } from "../lib/ledger-read.js";
import { getMeta } from "../lib/ledger-store.js";
import { writeInbox } from "../lib/remote-review-inbox.js";
import { handoffProjects, matchRemoteCard } from "../lib/remote-review-ledger.js";
import { parseRemoteReview, remoteConclusionText } from "../lib/remote-review-parse.js";
import { readSchedulerConfig, type SchedulerConfig } from "../lib/scheduler-config.js";
import { apiJson } from "./api-respond.js";

export interface IntakeDeps {
  config(): SchedulerConfig;
  db(): Database | null;
  stash(entry: { peer: string; agent: string; taskId: string; receivedAt: number; text: string }): string;
  now(): number;
}

let reader: LedgerReader | null = null;
const live: IntakeDeps = {
  config: () => readSchedulerConfig(),
  db: () => (reader ??= new LedgerReader()).get(),
  stash: (e) => writeInbox(e),
  now: () => Date.now(),
};

export interface IntakeInput { peer?: string; agent: string; text: string; attachments: number }

/** The card id this push belongs to, or null = not ours to take. Pure reads; throws are caught by the caller. */
function claim(input: IntakeInput, deps: IntakeDeps): { taskId: string; peer: string } | null {
  const peer = input.peer;
  if (!peer || input.attachments > 0) return null;
  const projects = handoffProjects(deps.config(), peer);
  if (!projects.length) return null;
  const review = parseRemoteReview(input.text);
  const db = review && deps.db();
  if (!review || !db) return null;
  const task = matchRemoteCard(db, projects, review.number);
  return task && getMeta(db, task.project).pms.includes(input.agent) ? { taskId: task.id, peer } : null;
}

export async function interceptRemoteReview(input: IntakeInput, mirror: (line: string) => Promise<void>, deps: IntakeDeps = live): Promise<Response | null> {
  let hit: { taskId: string; peer: string } | null;
  try {
    hit = claim(input, deps);
    if (!hit) return null;
    deps.stash({ peer: hit.peer, agent: input.agent, taskId: hit.taskId, receivedAt: deps.now(), text: input.text });
  } catch (e) {
    console.warn(`⚠️ [remote-review] 拦截判定出错，按原路投给 PM：${(e as Error).message}`);
    return null;
  }
  const r = parseRemoteReview(input.text)!;
  // the mirror is a courtesy copy: the push is already in the inbox, a failed mirror loses nothing
  await mirror(`[🌐 仓库方审查] ${hit.taskId} ${r.reportId}：${remoteConclusionText(r)}，head ${r.head12}，已交调度器入账（PM 不用转）`)
    .catch((e: unknown) => console.warn(`⚠️ [remote-review] PM 频道镜像没发出：${(e as Error).message}`));
  return apiJson(202, { ok: true, accepted: true, intake: "remote_review", reportId: r.reportId });
}
