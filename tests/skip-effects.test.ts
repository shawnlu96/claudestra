// EFFCNT1：效果点清单计数自动更新（scripts/skip-effects.ts）。改写是纯函数；入口可注入读法和清单路径，真实清单端到端只动临时副本。
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectSites, parseInventory, passGraph, rewriteInventory, runSkipEffects } from "../scripts/skip-effects.ts";
import { SCHEDULER_PASS_PATHS } from "../src/lib/scheduler-v2-skip-paths.ts";

const ROOT = join(import.meta.dir, "..");
const LIB = join(ROOT, "src", "lib");
const INVENTORY = join(LIB, "scheduler-v2-skip-effects.ts");
const source = (f: string) => readFileSync(join(LIB, f), "utf8");
const flat = (inv: Record<string, Record<string, string>>) => new Map(Object.values(inv).flatMap((byFile) => Object.entries(byFile)));
const diff = (scan: Map<string, string>, reg: Map<string, string>) => [...new Set([...scan.keys(), ...reg.keys()])].sort()
  .filter((f) => scan.get(f) !== reg.get(f)).map((f) => `${f}: code "${scan.get(f) ?? "-"}" registered "${reg.get(f) ?? "-"}"`);

const SAMPLE = [
  "/** header */",
  "export const SKIP_EFFECT_FILES = {",
  "  /** first gate */",
  "  pace: {",
  '    "a.ts": "proc=1", "b.ts": "fs=2", "c.ts": "vcs=1",',
  '    "gone.ts": "fs=1",',
  "  },",
  "  infra: {",
  "    // b-side: gone.ts and a are explained here; c is not",
  '    "d.ts": "stmt=1", "e.ts": "sql=1 stmt=1",',
  `    "${"f".repeat(60)}.ts": "proc=1", "${"g".repeat(60)}.ts": "proc=1", "h.ts": "fs=1",`,
  "  },",
  "};",
  "",
].join("\n");

