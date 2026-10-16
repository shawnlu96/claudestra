import { centerReplicaStatus, syncCenterReplicas } from "../lib/shared-ledger-center-replica.js";
import { centerReplicaOf, unbindCenterNode } from "../lib/shared-ledger-center-unbind.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/**
 * N7X1: `ledger center-replica sync|status`。sync 现读中心（service 凭据、5 秒超时），把主场是本实例的 N7 新建 feature 落成 / 重放成本机副本；
 * 只同步 --project（缺省调用方所属项目）绑定的中心项目，要这个项目的 PM / master / owner。status 只读本机状态文件。
 * REPLFAIR1：--center-feature-id <uuid> 只补拉这一个中心 feature（读一次列表、一次详情），权限同上。
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CENTER_REPLICA_CMDS: Record<string, CommandSpec> = {
  "center-replica": {
    valued: ["project", "reason", "center-feature-id"],
    usage: "center-replica sync [--project <本机项目>] [--center-feature-id <uuid>] | status | unbind <本机 featureId> <节点> --reason <原因>（sync / unbind 要项目 PM / master / owner）",
    async run(c) {
      const [, action] = c.p.pos;
      if (action === "status") return centerReplicaStatus();
      if (action === "unbind") { // N7X5：撤销本机没开成的中心绑定，要副本所在项目的 PM / master / owner
        const [, , featureId = "", key = ""] = c.p.pos;
        c.requireManager(centerReplicaOf(featureId)?.entry.localProject ?? c.project(), "撤销中心绑定");
        return unbindCenterNode(c.db, featureId, key, c.p.flags.reason ?? "");
      }
      if (action !== "sync") throw new LedgerError("invalid", "用法：center-replica sync [--project <本机项目>] [--center-feature-id <uuid>] | status");
      const project = c.project();
      c.requireManager(project, "同步中心副本");
      const centerFeatureId = c.p.flags["center-feature-id"];
      if (centerFeatureId !== undefined && !UUID.test(centerFeatureId)) throw new LedgerError("invalid", "--center-feature-id 要中心 feature 的 uuid");
      return syncCenterReplicas(c.db, { localProject: project, ...(centerFeatureId !== undefined ? { centerFeatureId } : {}) });
    },
  },
};
