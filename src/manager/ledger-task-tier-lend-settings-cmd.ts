/**
 * `ledger tier-lend-settings [show] | set on|off --rev <n>`（TIER3b）：出借方本机「接受降档建议」开关，缺省开。
 * 逻辑与权限（只有 owner / master，tierLendEditProblem）都在 lib/task-tier-lend-settings.ts，与网页同一模块；这里只解析参数。
 * 生效还要本机 taskTierModels 恢复键是 on：`ledger scheduler-recovery lend on|observe|off --key taskTierModels --reason <为什么>`。
 */
import { readTierLendSettings, saveTierLendSettings } from "../lib/task-tier-lend-settings.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const USAGE = "tier-lend-settings [show] | set on|off --rev <n>（出借方是否在授权内接受借入方的降档建议；只有 owner / master 能改）";

function run(c: LedgerCli) {
  const [, action = "show", value, ...extra] = c.p.pos;
  if (action === "show") {
    if (value !== undefined) throw new LedgerError("invalid", "show 不带参数");
    const r = readTierLendSettings();
    return { ok: true, status: r.status, acceptDowngrade: r.settings.acceptDowngrade, rev: r.settings.rev, ...("error" in r ? { error: r.error } : {}) };
  }
  if (action !== "set") throw new LedgerError("invalid", `tier-lend-settings 只认 show / set，收到 ${action}`);
  if ((value !== "on" && value !== "off") || extra.length) throw new LedgerError("invalid", "set 只接受 on 或 off");
  const rev = Number(c.need("rev"));
  if (!Number.isInteger(rev) || rev < 0) throw new LedgerError("invalid", "--rev 要是 show 读到的版本号");
  const ctx = c.ctx();
  const r = saveTierLendSettings({ kind: "actor", actor: ctx.actor }, { rev, acceptDowngrade: value === "on" }, ctx.now ?? Date.now());
  if (!r.ok) throw new LedgerError(r.code === "forbidden" ? "forbidden" : r.code === "conflict" ? "conflict" : "busy", r.error);
  return { ok: true, acceptDowngrade: r.settings.acceptDowngrade, rev: r.settings.rev };
}

export const TIER_LEND_SETTINGS_CMDS: Record<string, CommandSpec> = {
  "tier-lend-settings": { valued: ["rev"], bools: [], usage: USAGE, run },
};
