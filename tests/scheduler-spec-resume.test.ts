/**
 * i28-RSM1: an auto card handed back to the scheduler while still in spec (and any stock spec/auto card with no placement)
 * is placed by the same startPlacement the auto-open uses. A peer → placement decision + spec→restate「远端卡复述跳过」, then the
 * tick sends the write order to that peer; local → nothing written, the planner restates locally as before; no placement →
 * the card stays, one readable wait event, PM told once per reason. Real ledger CLI in-process, placement IO injected.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import { specResumeTick } from "../src/lib/scheduler-spec-resume.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const MATE: BorrowEntry = { peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 2 };
let f: ReturnType<typeof autoFixture>;
afterEach(() => f?.close());

function setup(opts: { remote?: Partial<RemotePolicy>; maxWorkers?: number; borrow?: BorrowEntry[] } = {}) {
  f = autoFixture();
  f.db.run("UPDATE task_workflows SET templateVersion = 3 WHERE taskId = 'T1'");
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [spec]);
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const borrow = opts.borrow ?? [MATE];
  const policy = { maxActiveWorkers: opts.maxWorkers ?? 2,
    remote: { mode: "balance", roles: ["review", "write"], repo: "o/r", poolTimeoutMin: 15, ...opts.remote } as RemotePolicy };
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key) },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const notices: string[] = [];
  const env = {
    db: f.db, projects: ["p"], ledger: (...args: string[]) => cli("scheduler", ...args.slice(1)), repoDir: async () => "/r",
    notifyPm: async (_p: string, text: string) => { notices.push(text); },
    place: (db: typeof f.db, q: Parameters<typeof startPlacement>[2]) => startPlacement(db, {
      policy: () => ({ remote: policy.remote, maxWorkers: policy.maxActiveWorkers }), borrow: async () => borrow,
      originRepo: async () => "o/r", now: () => f.tickDeps.now() }, q, true),
  };
  const pass = () => specResumeTick(env);
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const hello = (peer = "mate") => recordHello(f.db, peer, null, { v: 1, proto: 2, boot: `boot-${peer}`, seq: 1, paused: null,
    slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } },
    grant: { until: f.tickDeps.now() + 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, f.tickDeps.now());
  return { env, cli, pass, tick, hello, notices, policy, events: () => listEvents(f.db, { project: "p", target: "T1" }) };
}

/** The card fell back to manual in spec (quota), then the PM (or the service) hands it back to auto. */
async function handBack(t: ReturnType<typeof setup>) {
  const w = getWorkflow(f.db, "T1")!;
  expect(await t.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(w.rev), "--template", "code", "--version", "3",
    "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason", "本机 Claude 额度不足，退回人工")).toMatchObject({ ok: true });
  const m = getWorkflow(f.db, "T1")!;
  expect(await t.cli("pm", "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(m.rev), "--reason", "额度窗口过了，交回自动"))
    .toMatchObject({ ok: true, workflow: { mode: "auto" } });
  expect(f.task().stage).toBe("spec");
}

const waits = (t: ReturnType<typeof setup>) => t.events().filter((e) => e.kind === "note" && e.data.op === "spec_place_wait");

describe("spec-stage auto card handed back: placed like the auto-open", () => {
  test("placed at a peer → placement decision + spec→restate「远端卡复述跳过」, then the tick sends the write order to that peer", async () => {
    const t = setup();
    t.hello();
    await handBack(t);
    expect(await t.pass()).toEqual([]);
    const ev = t.events();
    const decision = ev.findLast((e) => e.kind === "decision")!;
    expect(decision).toMatchObject({ actor: "scheduler", data: { op: "spec_placement", placement: "peer:mate", repo: "o/r" } });
    expect(decision.text).toContain("放到 peer:mate");
    const stage = ev.findLast((e) => e.kind === "stage")!;
    expect(stage).toMatchObject({ data: { from: "spec", to: "restate" } });
    expect(stage.text.startsWith("远端卡复述跳过：")).toBe(true);
    expect(stage.seq).toBeGreaterThan(decision.seq);
    expect(f.task()).toMatchObject({ stage: "restate", extra: { repo: "o/r" } });
    expect(await t.tick()).toMatchObject({ step: "stage", detail: "restate→build" }); // v3: the restate record releases build
    t.hello();
    await t.tick(); // the write order is placed at the peer (handing its materials over is the pool step's, not injected here)
    expect(f.task().stage).toBe("build");
    expect(f.intents().filter((i) => i.node === "write")).toMatchObject([{ action: "dispatch", recipient: "peer:mate" }]);
    expect(f.intents().some((i) => i.node === "restate" && i.action === "dispatch")).toBe(false);
    expect(t.notices).toEqual([]);
  });

  test("placed local → nothing written, the planner restates locally as it does today", async () => {
    const t = setup({ borrow: [] });
    await handBack(t);
    const before = t.events().length;
    expect(await t.pass()).toEqual([]);
    expect(t.events()).toHaveLength(before);
    expect(f.task().stage).toBe("spec");
    await t.tick(); // author session
    await t.tick(); // restate order
    expect(f.sent.at(-1)).toMatchObject({ agent: "agent-task-one" });
    expect(f.intents().filter((i) => i.node === "restate" && i.action === "dispatch")).toHaveLength(1);
    expect(await t.pass()).toEqual([]); // the restate order is out: placement keeps its hands off
    expect(t.events().some((e) => e.kind === "decision" || e.data.op === "spec_place_wait")).toBe(false);
  });

  test("no placement → the card stays, one wait event with the reason; same reason over rounds told once, a new reason told again", async () => {
    const t = setup({ borrow: [], remote: { localPriority: "off" } });
    await handBack(t);
    for (let i = 0; i < 3; i++) expect(await t.pass()).toEqual([]);
    expect(f.task().stage).toBe("spec");
    expect(waits(t)).toHaveLength(1);
    expect(waits(t)[0].text).toContain("等写代码的空位：");
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain("[自动调度 T1]");
    t.policy.remote = { ...t.policy.remote, localPriority: "balance" };
    t.policy.maxActiveWorkers = 0;
    for (let i = 0; i < 2; i++) expect(await t.pass()).toEqual([]);
    expect(waits(t)).toHaveLength(2);
    expect(waits(t)[1].data.reason).not.toBe(waits(t)[0].data.reason);
    expect(t.notices).toHaveLength(2);
    expect(f.task().stage).toBe("spec");
  });
});

describe("stock cards and idempotency", () => {
  test("a stock spec/auto card with no placement record is picked up on the next round; re-running records nothing more", async () => {
    const t = setup();
    t.hello();
    expect(f.task()).toMatchObject({ stage: "spec" });
    expect(t.events().some((e) => e.kind === "decision")).toBe(false);
    expect(await t.pass()).toEqual([]);
    expect(f.task().stage).toBe("restate");
    const after = t.events().length;
    expect(await t.pass()).toEqual([]);
    expect(await t.pass()).toEqual([]);
    expect(t.events()).toHaveLength(after);
    expect(t.events().filter((e) => e.kind === "decision" && e.data.op === "spec_placement")).toHaveLength(1);
  });

  test("hands off: a card pinned by start_node, an order already out, a manual card", async () => {
    const t = setup();
    t.hello();
    f.db.run(`UPDATE tasks SET extra = json_set(extra, '$.placement', 'peer:mate') WHERE id = 'T1'`);
    expect(await t.pass()).toEqual([]);
    expect(f.task().stage).toBe("spec");
    f.db.run(`UPDATE tasks SET extra = json_remove(extra, '$.placement') WHERE id = 'T1'`);
    f.db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('x', 'T1', 'p', 'restate', 'ensure_session', 0, 1, 1, 3, 'submitted', 'r', 0, 0)`);
    expect(await t.pass()).toEqual([]);
    expect(f.task().stage).toBe("spec");
    f.db.run("UPDATE scheduler_intents SET status = 'cancelled'");
    f.db.run("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'");
    expect(await t.pass()).toEqual([]);
    expect(f.task().stage).toBe("spec");
    expect(t.events().some((e) => e.kind === "decision")).toBe(false);
  });

  test("the command is the scheduler's only, and a stale rev is a quiet conflict", async () => {
    const t = setup();
    const w = getWorkflow(f.db, "T1")!;
    const args = ["scheduler-spec-place", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(w.rev), "--wait", "x"];
    expect(await t.cli("pm", ...args)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await t.cli("scheduler", ...args)).toMatchObject({ ok: true, recorded: true });
    expect(await t.cli("scheduler", ...args)).toMatchObject({ ok: true, recorded: false });
    expect(await t.cli("scheduler", "scheduler-spec-place", "T1", "--rev", "99", "--workflow-rev", String(w.rev), "--wait", "x"))
      .toMatchObject({ ok: false, code: "conflict" });
  });
});


describe("resume regression coverage", () => {
  test("own-lock: retained card lease does not block peer resume", async () => {
    const t = setup({ borrow: [] });
    await t.tick();
    await t.tick();
    f.db.run("UPDATE scheduler_intents SET status = 'done'");
    f.db.run(`INSERT OR IGNORE INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope)
      VALUES ('p', 'src/lib/x.ts', 'T1', (SELECT id FROM scheduler_intents LIMIT 1), 1, 'card')`);
    await handBack(t);
    t.policy.remote.localPriority = "off";
    t.env.place = (db, q) => startPlacement(db, { policy: () => ({ remote: t.policy.remote, maxWorkers: 2 }),
      borrow: async () => [MATE], originRepo: async () => "o/r", now: () => f.tickDeps.now() }, q, true);
    t.hello();
    expect(await t.pass()).toEqual([]);
    expect(f.task().stage).toBe("restate");
    expect(f.db.query("SELECT resource FROM scheduler_resources WHERE resource = 'src/lib/x.ts'").all()).toHaveLength(1);
  });

  test("peer-pin: peer expiry cannot dispatch local write after skipped restate", async () => {
    const t = setup();
    t.hello();
    await t.pass();
    expect(f.task().extra.placement).toBe("peer:mate");
    await t.tick();
    f.advance(3_600_001);
    await t.tick();
    await t.tick();
    expect(f.intents().some((i) => i.action === "ensure_session" && i.node === "write")).toBe(false);
    expect(f.intents().filter((i) => i.node === "write" && i.recipient === "agent-task-one")).toHaveLength(0);
  });

  test("notice-loss: failed notification retries then suppresses successful delivery", async () => {
    const t = setup({ borrow: [], remote: { localPriority: "off" } });
    let attempts = 0;
    const send = t.env.notifyPm;
    t.env.notifyPm = async (p, text) => {
      if (++attempts === 1) throw new Error("temporary send failure");
      await send(p, text);
    };
    expect(await t.pass()).toHaveLength(1);
    expect(await t.pass()).toEqual([]);
    expect(await t.pass()).toEqual([]);
    expect(waits(t)).toHaveLength(1);
    expect(attempts).toBe(2);
    expect(t.notices).toHaveLength(1);
  });

  test("notice-loss: committed wait without a send is retried after restart", async () => {
    const t = setup({ borrow: [], remote: { localPriority: "off" } });
    const w = getWorkflow(f.db, "T1")!;
    const placed = await t.env.place(f.db, { project: "p", repoDir: "/r", fileGlobs: ["src/lib/x.ts"], want: "auto", taskId: "T1" });
    expect(placed.where).toBe("refused");
    expect(await t.cli("scheduler", "scheduler-spec-place", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(w.rev),
      "--wait", `等写代码的空位：${placed.reason}`)).toMatchObject({ ok: true });
    await t.pass();
    await t.pass();
    expect(waits(t)).toHaveLength(1);
    expect(t.notices).toHaveLength(1);
  });

});
