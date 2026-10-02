/** Durable per-card notification claim; send only after the surrounding stage/settlement transaction commits. */
import { Database } from "bun:sqlite";
import { bridgeSend } from "./bridge-client.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getMeta } from "./ledger-store.js";

type Notice = { id: string; project: string; text: string; state: "pending" | "sending" | "sent" | "unknown" };
type Send = typeof bridgeSend;
const noticeKey = (taskId: string): string => `finished-card-lease-notice:${taskId}`;

/** A later blocked round on the same card owes PM a fresh notice. */
export function clearFinishedLeaseNotice(db: Database, taskId: string): void {
  db.prepare("DELETE FROM scheduler_meta WHERE key = ?").run(noticeKey(taskId));
}

/** Separate connection survives a short-lived CLI closing its writer before this microtask runs. */
export function queueFinishedLeaseNotice(db: Database, task: LedgerTask, reason: string, send: Send = bridgeSend, assertActive?: () => void): void {
  const key = noticeKey(task.id);
  const notice: Notice = { id: crypto.randomUUID(), project: task.project, state: "pending",
    text: `[调度引擎] ${task.id} 已 ${task.stage}，但${reason}；保留残留写意图和文件锁，请 PM 核对。` };
  db.prepare("INSERT OR IGNORE INTO scheduler_meta (key, value) VALUES (?, ?)").run(key, JSON.stringify(notice));
  const filename = db.filename;
  queueMicrotask(() => {
    void sendCommittedNotice(filename, db, key, send, assertActive).catch((error) => console.error("[scheduler-lease] PM 通知失败，文件锁仍保留", error));
  });
}

async function sendCommittedNotice(filename: string, writer: Database, key: string, send: Send, assertActive?: () => void): Promise<void> {
  const memory = !filename || filename === ":memory:";
  const db = memory ? writer : new Database(filename, { readwrite: true, create: false });
  const stillActive = () => {
    try { assertActive?.(); return true; } catch { return false; /* A stopped scheduler cannot send this pending notice. */ }
  };
  try {
    if (!stillActive()) return;
    const row = db.query("SELECT value FROM scheduler_meta WHERE key = ?").get(key) as { value: string } | null;
    if (!row) return; // The enclosing transaction rolled back: nothing was committed to notify about.
    const notice = JSON.parse(row.value) as Notice;
    if (notice.state !== "pending") return;
    const meta = getMeta(db, notice.project);
    const pm = meta.pms.find((p) => p !== meta.team?.dispatcher) ?? "master";
    const sending = JSON.stringify({ ...notice, state: "sending" });
    if (!db.prepare("UPDATE scheduler_meta SET value = ? WHERE key = ? AND value = ?").run(sending, key, row.value).changes) return;
    const result = await send({ type: "route_to_agent", targetName: pm, text: notice.text, fromName: "scheduler", oneShot: true }, { timeoutMs: 30_000, stillActive });
    // A lost acknowledgement may already have notified PM. Never resend that case (or a process lost while sending).
    const state: Notice["state"] = result.ok ? "sent" : result.sent ? "unknown" : "pending";
    db.prepare("UPDATE scheduler_meta SET value = ? WHERE key = ? AND value = ?").run(JSON.stringify({ ...notice, state }), key, sending);
    if (!result.ok) console.error(`[scheduler-lease] PM 通知 ${state}：${result.error}`);
  } finally {
    if (!memory) db.close();
  }
}
