import { centerReplicaStatus, syncCenterReplicas } from "../lib/shared-ledger-center-replica.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/**
 * N7X1: `ledger center-replica sync|status`。sync 现读中心（service 凭据、5 秒超时），把主场是本实例的 N7 新建 feature 落成 / 重放成本机副本；
 * 只同步 --project（缺省调用方所属项目）绑定的中心项目，要这个项目的 PM / master / owner。status 只读本机状态文件。
 */
export const CENTER_REPLICA_CMDS: Record<string, CommandSpec> = {
  "center-replica": {
    valued: ["project"],
    usage: "center-replica sync|status [--project <本机项目>]（中心发布的 N7 新建 feature 落成本机副本；sync 要项目 PM / master / owner）",
    async run(c) {
      const [, action] = c.p.pos;
      if (action === "status") return centerReplicaStatus();
      if (action !== "sync") throw new LedgerError("invalid", "用法：center-replica sync|status [--project <本机项目>]");
      const project = c.project();
      c.requireManager(project, "同步中心副本");
      return syncCenterReplicas(c.db, { localProject: project });
    },
  },
};
