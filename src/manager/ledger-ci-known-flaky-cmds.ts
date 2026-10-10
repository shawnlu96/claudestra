/**
 * `ledger ci-known-flaky [list] | add <测试文件> --feature <f> --node <key> --reason <原因> | revoke <测试文件> --reason <原因>`
 * （dispatch-recovery-CIF8）：已知偶发测试清单。逻辑和权限（actorMayConfigure）都在 lib/ci-known-flaky.ts；这里只解析参数。
 * 开关不在这里：`ledger scheduler-recovery <project> on|observe|off --key ciKnownFlaky --reason <为什么>`，缺省 observe。
 */
import { addKnownFlaky, knownFlakyList, knownFlakyMode, revokeKnownFlaky } from "../lib/ci-known-flaky.js";
import { resolveFeature } from "../lib/ledger-feature.js";
import { storedOrigin } from "../lib/ledger-origin.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const USAGE = "ci-known-flaky [list] | add <测试文件> --feature <f> --node <节点 key> --reason <原因> | revoke <测试文件> --reason <原因>"
  + "（已知偶发测试清单：修它的节点 verified 后条目自动失效；开关用 scheduler-recovery --key ciKnownFlaky）";

function run(c: LedgerCli) {
  const [, action = "list", file, ...extra] = c.p.pos;
  const project = c.project();
  if (action === "list") {
    if (file !== undefined) throw new LedgerError("invalid", "list 不带参数");
    return { ok: true, project, mode: knownFlakyMode(project), entries: knownFlakyList(c.db, project) };
  }
  if (!file || extra.length) throw new LedgerError("invalid", "只接受一个测试文件路径");
  if (action === "add") {
    const featureId = resolveFeature(c.db, c.need("feature"), storedOrigin(c.db)).id;
    return { ok: true, project, ...addKnownFlaky(c.db, c.ctx(), { project, file, featureId, node: c.need("node"), reason: c.need("reason") }) };
  }
  if (action === "revoke") return { ok: true, project, ...revokeKnownFlaky(c.db, c.ctx(), { project, file, reason: c.need("reason") }) };
  throw new LedgerError("invalid", `ci-known-flaky 只认 list / add / revoke，收到 ${action}`);
}

export const CI_KNOWN_FLAKY_CMDS: Record<string, CommandSpec> = {
  "ci-known-flaky": { valued: ["project", "feature", "node", "reason", "dedup"], bools: [], usage: USAGE, run },
};
