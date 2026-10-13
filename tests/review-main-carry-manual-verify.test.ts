/**
 * MAINP2 验收线 8（审查 r1 verify-local / verify-reader）：真实临时 SQLite + 真实 Git。台账经 LedgerReader 的 query_only 连接读；
 * GitHub 事实由测试给（不联网）；每条沿用在钉住当时 main 的临时库里重跑证明。本地伪造 origin/main 不再能让核对通过。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { statePath } from "../src/lib/paths.js";
import { runManualCarry } from "../src/lib/review-main-carry-manual.js";
import { verifyMergedCarry, type MergedFacts, type VerifyPorts } from "../src/lib/review-main-carry-manual-verify.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { pinnedProof } from "../src/lib/review-main-carry-manual-verify.js";
import { reviewMainCarryProof } from "../src/lib/review-main-carry-proof.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";

const REPO = "example/verify", PR = `https://github.com/${REPO}/pull/3`;
let root = "", work = "", ledgerPath = "", db: Database, reader: LedgerReader;
let oldHead = "", main1 = "", main2 = "", two = "", merged = "";
const sh = async (...args: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (f: string, m: string) => { writeFileSync(join(work, f), `${m}\n`); await sh("add", "-A"); await sh("commit", "-qm", m); return sh("rev-parse", "HEAD"); };
const git: VerifyPorts["git"] = async (a) => { const r = await runBounded(["git", ...a], { cwd: work, timeoutMs: 30_000 }); return { code: r.code ?? -1, stdout: r.stdout }; };
const facts = (over: Partial<MergedFacts["pr"]> = {}, more: Partial<MergedFacts> = {}): MergedFacts =>
  ({ pr: { state: "MERGED", baseRefName: "main", headRefOid: two, mergeSha: merged, ...over }, actualMain: merged, mainContainsMerge: true, ...more });
const ports = (more: Partial<VerifyPorts> = {}): VerifyPorts => ({ repoDir: work, git, deployConfigured: false, ...more });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mainp2-verify-")); work = join(root, "repo"); mkdirSync(work);
  ledgerPath = join(root, "ledger.sqlite"); db = openLedger(ledgerPath); reader = new LedgerReader(ledgerPath);
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
  await sh("init", "-q", "-b", "main"); await sh("remote", "add", "origin", `https://github.com/${REPO}.git`);
  const base = await commit("shared", "base");
  await sh("checkout", "-qb", "feature"); oldHead = await commit("feature", "reviewed");
  await sh("checkout", "-q", "--detach", base); main1 = await commit("main1", "m1"); main2 = await commit("main2", "m2");
  await sh("update-ref", "refs/remotes/origin/main", main2);
  await sh("checkout", "-q", "--detach", oldHead); await sh("merge", "-q", "--no-edit", main1); await sh("merge", "-q", "--no-edit", main2);
  two = await sh("rev-parse", "HEAD");
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "T1", kind: "code", agent: "agent-author" });
  setWorkflow(db, { actor: "owner", now: 2 }, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "manual", authorFamily: "claude",
    fallback: "人工", reason: "pm_takeover: PM 手动推进合并" });
  db.query("UPDATE tasks SET stage='merge', round=1, headSHA=?, pr=?, branch='task/T1' WHERE id='T1'").run(oldHead, PR);
  mkdirSync(statePath("ledger", "reviews"), { recursive: true });
  writeFileSync(statePath("ledger", "reviews", "verify-T1.md"), `PASS head ${oldHead}\n`);
  const reviewSeq = insertEvent(db, { actor: "agent-rv", now: 3 }, { project: "p", target: "T1", kind: "review", text: "",
    data: { round: 1, head: oldHead, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "rs", reviewerFamily: "codex", path: "reviews/verify-T1.md",
      findings: [], p0: 0, p1: 0, p2: 0 } }, false).seq;
  const t = getTask(db, "T1")!;
  const r = await runManualCarry(db, { actor: "pm", now: 4 }, { taskId: "T1", oldHead, newHead: two, mainHead: main2, specRev: t.specRev, round: 1, reviewSeq, rev: t.rev },
    { repoDir: work, policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }) });
  if (r.status !== "carried") throw new Error(JSON.stringify(r));
  merged = await sh("commit-tree", `${two}^{tree}`, "-p", main2, "-p", two, "-m", "merge PR");
  await sh("update-ref", "refs/remotes/origin/main", merged); // main moved on after the carry: the re-proof pins the recorded main itself
});
afterAll(() => { reader.close(); closeLedger(ledgerPath); if (root) rmSync(root, { recursive: true, force: true }); });

describe("post-merge verify against GitHub facts, read-only ledger", () => {
  test("merged PR at the carried head, merge on main, carry re-proved at its recorded main → ok (query_only connection)", async () => {
    const ro = reader.get()!;
    expect(() => ro.query("UPDATE tasks SET rev = rev WHERE id='T1'").run()).toThrow();
    expect(await verifyMergedCarry(ro, "T1", facts(), ports())).toEqual({ ok: true, carries: 1, mergeSha: merged, problems: [] });
  });
  test("a locally forged origin/main no longer passes: GitHub says not merged / other head / merge not on main", async () => {
    const ro = reader.get()!;
    const no = async (f: MergedFacts, why: RegExp) => {
      const r = await verifyMergedCarry(ro, "T1", f, ports());
      expect(r.ok).toBe(false);
      expect(r.problems.join("\n")).toMatch(why);
    };
    await no(facts({ state: "OPEN", mergeSha: null }), /不是已合入|合并提交/);
    await no(facts({ headRefOid: oldHead }), /台账 head/);
    await no(facts({}, { mainContainsMerge: false }), /不在 GitHub 当前 main/);
    await no(facts({ mergeSha: "f".repeat(40) }), /父提交|读不到/);
  });
  test("tampered diff hash or chain, a failed re-proof, and an unverifiable deploy are problems", async () => {
    const ro = reader.get()!;
    // events are append-only, so the re-proof is skewed instead: a different digest or chain than the one recorded is a problem
    const { pinnedProof } = await import("../src/lib/review-main-carry-manual-verify.js");
    const skew = (patch: (p: Record<string, unknown>) => Record<string, unknown>): VerifyPorts["prove"] => async (i) => {
      const p = await pinnedProof(i);
      return p.ok ? patch({ ...p }) as unknown as typeof p : p;
    };
    expect((await verifyMergedCarry(ro, "T1", facts(), ports({ prove: skew((p) => ({ ...p, diffHash: "0".repeat(64) })) }))).problems.join()).toContain("净 diff 摘要");
    expect((await verifyMergedCarry(ro, "T1", facts(), ports({ prove: skew((p) => ({ ...p, chain: (p.chain as unknown[]).slice(1) })) }))).problems.join()).toContain("链");
    expect((await verifyMergedCarry(ro, "T1", facts(), ports({ prove: async () => ({ ok: false, reason: "净 diff 变了" }) }))).problems.join()).toContain("不成立");
    expect((await verifyMergedCarry(ro, "T1", facts(), ports({ deployConfigured: true }))).problems.join()).toContain("部署无法核实");
  });
});

/** CARRY3: the pinned temp repo belongs to no project, so the mainCarryMerge mode must come from the original repoDir. */
describe("pinnedProof takes mainCarryMerge from the original project", () => {
  const CO = "example/carry3", VERBATIM = "合并 main 后 PR 对 main 的净 diff 变了";
  let dir = "", oldHead = "", mainA = "", mainB = "", clean = "", verbatim = "";
  const run = async (...args: string[]) => {
    const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, timeoutMs: 30_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const lines = (over: Record<number, string> = {}, top?: string) =>
    `${[...(top ? [top] : []), ...Array.from({ length: 20 }, (_, i) => over[i + 1] ?? `line ${i + 1}`)].join("\n")}\n`;
  const put = async (files: Record<string, string>, m: string) => {
    for (const [f, v] of Object.entries(files)) writeFileSync(join(dir, f), v);
    await run("add", "-A"); await run("commit", "-qm", m); return run("rev-parse", "HEAD");
  };
  const mergeOnto = async (head: string, main: string) => { await run("checkout", "-q", "--detach", head); await run("merge", "-q", "--no-edit", main); return run("rev-parse", "HEAD"); };
  const policy = (mode: RecoveryMode, repoDir = dir) => {
    writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { p: { repoDir, maxActiveWorkers: 2, requiredChecks: ["test"] } } }));
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mainCarryMerge: mode } } } }));
  };
  const input = (newHead: string, mainHead: string) => ({ repoDir: dir, repository: CO, base: "main" as const, mainHead, oldHead, newHead });
  /** the same proof read in the original repo with the mode forced: what the formal entry (merge-external) decides */
  const direct = (newHead: string, mainHead: string, mode: RecoveryMode) => reviewMainCarryProof(input(newHead, mainHead), undefined, () => mode);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "carry3-"));
    await run("init", "-q", "-b", "main"); await run("remote", "add", "origin", `https://github.com/${CO}.git`);
    const base = await put({ shared: lines(), other: "o\n" }, "base");
    oldHead = await put({ shared: lines({ 5: "card five", 15: "card fifteen" }) }, "card");
    await run("checkout", "-q", "--detach", base);
    mainA = await put({ other: "main a\n" }, "main A"); // other file only: the byte-exact proof alone holds
    mainB = await put({ shared: lines({}, "main inserted") }, "main B"); // same file: the card's hunks shift, the bytes no longer match
    verbatim = await mergeOnto(oldHead, mainA);
    clean = await mergeOnto(oldHead, mainB);
    await run("update-ref", "refs/remotes/origin/main", mainB);
  });
  afterEach(() => { rmSync(SCHEDULER_CONFIG_PATH, { force: true }); rmSync(RECOVERY_POLICY_PATH, { force: true }); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("[验收线 1] on: a clean-merge carry re-proves in the pinned repo exactly as the formal entry carried it", async () => {
    policy("on");
    const want = await direct(clean, mainB, "on");
    expect(want).toMatchObject({ ok: true, oldHead, newHead: clean, mainHead: mainB, mainParent: mainB });
    expect(await pinnedProof(input(clean, mainB))).toEqual(want);
  });

  test("[验收线 2] off and observe: the pinned re-proof is the original repo's decision under that mode", async () => {
    policy("off");
    expect(await pinnedProof(input(clean, mainB))).toEqual({ ok: false, reason: VERBATIM, mainParent: mainB, mainHead: mainB });
    policy("observe");
    const observed = await pinnedProof(input(clean, mainB));
    expect(observed).toEqual(await direct(clean, mainB, "observe"));
    expect(observed.ok).toBe(false);
    expect(observed.reason).toStartWith(`${VERBATIM}；mainCarryMerge=observe：on 会沿用`);
    policy("on", join(dir, "elsewhere")); // the project names another repoDir: the original repo is in no project → off
    expect(await pinnedProof(input(clean, mainB))).toEqual(await direct(clean, mainB, "off"));
  });

  test("[验收线 2] a byte-exact carry re-proves the same under off / observe / on", async () => {
    const want = await direct(verbatim, mainB, "off");
    expect(want.ok).toBe(true);
    for (const mode of ["off", "observe", "on"] as const) { policy(mode); expect(await pinnedProof(input(verbatim, mainB))).toEqual(want); }
  });
});
