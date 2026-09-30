/**
 * `ledger submit-verdict`：M3 submit_verdict 工具写台账的那一头（bridge 经 lib/order-ledger-exit.ts 以调用方频道跑它）。
 * 判定全在 lib/review-verdict.ts，这里在写连接上重算一遍：actor 由频道推出，--session / --family 必须等于 registry 里这个 agent
 * 的当前值（bridge 从已验证身份填；对不上说明会话换过或是手敲的自报值，拒）。只记结论，不推阶段。tests/review-verdict-cmd.test.ts。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { agentRuntime } from "../lib/registry.js";
import { submitVerdict, verdictKey } from "../lib/review-verdict.js";
import { runtimeFamily } from "../lib/scheduler-auto-review.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

async function submitVerdictCmd(c: LedgerCli) {
  const orderId = c.p.pos[1];
  const { wire, session, family, dedup } = c.p.flags;
  if (!orderId || !wire || !session || !family) throw new LedgerError("invalid", "要带 <orderId> --wire --session --family");
  const reg = await c.deps.loadRegistry();
  const row = reg.agents[c.deps.actor];
  if (!row) throw new LedgerError("forbidden", `${c.deps.actor} 不是 registry 里的 agent，不能交审查结论`);
  const runtime = agentRuntime(row);
  if (!row.sessionId || session !== row.sessionId || family !== runtimeFamily(runtime)) {
    throw new LedgerError("forbidden", `--session / --family 与 ${c.deps.actor} 在 registry 里的当前会话 / 运行时不一致：结论没记`);
  }
  let raw: unknown;
  try { raw = JSON.parse(wire); } catch (e) { throw new LedgerError("invalid", `--wire 不是合法 JSON：${(e as Error).message}`); }
  const w = raw as { orderId?: unknown; head?: unknown };
  if (w?.orderId !== orderId) throw new LedgerError("invalid", "--wire 里的 orderId 与命令的 <orderId> 不一致");
  if (dedup !== undefined && dedup !== verdictKey({ orderId, head: String(w.head) })) throw new LedgerError("invalid", "--dedup 要是 verdict:<orderId>@<head>");
  const registry = Object.entries(reg.agents).map(([name, a]) => ({ name, runtime: (a as { runtime?: string }).runtime }));
  const r = submitVerdict(c.db, { agent: c.deps.actor, sessionId: row.sessionId, family: runtime, verified: true }, raw,
    { registry, registryPath: c.deps.registryPath, now: c.deps.now() });
  return r.ok ? { ...r } : { ok: false, code: r.error, error: r.message };
}

export const VERDICT_CMDS: Record<string, CommandSpec> = {
  "submit-verdict": {
    valued: ["wire", "session", "family", "dedup"],
    usage: "submit-verdict <orderId> --wire <VerdictWire JSON> --session <id> --family claude|codex [--dedup verdict:<orderId>@<head>]" +
      "（submit_verdict 工具专用，由 bridge 以审查员身份调用；只记结论，不推阶段）",
    run: submitVerdictCmd,
  },
};
