/**
 * i28-FB1 end to end on a real ledger, through the scheduler tick, the pool CLI and the lend CLI (same harness as
 * lend-fix-reassign.test.ts): a fix going back to the write-lease holder starts from the PR branch's remote head when that is a
 * descendant of the card's head (fake gh compare), with the card's head moved and an event naming both heads; diverged or a failed
 * query keeps the card's head and alarms PM. A not_started for a start mismatch keeps the lease and re-offers once; the second
 * one in the round goes back to PM. A fix with no lease at any peer and a local executor is dispatched to that executor.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import type { Gh } from "../src/lib/lend-fix-reassign-pr.js";
import { FIX_START_ALARM_OP, FIX_START_MOVED_OP, FIX_START_RETRY_OP, ghFixStartProbe, probeFixStart } from "../src/lib/lend-fix-start.js";
import { fixStartReviewFacts } from "../src/lib/lend-fix-start-review.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { autoFixture, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

const H3 = "3".repeat(40);
const H4 = "4".repeat(40);
const FP = "abcd-ef01-2345-6789";
const BRANCH = "lend/T1-abcd";
const E2E_MS = 30_000;
const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r" };
const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 3 }];
const MISMATCH = "远端 试推 不是这一单的起点（被别人推过），不强推：! [rejected] (fetch first)";
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });

async function ready() {
  const f = autoFixture({ reviewerRuntime: "claude-code" });
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  delete reg.agents["agent-rv-t1"].transport;
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const policy: { maxActiveWorkers: number; remote: RemotePolicy } = { maxActiveWorkers: 2, remote: WRITE };
  const heads: Record<string, RemoteHead> = { main: { ok: true, head: "b".repeat(40) } };
  /** Fake GitHub refs and compare answers; no Git credential helper or network. */
  const compare: Record<string, ReturnType<typeof ok> | { code: number; stdout: string; stderr: string; timedOut: boolean }> = {};
  const gh: string[][] = [];
  const relayGh: Gh = async (args) => {
    gh.push(args);
    const ref = args[1]?.match(/^repos\/o\/r\/git\/ref\/heads\/(.+)$/);
    if (ref) {
      const h = heads[ref[1]];
      return h?.ok ? ok(h.head) : { code: 1, stdout: "", stderr: h?.error ?? "没有这个分支", timedOut: false };
    }
    const m = args[1]?.match(/^repos\/o\/r\/compare\/(.+)$/);
    return m ? compare[m[1]] ?? ok("") : ok("");
  };
  const startProbe = ghFixStartProbe({ peerFp: async (peer) => peer === "mate" ? FP : null,
    remoteHead: async () => { throw new Error("fix head must use gh API"); } }, relayGh);
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key),
      ...startProbe },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend, relayGh }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  let seq = 0;
  const hello = () => recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "boot-mate", seq: ++seq, slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } },
    paused: null, grant: { until: f.tickDeps.now() + 3 * 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, f.tickDeps.now());
  const lendCall = (op: string, body: unknown) => cli("owner", op, "--", "mate", JSON.stringify(body));
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const fixes = () => listLendOrders(f.db, "T1").filter((o) => o.step === "fix");
  await toBuild(f);
  return { f, cli, tick, hello, lendCall, heads, compare, gh, policy, events, fixes, orders: () => listLendOrders(f.db, "T1") };
}
type P = Awaited<ReturnType<typeof ready>>;

/** Build → mate's Codex writes H2 with PR #7 → reviewed with one P1 → fix, write lease at mate (same as RA1's toFix). */
async function toFix(p: P) {
  p.hello();
  await p.tick();
  const orderId = p.orders()[0].orderId;
  expect(await p.lendCall("lend-claim", { v: 1, orderId, worker: "w1" })).toMatchObject({ ok: true });
  p.heads[BRANCH] = { ok: true, head: H2 };
  expect(await p.lendCall("lend-write", { v: 1, orderId, gen: 1, branch: BRANCH, pr: 7, session: { id: "sess-mate", family: "codex" },
    deliver: { v: 1, orderId, head: H2, evidence: BRANCH, summary: "改好了", selfCheck: "单测全绿" } })).toMatchObject({ ok: true });
  await p.tick(); // pool_done
  await p.tick(); // reviewer session (claude)
  await p.tick(); // review order
  const report = join(p.f.dir, "report.md");
  writeFileSync(report, "# 审查报告\nP1：两个 tick 抢同一个意图");
  const findings = join(p.f.dir, "p1.json");
  writeFileSync(findings, JSON.stringify([P1]));
  expect(await p.cli("agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "changes", "--p0", "0", "--p1", "1", "--p2", "0",
    "--head", H2, "--session", "s-rv", "--family", "claude", "--findings", findings, "--path", report)).toMatchObject({ ok: true });
  await p.tick(); // → fix
  expect(p.f.task()).toMatchObject({ stage: "fix", headSHA: H2 });
  expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", branch: BRANCH, state: "held" });
}

const ofOp = (p: P, op: string) => p.events().filter((e) => e.kind === "scheduler" && e.data.op === op);

