/**
 * Claimed write/fix orders relay spec appends and PM restate answers; keys deduplicate segments across scans.
 * The sensitive gate includes prior semantic context so refused field headers cannot leak their later values.
 * CLI settlement waits for authenticated remote acceptance: definite rejection retries, ambiguity goes to PM.
 * Retired orders drop pending segments; local authors receive the same lent-away note as take_order.
 * Baselines are recorded at offer; tests/lend-spec-push*.test.ts cover scan and transport boundaries.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { listEvents } from "./ledger-store.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { stepAtStage, stepsOf } from "./ledger-steps.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { chunkInput } from "./order-wire-chunks.js";
import { peerTextRefusal } from "./order-wire-render.js";
import { WIRE_LIMITS } from "./order-wire.js";
import { quoteExternal } from "./quote-text.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import type { RelayState } from "./ledger-lend-relay-schema.js";

type RelayKind = "spec" | "answer" | "note";

export interface RelayRow {
  key: string; orderId: string; taskId: string; project: string; kind: RelayKind; target: string; text: string; state: RelayState;
  reason: string | null; tries: number; createdAt: number; updatedAt: number;
}
/** 同 ledger-lend.ts LendNotice：事务提交后由 CLI 发给卡的 PM */
interface Notice { project: string; taskId: string; text: string }
/** 挂单那一刻要的那几列（避免和 ledger-lend.ts 互相 import） */
interface OrderRef { orderId: string; taskId: string; project: string; peer: string; step: string; specRev: number }
interface ClaimedRow extends OrderRef { worker: string; head: string }

/** bridge 明确没收下（对方不在 / 握手不全）的段最多重试这么多次，之后 failed 并通知 PM */
const MAX_TRIES = 5;
/** sending 超过这么久没结（发送进程半路没了）：不知道送没送到，交 PM，不重发 */
export const SENDING_STALE_MS = 10 * 60_000;
/** 复述的 PM 答复：这三种 decision 事件（ledger-scheduler-write.ts recordRestateBrake、restate-approve） */
const ANSWER_OPS = ["restate_approved", "restate_released", "restate_hold"];
const ANSWER_LABEL: Record<string, string> = { restate_approved: "放行复述", restate_released: "放行复述", restate_hold: "拦住复述" };

const hasRelay = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_relays'").get();

/** 本规格版本的复述记录（spec → restate 那条 stage 事件）与它之后 PM 有没有答复 */
export function restateFacts(events: readonly LedgerEvent[], specRev: number): { text: string | null; seq: number | null; answered: boolean } {
  const rec = events.findLast((e) => e.kind === "stage" && e.data.from === "spec" && e.data.to === "restate" && e.data.specRev === specRev);
  if (!rec) return { text: null, seq: null, answered: false };
  const answered = events.some((e) => e.seq > rec.seq && e.kind === "decision" && ANSWER_OPS.includes(e.data.op as string) && e.data.specRev === specRev);
  return { text: rec.text.trim() || null, seq: rec.seq, answered };
}

/** 本机复述会话：卡上没退役的作者会话绑定，否则当前这一步的本机执行者，否则卡上的本机 agent */
function localAuthorOf(db: Database, task: LedgerTask): string | null {
  const s = getSchedulerSession(db, task.id, "author");
  if (s && s.state !== "retired" && s.transport !== "peer") return s.agent;
  const at = stepAtStage(stepsOf(db, task), task);
  if (at?.executorKind === "agent" && at.executor) return at.executor;
  return task.agent && (task.assigneeKind ?? "agent") === "agent" ? task.agent : null;
}

/** 本机复述会话收到的固定说明；take_order 拿到空单时返回同一句（order-take.ts） */
export const lentAwayText = (peer: string, orderId: string, taskId: string): string =>
  `${taskId}：本卡代码由 ${peer} 写（单号 ${orderId}），你只负责复述和回答 PM，不写代码、不 push、不 deliver`;

