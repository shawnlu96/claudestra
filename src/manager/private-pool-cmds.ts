/**
 * `ledger private-pool [<on|observe|off>] [--project <id>]`（i28-SECPOOL2，docs/architecture/private-pool.md）：
 * 不带取值只读打印当前值；带取值切项目开关，项目真 PM / master / owner 才能切。缺省 off = 私仓节点照旧由 PM 手动开卡。
 */
import { privatePoolMode, setPrivatePoolMode } from "../lib/card-repo.js";
import { LedgerError } from "../lib/ledger-store.js";
import { isSecurityPoolMode } from "../lib/security-pool.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const PRIVATE_POOL_CMDS: Record<string, CommandSpec> = {
  "private-pool": { valued: ["project"], bools: [], usage: "private-pool [on|observe|off] [--project <id>]（私仓卡进统一池自动开卡的开关，缺省 off；不带取值只读）",
    run: async (c: LedgerCli) => {
      const project = c.project(), mode = c.p.pos[1];
      if (mode === undefined) return { ok: true, project, mode: privatePoolMode(project) };
      if (!isSecurityPoolMode(mode)) throw new LedgerError("invalid", `开关只能是 on / observe / off（不是 ${mode}）`);
      c.requireRealPm(project, "切私仓卡进池开关");
      return { ok: true, project, ...(await setPrivatePoolMode(project, mode)) };
    } },
};
