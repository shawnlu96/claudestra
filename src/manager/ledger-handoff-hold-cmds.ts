/**
 * `ledger handoff-hold <project> on|off --reason <文本>`（HDG-1）：项目级暂停交接，PM / master / owner 用。开着时审过的卡停在 merge，
 * build / fix / review 照常派；关掉后下一个 tick 自动恢复，不用逐卡 workflow-resume。状态在项目 meta（`ledger show` 可见），逻辑在 lib/handoff-gate.ts。
 */
import { setHandoffHold } from "../lib/scheduler-merge-handoff.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

function handoffHold(c: LedgerCli): Result {
  const [, project, mode, ...extra] = c.p.pos;
  if (!project || !c.deps.projectIds.includes(project)) throw new LedgerError("not_found", `projects.json 里没有项目 ${project ?? "（缺）"}`);
  if ((mode !== "on" && mode !== "off") || extra.length) throw new LedgerError("invalid", "用法：handoff-hold <project> on|off --reason <文本>");
  const r = setHandoffHold(c.db, c.ctx(), { project, on: mode === "on", reason: c.p.flags.reason ?? "" });
  return { ok: true, project, handoffHold: r.meta.handoffHold, event: r.event };
}

export const HANDOFF_HOLD_CMDS: Record<string, CommandSpec> = {
  "handoff-hold": { valued: ["reason"], usage: "handoff-hold <project> on|off --reason <文本>（暂停 / 恢复审过的卡交接；build / fix / review 照常）", run: handoffHold },
};
