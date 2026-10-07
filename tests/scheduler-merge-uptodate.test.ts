import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { driveMerge, type MainFreshness, type MergeExternal, type PrSnapshot, type ReviewCarry } from "../src/lib/scheduler-merge-driver.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { parseCarryReceipt, type MergeRun } from "../src/lib/scheduler-merge.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { runBounded } from "../src/lib/run-bounded.js";

const H = "a".repeat(40), N = "d".repeat(40), M = "b".repeat(40), MAIN = "e".repeat(40), X = "f".repeat(40);
const base: MergeRun = { intentId: "i", taskId: "T1", project: "p", prRef: "https://github.com/a/b/pull/1",
  reviewedHead: H, expectedBranch: "task/T1", requiredChecks: "check", phase: "ready", rev: 1, mergeSha: null,
  reason: null, createdAt: 1, updatedAt: 1 };
const pr = (p: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: H, branch: "task/T1", base: "main", draft: false,
  crossRepository: false, mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }], ...p });
const CARRY: ReviewCarry = { ok: true, reason: "净 diff 一致", mainParent: X, mainHead: MAIN, diffHash: "9".repeat(64) };

type Fresh = MainFreshness | Error;
/** Fakes GitHub: inspect replays snapshots (last one repeats), freshness / carry replay their own queues the same way. */
function fixture(phase: MergeRun["phase"], o: { snaps: PrSnapshot[]; fresh?: Fresh[]; carry?: (ReviewCarry | Error)[]; refuse?: MergeRun["phase"] }) {
  let row: MergeRun = { ...base, phase };
  const snaps = [...o.snaps], fresh = [...(o.fresh ?? [{ behindBy: 0, mainHead: MAIN }])], carry = [...(o.carry ?? [CARRY])];
  const calls: string[] = [], heads: (string | undefined)[] = [];
  const next = <T>(q: T[]): T => (q.length > 1 ? q.shift()! : q[0]!);
  const ops: MergeExternal = {
    inspect: async () => { calls.push("inspect"); return next(snaps); },
    freshness: async (_, head) => {
      calls.push(`fresh:${head.slice(0, 1)}`);
      const r = next(fresh);
      if (r instanceof Error) throw r;
      return r;
    },
    carryReview: async (_, oldHead, newHead) => {
      calls.push(`carry:${oldHead.slice(0, 1)}>${newHead.slice(0, 1)}`);
      const r = next(carry);
      if (r instanceof Error) throw r;
      return r;
    },
    updateBranch: async () => { calls.push("update"); },
    merge: async (_, expectedHead) => {
      calls.push(`merge:${expectedHead.slice(0, 1)}`);
      snaps.splice(0, snaps.length, pr({ state: "MERGED", head: row.reviewedHead, mergeSha: M }));
      return M;
    },
  };
  const advance = async (from: MergeRun["phase"], to: MergeRun["phase"], rev: number, receipt?: string, mergeSha?: string, newHead?: string) => {
    expect([from, rev]).toEqual([row.phase, row.rev]);
    if (to === o.refuse) throw new Error("等 CI 期间 main 已前进 3 次，不再自动更新"); // what the journal says on the 4th refresh
    calls.push(`journal:${to}`);
    heads.push(newHead);
    // Mirrors the journal: a carried await_ci re-pins the run on the new head.
    row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null, mergeSha: mergeSha ?? row.mergeSha,
      reviewedHead: to === "await_ci" && newHead ? newHead : row.reviewedHead };
    return row;
  };
  return { get row() { return row; }, calls, heads, drive: () => driveMerge(row, ops, advance) };
}