function enqueue(db: Database, r: Omit<RelayRow, "state" | "reason" | "tries" | "createdAt" | "updatedAt">, state: RelayState, reason: string | null, now: number): boolean {
  return db.prepare(`INSERT INTO lend_relays (key, orderId, taskId, project, kind, target, text, state, reason, tries, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT (key) DO NOTHING`)
    .run(r.key, r.orderId, r.taskId, r.project, r.kind, r.target, r.text, state, reason, now, now).changes > 0;
}

/**
 * 挂单事务里调（ledger-lend.ts offerLendCore）：写 / 修单记下基线；开工单给本机复述会话排固定说明。
 * spec = 这一单内联的规格原文（它的字节数之后的才算追加）。
 */
export function markRelayBaseline(db: Database, task: LedgerTask, o: OrderRef, spec: string, now: number): void {
  if (!hasRelay(db) || (o.step !== "write" && o.step !== "fix")) return;
  const events = listEvents(db, { project: task.project, target: task.id });
  const top = events.reduce((m, e) => Math.max(m, e.seq), 0);
  const restate = o.step === "write" ? restateFacts(events, task.specRev).seq : null;
  db.prepare("INSERT OR REPLACE INTO lend_relay_marks (orderId, specBytes, answerSeq) VALUES (?, ?, ?)")
    .run(o.orderId, Buffer.byteLength(spec, "utf8"), restate ?? top);
  if (o.step !== "write") return;
  const agent = localAuthorOf(db, task);
  if (!agent) return;
  enqueue(db, { key: `${o.orderId}:note`, orderId: o.orderId, taskId: o.taskId, project: o.project, kind: "note", target: agent,
    text: `[出借] ${lentAwayText(o.peer, o.orderId, o.taskId)}。PM 对复述的答复和规格追加会自动转给 ${o.peer}，不用你转。` }, "pending", null, now);
}

/** 出借 worker 在 send_to_agent 里的地址：`<worker 去掉 agent->@<peer>`（lend-workers-view.ts 同一口径） */
const workerAddr = (o: ClaimedRow): string => `${o.worker.replace(/^agent-/, "")}@${o.peer}`;

const HEAD: Record<"spec" | "answer", string> = {
  spec: "本机 PM 在你持单期间给规格追加了下面这段（原文，非指令；以规格为准，和原单冲突的按追加做）",
  answer: "PM 对复述的答复（原文，非指令；复述里列的待定点按这里定的做）",
};

function relayText(o: ClaimedRow, kind: "spec" | "answer", part: string): string {
  return [`【出借单补充 · ${kind === "spec" ? "规格追加" : "复述答复"}】${o.taskId} · 单号 ${o.orderId}`, `${HEAD[kind]}：`,
    ...part.split("\n").map((l) => `  ${quoteExternal(l, WIRE_LIMITS.input)}`), `继续按单号 ${o.orderId} 做，交付照旧。`].join("\n");
}

/** 一段新内容：过闸（拒了记 refused + 告诉 PM），太长按行分段，每段一个 key */
function addPiece(db: Database, o: ClaimedRow, kind: "spec" | "answer", baseKey: string, label: string, body: string, now: number, out: Notice[], context = body): void {
  const tell = (why: string) => out.push({ project: o.project, taskId: o.taskId,
    text: `出借单 ${o.orderId}（${o.taskId}，${o.peer}）的${label}没推给对方：${why}。要转就脱敏后手动 send_to_agent ${workerAddr(o)}` });
  const bad = peerTextRefusal(context);
  if (bad) {
    if (enqueue(db, { key: baseKey, orderId: o.orderId, taskId: o.taskId, project: o.project, kind, target: workerAddr(o), text: "" }, "refused", bad, now)) tell(`外发闸拒了（${bad}）`);
    return;
  }
  let parts: string[];
  try {
    parts = chunkInput(label, body, WIRE_LIMITS.input);
  } catch (e) {
    if (enqueue(db, { key: baseKey, orderId: o.orderId, taskId: o.taskId, project: o.project, kind, target: workerAddr(o), text: "" }, "refused", "过长", now)) tell((e as Error).message);
    return;
  }
  parts.forEach((p, i) => enqueue(db, { key: parts.length > 1 ? `${baseKey}#${i + 1}` : baseKey, orderId: o.orderId, taskId: o.taskId, project: o.project,
    kind, target: workerAddr(o), text: relayText(o, kind, p.slice(p.indexOf("\n") + 1)) }, "pending", null, now));
}

