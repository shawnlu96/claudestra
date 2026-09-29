/**
 * `ledger peer-write <peer> <task> <json>`：peer 台账接口的写入执行（bridge 的 local-api/peer-ledger.ts 经 runManager 调）。
 * 能不能写在 lib/peer-ledger.ts 判，阶段合不合法由写入层按 peer 角色判；事件 actor 记 "peer:<名>"。
 * 只认 owner 身份调用（bridge 进程没有频道号）：带着自己频道号的 agent 直接调会被拒。台账身份本来就是自报的（ledger-identity.ts），
 * 本机 agent 清掉频道号照样能以 owner 身份伪造 peer:<名> 的事件；防的是对方 peer，它只能经 bridge 的接口写。
 * tests/peer-ledger.test.ts。
 */
import { LedgerError, getTask } from "../lib/ledger-store.js";
import { appendEvent, moveStage, recordReview, setTask } from "../lib/ledger-write.js";
import { parsePeerOp, peerLinks, peerOpDenied, peerTaskView } from "../lib/peer-ledger.js";
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
  const links = task ? peerLinks(task, peer) : [];
  if (!task || !links.length) throw new LedgerError("not_found", `没有委托给 ${peer} 的任务 ${id ?? ""}`);
  const denied = peerOpDenied(op, task, links);
  if (denied) throw new LedgerError("forbidden", denied);
  const dedup = (body as { dedup?: unknown }).dedup;
  const ctx = { actor: `peer:${peer}`, now: c.deps.now(), ...(typeof dedup === "string" && dedup ? { dedupKey: `peer:${peer}:${dedup.slice(0, 200)}` } : {}) };
  if (op.op === "note") {
    const r = appendEvent(c.db, ctx, { project: task.project, target: task.id, kind: "note", text: op.text });
    return { ok: true, event: r.event, duplicate: r.duplicate };
  }
  let r: ReturnType<typeof setTask>;
  if (op.op === "pr") {
    checkTaskRefs({ pr: op.pr, head: op.head });
    r = setTask(c.db, ctx, { id: task.id, rev: op.rev, patch: { ...(op.pr ? { pr: op.pr } : {}), ...(op.head ? { headSHA: op.head } : {}) } });
  } else if (op.op === "stage") r = moveStage(c.db, ctx, { taskId: task.id, from: op.from, to: op.to, text: op.text });
  else r = recordReview(c.db, ctx, { taskId: task.id, reviewer: ctx.actor, verdict: op.verdict, p0: op.p0, p1: op.p1, p2: op.p2, text: op.text });
  return { ok: true, task: peerTaskView(r.row, peerLinks(r.row, peer)), event: r.event, duplicate: r.duplicate };
}

export const PEER_CMDS: Record<string, CommandSpec> = {
  "peer-write": { valued: [], usage: "peer-write <peer> <task> <json>（bridge 专用：受托方经 peer 台账接口写委托给它的卡）", run: peerWrite },
};
