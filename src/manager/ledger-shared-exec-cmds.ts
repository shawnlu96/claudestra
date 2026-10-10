/**
 * S2F · `ledger shared-exec switch|release|receipt|recover|observe-log` (plan §7.1, appendix S2F).
 * - switch <项目>：不带档位 = 打印有效档、记录档与放行条目（过期标「已过期」）；off / observe 要 PM / owner，on 只认 owner
 *   （S2S 另核有效放行条目）。
 * - release <项目> --kind drill|release --ask <askId> [--expires-at <ms|ISO>] | --revoke：只认 owner；grantedAt 固定为当下。
 * - receipt <项目> --request <id> --digest <commandDigest> [--operation <id>]：只读查中心回执。
 * - recover <项目> --order <orderId> --kind claim|result [--resubmit]：先查回执、租约、版本；不带 --resubmit 不重交。
 * - observe-log [项目] [--limit n]：observe 档的决定记录。
 * There is no entry that writes an execution mode: only X13 does.
 */
import { LedgerError } from "../lib/ledger-store.js";
import { STATE_DIR } from "../lib/paths.js";
import { validAutoShareId } from "../lib/shared-ledger-auto-share-state.js";
import { readStage2Release, readStage2Switch, writeStage2Release, writeStage2Switch, type Stage2Release, type Stage2Switch } from "../lib/shared-ledger-v2-switch.js";
import { readStage2ObserveLog, Stage2Wiring } from "../lib/shared-ledger-v2-wiring.js";
import { readJsonStateSync } from "../lib/state-file.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const USAGE = "shared-exec switch <项目> [off|observe|on] | release <项目> --kind drill|release --ask <askId> [--expires-at <ms|ISO>] | "
  + "release <项目> --revoke | receipt <项目> --request <id> --digest <commandDigest> [--operation <id>] | "
  + "recover <项目> --order <orderId> --kind claim|result [--resubmit] | observe-log [项目] [--limit <n>]";

export interface SharedExecCliDeps {
  dir?: string;
  now?(): number;
  wiring?: Stage2Wiring;
  /** S2L recovery (bridge wiring); injected so the manager process loads the bridge modules only for recover. */
  recover?(orderId: string, kind: "claim" | "result", resubmit: boolean): Promise<unknown>;
}

const invalid = (): never => { throw new LedgerError("invalid", `用法：${USAGE}`); };
function project(raw: string | undefined): string {
  if (!validAutoShareId(raw)) invalid();
  return raw!;
}
function requireOwner(c: LedgerCli, what: string): void {
  if (c.deps.actor !== "owner") throw new LedgerError("forbidden", `${what}只认 owner（你是 ${c.deps.actor}）`);
}
function time(raw: string): number {
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new LedgerError("invalid", "--expires-at 要毫秒时间戳或 ISO 时间");
  return n;
}

function recordedSwitch(dir: string, p: string): Stage2Switch {
  const state = readJsonStateSync(`${dir}/shared-ledger-v2-switch.json`);
  const projects = state.status === "ok" ? (state.data as { projects?: Record<string, unknown> }).projects : undefined;
  const v = projects && Object.hasOwn(projects, p) ? projects[p] : undefined;
  return v === "on" || v === "observe" ? v : "off";
}
export function sharedExecStatus(p: string, dir = STATE_DIR, now = Date.now()) {
  const release = readStage2Release(p, dir);
  const at = (t: number | undefined) => t === undefined ? null : new Date(t).toISOString();
  const state = (r: Stage2Release) => r.grantedAt > now ? "未生效" : r.expiresAt !== undefined && now >= r.expiresAt ? "已过期" : "有效";
  return { ok: true, project: p, effective: readStage2Switch(p, dir, now), recorded: recordedSwitch(dir, p),
    release: release && { kind: release.kind, askId: release.askId, grantedAt: at(release.grantedAt), expiresAt: at(release.expiresAt),
      state: state(release) } };
}

async function switchCmd(c: LedgerCli, d: SharedExecCliDeps) {
  const dir = d.dir ?? STATE_DIR, p = project(c.p.pos[2]), mode = c.p.pos[3];
  if (mode === undefined) return sharedExecStatus(p, dir, d.now?.() ?? Date.now());
  if (mode !== "off" && mode !== "observe" && mode !== "on") return invalid();
  if (mode === "on") requireOwner(c, "打开阶段二执行开关");
  else c.requireManager(p, "改阶段二执行开关");
  try { await writeStage2Switch(p, mode, dir); }
  catch (e) { throw new LedgerError("conflict", (e as Error).message); }
  return sharedExecStatus(p, dir, d.now?.() ?? Date.now());
}

