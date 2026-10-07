/**
 * 原用例只在私有子进程里跑（scheduler-update-fail-remote-fixture.ts）：子进程登记 CLAUDESTRA_UPDTEST_MODE 那一条，
 * 父进程在模块顶层并行起两套子进程（外加改坏断言、setup 失败重启各一条）再逐条核结果，不碰本进程的 module cache / STATE。
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { ackFindings, openFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { bounceReceipt, parseBounceReceipt, updateOrBounce } from "../src/lib/scheduler-merge-conflict.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import { autoFixture, H2 } from "./scheduler-auto-helpers.js";
import { assertChildPassed, childCase, MODES, reportChild, runChild } from "./scheduler-update-fail-remote-fixture.js";

const child = childCase();

for (const mode of MODES) {
if (child?.mode !== mode) continue;
const refused = mode === "secret";
test(`GitHub update refusal: ${mode}`, async () => {
  const f = autoFixture();
  try {
    if (child.hook === "failSetup") throw new Error("synthetic setup failure after the fixture opened");
    const base = "b".repeat(40), foreign = refused ? `sk-${"Q".repeat(20)}` : H2, branch = "lend/T1-abcd";
    const error = mode === "plain" ? "HTTP 422: update permission denied" : `GitHub update refused: expected commit ${foreign}, please retry`;
    const run = { taskId: "T1", reviewedHead: H2, prRef: "https://github.com/o/r/pull/7", phase: "updating" } as MergeRun;
    let receipt = "";
    await updateOrBounce(run, {
      updateBranch: async () => { throw new Error(error); }, inspect: async () => { throw new Error("read unavailable"); },
      freshness: async () => ({ behindBy: 0, mainHead: base }), carryReview: async () => ({ ok: false, reason: "unused" }), merge: async () => H2,
    }, async (_phase, r) => { receipt = r!; return run; }, () => false);
    const bounce = parseBounceReceipt(receipt)!;
    expect(bounce).toMatchObject({ cause: "update_fail", error: child.hook === "corrupt" ? `${error} (corrupted)` : error });
    expect(receipt).toBe(bounceReceipt(bounce));
    const spec = join(f.dir, "spec.md");
    writeFileSync(spec, "规格：修复更新分支失败");
    f.db.run("UPDATE tasks SET stage='fix', stageBefore='merge', round=1, headSHA=?, branch=?, pr=?, spec=? WHERE id='T1'",
      [H2, branch, run.prRef, spec]);
    f.db.run("UPDATE task_workflows SET authorFamily='codex' WHERE taskId='T1'");
    holdWriteLease(f.db, f.task(), { peer: "mate", fp: "abcd-ef01-2345-6789", branch, repo: "o/r" }, 1000);
    insertEvent(f.db, { actor: "scheduler", now: 1001 }, { project: "p", target: "T1", kind: "stage", text: receipt,
      data: { from: "merge", to: "fix", round: 1, mergeBounce: bounce } }, true);
    recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "boot", seq: 1, paused: null,
      slots: { codex: { total: 1, busy: 0 }, claude: { total: 0, busy: 0 } },
      grant: { until: 100_000, roles: ["write"], repos: ["o/r"], ordersPerDay: 10, ordersLeftToday: 10 } }, 1001);
    const borrow = [{ peer: "mate", projects: ["p"], roles: ["write" as const], maxOpen: 1 }];
    const remote = { mode: "balance" as const, roles: ["write" as const], poolTimeoutMin: 15, repo: "o/r" };
    const policy = { maxActiveWorkers: 2, remote };
    const lend = { borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
      result: { reportDir: () => f.dir, writeReport: (path: string, text: string) => writeFileSync(path, text),
        sign: () => { throw new Error("claim does not sign verdicts"); },
        peerFp: async () => "abcd-ef01-2345-6789", remoteHead: async () => ({ ok: true as const, head: base }) } };
    const cli = (...args: string[]) => f.cliWith({ lend }, "scheduler", ...args);
    const doTick = () => schedulerAutoTick(f.db, { p: policy }, { ...f.tickDeps, borrow: async () => borrow,
      manager: (...args) => cli(...args.slice(1)) as Promise<Record<string, any>> });
    if (refused) { const r = auditLedger({ project: "p", pms: ["pm"], tasks: [], agents: null, reviewers: null, held: null, ownerInbox: null }, Date.now());
      reconcileFindings(f.db, "p", r.findings, r.evaluated, Date.now()); } // the patrol was already running before the refusal
    const tick = await doTick();
    expect(tick.failed).toEqual([]);
    if (refused) {
      expect(tick.cards[0]).toMatchObject({ step: "pool_refused" });
      expect(tick.cards[0].detail).toContain("疑似含密钥");
      expect(tick.cards[0].detail).not.toContain(foreign);
      const settled = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "settle");
      expect(settled.at(-1)?.data.receipt).toContain("疑似含密钥");
      expect(settled.at(-1)?.data.receipt).not.toContain(error);
      // dispatch-recovery-R1: a gate refusal is a tracked block on the auto card (no manual fallback), reported to PM by the patrol.
      const next = (await doTick()).cards[0]!;
      expect(next.step).toBe("waiting");
      expect(next.detail).toStartWith("安全材料阻塞（第 1 轮 fix");
      expect(next.detail.includes(error)).toBe(false);
      await doTick();
      await doTick();
      expect(f.notices).toEqual([]);
      expect(listLendOrders(f.db, "T1")).toEqual([]);
      // The one PM notice is now the patrol's: a persisted open finding, pushed to PM once, deduped on later runs.
      const patrol = () => {
        const r = auditLedger({ project: "p", pms: ["pm"], tasks: [{ task: f.task(), events: listEvents(f.db, { project: "p", target: "T1" }) }],
          agents: null, reviewers: null, held: null, ownerInbox: null }, Date.now());
        return reconcileFindings(f.db, "p", r.findings, r.evaluated, Date.now());
      };
      const first = patrol().pending.filter((x) => x.rule === "dispatch_blocked");
      expect(first).toEqual([expect.objectContaining({ taskId: "T1", notify: "pm" })]);
      expect(first[0]!.detail.includes(error) || first[0]!.detail.includes(foreign)).toBe(false);
      ackFindings(f.db, first.map((x) => x.key), Date.now());
      await doTick();
      expect(patrol().pending.filter((x) => x.rule === "dispatch_blocked")).toEqual([]);
      expect(openFindings(f.db, "p").filter((x) => x.rule === "dispatch_blocked")).toHaveLength(1);
      return;
    }
    expect(tick.cards[0]).toMatchObject({ step: "pool_pooled" });
    const [order] = listLendOrders(f.db, "T1");
    expect(order).toMatchObject({ step: "fix", peer: "mate", head: H2, branch });
    expect(order.text).toContain("更新分支失败");
    if (mode === "hex") {
      expect(order.text).not.toContain("GitHub update refused");
      expect(order.wire.inputs.join("\n")).not.toContain(foreign);
      expect(order.text).toContain("原文含提交号,留在发起方台账");
      expect(order.text).toMatch(/本机事件 #\d+/);
    } else expect(order.wire.inputs.join("\n")).toContain(error);
    expect(order.text).not.toContain("git fetch");
    expect(order.text).toContain("refs/remotes/origin/HEAD");
    const claim = await f.cliWith({ lend }, "owner", "lend-claim", "--", "mate", JSON.stringify({ v: 1, orderId: order.orderId, worker: "fixer" }));
    expect(claim).toMatchObject({ ok: true, order: order.wire, text: order.text });
  } finally { reportChild(f); f.close(); }
});
}

if (!child) {
  // A neighbor fixture in this process: its ledger, key and directory must survive every child untouched.
  const neighbor = autoFixture();
  const neighborKey = crypto.randomUUID();
  neighbor.db.run("INSERT INTO meta (project, key, value) VALUES ('updtest', ?, ?)", [`nonce:${neighborKey}`, neighborKey]);
  const stateDir = process.env.CLAUDESTRA_STATE_DIR!;
  // The process STATE is shared with every other test file in this bun process (and their delayed async writes), so it is no
  // evidence of pollution. The children's launcher gets this run's own STATE instead: only this run can write it, so it must stay empty.
  const parentState = mkdtempSync(join(tmpdir(), "updtest-parent-state-"));
  const envBefore = JSON.stringify(process.env);
  afterAll(() => { neighbor.close(); rmSync(parentState, { recursive: true, force: true }); });
  // Top level, not inside a test: the children's spawn time never counts against a test timeout.
  const set = () => Promise.all(MODES.map((mode) => runChild(mode, null, parentState)));
  const [setA, setB, corrupted] = await Promise.all([set(), set(), runChild("plain", "corrupt", parentState)]);
  const failedSetup = await runChild("hex", "failSetup", parentState);
  const restarted = await runChild("hex", null, parentState);

  for (const [i, mode] of MODES.entries()) {
    test(`GitHub update refusal: ${mode}（私有子进程，两套并行）`, () => {
      const a = assertChildPassed(setA[i]!), b = assertChildPassed(setB[i]!);
      expect(a.pid).not.toBe(b.pid);
      expect(a.nonce).not.toBe(b.nonce);
    });
  }

  test("并行两套与同进程邻居：私有目录 / 台账连接 / key 各归各，邻居、STATE 与 env 不受污染", () => {
    const infos = [...setA, ...setB, restarted].map(assertChildPassed);
    for (const key of ["pid", "home", "state", "runtime", "tmp", "fixtureDir", "ledger", "nonce"] as const) {
      expect(new Set(infos.map((x) => x[key])).size).toBe(infos.length);
    }
    for (const x of infos) {
      expect(x.nonces).toEqual([x.nonce]);
      expect(x.ledger.startsWith(neighbor.dir)).toBe(false);
      expect(x.state).not.toBe(stateDir);
      expect(x.state).not.toBe(parentState);
    }
    const keys = (neighbor.db.query("SELECT value FROM meta WHERE project = 'updtest'").all() as { value: string }[]).map((r) => r.value);
    expect(keys).toEqual([neighborKey]);
    expect(neighbor.task()).toMatchObject({ id: "T1", stage: "spec" });
    expect(existsSync(neighbor.dir)).toBe(true);
    expect(readdirSync(parentState)).toEqual([]);
    expect(JSON.stringify(process.env)).toBe(envBefore);
  });

  test("故意改坏子断言：子进程 1 fail，父入口判不通过", () => {
    expect(corrupted).toMatchObject({ ran: 1, pass: 0, fail: 1 });
    expect(corrupted.code).not.toBe(0);
    expect(corrupted.err).toContain("(corrupted)");
    expect(() => assertChildPassed(corrupted)).toThrow(/1 fail（应为 0）/);
  });

  test("setup 失败后重启：失败那次自己关库删目录、父进程删临时根，重启换新的私有连接跑绿", () => {
    expect(failedSetup).toMatchObject({ ran: 1, pass: 0, fail: 1, fixtureLeft: false, rootRemoved: true });
    expect(failedSetup.err).toContain("synthetic setup failure");
    expect(() => assertChildPassed(failedSetup)).toThrow();
    const before = failedSetup.info!, after = assertChildPassed(restarted);
    expect(existsSync(failedSetup.root)).toBe(false);
    expect(after.fixtureDir).not.toBe(before.fixtureDir);
    expect(after.nonce).not.toBe(before.nonce);
    expect(after.nonces).toEqual([after.nonce]);
  });
}