describe("i28-M9 ready: a branch behind main is always updated first", () => {
  test.each([["CLEAN"], ["UNSTABLE"], ["BEHIND"]])("behind main with mergeState=%s → update-branch, never await_ci", async (mergeState) => {
    const f = fixture("ready", { snaps: [pr({ mergeState, checks: [{ name: "check", bucket: "pending" }] })], fresh: [{ behindBy: 3, mainHead: MAIN }] });
    await f.drive();
    expect(f.row.phase).toBe("updating");
    expect(f.calls).toEqual(["inspect", "fresh:a", "journal:updating", "update"]);
  });
  test("GitHub BEHIND still updates even if compare says 0 (either signal is enough)", async () => {
    const f = fixture("ready", { snaps: [pr({ mergeState: "BEHIND" })] });
    await f.drive();
    expect(f.calls).toEqual(["inspect", "fresh:a", "journal:updating", "update"]);
  });
  test("staleness lookup failing is unknown, never 'up to date': no update, no await_ci, no merge", async () => {
    const f = fixture("ready", { snaps: [pr()], fresh: [new Error("gh compare 失败：HTTP 502")] });
    await f.drive();
    expect(f.row.phase).toBe("unknown");
    expect(f.row.reason).toContain("HTTP 502");
    expect(f.calls).toEqual(["inspect", "fresh:a", "journal:unknown"]);
  });
  test("up to date + CLEAN keeps the old path; draft is still a silent wait before any lookup", async () => {
    const ok = fixture("ready", { snaps: [pr()] });
    await ok.drive();
    expect(ok.calls).toEqual(["inspect", "fresh:a", "journal:await_ci"]);
    const draft = fixture("ready", { snaps: [pr({ draft: true })], fresh: [{ behindBy: 9, mainHead: MAIN }] });
    await draft.drive();
    expect(draft.calls).toEqual(["inspect"]);
  });
});

describe("i28-M9 updating: a moved head keeps its review only when it merely merged main in", () => {
  test("pure merge of main → await_ci on the new head, receipt carries both heads, main head and diff hash", async () => {
    const f = fixture("updating", { snaps: [pr({ head: N, mergeState: "UNSTABLE", checks: [{ name: "check", bucket: "pending" }] })] });
    await f.drive();
    expect(f.row.phase).toBe("await_ci");
    expect(f.heads).toEqual([N]);
    expect(parseCarryReceipt(f.row.reason!)).toEqual({ oldHead: H, newHead: N, mainParent: X, mainHead: MAIN, diffHash: CARRY.diffHash! });
    expect(f.calls).toEqual(["inspect", "carry:a>d", "journal:await_ci"]);
  });
  const refusals: [string, ReviewCarry | Error][] = [
    ["not a merge commit", { ok: false, reason: "新 head 不是合并提交（父提交 1 个）" }],
    ["wrong parents", { ok: false, reason: "另一个父提交不在 main 上" }],
    ["net diff changed / evil merge", { ok: false, reason: "合并 main 后 PR 对 main 的净 diff 变了" }],
    ["lookup failed", new Error("git fetch 失败：network")],
    ["ok without evidence", { ok: true, reason: "?" }],
  ];
  test.each(refusals)("%s → await_review with the new head, old review void", async (_, carry) => {
    const f = fixture("updating", { snaps: [pr({ head: N })], carry: [carry] });
    await f.drive();
    expect(f.row.phase).toBe("await_review");
    expect(f.heads).toEqual([N]);
    expect(f.row.reason).toContain("旧审查失效");
    expect(f.calls).not.toContain("journal:await_ci");
  });
  test("carried head waiting on GitHub persists only the UNKNOWN clock and re-checks next round", async () => {
    for (const p of [{ mergeState: "UNKNOWN" }, { mergeState: "BEHIND" }, { draft: true }]) {
      const f = fixture("updating", { snaps: [pr({ head: N, ...p })] });
      await f.drive();
      expect(f.row.phase).toBe("updating");
      expect(f.calls).toEqual(["inspect", "carry:a>d", ...(p.mergeState === "UNKNOWN" ? ["journal:updating"] : [])]);
    }
  });
  test("carried head with a failed check or odd mergeState is unknown, not a merge", async () => {
    const failedCi = fixture("updating", { snaps: [pr({ head: N, mergeState: "UNSTABLE", checks: [{ name: "check", bucket: "fail" }] })] });
    await failedCi.drive();
    expect(failedCi.row.phase).toBe("unknown");
  });
  test("carried head DIRTY → carry journaled, then conflict bounce back to fix on the new head (i28-M12b)", async () => {
    const dirty = fixture("updating", { snaps: [pr({ head: N, mergeState: "DIRTY" })] });
    await dirty.drive();
    expect(dirty.row.phase).toBe("resolved");
    expect(dirty.row.reason).toBe(`退回 fix（conflict）：PR head ${N}，main head ${MAIN}`);
    expect(dirty.calls).toEqual(["inspect", "carry:a>d", "journal:await_ci", "fresh:d", "journal:resolved"]);
    expect(dirty.calls).not.toContain("merge:d");
  });
  test("losing ownership during the carry check propagates instead of journaling", async () => {
    const f = fixture("updating", { snaps: [pr({ head: N })], carry: [new SchedulerStopped("lost")] });
    await expect(f.drive()).rejects.toBeInstanceOf(SchedulerStopped);
    expect(f.calls).toEqual(["inspect", "carry:a>d"]);
  });
  test("end to end: main moves during CI → re-update → carried again → merged on the newest head", async () => {
    const f = fixture("await_ci", { snaps: [pr(), pr({ head: N }), pr({ head: N })],
      fresh: [{ behindBy: 1, mainHead: MAIN }, { behindBy: 0, mainHead: MAIN }] });
    await f.drive();
    expect(f.row.phase).toBe("updating");
    await f.drive();
    expect([f.row.phase, f.row.reviewedHead]).toEqual(["await_ci", N]);
    await f.drive();
    expect(f.row.phase).toBe("merged");
    expect(f.calls).toContain("merge:d");
  });
  test("end to end: stale CLEAN PR → update → carried → CI green on the new head → merged pinned to the new head", async () => {
    const f = fixture("ready", { snaps: [pr(), pr({ head: N, mergeState: "UNKNOWN" }), pr({ head: N })],
      fresh: [{ behindBy: 2, mainHead: MAIN }, { behindBy: 0, mainHead: MAIN }] });
    for (let i = 0; i < 6 && f.row.phase !== "merged"; i++) await f.drive();
    expect(f.row.phase).toBe("merged");
    expect(f.calls).toContain("merge:d");
    expect(f.calls.filter((c) => c.startsWith("merge:a"))).toEqual([]);
  });
});

