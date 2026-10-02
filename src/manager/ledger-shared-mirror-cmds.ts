import { sharedMirrorOff, sharedMirrorOn, sharedMirrorStatus } from "../lib/shared-ledger-mirror.js";
import { getFeature } from "../lib/ledger-feature.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** PJ1: `ledger shared-mirror on|off|status <featureId>`；on / off 只许本机 PM / owner。activate 不在这里（owner 另批）。 */
export const SHARED_MIRROR_CMDS: Record<string, CommandSpec> = {
  "shared-mirror": {
    valued: [],
    usage: "shared-mirror on|off|status <featureId>（已 commit 未 activate 的 feature 只读共享到中心，本机照常规划；on / off 本机 PM / owner）",
    async run(c) {
      const [, action, featureId] = c.p.pos;
      if (!["on", "off", "status"].includes(action ?? "") || !featureId) throw new LedgerError("invalid", "用法：shared-mirror on|off|status <featureId>");
      if (action === "status") return sharedMirrorStatus(featureId);
      const feature = getFeature(c.db, featureId);
      if (!feature) throw new LedgerError("not_found", `没有 feature ${featureId}`);
      c.requireManager(feature.project, action === "on" ? "开启共享镜像" : "关闭共享镜像");
      return action === "on" ? sharedMirrorOn(c.db, featureId) : sharedMirrorOff(c.db, featureId);
    },
  },
};
