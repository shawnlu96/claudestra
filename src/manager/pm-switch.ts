import { bindHash, checkAsk } from "../lib/ask-bind.js";
import { getAsk, hasAsksTable, ownerAnswered } from "../lib/ledger-asks.js";
import { LedgerError } from "../lib/ledger-store.js";
import { switchProjectPm, type PmSwitchDeps } from "../lib/pm-role-switch.js";
import { readPmState, onlinePmAgents } from "../lib/pm-role-state.js";
import { pmStatus } from "../lib/pm-role-status.js";
import { writePeerPrConfig } from "../lib/peer-pr-config.js";
import { writeConfig, type AppConfig } from "../lib/config-store.js";
import { bridgeSend } from "../lib/bridge-client.js";
import { activeProjectPm } from "../lib/pm-role.js";
import { agentKey } from "./ledger-identity.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export function pmSwitchAuthorization(db: LedgerCli["db"], actor: string, project: string, agent: string, id?: string, now = Date.now()): void {
  if (actor === "owner") return;
  const ask = id && hasAsksTable(db) ? getAsk(db, id) : null;
  if (!ask || ask.kind !== "authorize" || ask.project !== project || !ownerAnswered(ask.answer)) {
    throw new LedgerError("forbidden", "切换 PM 要 owner 授权：需要本项目实际由 owner 答过的 authorize 卡");
  }
  const hash = bindHash({ action: "pm-switch", params: { project, agent } }, actor);
  const r = checkAsk(ask, hash, actor, now);
  if (!r.ok) throw new LedgerError("forbidden", `切换 PM 要 owner 授权（authorize action=pm-switch params={project,agent}）：${r.reason}`);
}

function pmSwitchDeps(db: LedgerCli["db"], project: string): PmSwitchDeps {
  // Use the old PM as the notice sender so its own retirement notice can still reach it.
  const sender = activeProjectPm(db, project) ?? "pm-switch";
  return { read: readPmState, online: onlinePmAgents, writePeerPrs: writePeerPrConfig,
    writeConfig: (value) => writeConfig(value as unknown as AppConfig),
    notify: async (target, text) => {
      const r = await bridgeSend({ type: "route_to_agent", targetName: target, fromName: sender, text, oneShot: true });
      if (!r.ok) throw new Error(r.error);
    } };
}

async function switchCmd(c: LedgerCli) {
  const project = c.project(), raw = c.p.pos[1];
  if (!raw || c.p.pos.length !== 2) throw new LedgerError("invalid", "pm-switch requires one agent");
  const agent = agentKey(raw), dryRun = c.p.bools.has("dry-run");
  if (!dryRun) pmSwitchAuthorization(c.db, c.deps.actor, project, agent, c.p.flags["ask-id"], c.deps.now());
  return switchProjectPm(c.db, project, agent, { dryRun, actor: c.deps.actor, now: c.deps.now() }, pmSwitchDeps(c.db, project));
}

export const PM_SWITCH_CMDS: Record<string, CommandSpec> = {
  "pm-status": { valued: ["project"], bools: [], usage: "pm-status [--project <id>]", run: async (c) =>
    ({ ok: true, project: c.project(), status: pmStatus(c.db, c.project(), await readPmState()) }) },
  "pm-switch": { valued: ["ask-id", "project"], bools: ["dry-run"], usage: "pm-switch <agent> [--dry-run] [--ask-id <id>] [--project <id>]", run: switchCmd },
};