describe("i28-M9 await_ci: main moving while CI ran is never merged", () => {
  test("green but behind → back to updating and update-branch again, never a merge", async () => {
    const f = fixture("await_ci", { snaps: [pr()], fresh: [{ behindBy: 1, mainHead: MAIN }] });
    await f.drive();
    expect(f.row.phase).toBe("updating");
    expect(f.calls).toEqual(["inspect", "fresh:a", "journal:updating", "update"]);
  });
  test.each([["pass"], ["pending"]] as const)("GitHub BEHIND with %s checks → back to updating without asking compare (M9-R1-001)", async (bucket) => {
    const f = fixture("await_ci", { snaps: [pr({ mergeState: "BEHIND", checks: [{ name: "check", bucket }] })], fresh: [new Error("must not be asked")] });
    await f.drive();
    expect(f.row.phase).toBe("updating");
    expect(f.calls).toEqual(["inspect", "journal:updating", "update"]);
  });
  test("GitHub BEHIND keeps every other guard: failed optional CI / moved head / base / branch / fork / closed → unknown, draft waits", async () => {
    const behind = (p: Partial<PrSnapshot>) => pr({ mergeState: "BEHIND", ...p });
    // A failed *required* check on the reviewed head is a bounce back to fix since i28-M12 (tests/scheduler-merge-conflict.test.ts).
    for (const p of [{ checks: [{ name: "check", bucket: "pass" as const }, { name: "lint", bucket: "fail" as const }] }, { head: N }, { base: "dev" },
      { branch: "task/T2" }, { crossRepository: true }, { state: "CLOSED" as const }]) {
      const f = fixture("await_ci", { snaps: [behind(p)] });
      await f.drive();
      expect([f.row.phase, f.calls.includes("update")]).toEqual(["head" in p ? "await_review" : "unknown", false]); // MCRY3: an author push re-reviews
    }
    const draft = fixture("await_ci", { snaps: [behind({ draft: true })] });
    await draft.drive();
    expect(draft.calls).toEqual(["inspect"]);
  });
  test("GitHub BEHIND after the refresh budget is spent → unknown, no update", async () => {
    const f = fixture("await_ci", { snaps: [pr({ mergeState: "BEHIND" })], refuse: "updating" });
    await f.drive();
    expect([f.row.phase, f.calls.includes("update")]).toEqual(["unknown", false]);
  });
  test("staleness lookup failing right before merge → unknown, no merge", async () => {
    const f = fixture("await_ci", { snaps: [pr()], fresh: [new Error("gh compare 失败")] });
    await f.drive();
    expect(f.row.phase).toBe("unknown");
    expect(f.calls.some((c) => c.startsWith("merge:"))).toBe(false);
  });
  test("the journal refusing another refresh (4th time) → unknown, no update, no merge", async () => {
    const f = fixture("await_ci", { snaps: [pr()], fresh: [{ behindBy: 1, mainHead: MAIN }], refuse: "updating" });
    await f.drive();
    expect(f.row.phase).toBe("unknown");
    expect(f.row.reason).toContain("前进 3 次");
    expect(f.calls.some((c) => c === "update" || c.startsWith("merge:"))).toBe(false);
  });
  test("green and up to date → merges on the reviewed head", async () => {
    const f = fixture("await_ci", { snaps: [pr()] });
    await f.drive();
    expect(f.row.phase).toBe("merged");
    expect(f.calls).toEqual(["inspect", "fresh:a", "inspect", "journal:merging", "merge:a", "inspect", "journal:merged"]);
  });
});