/** mate claims the pooled fix and reports not_started from its push probe. */
async function mismatch(p: P, detail = MISMATCH) {
  const o = p.fixes().at(-1)!;
  expect(await p.lendCall("lend-claim", { v: 1, orderId: o.orderId, worker: "w2" })).toMatchObject({ ok: true });
  expect(await p.lendCall("lend-lease", { v: 1, orderId: o.orderId, gen: 1, action: "release", reason: "not_started", detail })).toMatchObject({ ok: true });
  return o;
}

describe("fix order start follows the PR branch (i28-FB1)", () => {
  test.each([
    ["update-branch merge commit (card-merge.sh)", H3],
    ["a previous worker's pushed commit (delivery refused)", H4],
  ])("remote head is a descendant: %s → the fix starts there, card head moved, event names both heads", async (_label, remote) => {
    const p = await ready();
    try {
      await toFix(p);
      p.heads[BRANCH] = { ok: true, head: remote };
      p.compare[`${H2}...${remote}`] = ok("ahead\n");
      p.hello();
      expect(await p.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining("修复挂给 mate") });
      expect(p.fixes()).toEqual([expect.objectContaining({ peer: "mate", head: remote, branch: BRANCH, pr: 7, status: "pooled" })]);
      expect(p.f.task().headSHA).toBe(remote);
      const [moved] = ofOp(p, FIX_START_MOVED_OP);
      expect(moved.data).toMatchObject({ oldHead: H2, newHead: remote });
      expect(moved.data.reason).toContain("update-branch");
      expect(p.gh).toContainEqual(["api", `repos/o/r/git/ref/heads/${BRANCH}`, "--jq", ".object.sha"]);
      expect(p.gh).toContainEqual(["api", `repos/o/r/compare/${H2}...${remote}`, "--jq", ".status"]);
      expect(await p.lendCall("lend-claim", { v: 1, orderId: p.fixes()[0].orderId, worker: "w2" })).toMatchObject({ ok: true });
    } finally { p.f.close(); }
  }, E2E_MS);

  test.each([
    ["diverged", (p: P) => { p.heads[BRANCH] = { ok: true, head: H3 }; p.compare[`${H2}...${H3}`] = ok("diverged"); }, "已分叉"],
    ["gh compare fails", (p: P) => { p.heads[BRANCH] = { ok: true, head: H3 }; p.compare[`${H2}...${H3}`] = { code: 1, stdout: "", stderr: "gh: 502", timedOut: false }; }, "gh compare 失败"],
    ["remote head unreadable", (p: P) => { p.heads[BRANCH] = { ok: false, error: "gh API 超时" }; }, "查不到"],
  ])("%s → not adopted: the fix keeps the card's head and PM gets a visible alarm", async (_label, arrange, why) => {
    const p = await ready();
    try {
      await toFix(p);
      arrange(p);
      p.hello();
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(p.fixes()).toEqual([expect.objectContaining({ peer: "mate", head: H2, status: "pooled" })]);
      expect(p.f.task().headSHA).toBe(H2);
      expect(ofOp(p, FIX_START_MOVED_OP)).toEqual([]);
      const alarms = ofOp(p, FIX_START_ALARM_OP);
      expect(alarms).toHaveLength(1);
      expect(alarms[0].text).toContain(why);
      expect(alarms[0].data).toMatchObject({ head: H2 });
    } finally { p.f.close(); }
  }, E2E_MS);

  test.each([false, true])("not_started keeps lease and retries once; initial offer refreshed: %s", async (refreshFirst) => {
    const p = await ready();
    try {
      await toFix(p);
      const firstHead = refreshFirst ? H3 : H2;
      const retryHead = refreshFirst ? H4 : H3;
      p.heads[BRANCH] = { ok: true, head: firstHead };
      p.compare[`${H2}...${firstHead}`] = ok("ahead");
      p.hello();
      await p.tick();
      expect(p.fixes()).toEqual([expect.objectContaining({ head: firstHead, status: "pooled" })]);
      // The remote advances again after the first offer.
      p.heads[BRANCH] = { ok: true, head: retryHead };
      p.compare[`${firstHead}...${retryHead}`] = ok("ahead");
      const first = await mismatch(p);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ peer: "mate", state: "held" });
      expect(ofOp(p, FIX_START_RETRY_OP).map((e) => e.data)).toEqual([expect.objectContaining({ orderId: first.orderId, head: firstHead })]);
      expect(p.events().some((e) => e.data.lend && (e.data.lend as Record<string, unknown>).op === "send_back")).toBe(false);

      p.hello();
      for (let i = 0; i < 4 && p.fixes().length < 2; i++) await p.tick();
      expect(p.fixes().map((o) => [o.peer, o.head, o.status])).toEqual([["mate", firstHead, "released"], ["mate", retryHead, "pooled"]]);
      expect(p.f.task().headSHA).toBe(retryHead);
      const task = p.f.task(), events = p.events();
      expect(fixStartReviewFacts(task, events)).toMatchObject({ kind: "facts", facts: { head: H2, findings: [expect.objectContaining({ findingId: P1.findingId })] } });
      expect(currentReviewFacts(task, events).kind).toBe("invalid");
      expect(fixStartReviewFacts({ ...task, stage: "merge" }, events).kind).toBe("invalid");
      const moved = events.find((e) => e.data.op === FIX_START_MOVED_OP)!;
      const badMoves = [
        { ...moved, actor: "peer:mate" }, { ...moved, target: "OTHER" },
        { ...moved, data: { ...moved.data, specRev: task.specRev + 1 } },
        { ...moved, data: { ...moved.data, round: task.round + 1 } },
        { ...moved, data: { ...moved.data, oldHead: H4 } },
      ];
      for (const bad of badMoves) {
        expect(fixStartReviewFacts(task, events.map((e) => e === moved ? bad : e)).kind).toBe("invalid");
      }
      expect(fixStartReviewFacts(task, events.filter((e) => e !== moved)).kind).toBe("invalid");
      const delivered = { ...moved, seq: events.at(-1)!.seq + 1, kind: "deliver" as const, data: { headSHA: retryHead } };
      expect(fixStartReviewFacts(task, [...events, delivered]).kind).toBe("invalid");

      // The second mismatch in the same round ends the lease and goes back to PM, as before.
      await mismatch(p);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ state: "ended" });
      expect(ofOp(p, FIX_START_RETRY_OP)).toHaveLength(1);
      expect(p.events().some((e) => e.data.lend && (e.data.lend as Record<string, unknown>).op === "send_back")).toBe(true);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("a start mismatch the refresh cannot fix (diverged): the re-offer keeps the card head, the second mismatch goes to PM", async () => {
    const p = await ready();
    try {
      await toFix(p);
      p.hello();
      await p.tick();
      p.heads[BRANCH] = { ok: true, head: H3 };
      p.compare[`${H2}...${H3}`] = ok("diverged");
      await mismatch(p);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ state: "held" });
      p.hello();
      for (let i = 0; i < 4 && p.fixes().length < 2; i++) await p.tick();
      expect(p.fixes().map((o) => o.head)).toEqual([H2, H2]);
      expect(ofOp(p, FIX_START_ALARM_OP)).toHaveLength(1);
      await mismatch(p);
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ state: "ended" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("not_started for another reason still ends the lease at once (unchanged)", async () => {
    const p = await ready();
    try {
      await toFix(p);
      p.hello();
      await p.tick();
      await mismatch(p, "没有推送权限：出借人的 GitHub 登录推不了这个仓库");
      expect(getWriteLease(p.f.db, "T1")).toMatchObject({ state: "ended" });
      expect(ofOp(p, FIX_START_RETRY_OP)).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test.each([
    ["balance pool", WRITE],
    ["unified agent pool", { ...WRITE, agents: { claude: 1, codex: 1 } } as RemotePolicy],
  ])("lease reclaimed, executor local (%s): the fix is dispatched to task.agent, not pooled", async (_label, remote) => {
    const p = await ready();
    try {
      await toFix(p);
      expect(await p.cli("owner", "lend-reclaim", "T1", "--reason", "PM 收回本机做")).toMatchObject({ ok: true });
      const agent = p.f.task().agent;
      expect(agent).toBeTruthy();
      expect(p.f.task().assigneeKind).not.toBe("peer_agent");
      // RST1 r4: the local executor that took the card back writes in Codex, the family of the head on the PR branch.
      p.f.db.run("UPDATE scheduler_sessions SET family = 'codex' WHERE taskId = 'T1' AND role = 'author'");
      p.policy.remote = remote;
      p.hello();
      for (let i = 0; i < 4; i++) await p.tick();
      expect(p.fixes()).toEqual([]);
      const fixIntents = p.f.intents().filter((i: { action: string; node: string }) => i.action === "dispatch" && i.node === "fix");
      expect(fixIntents.map((i: { recipient: string | null }) => i.recipient)).toContain(agent);
      expect(fixIntents.some((i: { recipient: string | null }) => i.recipient?.startsWith("peer:"))).toBe(false);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("probeFixStart (pure, fake gh)", () => {
  const head = (h: string) => async (): Promise<RemoteHead> => ({ ok: true, head: h });
  test("same head: no gh call, nothing to do", async () => {
    const calls: string[][] = [];
    expect(await probeFixStart("o/r", BRANCH, H2, head(H2), async (a) => (calls.push(a), ok("")))).toBeNull();
    expect(calls).toEqual([]);
  });
  test("ahead → adopt; behind / identical-but-different / empty → refuse with the reason", async () => {
    expect(await probeFixStart("o/r", BRANCH, H2, head(H3), async () => ok("ahead"))).toEqual({ ok: true, from: H2, head: H3 });
    expect(await probeFixStart("o/r", BRANCH, H2, head(H3), async () => ok("behind"))).toMatchObject({ ok: false, head: H3, why: expect.stringContaining("behind") });
    expect(await probeFixStart("o/r", BRANCH, H2, head(H3), async () => ok(""))).toMatchObject({ ok: false, why: expect.stringContaining("（空）") });
    expect(await probeFixStart("o/r", BRANCH, H2, head("abc"), async () => ok("ahead"))).toMatchObject({ ok: false, head: null });
  });
});