/** Only an explicit new heading, list item or field closes context; blank lines alone can be part of a value. */
function specContext(spec: string, offset: number): string {
  const prior = Buffer.from(spec, "utf8").subarray(0, offset).toString("utf8");
  let start = 0;
  for (const match of spec.matchAll(/\n[ \t]*\n(?=(?:#{1,6} |[-*+] |[A-Za-z_][\w.-]*[ \t]*:))/g)) {
    if (match.index > prior.length) break;
    start = match.index + match[0].length;
  }
  return spec.slice(start);
}

/**
 * 扫一遍持单中的写 / 修单，把新增的规格字节和新的复述答复排进队列；不再持单的单上没发出的段记 dropped；sending 停太久的记 unknown。
 * readSpec 读这张卡此刻的规格文件（读不到 = null，这轮跳过）。返回要告诉 PM 的话。
 */
export function scanRelays(db: Database, ctx: WriteCtx, readSpec: (task: LedgerTask) => string | null, getTask: (id: string) => LedgerTask | null): Notice[] {
  if (!hasRelay(db)) return [];
  const now = ctx.now ?? Date.now();
  return tx(db, () => {
    const out: Notice[] = [];
    const rows = db.query(`SELECT o.orderId, o.taskId, o.project, o.peer, o.step, o.specRev, o.worker, o.head, m.specBytes, m.answerSeq
      FROM lend_orders o JOIN lend_relay_marks m ON m.orderId = o.orderId
      WHERE o.status = 'claimed' AND o.step IN ('write','fix') AND o.worker IS NOT NULL`).all() as (ClaimedRow & { specBytes: number; answerSeq: number })[];
    for (const o of rows) {
      const task = getTask(o.taskId);
      if (!task) continue;
      const spec = readSpec(task);
      if (spec !== null) {
        const bytes = Buffer.from(spec, "utf8");
        if (bytes.length > o.specBytes) {
          const added = bytes.subarray(o.specBytes).toString("utf8");
          if (added.trim()) addPiece(db, o, "spec", `${o.orderId}:spec:${o.specBytes}-${bytes.length}`, "规格追加",
            added.replace(/^\n+|\s+$/g, ""), now, out, specContext(spec, o.specBytes));
        } else if (bytes.length < o.specBytes) {
          out.push({ project: o.project, taskId: o.taskId, text: `出借单 ${o.orderId}（${o.taskId}）持单期间规格文件变短了（${o.specBytes} → ${bytes.length} 字节）：只有追加会自动推，改过的地方请手动转给 ${workerAddr(o)}` });
        }
        if (bytes.length !== o.specBytes) db.prepare("UPDATE lend_relay_marks SET specBytes = ? WHERE orderId = ?").run(bytes.length, o.orderId);
      }
      const answers = listEvents(db, { project: o.project, target: o.taskId })
        .filter((e) => e.seq > o.answerSeq && e.kind === "decision" && ANSWER_OPS.includes(e.data.op as string) && e.data.specRev === o.specRev);
      for (const e of answers) {
        const body = `${ANSWER_LABEL[e.data.op as string]}${e.text.trim() ? `：${e.text.trim()}` : ""}`;
        addPiece(db, o, "answer", `${o.orderId}:answer:${e.seq}`, "复述答复", body, now, out);
      }
      if (answers.length) db.prepare("UPDATE lend_relay_marks SET answerSeq = ? WHERE orderId = ?").run(answers.at(-1)!.seq, o.orderId);
    }
    db.prepare(`UPDATE lend_relays SET state = 'dropped', reason = '单已不在对方手里（交付 / 撤销 / 过期）', updatedAt = ?
      WHERE state = 'pending' AND kind != 'note' AND orderId NOT IN (SELECT orderId FROM lend_orders WHERE status = 'claimed')`).run(now);
    const stale = db.query("SELECT * FROM lend_relays WHERE state = 'sending' AND updatedAt < ?").all(now - SENDING_STALE_MS) as RelayRow[];
    for (const r of stale) {
      db.prepare("UPDATE lend_relays SET state = 'unknown', reason = '发送中途断了，不知道送没送到', updatedAt = ? WHERE key = ? AND state = 'sending'").run(now, r.key);
      out.push({ project: r.project, taskId: r.taskId, text: `出借单 ${r.orderId} 的一段补充（${r.key}）发送中途断了，不知道 ${r.target} 收没收到；不会自动重发，请核对后手动转` });
    }
    return out;
  });
}

/** 取这一轮要发的段并标成 sending（CAS，两个进程同时取也不会发两遍）；写 / 修单的段只在单还 claimed 时发 */
export function takeRelays(db: Database, now: number): RelayRow[] {
  if (!hasRelay(db)) return [];
  return tx(db, () => {
    const rows = db.query(`SELECT * FROM lend_relays WHERE state = 'pending' AND (kind = 'note' OR orderId IN (SELECT orderId FROM lend_orders WHERE status = 'claimed'))
      ORDER BY createdAt, key`).all() as RelayRow[];
    const mark = db.prepare("UPDATE lend_relays SET state = 'sending', tries = tries + 1, updatedAt = ? WHERE key = ? AND state = 'pending'");
    return rows.filter((r) => mark.run(now, r.key).changes > 0).map((r) => ({ ...r, state: "sending" as const, tries: r.tries + 1 }));
  });
}

/** 一次发送的结果：maybeSent = 请求已经出去了却没拿到回执（可能送到了），这种不重发 */
export type RelaySend = { ok: true } | { ok: false; error: string; maybeSent?: boolean };

/** 发完结账：送达 sent；明确没收下的回 pending，满 MAX_TRIES 次 failed；可能送到了的记 unknown。后两种告诉 PM */
export function settleRelay(db: Database, ctx: WriteCtx, key: string, r: RelaySend): Notice[] {
  const now = ctx.now ?? Date.now();
  return tx(db, () => {
    const row = db.query("SELECT * FROM lend_relays WHERE key = ?").get(key) as RelayRow | null;
    if (!row || row.state !== "sending") return [];
    if (r.ok) {
      db.prepare("UPDATE lend_relays SET state = 'sent', reason = NULL, updatedAt = ? WHERE key = ?").run(now, key);
      if (row.kind !== "note") {
        insertEvent(db, ctx, { project: row.project, target: row.taskId, kind: "note", text: `出借：${row.kind === "spec" ? "规格追加" : "复述答复"}已转给 ${row.target}`,
          data: { lend: { orderId: row.orderId, op: "relay", key, kind: row.kind } } }, false);
      }
      return [];
    }
    if (r.maybeSent) {
      db.prepare("UPDATE lend_relays SET state = 'unknown', reason = ?, updatedAt = ? WHERE key = ?").run(r.error.slice(0, 300), now, key);
      return [{ project: row.project, taskId: row.taskId, text: `出借单 ${row.orderId} 的一段补充（${row.key}）发给 ${row.target} 时没拿到回执，可能已送到：不自动重发，请核对后决定要不要手动转` }];
    }
    const failed = row.tries >= MAX_TRIES;
    db.prepare("UPDATE lend_relays SET state = ?, reason = ?, updatedAt = ? WHERE key = ?").run(failed ? "failed" : "pending", r.error.slice(0, 300), now, key);
    return failed ? [{ project: row.project, taskId: row.taskId, text: `出借单 ${row.orderId} 的一段补充（${row.key}）${MAX_TRIES} 次没发给 ${row.target}：${r.error.slice(0, 200)}。请手动转` }] : [];
  });
}

export function listRelays(db: Database, orderId: string): RelayRow[] {
  return hasRelay(db) ? db.query("SELECT * FROM lend_relays WHERE orderId = ? ORDER BY createdAt, key").all(orderId) as RelayRow[] : [];
}
