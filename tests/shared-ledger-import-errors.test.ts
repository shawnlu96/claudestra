import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MigrationError, migrationErrorText, resolveImportCredential } from "../scripts/shared-ledger-import.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { SharedLedgerScrubError } from "../src/lib/shared-ledger-scrub.js";

const SPAWN_MS = 30_000;
const GENERIC = "Migration stopped; retain local gate and inspect the local journal before recovery.";
const plan = { centerId: "center-a", teamId: "team-a", localProject: "project-a", projectId: "shared-project", sourceInstanceId: "peer-a",
  featureIds: ["c602-plan"], batchId: "batch-a", summaries: {} };

const credential = (kind: "person" | "service", actions: string[]) => ({
  localSubject: "owner:self", kind, centerId: plan.centerId, baseUrl: "http://127.0.0.1:9", teamId: plan.teamId, personId: `${kind}-a`,
  instanceId: "peer-a", bearer: `bearer-${kind}`, projects: [{ projectId: plan.projectId, actions }],
});

/** 本机：临时状态目录 + 空台账 + 计划文件；credentials 写进 0600 的凭据文件 */
function fixture(credentials: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-import-")), db = join(dir, "ledger.sqlite");
  openLedger(db);
  closeLedger(db);
  mkdirSync(join(dir, "shared-ledger-migrations"), { mode: 0o700 });
  writeFileSync(join(dir, "shared-ledger-credentials.json"), JSON.stringify({ credentials }), { mode: 0o600 });
  const planPath = join(dir, "local-plan.json");
  writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
  const run = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "scripts", "shared-ledger-import.ts"), ...args], {
      env: { ...process.env, CLAUDESTRA_STATE_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, stderr: p.stderr.toString(), stdout: p.stdout.toString() };
  };
  return { dir, planPath, run, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("commit resolves a service credential holding import", async () => {
  const f = fixture([credential("person", ["read", "plan"]), credential("service", ["import"])]);
  try {
    expect(resolveImportCredential(plan, f.dir)).toMatchObject({ kind: "service", personId: "service-a" });
    // 凭据解析过了，下一道才拦：没有 prepare 过的批次，报 reviewed manifest digest required（原样）
    const r = f.run("commit", f.planPath, "0".repeat(64));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("reviewed manifest digest required");
    expect(r.stderr).not.toContain("local import credential unavailable");
  } finally { f.close(); }
}, SPAWN_MS);

test("a member (person read/plan) credential cannot import and the reason reaches stderr verbatim", async () => {
  const f = fixture([credential("person", ["read", "plan"])]);
  try {
    expect(resolveImportCredential(plan, f.dir)).toBeNull();
    const r = f.run("commit", f.planPath, "0".repeat(64));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("local import credential unavailable");
    expect(r.stderr).not.toContain(GENERIC);
    expect(r.stderr).not.toContain("bearer-person");
  } finally { f.close(); }
}, SPAWN_MS);

test("the script's own fixed errors print as-is; prepare names the blocker", async () => {
  const f = fixture([]);
  try {
    const r = f.run("prepare", f.planPath);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("migration feature unavailable");
    expect(f.run("bogus", f.planPath).stderr).toContain("Usage: shared-ledger-import.ts");
  } finally { f.close(); }
}, SPAWN_MS);

test("errors from center responses or other sources print only the generic line", () => {
  for (const text of ["migration blocked: unfinished manual start", "invalid migration selection", "reviewed manifest digest required", "local import credential unavailable"]) {
    expect(migrationErrorText(new MigrationError(text))).toBe(text);
  }
  expect(migrationErrorText(new SharedLedgerScrubError(["manifest.features[0].ownerWords"]))).toBe("upload blocked at manifest.features[0].ownerWords");
  // 中心响应抛出的错误可能夹带响应内容：同样的固定文本也不放行，只认脚本自己的错误类
  const center = new Error("center 409: {\"bearer\":\"secret-token\",\"ownerWords\":\"private plan\"}");
  expect(migrationErrorText(center)).toBe(GENERIC);
  expect(migrationErrorText(new Error("migration blocked: forged by response"))).toBe(GENERIC);
  expect(migrationErrorText("raw string")).toBe(GENERIC);
});

test("a corrupt plan file from another source prints only the generic line", () => {
  const f = fixture([]);
  try {
    writeFileSync(f.planPath, "{\"secret\": private-body");
    const r = f.run("prepare", f.planPath);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe(GENERIC);
    expect(r.stderr).not.toContain("private-body");
  } finally { f.close(); }
}, SPAWN_MS);
