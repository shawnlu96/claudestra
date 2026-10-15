/** Dedicated repair intake: untrusted repository names never classify urgency, and URLs remain unabridged digest detail. */
import { createHash } from "node:crypto";
import { PmDigestStore, PM_DIGEST_LOG_MS } from "../lib/pm-digest-store.js";

interface RepairFrame { requestId?: unknown; project?: unknown; key?: unknown; runUrl?: unknown }
const RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/;

/** Queue and notification receipt share one atomic store write; the log survives queue consumption and bridge restarts. */
export function enqueueSelectedRepair(msg: RepairFrame, store = new PmDigestStore(), now = Date.now()): void {
  const { project, key, runUrl } = msg;
  if (typeof project !== "string" || !project || typeof key !== "string" || !/^[a-f0-9]{16}$/.test(key)
    || typeof runUrl !== "string" || !RUN_URL.test(runUrl)) throw new Error("invalid CI repair notice");
  const reason = `ci-selected-repair:${key}`, source = "ci-selected-gate";
  if (store.read().log.some((r) => r.project === project && r.source === source && r.reason === reason && now - r.at < PM_DIGEST_LOG_MS)) return;
  const id = createHash("sha256").update(`${project}\0${key}\0${now}`).digest("hex");
  store.record({ at: now, project, send: "digest", reason, source, kind: "sync", mode: "on" },
    { id, project, at: now, kind: "sync", source, firstLine: `[CI 放行待修] 待修键 ${key}`,
      detail: [runUrl, "文件与用例名见台账 ci_selected_repair；由 PM 决定是否另开修复。"] });
}

/** A failed write returns an error, so the scheduler keeps the durable repair pending for retry. */
export function answerSelectedRepair(ws: { send(data: string): unknown }, msg: RepairFrame, store?: PmDigestStore): void {
  let result: Record<string, unknown>;
  try { enqueueSelectedRepair(msg, store); result = { result: { queued: true } }; }
  catch (e) { result = { error: `CI repair digest: ${(e as Error).message}` }; }
  try { ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, ...result })); }
  catch (e) { console.warn("CI repair acknowledgement lost; persisted key makes retry safe:", (e as Error).message); }
}