const policy = (repoDir: string) => parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["check"], repoDir } } }).projects.p;

describe("i28-M9 external freshness reads GitHub compare and rejects anything malformed", () => {
  const withOut = (stdout: string, code = 0) => {
    const calls: string[][] = [];
    const command: typeof runBounded = async (argv) => { calls.push(argv); return { code, stdout, stderr: "boom", timedOut: false }; };
    return { calls, ops: mergeExternal(policy("/tmp/project"), command) };
  };
  test("parses behind_by and main head from a bounded jq projection", async () => {
    const { calls, ops } = withOut(JSON.stringify({ behind: 4, main: MAIN }));
    expect(await ops.freshness(base.prRef, H)).toEqual({ behindBy: 4, mainHead: MAIN });
    expect(calls).toEqual([["gh", "api", `repos/a/b/compare/main...${H}`, "--jq", "{behind: .behind_by, main: .base_commit.sha}"]]);
  });
  test.each([[{ behind: null, main: MAIN }], [{ behind: -1, main: MAIN }], [{ behind: 1.5, main: MAIN }], [{ behind: 0, main: "x" }], [{}]])(
    "malformed %j throws", async (out) => {
      await expect(withOut(JSON.stringify(out)).ops.freshness(base.prRef, H)).rejects.toThrow();
    });
  test("gh failure and bad inputs throw", async () => {
    await expect(withOut("", 1).ops.freshness(base.prRef, H)).rejects.toThrow(/gh 失败/);
    await expect(withOut("{}").ops.freshness(base.prRef, "nope")).rejects.toThrow(/head/);
    await expect(withOut("{}").ops.freshness("https://evil.example/a/b/pull/1", H)).rejects.toThrow(/PR URL/);
  });
});

