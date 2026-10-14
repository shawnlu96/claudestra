/**
 * KEYUNION1: the recovery key table is its own union-merged file. Keys stay unique and well-formed (a union that duplicated a
 * line turns this red), no key from before the move is lost, and two cards appending at the same spot merge cleanly with
 * git's own union driver while the same edits in the old in-file table conflict.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECOVERY_KEYS } from "../src/lib/recovery-keys.js";
import { RECOVERY_KEYS as REEXPORTED } from "../src/lib/recovery-policy.js";
import { runBounded } from "../src/lib/run-bounded.js";

/** The table on main right before the move (a692e2429), in its order. */
const BEFORE = ["askReminder", "audit", "auditEscalate", "auditIdleFacts", "auditMirrorPush", "auditStall", "auditTrainQueue", "authorRebuild",
  "cardPause", "cardProcReap", "ciClaimUnsent", "ciCoverageGate", "ciIoMapFuse", "ciKnownFlaky", "ciManualResume", "ciProofReuse", "ciTrainFailureClass", "ciWebBuild",
  "dagWriteScrub", "deployFirst", "deployReconcile", "fixLocalSwap", "iaWatchdogScope", "lendConfigFailure", "lendUiShots", "localDelivery",
  "localFallback", "localReviewAdopt", "lockYield", "mainCarry", "mainCarryMerge", "mainCiPause", "manualCaseOwnership", "manualMergeQueue",
  "manualRecovery", "manualStall", "materials", "mergeContentReview", "mergeContentUi", "mergeDeployDetach", "mergeDirect", "mergeStaleYield",
  "mergeUnsentCancel", "modelOutcome", "nearMarker", "placementReservations", "planGap", "poolIdleSkip", "reviewLocalFirst", "roleModel", "skipEffectsAutoScope", "specObservationHours",
  "staleReplacement", "teamBody", "trainCiTimeout", "uiCarry", "uiCarryOwnGlobs", "uiDelivery", "uiManualResume", "uiReviewCarry",
  "unifiedMergeQueue", "updateGap"];
const ROOT = join(import.meta.dir, "..");

describe("recovery key table", () => {
  test("[验收线 5] keys are unique and each matches the key format", () => {
    expect(new Set(RECOVERY_KEYS).size).toBe(RECOVERY_KEYS.length);
    for (const k of RECOVERY_KEYS) expect(k).toMatch(/^[a-z][A-Za-z0-9]{2,40}$/);
  });

  test("[验收线 5] no key from before the move is lost and mergeUnion is there", () => {
    for (const k of BEFORE) expect(RECOVERY_KEYS as readonly string[]).toContain(k);
    expect(RECOVERY_KEYS).toContain("mergeUnion");
    expect(REEXPORTED).toBe(RECOVERY_KEYS); // recovery-policy.ts re-exports the same table for every caller
  });

  test("KEYSORT1: the table is in JS default sort order", () => {
    expect([...RECOVERY_KEYS]).toEqual([...RECOVERY_KEYS].sort());
  });

  test("the file holds only the table, one key per line, and .gitattributes merges it with union", () => {
    const text = readFileSync(join(ROOT, "src/lib/recovery-keys.ts"), "utf8");
    const code = text.replace(/\/\*\*[\s\S]*?\*\/\n/, "");
    expect(code).toBe(`export const RECOVERY_KEYS = [\n${RECOVERY_KEYS.map((k) => `  "${k}",\n`).join("")}] as const;\n`);
    expect(readFileSync(join(ROOT, ".gitattributes"), "utf8").split("\n")).toContain("src/lib/recovery-keys.ts merge=union");
  });
});

describe("[验收线 1] two cards adding a key at the same spot", () => {
  let root = "";
  const repo = async (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir);
    const git = async (...args: string[]) => {
      const r = await runBounded(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
        "-c", "core.attributesFile=/dev/null", ...args], { cwd: dir, timeoutMs: 30_000 });
      if (r.timedOut) throw new Error(`git ${args[0]} timed out`);
      return r;
    };
    await git("init", "-q", "-b", "main");
    return { dir, git };
  };
  const insertAfter = (text: string, anchor: string, key: string) => text.replace(`  "${anchor}",\n`, `  "${anchor}",\n  "${key}",\n`);
  /** base → card A and card B each insert one key after `anchor`; returns the merge exit code and the merged file */
  async function race(name: string, file: string, base: string, anchor: string, attributes?: string) {
    const { dir, git } = await repo(name);
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    writeFileSync(join(dir, file), base);
    if (attributes) writeFileSync(join(dir, ".gitattributes"), attributes);
    await git("add", "-A"); await git("commit", "-qm", "base");
    await git("checkout", "-qb", "a"); writeFileSync(join(dir, file), insertAfter(base, anchor, "alphaKey")); await git("commit", "-qam", "a");
    await git("checkout", "-q", "main"); writeFileSync(join(dir, file), insertAfter(base, anchor, "betaKey")); await git("commit", "-qam", "b");
    const merged = await git("merge", "--no-edit", "a");
    return { code: merged.code, text: readFileSync(join(dir, file), "utf8") };
  }
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "recovery-keys-")); });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("red: the old table inside recovery-policy.ts conflicts", async () => {
    const policy = `export const X = 1;\nexport const RECOVERY_KEYS = [\n${BEFORE.map((k) => `  "${k}",\n`).join("")}] as const;\nexport const Y = 2;\n`;
    const r = await race("old", "src/lib/recovery-policy.ts", policy, "authorRebuild");
    expect(r.code).not.toBe(0);
    expect(r.text).toContain("<<<<<<<");
  });

  test("green: recovery-keys.ts with this repo's .gitattributes merges cleanly with both keys, at the end and mid-table", async () => {
    const real = readFileSync(join(ROOT, "src/lib/recovery-keys.ts"), "utf8");
    const attributes = readFileSync(join(ROOT, ".gitattributes"), "utf8");
    for (const [name, anchor] of [["tail", RECOVERY_KEYS.at(-1)!], ["mid", "authorRebuild"]] as const) {
      const r = await race(name, "src/lib/recovery-keys.ts", real, anchor, attributes);
      expect(r.code).toBe(0);
      expect(r.text).not.toContain("<<<<<<<");
      const keys = [...r.text.matchAll(/^ {2}"(\w+)",$/gm)].map((m) => m[1]);
      expect(keys).toContain("alphaKey");
      expect(keys).toContain("betaKey");
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.length).toBe(RECOVERY_KEYS.length + 2);
    }
  });
});
