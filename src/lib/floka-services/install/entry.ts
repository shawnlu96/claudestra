import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { consumeGrant, type Grant } from "../../state-maintenance/grant.js";
import { maintenanceRoleRefusal } from "../../state-maintenance/ledger-access.js";
import { prepareMaintenanceRoot } from "../../state-maintenance/paths.js";
import { validTxId } from "../../floka-migration/transaction/journal.js";
import { STATE_DIR, RUNTIME_DIR } from "../../paths.js";
import { isTestProcess } from "../../test-guard.js";
import { serviceMaintenance, servicesBinding } from "./maintenance.js";
import { cliInstallPaths, modes, productionHost, rawConfig } from "./production.js";
import { durableJson, ServiceStore, type Snapshot } from "./store.js";
import { submitPartJob } from "./job.js";
import { runPart } from "./parts.js";

export interface EntryContext { root: string; home: string; ledgerPath: string; grant: string | null }
export interface Request {
  version: 1;
  item: "services" | "runtime" | "config";
  txId: string;
  action: "resume" | "rollback" | "retire";
  authorization: Grant;
  config: { rename: Record<string, string> };
  input: Snapshot["input"];
  cliPaths: string[];
}

/** Only explicit maintenance dispatch reaches this entry. Normal startup and update never spawn a runner. */
export async function maintenanceCommand(argv: string[], c: EntryContext): Promise<Record<string, unknown> & { ok: boolean }> {
  const [item, txId, action = "resume"] = argv;
  if (!(["services", "runtime", "config"] as string[]).includes(item ?? "") || !validTxId(txId ?? "") ||
      !["resume", "rollback", "retire"].includes(action) || argv.length > 3) return { ok: false, error: "用法: services|runtime|config <txId> [resume|rollback|retire] --grant <单次授权>" };
  if (item !== "services" && action !== "resume") return { ok: false, error: "runtime/config 只接受显式事务执行；失败由 CONFIG1 事务补偿" };
  try {
    const config = rawConfig(), r = modes(config), production = productionHost(c.root, c.home, txId!);
    if (item === "services" && (r.services === "observe" || r.cli === "observe" || action === "resume" && r.services === "off" && r.cli === "off")) {
      const result = await serviceMaintenance({ root: c.root, plan: production.plan, input: production.input, controller: production.host,
        config, cliPaths: [], callerSafe: async () => false, provePaths: async () => false, roleRefusal: () => null });
      return { ok: true, ...result };
    }
    if (item === "services" && r.services === "on" && r.cli !== "on" && action === "resume") return { ok: false, error: "先把 cli 切到 on" };
    if (item !== "services" && r[item!] !== "on") return { ok: true, ...await runPart(item as "runtime" | "config", txId!, c.root) };
    if (!c.grant) return { ok: false, error: "缺少 STATE2 单次授权" };
    const binding = item === "services" ? servicesBinding(production.plan, action) : { txId: txId! };
    const auth = consumeGrant(c.root, c.grant, item as Request["item"], binding);
    if (!auth.ok) return { ok: false, error: auth.error };
    const no = maintenanceRoleRefusal(auth.grant.actor, c.ledgerPath);
    if (no) return { ok: false, error: no };
    if (!await production.host.callerSafe(production.plan)) return { ok: false, error: "维护命令不能在被切换的 daemon 内执行" };
    if (isTestProcess()) return { ok: false, error: "测试只能注入 fake，不拉起生产维护执行器" };
    prepareMaintenanceRoot(c.root, [STATE_DIR, RUNTIME_DIR]);
    const old = new ServiceStore(c.root).active();
    const request: Request = { version: 1, item: item as Request["item"], txId: txId!, action: action as Request["action"],
      authorization: auth.grant, config: { rename: r }, input: old?.plan.id === txId ? old.input : production.input,
      cliPaths: cliInstallPaths(c.home, config) };
    const id = randomBytes(16).toString("hex");
    durableJson(join(c.root, "part-requests", `${id}.json`), request);
    await submitPartJob(c.root, id);
    return { ok: true, requestId: id, txId, report: `part-requests/${id}.result.json`, note: "单次授权已消费，独立 runner 执行；结果写入维护报告" };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
