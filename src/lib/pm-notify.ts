/**
 * One system notice to a project's PM (the first PM on the list who is not the team dispatcher, else master), sent through
 * the bridge as a one-shot agent message. Used by the scheduler (escalations) and by lend (expired / stopped orders);
 * a caller that cannot reach the bridge gets the error and decides whether losing the notice matters.
 */
import type { Database } from "bun:sqlite";
import { bridgeSend } from "./bridge-client.js";
import { getMeta } from "./ledger-store.js";

export async function notifyProjectPm(db: Database, project: string, text: string, opts: { fromName: string; stillActive?: () => boolean }): Promise<void> {
  const meta = getMeta(db, project);
  const pm = meta.pms.find((p) => p !== meta.team?.dispatcher) ?? "master";
  const r = await bridgeSend({ type: "route_to_agent", targetName: pm, text, fromName: opts.fromName, oneShot: true }, { timeoutMs: 30_000, stillActive: opts.stillActive });
  if (!r.ok) throw new Error(`发给 ${pm} 失败：${r.error}`);
}
