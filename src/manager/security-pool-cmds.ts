/**
 * `ledger security-pool [<on|observe|off>] [--project <id>]`（i28-SECPOOL1，docs/architecture/security-pool.md）：
 * 不带取值只读打印当前值；带取值切项目开关，项目真 PM / master / owner 才能切。缺省 off = security 卡只在本机审。
 */
import { LedgerError } from "../lib/ledger-store.js";
import { isSecurityPoolMode, securityPoolMode, setSecurityPoolMode } from "../lib/security-pool.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const SECURITY_POOL_CMDS: Record<string, CommandSpec> = {
  "security-pool": { valued: ["project"], bools: [], usage: "security-pool [on|observe|off] [--project <id>]（security 卡审查进统一池的开关，缺省 off；不带取值只读）",
    run: async (c: LedgerCli) => {
      const project = c.project(), mode = c.p.pos[1];
      if (mode === undefined) return { ok: true, project, mode: securityPoolMode(project) };
      if (!isSecurityPoolMode(mode)) throw new LedgerError("invalid", `开关只能是 on / observe / off（不是 ${mode}）`);
      c.requireRealPm(project, "切 security 卡审查进池开关");
      return { ok: true, project, ...(await setSecurityPoolMode(project, mode)) };
    } },
};
