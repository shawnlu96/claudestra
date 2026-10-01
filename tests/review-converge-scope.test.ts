import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { fixDiffOf } from "../src/lib/review-converge-scope.js";
import { touchesDiff } from "../src/lib/review-converge.js";

test("real git fix diff preserves unicode and both sides of a rename; failed git keeps P1", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-fix-diff-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "test");
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "before.ts"), "export const x = 1;\n");
    const from = commit();
    renameSync(join(dir, "src", "before.ts"), join(dir, "src", "中文.ts"));
    const to = commit();
    const events: LedgerEvent[] = [2, 3].map((round) => ({ kind: "review", seq: round, ts: round, actor: "reviewer",
      project: "p", target: "T1", text: "", dedupKey: null, data: { round, head: round === 2 ? from : to } }));
    const diff = fixDiffOf({ id: "T1", round: 3 }, events, undefined, [dir]);
    expect(diff?.files.sort()).toEqual(["src/before.ts", "src/中文.ts"]);
    expect(touchesDiff("src/中文.ts:12", diff!.files)).toBe(true);
    expect(touchesDiff("src/Makefile:3", ["src/Makefile"])).toBe(true);
    expect(touchesDiff(".env:3", [".env"])).toBe(true);
    expect(touchesDiff("src/a b.ts:2", ["src/a b.ts"])).toBe(true);
    expect(touchesDiff("src/a.tsx:2", ["src/a.ts"])).toBe(false);
    const unknown = events.map((e) => ({ ...e, data: { ...e.data, head: e.data.round === 3 ? "f".repeat(40) : from } }));
    expect(fixDiffOf({ id: "T1", round: 3 }, unknown, () => { throw new Error("checkout gone"); }, [dir])).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
