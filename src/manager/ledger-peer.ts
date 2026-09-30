/**
 * `ledger peer-write <peer> <task> <json>`：peer 台账接口的写入执行（bridge 的 local-api/peer-ledger.ts 经 runManager 调）。
 * 能不能写在 lib/peer-ledger.ts 判，阶段合不合法由写入层按 peer 角色判；事件 actor 记 "peer:<名>"。
 * 只认 owner 身份调用（bridge 进程没有频道号）：带着自己频道号的 agent 直接调会被拒。台账身份本来就是自报的（ledger-identity.ts），
 * 本机 agent 清掉频道号照样能以 owner 身份伪造 peer:<名> 的事件；防的是对方 peer，它只能经 bridge 的接口写。
 * tests/peer-ledger.test.ts。
 */
import { LedgerError, getTask } from "../lib/ledger-store.js";
import { appendEvent, moveStage, recordReview, setTask } from "../lib/ledger-write.js";
import { lendManaged, withoutLendSteps } from "../lib/ledger-lend.js";
import { listSteps, stepsOf } from "../lib/ledger-steps.js";
import { recordAccept } from "../lib/ledger-steps-write.js";
import { parsePeerOp, peerEventView, peerLinks, peerOpDenied, peerTaskView } from "../lib/peer-ledger.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import { checkTaskRefs } from "./ledger-field-checks.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const PEER_NAME_RE = /^[\p{L}\p{N}_.-]{1,64}$/u;

function peerWrite(c: LedgerCli): Result {
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", "peer-write 只给 bridge 用（以 owner 身份调）");
  const [, peer, id, json] = c.p.pos;
  if (!peer || !PEER_NAME_RE.test(peer)) throw new LedgerError("invalid", "peer 名不合法");
  let body: unknown;
  try {
    body = JSON.parse(json ?? "");
  } catch {
    throw new LedgerError("invalid", "请求体不是合法 JSON"); // 原文可能很长，不回显
  }
  const op = parsePeerOp(body);
  if (typeof op === "string") throw new LedgerError("invalid", op);
  const task = id ? getTask(c.db, id) : null;
  const all = task ? listSteps(c.db, task.id) : [];
  const links = task ? peerLinks(task, peer, withoutLendSteps(c.db, all)) : [];
  // 本轮审查由出借单管着：谁都不能经这里写结论、推阶段、改 PR / head，只能走 lend/result（T93）
  if (task && (op.op === "review" || op.op === "stage" || op.op === "pr") && lendManaged(c.db, task.id, task.round) && (links.length || peerLinks(task, peer, all).length)) {
    throw new LedgerError("forbidden", "lend_managed：这一轮审查由出借单管理，只能经 lend/result 回写", { lend: "lend_managed" });
  }
  if (!task || !links.length) throw new LedgerError("not_found", `没有委托给 ${peer} 的任务 ${id ?? ""}`);
  const denied = peerOpDenied(op, task, stepsOf(c.db, task), peer);
  if (denied) throw new LedgerError("forbidden", denied);
  const dedup = (body as { dedup?: unknown }).dedup;
  const ctx = { actor: `peer:${peer}`, now: c.deps.now(), ...(typeof dedup === "string" && dedup ? { dedupKey: `peer:${peer}:${dedup.slice(0, 200)}` } : {}) };
  if (op.op === "note") {
    const r = appendEvent(c.db, ctx, { project: task.project, target: task.id, kind: "note", text: op.text });
    return { ok: true, event: peerEventView(r.event, peer), duplicate: r.duplicate };
  }
  if (op.op === "accept") {
    const r = recordAccept(c.db, ctx, { taskId: task.id, peer });
    return { ok: true, event: peerEventView(r.event, peer), duplicate: r.duplicate };
  }
  let r: ReturnType<typeof setTask>;
  if (op.op === "pr") {
    checkTaskRefs({ pr: op.pr, head: op.head });
    r = setTask(c.db, ctx, { id: task.id, rev: op.rev, patch: { ...(op.pr ? { pr: op.pr } : {}), ...(op.head ? { headSHA: op.head } : {}) } });
  } else if (op.op === "stage") {
    // 自报的模型和推阶段同一个事务记进它交付的那一步（被拒就一起回滚，也改不到别人那一步）
    r = moveStage(c.db, ctx, { taskId: task.id, from: op.from, to: op.to, text: op.text, model: op.model });
  } else r = recordReview(c.db, ctx, { taskId: task.id, reviewer: ctx.actor, verdict: op.verdict, p0: op.p0, p1: op.p1, p2: op.p2, text: op.text, model: op.model });
  const rows = listSteps(c.db, task.id);
  // 回给 peer 的事件也过白名单：审查事件里本机算的作者名不给（T47 复核 P2-2）
  return { ok: true, task: peerTaskView(r.row, peerLinks(r.row, peer, rows), rows, peer), event: peerEventView(r.event, peer), duplicate: r.duplicate };
}

export const PEER_CMDS: Record<string, CommandSpec> = {
  "peer-write": { valued: [], usage: "peer-write <peer> <task> <json>（bridge 专用：受托方经 peer 台账接口写委托给它的卡）", run: peerWrite },
};
