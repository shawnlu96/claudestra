import { setSharedLedgerBinding } from "../lib/shared-ledger-gate-bindings.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const SHARED_BINDINGS_CMDS: Record<string, CommandSpec> = {
  "shared-bindings-set": {
    valued: ["center", "team", "shared-project", "project"],
    usage: "shared-bindings-set --center <id> --team <id> --shared-project <id> [--project <本机项目>]（本机 PM / owner）",
    async run(c) {
      const localProjectId = c.project();
      c.requireManager(localProjectId, "配置共享台账绑定");
      await setSharedLedgerBinding({ centerId: c.need("center"), teamId: c.need("team"), projectId: c.need("shared-project"), localProjectId });
      return { ok: true, localProjectId };
    },
  },
};