describe("i28-M9 external carryReview against a real git repository", () => {
  let root = "", work = "";
  const sh = async (...argv: string[]) => {
    const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...argv],
      { cwd: work, timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commitFile = async (file: string, body: string, msg: string) => {
    writeFileSync(join(work, file), body);
    await sh("add", file);
    await sh("commit", "-q", "-m", msg);
    return sh("rev-parse", "HEAD");
  };
  const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i}${i === 0 ? tag : ""}`).join("\n") + "\n";
  let reviewed = "", mainTip = "";
  /** MAINP2: the canonical proof binds origin to the PR's GitHub repository; the network fetch is served from the local bare repo. */
  const localFetch: typeof runBounded = (argv, opts) =>
    runBounded(argv[0] === "git" && argv[1] === "fetch" ? argv.map((a) => (a === "origin" ? join(root, "origin.git") : a)) : argv, opts);
  const ops = () => mergeExternal(policy(work), localFetch);
  /** A fresh topic branch off the reviewed head; returns to `feature` afterwards so cases stay independent. */
  const onBranch = async (name: string, build: () => Promise<void>) => {
    await sh("checkout", "-q", "-b", name, reviewed);
    await build();
    const head = await sh("rev-parse", "HEAD");
    await sh("push", "-q", "origin", `HEAD:refs/heads/${name}`);
    await sh("checkout", "-q", "feature");
    return head;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "m9-carry-"));
    work = join(root, "work");
    await runBounded(["git", "init", "-q", "--bare", "-b", "main", join(root, "origin.git")], { timeoutMs: 30_000 });
    await runBounded(["git", "init", "-q", "-b", "main", work], { timeoutMs: 30_000 });
    await sh("remote", "add", "origin", "https://github.com/a/b.git");
    await sh("remote", "set-url", "--push", "origin", join(root, "origin.git"));
    await commitFile("shared.txt", lines(40), "base");
    await commitFile("other.txt", "o\n", "base2");
    await sh("push", "-q", "origin", "main");
    await sh("checkout", "-q", "-b", "feature");
    reviewed = await commitFile("feature.txt", "reviewed change\n", "feature");
    await sh("push", "-q", "origin", "feature");
    await sh("checkout", "-q", "main");
    mainTip = await commitFile("other.txt", "o2\n", "main moves on");
    await sh("push", "-q", "origin", "main");
    await sh("checkout", "-q", "feature");
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("pure merge of main → ok, evidence names the main parent, main head and the diff hash", async () => {
    const head = await onBranch("pure", () => sh("merge", "-q", "--no-edit", mainTip).then(() => {}));
    const r = await ops().carryReview(base.prRef, reviewed, head);
    expect(r).toMatchObject({ ok: true, mainParent: mainTip, mainHead: mainTip });
    const diff = await sh("diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--binary", "--full-index", `origin/main...${head}`);
    expect(r.diffHash).toBe(createHash("sha256").update(`${diff}\n`).digest("hex"));
  });
  test("evil merge (extra change folded into the merge commit) → refused", async () => {
    const head = await onBranch("evil", async () => {
      await sh("merge", "-q", "--no-commit", "--no-ff", mainTip);
      writeFileSync(join(work, "feature.txt"), "reviewed change\nsmuggled\n");
      await sh("add", "feature.txt");
      await sh("commit", "-q", "--no-edit");
    });
    expect(await ops().carryReview(base.prRef, reviewed, head)).toMatchObject({ ok: false, reason: expect.stringContaining("净 diff") });
  });
  test("plain commit on top (not a merge) → refused", async () => {
    const head = await onBranch("plain", () => commitFile("feature.txt", "changed after review\n", "more").then(() => {}));
    expect((await ops().carryReview(base.prRef, reviewed, head)).ok).toBe(false);
  });
  test("merge whose other parent is not on main → refused", async () => {
    await sh("checkout", "-q", "-b", "side", "main");
    const side = await commitFile("side.txt", "s\n", "side only");
    await sh("checkout", "-q", "feature");
    const head = await onBranch("offmain", () => sh("merge", "-q", "--no-edit", side).then(() => {}));
    expect(await ops().carryReview(base.prRef, reviewed, head)).toMatchObject({ ok: false, reason: expect.stringContaining("不在 main") });
  });
  test("merge whose parents do not include the reviewed head → refused", async () => {
    const other = await onBranch("other-base", () => commitFile("feature.txt", "different\n", "x").then(() => {}));
    await sh("checkout", "-q", "-b", "wrongparent", other);
    await sh("merge", "-q", "--no-edit", mainTip);
    const head = await sh("rev-parse", "HEAD");
    await sh("push", "-q", "origin", "HEAD:refs/heads/wrongparent");
    await sh("checkout", "-q", "feature");
    expect((await ops().carryReview(base.prRef, reviewed, head)).ok).toBe(false);
  });
  test("main touched the same file → net diff text differs → refused (re-review, never a silent pass)", async () => {
    await sh("checkout", "-q", "main");
    await commitFile("shared.txt", lines(40, " main-edit"), "main edits shared");
    await sh("push", "-q", "origin", "main");
    await sh("checkout", "-q", "feature");
    const touched = await onBranch("touch-base", () => commitFile("shared.txt", lines(40).replace("line 39", "line 39 pr"), "pr edits shared").then(() => {}));
    const merged = await onBranch("touch-merge", async () => {
      await sh("reset", "-q", "--hard", touched);
      await sh("merge", "-q", "--no-edit", "origin/main");
    });
    const r = await ops().carryReview(base.prRef, touched, merged);
    expect(r.ok).toBe(false);
  });
  test("an unknown commit throws (caller turns that into await_review)", async () => {
    await expect(ops().carryReview(base.prRef, reviewed, "1".repeat(40))).rejects.toThrow();
  });
});