describe("EFFCNT1 rewriteInventory", () => {
  const scan = new Map([["a.ts", "proc=2"], ["b.ts", "fs=2"], ["c.ts", "vcs=1"], ["d.ts", "stmt=1"], ["e.ts", "sql=1 stmt=1"],
    [`${"f".repeat(60)}.ts`, `proc=1 ${"x=1 ".repeat(20).trim()}`], [`${"g".repeat(60)}.ts`, "proc=1"], ["h.ts", "fs=1"], ["new.ts", "vcs=2"]]);
  const r = rewriteInventory(SAMPLE, scan);
  const lines = r.text.split("\n");

  test("[验收线 1] (a) a changed count is replaced in place, every other byte is kept", () => {
    expect(r.changed).toEqual([{ file: "a.ts", from: "proc=1", to: "proc=2" }, { file: `${"f".repeat(60)}.ts`, from: "proc=1", to: `proc=1 ${"x=1 ".repeat(20).trim()}` }]);
    expect(lines[4]).toBe('    "a.ts": "proc=2", "b.ts": "fs=2", "c.ts": "vcs=1",');
    const keep = (t: string) => t.split("\n").filter((l) => !/"(a|gone|f+|g+|h)\.ts"/.test(l));
    expect(keep(r.text)).toEqual(keep(SAMPLE));
  });

  test("[验收线 1] (b) a registered file the scan no longer has is deleted, and a line it empties goes too", () => {
    expect(r.removed).toEqual([{ file: "gone.ts", was: "fs=1" }]);
    expect(r.text).not.toContain("gone.ts\":");
    expect(lines[5]).toBe("  },");
    const partial = rewriteInventory(SAMPLE, new Map([...scan].filter(([f]) => f !== "c.ts")));
    expect(partial.text.split("\n")[4]).toBe('    "a.ts": "proc=2", "b.ts": "fs=2",');
  });

  test("[验收线 1] (c) an unregistered file is not written, only listed", () => {
    expect(r.unregistered).toEqual([{ file: "new.ts", sites: "vcs=2" }]);
    expect(r.text).not.toContain("new.ts");
  });

  test("[验收线 1] (d) a line longer than 200 after the rewrite folds between entries with the same indent", () => {
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(200);
    const folded = lines.filter((l) => /"(f+|g+|h)\.ts"/.test(l));
    expect(folded.length).toBe(2);
    for (const l of folded) expect(l).toMatch(/^ {4}"/);
    expect(parseInventory(r.text)).toEqual(new Map([...scan].filter(([f]) => f !== "new.ts")));
  });

  test("touched files named in a `//` comment are reported for a manual check; untouched ones are not", () => {
    expect(r.comments).toEqual([{ file: "a.ts", line: 9 }, { file: "gone.ts", line: 9 }]);
    expect(rewriteInventory(SAMPLE, new Map([...scan, ["gone.ts", "fs=1"], ["a.ts", "proc=1"], ["d.ts", "stmt=2"]])).comments).toEqual([]);
  });
});

describe("EFFCNT1 real inventory end to end", () => {
  test("[验收线 2] a drifted count is rewritten in a temp copy; only the new file stays unregistered, exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skip-effects-"));
    try {
      const inventory = join(dir, "scheduler-v2-skip-effects.ts");
      copyFileSync(INVENTORY, inventory);
      const extra: Record<string, string> = { "zz-new-effect.ts": 'export const go = () => Bun.spawn(["gh", "pr", "merge"]);' };
      const find = "const wire =";
      const read = (f: string) => {
        if (extra[f]) return extra[f]!;
        const text = source(f);
        if (f !== "scheduler-lock-yield-deps.ts") return text;
        expect(text).toContain(find);
        return `import { go } from "./zz-new-effect.js";\n${text.replace(find, `${find}\n  const write = manager; await write("ledger", "scheduler-brand-new", c.taskId);`)}`;
      };
      const exists = (f: string) => f in extra || existsSync(join(LIB, f));
      const log: string[] = [];
      expect(runSkipEffects([], { inventory, read, exists, log: (l) => log.push(l) })).toBe(1);
      expect(log.join("\n")).toContain('改 scheduler-lock-yield-deps.ts: "ledger=2" → "ledger=3"');
      expect(log.join("\n")).toContain("未登记 zz-new-effect.ts");
      const { SKIP_EFFECT_FILES } = await import(inventory);
      expect(diff(effectSites(passGraph(read, exists)), flat(SKIP_EFFECT_FILES))).toEqual(['zz-new-effect.ts: code "proc=1 vcs=1" registered "-"']);
      expect(flat(SKIP_EFFECT_FILES).get("scheduler-lock-yield-deps.ts")).toBe("ledger=3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("[验收线 2] `bun run skip-effects --check` on this branch exits 0 and writes nothing", () => {
    const before = readFileSync(INVENTORY, "utf8");
    const p = Bun.spawnSync([process.execPath, "run", "skip-effects", "--check"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect([p.exitCode, p.stdout.toString().trim()]).toEqual([0, "效果点清单和代码一致"]);
    expect(readFileSync(INVENTORY, "utf8")).toBe(before);
  }, 30_000);

  test("an inventory text that disagrees with SKIP_EFFECT_FILES exits 2 and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "skip-effects-"));
    try {
      const inventory = join(dir, "inv.ts");
      const text = readFileSync(INVENTORY, "utf8").replace('"scheduler-lock-yield-deps.ts": "ledger=2"', '"scheduler-lock-yield-deps.ts": "ledger=9"');
      writeFileSync(inventory, text);
      expect(runSkipEffects([], { inventory, log: () => {} })).toBe(2);
      expect(readFileSync(inventory, "utf8")).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("[验收线 3] deployTick's gates include the unified hook", () => {
  expect(SCHEDULER_PASS_PATHS.find((p) => p.step === "deployTick")!.gates).toEqual(["pace", "hook", "manager"]);
});
