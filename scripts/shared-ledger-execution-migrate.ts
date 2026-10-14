#!/usr/bin/env bun
/** X13 drill entry: whole-group execution migration against a V2 center, only inside an isolated temp root.
 * Usage: shared-ledger-execution-migrate.ts --root <tmp-dir> --plan <plan.json> --center <center.json> dry-run|commit|reverse
 *   center.json = { centerId, baseUrl, teamId, personId, instanceId, projectId }; the bearer comes from SHARED_LEDGER_V2_DRILL_BEARER
 *   and the signing key is the drill root's own instance key. Production state directories are refused; a formal migration
 *   (X15 passed + owner authorization) is out of scope for this script.
 * Exit codes: 0 done (dry-run / switched / exported), 2 refused (itemized list on stderr), 3 frozen pending PM, 1 usage / error.
 */
import { readFileSync } from "node:fs";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { createStage2Transport } from "../src/lib/shared-ledger-v2-transport.js";
import { assertDrillRoot, MigrationRefused, underRoot } from "../src/lib/shared-ledger-v2-migration-local.js";
import {
  exportForReverse, migrationCenter, runExecutionMigration, type MigrationCenter, type MigrationPlan,
} from "../src/lib/shared-ledger-v2-migration.js";

export interface CliDeps { center?: (root: string) => MigrationCenter; env?: NodeJS.ProcessEnv; print?: (line: string) => void }

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function liveCenter(root: string, file: string, env: NodeJS.ProcessEnv): MigrationCenter {
  const c = JSON.parse(readFileSync(underRoot(root, file), "utf8")) as Record<string, string>;
  const bearer = env.SHARED_LEDGER_V2_DRILL_BEARER, key = instanceKeySync(root);
  if (!bearer || !key) throw new Error("drill bearer (SHARED_LEDGER_V2_DRILL_BEARER) and drill instance key required");
  return migrationCenter(createStage2Transport({ key, projectId: c.projectId, connection: {
    centerId: c.centerId, baseUrl: c.baseUrl, teamId: c.teamId, personId: c.personId, instanceId: c.instanceId, bearer } }));
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const print = deps.print ?? ((line: string) => console.error(line));
  const action = argv.find((a): a is "dry-run" | "commit" | "reverse" => ["dry-run", "commit", "reverse"].includes(a));
  const rootArg = arg(argv, "--root"), planArg = arg(argv, "--plan");
  if (!action || !rootArg || !planArg) { print("用法: --root <临时目录> --plan <plan.json> [--center <center.json>] dry-run|commit|reverse"); return 1; }
  let root: string;
  try { root = assertDrillRoot(rootArg); }
  catch (e) {
    if (!(e instanceof MigrationRefused)) throw e;
    for (const f of e.findings) print(`✗ ${f.code} ${f.item}: ${f.detail}`);
    return 2;
  }
  const plan = JSON.parse(readFileSync(underRoot(root, planArg), "utf8")) as MigrationPlan;
  const centerFile = arg(argv, "--center");
  const center = deps.center?.(root) ?? (centerFile ? liveCenter(root, centerFile, deps.env ?? process.env) : null);
  if (!center) { print("缺 --center"); return 1; }
  if (action === "reverse") {
    const out = await exportForReverse({ root, batchId: plan.batchId, featureIds: plan.featureIds, center });
    print(`冻结 → 导出 ${out.export} → 核对报告 ${out.report}；直接回写：拒绝${out.centerAdvanced ? "（中心已有新提交）" : ""}`);
    return 3;
  }
  const out = await runExecutionMigration({ root, plan, center, mode: action });
  if (out.status === "refused") {
    print(`迁移被拒（${out.findings.length} 项），报告 ${out.report}`);
    for (const f of out.findings) print(`✗ ${f.code} ${f.item}: ${f.detail}`);
    return 2;
  }
  if (out.status === "frozen") { print(`第 ${out.step} 步失败：已冻结待 PM 核对，报告 ${out.report}`); return 3; }
  print(`${out.status}，报告 ${out.report}`);
  return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
