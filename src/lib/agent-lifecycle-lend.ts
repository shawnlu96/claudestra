/** Pure B terminal adapter. Canonical B readers supply every fact; a local task stage never decides remote order completion. */
import type { LifecyclePolicy } from "./agent-lifecycle-config.js";
import type { CardWorker } from "./agent-lifecycle-store.js";
import type { CardFacts, Plan } from "./agent-lifecycle.js";
import type { LendRow } from "./lend-journal.js";
import { archiveHash, workerArchiveFactsProblem, type WorkerArchiveFacts,
  type WorkerArchiveIdentity, type WorkerArchiveRecord } from "./lend-worker-registry-archive.js";

export interface LendLifecycleInput {
  identity: WorkerArchiveIdentity;
  row: LendRow | null;
  record: WorkerArchiveRecord;
  index: ReadonlyMap<string, CardWorker>;
  cards: readonly CardFacts[];
  pms: ReadonlySet<string>;
  facts: WorkerArchiveFacts;
  /** A separate B port policy; never inherit the ordinary LIFE1 production on/idle/memory policy. */
  mode?: LifecyclePolicy["mode"];
}
export type LendLifecyclePlan = { ok: true; plan: Plan } | { ok: false; code: "blocked-capability" | "protected"; reason: string };

function sourceProblem(input: LendLifecycleInput): string | null {
  const { row, identity, index, cards, pms } = input;
  if (!row || !row.peer || !row.fp || !row.wire || row.wire.order.orderId !== identity.orderId
    || typeof row.wire.order.taskId !== "string" || !row.wire.order.taskId || !row.wire.text) return "B 正规 claim / 实例来源不可核";
  if (row.state === "acked" && row.receipt?.taskId !== row.wire.order.taskId) return "B 已验证回执的远端卡来源不匹配";
  if (pms.has(identity.agent)) return "本机 PM 保护";
  const links = index.get(identity.agent)?.links;
  if (!links?.length) return "cardWorkerIndex 无 B 归属";
  const remote = links.filter((l) => l.source === "lend_orders");
  if (remote.length !== 1 || remote[0].taskId !== null || !remote[0].lend
    || archiveHash(JSON.stringify(remote[0].lend)) !== archiveHash(JSON.stringify(row))) return "B reader 来源漂移 / 关联其他订单";
  for (const link of links.filter((l) => l.source !== "lend_orders")) {
    if (link.sessionId && link.sessionId !== identity.sessionId) return "本机关联登记属于另一会话";
    const card = cards.find((c) => c.id === link.taskId);
    if (!card || card.extraError || card.frozen) return "本机关联卡冻结 / 权限 / 归属未知";
    if (!["verified", "done", "cancelled"].includes(card.stage)) return "其他本机任务未终态，保留";
  }
  return null;
}

/** Plans only the exact B terminal action. Observe/off and unknown authority leave the capability closed. */
export function planLendLifecycle(input: LendLifecycleInput): LendLifecyclePlan {
  const problem = workerArchiveFactsProblem(input.identity, input.row, input.record, input.facts) ?? sourceProblem(input);
  if (problem) return { ok: false, code: "protected", reason: problem };
  if ((input.mode ?? "observe") !== "on") return { ok: false, code: "blocked-capability", reason: "B 终态退休端口为 observe/off" };
  return { ok: true, plan: {
    actions: [{ agent: input.identity.agent, taskId: null, role: "other", rule: "lend_terminal", idleMs: null,
      sessionId: input.identity.sessionId, cwd: input.record.cwd, mode: "archive-only-no-disk", reason: `B 订单 ${input.identity.orderId} 已 ${input.row!.state}`,
      lend: { identity: { ...input.identity }, peer: input.row!.peer, fp: input.row!.fp!,
        journalHash: archiveHash(JSON.stringify(input.row)), recordHash: archiveHash(JSON.stringify(input.record)) } }],
    memory: [], cleanups: [], frozen: [], kept: [], live: 0, registerFailed: 0, swapPct: null,
  } };
}