async function releaseCmd(c: LedgerCli, d: SharedExecCliDeps) {
  const dir = d.dir ?? STATE_DIR, p = project(c.p.pos[2]);
  requireOwner(c, "写放行条目");
  const now = d.now?.() ?? Date.now();
  let entry: Stage2Release | null = null;
  if (!c.p.bools.has("revoke")) {
    const kind = c.p.flags.kind, askId = c.p.flags.ask;
    if ((kind !== "drill" && kind !== "release") || !askId) return invalid();
    const expires = c.p.flags["expires-at"];
    entry = { kind, askId, grantedAt: now, ...(expires ? { expiresAt: time(expires) } : {}) };
  } else if (c.p.flags.kind || c.p.flags.ask) return invalid();
  try { await writeStage2Release(p, entry, dir, { now }); }
  catch (e) { throw new LedgerError("invalid", (e as Error).message); }
  return sharedExecStatus(p, dir, now);
}

async function receiptCmd(c: LedgerCli, d: SharedExecCliDeps) {
  const p = project(c.p.pos[2]), requestId = c.p.flags.request, digest = c.p.flags.digest;
  if (!requestId || !digest) return invalid();
  const transport = (d.wiring ?? new Stage2Wiring({ dir: d.dir })).transportFor(p);
  if (!transport) throw new LedgerError("conflict", "unavailable: 本机没有该项目的中心凭据或绑定");
  return { ok: true, project: p, receipt: await transport.receipt({ requestId, operationId: c.p.flags.operation ?? null, commandDigest: digest }) };
}

async function recoverCmd(c: LedgerCli, d: SharedExecCliDeps) {
  const p = project(c.p.pos[2]), orderId = c.p.flags.order, kind = c.p.flags.kind;
  if (!orderId || (kind !== "claim" && kind !== "result")) return invalid();
  const wiring = d.wiring ?? new Stage2Wiring({ dir: d.dir });
  const transport = wiring.transportFor(p);
  if (!transport) throw new LedgerError("conflict", "unavailable: 本机没有该项目的中心凭据或绑定");
  // Receipt / lease / version first (read only); the outcome below resubmits only with --resubmit.
  const view = await transport.lend(() => null).view(orderId);
  const recover = d.recover ?? (async (o, k, r) => {
    const { initSharedLedgerV2 } = await import("../bridge/shared-ledger-v2-wiring.js");
    const { recoverLendCentral } = await import("../bridge/shared-ledger-v2-lend.js");
    initSharedLedgerV2({ wiring, db: () => c.db });
    return recoverLendCentral(o, k, r);
  });
  let outcome: unknown;
  try { outcome = await recover(orderId, kind, c.p.bools.has("resubmit")); }
  catch (e) { outcome = { ok: false, code: (e as { code?: string }).code ?? "unavailable" }; } // e.g. not_found: nothing pending
  return { ok: true, project: p, orderId, view, outcome };
}

export const SHARED_EXEC_CMDS: Record<string, CommandSpec> = {
  "shared-exec": {
    valued: ["kind", "ask", "expires-at", "request", "digest", "operation", "order", "limit"],
    bools: ["revoke", "resubmit"],
    usage: USAGE,
    run: (c) => sharedExecRun(c),
  },
};

export async function sharedExecRun(c: LedgerCli, d: SharedExecCliDeps = {}) {
  const action = c.p.pos[1];
  if (action === "switch") return switchCmd(c, d);
  if (action === "release") return releaseCmd(c, d);
  if (action === "receipt") return receiptCmd(c, d);
  if (action === "recover") return recoverCmd(c, d);
  if (action === "observe-log") {
    const limit = c.p.flags.limit ? Number(c.p.flags.limit) : 50;
    if (!Number.isSafeInteger(limit) || limit <= 0) return invalid();
    const p = c.p.pos[2] === undefined ? undefined : project(c.p.pos[2]);
    return { ok: true, entries: readStage2ObserveLog(d.dir ?? STATE_DIR, p, limit) };
  }
  return invalid();
}
