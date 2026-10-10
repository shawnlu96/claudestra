/**
 * MAINP2 验收线 8（审查 r1 verify-local / verify-reader）：真实临时 SQLite + 真实 Git。台账经 LedgerReader 的 query_only 连接读；
 * GitHub 事实由测试给（不联网）；每条沿用在钉住当时 main 的临时库里重跑证明。本地伪造 origin/main 不再能让核对通过。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
