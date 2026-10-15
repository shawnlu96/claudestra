#!/usr/bin/env bun
/** X13 drill entry: whole-group execution migration against a V2 center, only inside an isolated temp root.
 * Usage: shared-ledger-execution-migrate.ts --root <tmp-dir> --plan <plan.json> --center <center.json> dry-run|commit|reverse
 *   center.json = { centerId, baseUrl, teamId, personId, instanceId, projectId }; the bearer comes from SHARED_LEDGER_V2_DRILL_BEARER
 *   and the signing key is the drill root's own instance key. Production state directories are refused; a formal migration
 *   (X15 passed + owner authorization) is out of scope for this script.
 * plan.json lists the whole group (本机 / peer A / peer B), each member an isolated state dir under the drill root.
 * dry-run / commit send only the frozen manifest `ledger shared-exec migration-ask` wrote (and the owner approved); a missing,
 * unapproved or plan-mismatched one is refused (exit 2) before any center call.
 * Exit codes: 0 done (dry-run / switched / exported), 2 refused (itemized list on stderr), 3 frozen pending PM, 1 usage / error.
 */
import { closeSync, constants, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import type { InstanceKey } from "../src/lib/instance-key.js";
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
/** The drill root's own signing key. Not `instanceKeySync`: its fixed temp name would follow a planted link out of the root.
 * The key file is checked under the root by its real landing place, then created O_EXCL | O_NOFOLLOW (an existing link refuses)
 * or read O_NOFOLLOW, so nothing outside the drill root is ever written or read through a link. */
function drillKey(root: string): InstanceKey {
  const path = underRoot(root, "instance-key.pem"), NOFOLLOW = constants.O_NOFOLLOW;
  let pem: string;
  if (existsSync(path)) {
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    try { pem = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
  } else {
    pem = String(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    try { writeSync(fd, pem); } finally { closeSync(fd); }
  }
  const privateKey = createPrivateKey(pem);
  return { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
}
function liveCenter(root: string, file: string, env: NodeJS.ProcessEnv): MigrationCenter {
  const c = JSON.parse(readFileSync(underRoot(root, file), "utf8")) as Record<string, string>;
  // Credentials first: a run without a bearer writes nothing into the drill root (not even a key).
  const bearer = env.SHARED_LEDGER_V2_DRILL_BEARER;
  if (!bearer) throw new Error("drill bearer (SHARED_LEDGER_V2_DRILL_BEARER) required");
  const key = drillKey(root);
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
  let center: MigrationCenter | null;
  try { center = deps.center?.(root) ?? (centerFile ? liveCenter(root, centerFile, deps.env ?? process.env) : null); }
  catch (e) { print(`✗ ${e instanceof MigrationRefused ? e.message : (e as Error).message}`); return e instanceof MigrationRefused ? 2 : 1; }
  if (!center) { print("缺 --center"); return 1; }
  if (action === "reverse") {
    const out = await exportForReverse({ root, batchId: plan.batchId, featureIds: plan.featureIds, center, members: plan.members ?? [] });
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
