import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convergeFollowUp, mainHasPath } from "../src/lib/review-converge-followup.js";
import { downgradeBrief, followUpGlobs, probeLead } from "../src/lib/review-converge-followup-text.js";
import type { Downgrade } from "../src/lib/review-converge.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getDagVersion } from "../src/lib/ledger-feature.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const ctx = { actor: "owner", now: 1000 };
const MIXED = "[验收线 1] hold-slot.ts 没释放，见 /tmp/rv-mt1f2-r2-acceptance.test.ts；void/done 两条路径都漏，真问题在 src/lib/review-converge.ts:40。";
const NONE = "hold-slot.ts 在 void/done 里没释放；复现 /tmp/rv-x.test.ts。";

function git(dir: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

describe("follow-up fileGlobs name only real repo paths", () => {
  test("tmp paths, missing bare names and prose tokens drop; nothing left falls back to the card's globs", () => {
    const exists = (p: string) => ["src/lib/review-converge.ts", "package.json"].includes(p);
    expect(followUpGlobs([{ probe: MIXED }], ["src/own.ts"], exists)).toEqual(["src/lib/review-converge.ts"]);
    expect(followUpGlobs([{ probe: NONE }], ["src/own.ts"], exists)).toEqual(["src/own.ts"]);
    expect(followUpGlobs([{ probe: "package.json:3" }], ["src/own.ts"], exists)).toEqual(["package.json"]);
    // /tmp is never a repo path, even if a same-named file is tracked
    expect(followUpGlobs([{ probe: "/tmp/a.ts" }], ["src/own.ts"], () => true)).toEqual(["src/own.ts"]);
  });

  test("main's tree is the reference: an untracked working-tree file does not count", () => {
    const dir = mkdtempSync(join(tmpdir(), "converge-main-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "tracked.ts"), "x");
      git(dir, "add", "tracked.ts");
      git(dir, "commit", "-q", "-m", "init");
      writeFileSync(join(dir, "untracked.ts"), "x");
      const has = mainHasPath(dir);
      expect([has("tracked.ts"), has("untracked.ts"), has("void/done")]).toEqual([true, false, false]);
      const plain = mkdtempSync(join(tmpdir(), "converge-nogit-"));
      writeFileSync(join(plain, "here.ts"), "x");
      expect([mainHasPath(plain)("here.ts"), mainHasPath(plain)("gone.ts")]).toEqual([true, false]);
      rmSync(plain, { recursive: true, force: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the node the scheduler builds keeps the real path, or the card's globs when the probe names none", () => {
    const dir = mkdtempSync(join(tmpdir(), "converge-globs-"));
    const path = join(dir, "ledger.sqlite"), db = openLedger(path);
    try {
      setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
      createTask(db, ctx, { project: "p", id: "T1", title: "task", kind: "code", pm: "pm" });
      db.query("INSERT OR REPLACE INTO ledger_instance (key, value) VALUES ('origin', 'abcd')").run();
      const feature = createFeature(db, ctx, { project: "p", slug: "feat", title: "feature" }).row;
      initDag(db, ctx, { id: feature.id, rev: feature.rev, nodes: [{ key: "A", taskId: "T1", fileGlobs: ["src/old.ts"] }] });
      const task = getTask(db, "T1")!;
      const report = join(dir, "report.md"); writeFileSync(report, "# r\n");
      const d = (round: number, probe: string): Downgrade => ({ round, head: "a".repeat(40), reportPath: report,
        items: [{ findingId: "F1", family: "slot", probe, why: "no_basis" }] });
      db.transaction(() => convergeFollowUp(db, ctx, task, d(2, MIXED), dir))();
      expect(getDagVersion(db, feature.id, 2)!.nodes.find((n) => n.key === "Af2")?.fileGlobs).toEqual(["src/lib/review-converge.ts"]);
      db.transaction(() => convergeFollowUp(db, ctx, task, d(3, NONE), dir))();
      expect(getDagVersion(db, feature.id, 3)!.nodes.find((n) => n.key === "Af3")?.fileGlobs).toEqual(["src/old.ts"]);
    } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("PM hears why a P1 was demoted", () => {
  test("the brief names the reason and the probe's first sentence", () => {
    expect(probeLead("第一句。第二句")).toBe("第一句。");
    expect(probeLead("src/a.ts:3 leaks. Then more")).toBe("src/a.ts:3 leaks.");
    const brief = downgradeBrief({ items: [{ findingId: "F1", family: "f", probe: "[验收 线] 漏了释放。细节很长", why: "no_basis" },
      { findingId: "F2", family: "f", probe: "别处的问题", why: "outside_diff" }] });
    expect(brief).toBe("「F1」 没对应验收线：「[验收 线] 漏了释放。」；「F2」 修复 diff 外的新问题：「别处的问题」");
  });

  test("the pass notice after a demotion carries reason and probe lead", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick();
      expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
      await f.tick(); await f.tick();
      const path = join(f.dir, "report.md"); writeFileSync(path, "# r\n");
      expect(await f.review("changes", H1, [{ findingId: "cleanup", family: "cleanup", severity: "P1",
        probe: "命名不统一，不挂验收线。其余略" }], ["--path", path])).toMatchObject({ ok: true });
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
      const notice = f.notices.find((t) => t.includes("审查通过但留有 P2"));
      expect(notice).toContain("1 项 P1 降为 P2");
      expect(notice).toContain("没对应验收线：「命名不统一，不挂验收线。」");
    } finally { f.close(); }
  });
});
