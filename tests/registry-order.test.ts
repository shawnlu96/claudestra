/**
 * KEYSORT1: registries that cards insert lines into stay in order. The recovery key table is in JS default sort order (and the
 * pure check the merge queue runs on a union result says why when it is not), the skip-effects inventory holds one entry per
 * line sorted within each gate, and IMPLICIT_INPUTS stays sorted by module path. The gain, on real git without attributes
 * (as GitHub merges): two cards inserting at different places in the sorted table merge cleanly, one key apart is enough.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IMPACT_INPUTS } from "../src/lib/ci-impact-inputs.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-keys.js";
import { ORDERED_UNION_FILES, orderCheckFor, recoveryKeysOrderProblem } from "../src/lib/registry-order.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { ENTRY, inventoryLines, isEntryLine } from "../src/lib/skip-effects-auto-scope-scan.js";

const ROOT = join(import.meta.dir, "..");
const KEYS = "src/lib/recovery-keys.ts";
const table = (...keys: string[]) => `/** keys */\nexport const RECOVERY_KEYS = [\n${keys.map((k) => `  "${k}",\n`).join("")}] as const;\n`;
const sorted = (xs: readonly string[]) => [...xs].sort();

describe("recoveryKeysOrderProblem", () => {
  test("the real recovery-keys.ts has no problem", () => {
    expect(recoveryKeysOrderProblem(readFileSync(join(ROOT, KEYS), "utf8"))).toBeNull();
  });

  test("out of order, duplicated, missing table", () => {
    expect(recoveryKeysOrderProblem(table("audit", "beta", "gamma"))).toBeNull();
    expect(recoveryKeysOrderProblem(table("audit", "gamma", "beta"))).toBe("不按字母序：gamma 在 beta 前");
    expect(recoveryKeysOrderProblem(table("audit", "beta", "beta", "gamma"))).toBe("有重复键：beta");
    expect(recoveryKeysOrderProblem(table("zeta", "audit", "zeta"))).toBe("有重复键：zeta"); // a duplicate is named before the order
    expect(recoveryKeysOrderProblem(table("audit", "Zed"))).toBe("不按字母序：audit 在 Zed 前"); // UTF-16 code units: upper case first
    expect(recoveryKeysOrderProblem("export const OTHER = [\n] as const;\n")).toBe("找不到 RECOVERY_KEYS 表");
  });

  test("ORDERED_UNION_FILES registers only recovery-keys.ts, own keys only", () => {
    expect(Object.keys(ORDERED_UNION_FILES)).toEqual([KEYS]);
    expect(orderCheckFor(KEYS)).toBe(recoveryKeysOrderProblem);
    expect(orderCheckFor("src/lib/other.ts")).toBeUndefined();
    expect(orderCheckFor("constructor")).toBeUndefined();
  });
});

describe("skip-effects inventory and IMPLICIT_INPUTS order", () => {
  test("SKIP_EFFECT_FILES: each entry line holds exactly one entry, file names sorted within each gate", () => {
    const lines = readFileSync(join(ROOT, "src/lib/scheduler-v2-skip-effects.ts"), "utf8").split("\n"), { start, end } = inventoryLines(lines);
    const gates = new Map<string, string[]>();
    let gate = "";
    for (const l of lines.slice(start, end)) {
      const head = /^\s*(\w+)\s*:\s*\{/.exec(l);
      if (head) { gate = head[1]!; gates.set(gate, []); continue; }
      if (!isEntryLine(l)) continue;
      const entries = [...l.matchAll(ENTRY)];
      expect(entries.length, l).toBe(1);
      gates.get(gate)!.push(entries[0]![1]!);
    }
    expect(gates.size).toBeGreaterThan(5);
    for (const [g, files] of gates) expect(files, g).toEqual(sorted(files));
  });

  test("IMPLICIT_INPUTS is sorted by module path (webLoader / tmpCopy expanded)", () => {
    const modules = DEFAULT_IMPACT_INPUTS.implicit.map((i) => i.module);
    expect(modules.length).toBeGreaterThan(100);
    expect(modules).toEqual(sorted(modules));
  });
});

describe("[验收线 4] without attributes (as GitHub merges), inserts at different places in the sorted table", () => {
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
  /** base → card A inserts `a` after `anchorA`, card B (main) inserts `b` after `anchorB`; no .gitattributes at all */
  async function race(name: string, anchorA: string, a: string, anchorB: string, b: string) {
    const { dir, git } = await repo(name);
    const base = readFileSync(join(ROOT, KEYS), "utf8");
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    writeFileSync(join(dir, KEYS), base);
    await git("add", "-A"); await git("commit", "-qm", "base");
    await git("checkout", "-qb", "a"); writeFileSync(join(dir, KEYS), insertAfter(base, anchorA, a)); await git("commit", "-qam", "a");
    await git("checkout", "-q", "main"); writeFileSync(join(dir, KEYS), insertAfter(base, anchorB, b)); await git("commit", "-qam", "b");
    const merged = await git("merge", "--no-edit", "a");
    const text = readFileSync(join(dir, KEYS), "utf8");
    return { code: merged.code, text, keys: [...text.matchAll(/^ {2}"(\w+)",$/gm)].map((m) => m[1]!) };
  }
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "registry-order-")); });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("the anchors used below are adjacent in the real table", () => {
    const at = (k: string) => RECOVERY_KEYS.indexOf(k as never);
    expect(at("auditEscalate")).toBe(at("audit") + 1);
    expect(at("auditIdleFacts")).toBe(at("audit") + 2);
  });

  test("one key apart: the merge is clean, both keys are there and the table stays sorted", async () => {
    // auditB goes between audit and auditEscalate, auditF between auditEscalate and auditIdleFacts
    const r = await race("apart", "audit", "auditB", "auditEscalate", "auditF");
    expect(r.code).toBe(0);
    expect(r.text).not.toContain("<<<<<<<");
    expect(r.keys).toContain("auditB");
    expect(r.keys).toContain("auditF");
    expect(r.keys).toHaveLength(RECOVERY_KEYS.length + 2);
    expect(recoveryKeysOrderProblem(r.text)).toBeNull();
  });

  test("the same gap still conflicts without attributes (the case merge=union and the queue's order check cover)", async () => {
    const r = await race("same", "audit", "auditB", "audit", "auditC");
    expect(r.code).not.toBe(0);
    expect(r.text).toContain("<<<<<<<");
  });
});
