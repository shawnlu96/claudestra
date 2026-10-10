/**
 * dispatch-recovery-FB2 on a real temp ledger and the real ledger CLI (scheduler identity): the R1 incident (tests/scheduler-dispatch-block-helpers.ts,
 * a fix refused by the outbound gate) driven through the takeover executor. No port = nothing read or written; observe records one note;
 * the incident as it stands (write lease at mate) and a pinned card are exact blocks for PM; once the formal pre-steps hold, one local
 * Codex author is created, bound and given the fix through the ordinary claim, the card stays auto and keeps task / spec / branch / head.
 * Duplicate ticks, a restart after the claim and every failed step leave at most one author and never resend.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { assessLocalFallback, readLocalFallbackFacts, type LocalFallbackPolicyPort } from "../src/lib/recovery-local-fallback-plan.js";
import { recordObserved } from "../src/lib/recovery-policy.js";
import { gateBlock } from "../src/lib/scheduler-dispatch-block.js";
import { driveLocalTakeover, localCodexSlotProof, localTakeoverTick, type TakeoverDeps } from "../src/lib/scheduler-dispatch-recovery.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import type { EnsureResult } from "../src/lib/worker-session.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { parseSchedulerConfig, readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { liveGrant } from "../src/lib/scheduler-autostart-deps.js";
import { setLocalSlots } from "../src/lib/scheduler-config-write.js";
import { blockFixture, E2E_MS, FREE, MIN, toFix, type Fx } from "./scheduler-dispatch-block-helpers.js";

const leaked = () => `# 审查报告\nP1：两个 tick 抢同一个意图\n别处粘来的 secret ${randomBytes(32).toString("hex")}`;
const BORROW = [{ peer: "mate", projects: ["p"], roles: ["review", "write"] as ("review" | "write")[], maxOpen: 3 }];
const on: LocalFallbackPolicyPort = () => ({ mode: "on", manualAfterMs: null });
const observe: LocalFallbackPolicyPort = () => ({ mode: "observe", manualAfterMs: null });
const off: LocalFallbackPolicyPort = () => ({ mode: "off", manualAfterMs: null });
const quota = (usedPct: number | null, status: InventoryQuota["status"] = "known"): InventoryQuota => ({ status, source: "live", observedAt: 1, plan: null,
  reason: status === "known" ? null : "没有快照", windows: [{ id: "weekly", kind: "weekly", usedPct, resetsAtMs: null, resetPassed: false }] });
const NEW_AUTHOR = "agent-task-t1";

/** The R1 refusal: a fix for lease holder mate refused by the gate; this machine seats a Codex writer; the card is Codex-written. */
async function refused(): Promise<Fx> {
  const p = await blockFixture();
  await toFix(p, leaked());
  expect(await p.tick()).toMatchObject({ step: "pool_refused" });
  p.policy.remote.agents = { claude: 1, codex: 1 };
  p.f.db.run("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'");
  return p;
}

/**
 * R1 with the peer assignee cleared and mate healthy; `author` = this card already has its local Codex author bound (agent-task-one),
 * `none` = no author session row at all (as a card pinned to a peer that never restated locally). The write lease is still held at mate in the ledger,
 * so the planner keeps the gate wait. On main every eligible case is held by such a PM-only pre-step; the execution path below runs
 * with the harness option `ended` (Tests only reader seam: the lease reads as formally ended) to exercise the real CLI writes.
 */
async function stuck(kind: "author" | "none"): Promise<Fx> {
  const p = await refused();
  const db = p.f.db;
  db.run("UPDATE tasks SET assignee = NULL, assigneeKind = NULL WHERE id = 'T1'");
  if (kind === "author") {
    db.run("UPDATE scheduler_sessions SET family = 'codex', transport = 'acp' WHERE taskId = 'T1' AND role = 'author'");
    db.run("UPDATE tasks SET agent = 'agent-task-one' WHERE id = 'T1'");
    const reg = JSON.parse(readFileSync(p.f.registryPath, "utf8"));
    reg.agents["agent-task-one"] = { ...reg.agents["agent-task-one"], runtime: "codex", transport: "acp" };
    writeFileSync(p.f.registryPath, JSON.stringify(reg));
  } else db.run("DELETE FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'author'"); // never had a local author (a peer-pinned card skips local restate)
  p.hello();
  return p;
}
const ready = () => stuck("none");

interface Harness { deps: TakeoverDeps; ensured: string[]; notices: string[]; observed: string[] }

/** The executor's ports over the fixture: the real CLI as scheduler, a create that registers one Codex worker, the fixture's adapters. */
function harness(p: Fx, policy: LocalFallbackPolicyPort | undefined,
  over: Partial<TakeoverDeps> & { create?: () => Promise<EnsureResult>; ended?: boolean } = {}): Harness {
  const ensured: string[] = [], notices: string[] = [], observed: string[] = [];
  const create = async (): Promise<EnsureResult> => {
    const reg = JSON.parse(readFileSync(p.f.registryPath, "utf8"));
    reg.agents[NEW_AUTHOR] = { runtime: "codex", transport: "acp", sessionId: "s-t1", cwd: `${p.f.dir}/wt-t1`, projectId: "p" };
    writeFileSync(p.f.registryPath, JSON.stringify(reg));
    return { kind: "ready", created: true, ref: { taskId: "T1", role: "author", agent: NEW_AUTHOR, sessionId: "s-t1", family: "codex", transport: "acp" } };
  };
  const deps: TakeoverDeps = {
    db: p.f.db, policy, manager: (...args) => p.cli("scheduler", ...args.slice(1)),
    ensure: async (task, role, family) => { ensured.push(`${task.id}/${role}/${family}`); return (over.create ?? create)(); },
    worker: p.f.tickDeps.worker, authorRuntime: () => "codex", grant: () => ({ remote: p.policy.remote, maxActiveWorkers: 2 }),
    notifyPm: async (_t, text) => { notices.push(text); }, observe: (a) => { observed.push(a.actionKey); recordObserved(p.f.db, a, p.f.tickDeps.now()); },
    codexQuota: async () => quota(10), borrow: async () => BORROW, now: p.f.tickDeps.now, told: new Set(),
    ...(over.ended ? { readFacts: (...a: Parameters<typeof readLocalFallbackFacts>) => ({ ...readLocalFallbackFacts(...a), lease: null }) } : {}), ...over,
  };
  return { deps, ensured, notices, observed };
}

const tick = (p: Fx, h: Harness) => localTakeoverTick(h.deps, { p: p.policy });
const drive = (p: Fx, h: Harness) => driveLocalTakeover(h.deps, getTask(p.f.db, "T1")!, { registry: [], maxWorkers: 2, now: p.f.tickDeps.now(),
  pool: { remote: p.policy.remote, borrow: BORROW } });
const state = (p: Fx) => ({ events: p.events().length, intents: p.f.intents().map((i) => `${i.id}:${i.status}`), task: getTask(p.f.db, "T1")!.rev,
  sessions: p.f.db.query("SELECT agent, state FROM scheduler_sessions WHERE taskId = 'T1' ORDER BY createdAt").all() });
const card = (p: Fx) => { const t = getTask(p.f.db, "T1")!; return { stage: t.stage, specRev: t.specRev, round: t.round, branch: t.branch, head: t.headSHA, spec: t.spec }; };

describe("FB2 policy: no port does nothing, observe only records, off does nothing", () => {
  test("no port: the tick returns before reading — nothing written, no ensure, no notice, even for an eligible card", async () => {
    const p = await ready();
    try {
      const h = harness(p, undefined);
      const before = state(p);
      expect(await tick(p, h)).toEqual({ cards: [], failed: [] });
      expect(state(p)).toEqual(before);
      expect(h.ensured).toEqual([]);
      expect(h.notices).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("observe records what on would do once (a repeated tick adds nothing): the lease block as it stands, the takeover once the lease is ended; off writes nothing", async () => {
    const p = await ready();
    try {
      const notes = () => p.events().filter((e) => e.data.op === "recovery_observe");
      const before = state(p);
      const h = harness(p, observe);
      expect((await tick(p, h)).cards).toEqual([expect.objectContaining({ taskId: "T1", step: "observe", detail: expect.stringContaining("lease_held") })]);
      await tick(p, h);
      expect(notes().map((e) => e.data)).toEqual([expect.objectContaining({ mechanism: "localFallback", kind: "blocked", code: "lease_held" })]);
      const e = harness(p, observe, { ended: true });
      expect((await tick(p, e)).cards).toEqual([expect.objectContaining({ step: "observe", detail: expect.stringContaining("本机 Codex 接管修复") })]);
      await tick(p, e);
      await tick(p, e);
      expect(notes()).toHaveLength(2);
      expect(notes()[1]!.data).toMatchObject({ kind: "eligible", role: "fix", trigger: "gate_refused" });
      expect(state(p)).toEqual({ ...before, events: before.events + 2 });
      expect([...h.ensured, ...e.ensured, ...h.notices, ...e.notices]).toEqual([]);
      const o = harness(p, off, { ended: true });
      const mid = state(p);
      expect((await tick(p, o)).cards).toEqual([expect.objectContaining({ step: "off" })]);
      expect(state(p)).toEqual(mid);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("FB2 exact blocks: what only PM may do is reported, never worked around", () => {
  test("the R1 incident as it stands: write lease at mate → lease_held with the lend-reclaim step, told once; nothing written", async () => {
    const p = await refused();
    try {
      p.hello();
      expect(assessLocalFallback(readLocalFallbackFacts(p.f.db, getTask(p.f.db, "T1")!, { registry: [], maxWorkers: 2, now: p.f.tickDeps.now(),
        pool: { remote: p.policy.remote, borrow: BORROW } }, { slot: { ok: true }, quota: { ok: true } })).kind).toBe("eligible");
      const h = harness(p, on);
      const before = state(p);
      expect(await drive(p, h)).toMatchObject({ step: "blocked", detail: expect.stringContaining("ledger lend-reclaim T1") });
      await drive(p, h);
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toContain("写租约仍在 mate");
      expect(state(p)).toEqual(before);
      expect(h.ensured).toEqual([]);
      expect(p.f.db.query("SELECT state FROM lend_write_leases WHERE taskId = 'T1'").get()).toEqual({ state: "held" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("a pinned card is not moved by the scheduler; a peer assignee needs PM first", async () => {
    const p = await ready();
    try {
      p.f.db.run("UPDATE tasks SET extra = json_set(extra, '$.placement', 'peer:mate') WHERE id = 'T1'");
      const h = harness(p, on, { ended: true });
      const before = state(p);
      const r = await drive(p, h);
      expect(r.step).toBe("blocked");
      expect(r.detail).toMatch(/pinned|固定/);
      expect(state(p)).toEqual(before);
      p.f.db.run("UPDATE tasks SET extra = json_remove(extra, '$.placement'), assigneeKind = 'peer_agent', assignee = 'abcd/w1' WHERE id = 'T1'");
      expect(await drive(p, h)).toMatchObject({ step: "blocked", detail: expect.stringContaining("assignee_peer") });
      expect(h.ensured).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("an author session row already on the card (retired here) cannot be replaced by the ledger: author_bound before any write", async () => {
    const p = await refused();
    try {
      p.f.db.run("UPDATE tasks SET assignee = NULL, assigneeKind = NULL WHERE id = 'T1'");
      p.f.db.run("UPDATE scheduler_sessions SET state = 'retired' WHERE taskId = 'T1' AND role = 'author'");
      p.hello();
      const h = harness(p, on, { ended: true });
      const before = state(p);
      expect(await drive(p, h)).toMatchObject({ step: "blocked", detail: expect.stringContaining("author_bound") });
      expect(state(p)).toEqual(before);
      expect(h.ensured).toEqual([]);
      expect(h.notices.join()).toContain("agent-task-one");
    } finally { p.f.close(); }
  }, E2E_MS);

  test("no seat, no quota proof, or the existing create would pick Claude: blocked, never 'add a seat' or switch model; nothing written", async () => {
    const p = await ready();
    try {
      const before = state(p);
      p.policy.remote.agents = { claude: 1, codex: 0 };
      const noGrant = harness(p, on, { ended: true });
      expect(await drive(p, noGrant)).toMatchObject({ step: "blocked", detail: expect.stringContaining("no_grant") });
      p.policy.remote.agents = { claude: 1, codex: 1 };
      const noQuota = harness(p, on, { ended: true, codexQuota: async () => quota(null, "unknown") });
      expect(await drive(p, noQuota)).toMatchObject({ step: "blocked", detail: expect.stringContaining("no_quota") });
      const claude = harness(p, on, { ended: true, authorRuntime: () => "claude" });
      expect(await drive(p, claude)).toMatchObject({ step: "blocked", detail: expect.stringContaining("family_switch") });
      const unknownRuntime = harness(p, on, { ended: true, authorRuntime: undefined });
      expect(await drive(p, unknownRuntime)).toMatchObject({ step: "blocked", detail: expect.stringContaining("family_switch") });
      expect(state(p)).toEqual(before);
      const told = [...noGrant.notices, ...noQuota.notices, ...claude.notices].join("\n");
      expect(/加位|扩容/.test(told)).toBe(false);
      expect([...noGrant.ensured, ...noQuota.ensured, ...claude.ensured]).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("FB2 takeover: one local Codex author through the formal claim, card stays auto", () => {
  test("eligible: plan → claim → create → bind → fix order via the ordinary dispatch claim; gate block closes; binding preserved", async () => {
    const p = await ready();
    try {
      const was = card(p);
      const h = harness(p, on, { ended: true });
      const r = await tick(p, h);
      expect(r.failed).toEqual([]);
      expect(r.cards).toEqual([expect.objectContaining({ taskId: "T1", step: "sent", detail: expect.stringContaining("fix") })]);
      expect(h.ensured).toEqual(["T1/author/codex"]);
      const intents = p.f.intents().filter((i) => i.status !== "cancelled").slice(-2);
      expect(intents).toEqual([expect.objectContaining({ action: "ensure_session", node: "fix", status: "done" }),
        expect.objectContaining({ action: "dispatch", node: "fix", status: "done", recipient: NEW_AUTHOR })]);
      const claim = p.events().find((e) => e.data.op === "settle" && e.data.to === "submitted" && String(e.data.receipt).includes("local-takeover"));
      expect(String(claim?.data.receipt)).toContain(`branch=${was.branch}; head=${was.head}`);
      expect(getSchedulerSession(p.f.db, "T1", "author")).toMatchObject({ agent: NEW_AUTHOR, family: "codex", state: "active" });
      expect(p.f.sent.at(-1)).toMatchObject({ agent: NEW_AUTHOR, route: "acp" });
      expect(card(p)).toEqual(was);
      expect(getWorkflow(p.f.db, "T1")).toMatchObject({ mode: "auto", authorFamily: "codex" });
      expect(gateBlock(getTask(p.f.db, "T1")!, p.events())).toBeNull();
      // The ordinary tick now just waits for the author's result; the next review is the planner's cross-family one (author codex).
      p.f.advance(MIN);
      expect(await p.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("fix") });
      expect(p.orders().filter((o) => o.step === "fix")).toEqual([]);
      // A later takeover pass sees the order in flight: nothing more, no notice.
      const again = await tick(p, h);
      expect(again.cards).toEqual([expect.objectContaining({ step: "blocked", detail: expect.stringContaining("in_flight") })]);
      expect(h.ensured).toHaveLength(1);
      expect(h.notices).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("the card's own local Codex author is already bound: no create, the fix goes to it through the dispatch claim", async () => {
    const p = await stuck("author");
    try {
      const h = harness(p, on, { ended: true });
      expect(await drive(p, h)).toMatchObject({ step: "sent" });
      expect(h.ensured).toEqual([]);
      expect(p.f.intents().at(-1)).toMatchObject({ action: "dispatch", node: "fix", status: "done", recipient: "agent-task-one" });
      expect(p.f.sent.at(-1)).toMatchObject({ agent: "agent-task-one", route: "acp" });
    } finally { p.f.close(); }
  }, E2E_MS);

  test("two ticks at once (and a third after): exactly one claim, one author created, one order", async () => {
    const p = await ready();
    try {
      const a = harness(p, on, { ended: true }), b = harness(p, on, { ended: true });
      const [ra, rb] = await Promise.all([drive(p, a), drive(p, b)]);
      expect([ra.step, rb.step].filter((s) => s === "sent")).toHaveLength(1);
      expect([...a.ensured, ...b.ensured]).toHaveLength(1);
      await drive(p, harness(p, on, { ended: true }));
      expect(p.f.intents().filter((i) => i.action === "ensure_session" && i.node === "fix" && i.status === "done")).toHaveLength(1);
      expect(p.f.intents().filter((i) => i.action === "dispatch" && i.node === "fix" && i.status === "done")).toHaveLength(1);
      expect(p.f.sent.filter((s) => s.agent === NEW_AUTHOR)).toHaveLength(1);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("service stops right after the claim (restart): no second author from any later tick; the expired claim goes to PM as unknown", async () => {
    const p = await ready();
    try {
      const stopping = harness(p, on, { ended: true, create: async () => { throw new SchedulerStopped("lease lost mid-create"); } });
      await expect(drive(p, stopping)).rejects.toBeInstanceOf(SchedulerStopped);
      const claimed = p.f.intents().find((i) => i.action === "ensure_session" && i.status === "submitted");
      expect(claimed).toBeDefined();
      const fresh = harness(p, on, { ended: true });
      expect((await tick(p, fresh)).cards).toEqual([]); // a live intent: not a candidate
      p.f.advance(11 * MIN);
      expect(await p.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("结果不明") });
      expect(p.f.intents().find((i) => i.id === claimed!.id)?.status).toBe("unknown");
      expect((await tick(p, fresh)).cards).toEqual([]);
      expect(fresh.ensured).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("failed steps roll back or stop: wait / manual → cancelled (nothing created), unknown → unknown and never retried, bind refused → unknown", async () => {
    const p = await ready();
    try {
      const wait = harness(p, on, { ended: true, create: async () => ({ kind: "wait", reason: "本机执行者排队等槽" }) });
      expect(await drive(p, wait)).toMatchObject({ step: "waiting" });
      expect(p.f.intents().at(-1)).toMatchObject({ action: "ensure_session", status: "cancelled" });
      expect(getSchedulerSession(p.f.db, "T1", "author")).toBeNull();
      const manual = harness(p, on, { ended: true, create: async () => ({ kind: "manual", reason: "当前项目没有可用 git 仓库" }) });
      expect(await drive(p, manual)).toMatchObject({ step: "blocked" });
      expect(p.f.intents().at(-1)).toMatchObject({ status: "cancelled" });
      expect(manual.notices.join()).toContain("没有可用 git 仓库");
      expect(getWorkflow(p.f.db, "T1")?.mode).toBe("auto"); // never flipped to manual by the takeover
      const unknown = harness(p, on, { ended: true, create: async () => ({ kind: "unknown", reason: "agent-task-t1 已建，90 秒内没等到 session id" }) });
      expect(await drive(p, unknown)).toMatchObject({ step: "held" });
      expect(p.f.intents().at(-1)).toMatchObject({ status: "unknown" });
      expect(unknown.notices.join()).toContain("不重建");
      const later = harness(p, on, { ended: true });
      expect((await tick(p, later)).cards).toEqual([]);
      expect(later.ensured).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("a created session that is not a local Codex, or that the ledger will not bind, is never bound and never re-created", async () => {
    const p = await ready();
    try {
      const wrong = harness(p, on, { ended: true, create: async () => ({ kind: "ready", created: true,
        ref: { taskId: "T1", role: "author", agent: "agent-task-one", sessionId: "s-one", family: "claude", transport: "tmux" } }) });
      expect(await drive(p, wrong)).toMatchObject({ step: "held" });
      expect(p.f.intents().at(-1)).toMatchObject({ action: "ensure_session", status: "unknown" });
      expect(getSchedulerSession(p.f.db, "T1", "author")).toBeNull();
    } finally { p.f.close(); }
    const q = await ready();
    try {
      // Registry says Claude for the name the create reports as Codex: the bind CLI refuses, the claim ends unknown.
      const reg = JSON.parse(readFileSync(q.f.registryPath, "utf8"));
      reg.agents[NEW_AUTHOR] = { runtime: "claude-code", sessionId: "s-t1", cwd: q.f.dir };
      writeFileSync(q.f.registryPath, JSON.stringify(reg));
      const h = harness(q, on, { ended: true, create: async () => ({ kind: "ready", created: true,
        ref: { taskId: "T1", role: "author", agent: NEW_AUTHOR, sessionId: "s-t1", family: "codex", transport: "acp" } }) });
      expect(await drive(q, h)).toMatchObject({ step: "held", detail: expect.stringContaining("绑定失败") });
      expect(q.f.intents().at(-1)).toMatchObject({ status: "unknown" });
      expect(q.f.sent.filter((s) => s.agent === NEW_AUTHOR)).toEqual([]);
    } finally { q.f.close(); }
  }, E2E_MS);

  test("check and write are one CAS: an event landing between the re-check and the plan voids the plan; nothing claimed", async () => {
    const p = await ready();
    try {
      const h = harness(p, on, { ended: true });
      const real = h.deps.manager;
      h.deps.manager = async (...args) => {
        if (args[1] === "scheduler-plan") insertEvent(p.f.db, p.f.at("pm"), { project: "p", target: "T1", kind: "note", text: "PM 刚写了一句", data: {} }, true);
        return real(...args);
      };
      expect(await drive(p, h)).toMatchObject({ step: "replan", detail: expect.stringContaining("没写进台账") });
      expect(p.f.intents().filter((i) => i.action === "ensure_session" && i.status !== "cancelled" && i.node === "fix")).toEqual([]);
      expect(h.ensured).toEqual([]);
      // The next pass re-plans on the new facts and proceeds.
      h.deps.manager = real;
      expect(await drive(p, h)).toMatchObject({ step: "sent" });
    } finally { p.f.close(); }
  }, E2E_MS);
});

/**
 * claim-hold-race (review r1): an owner hold, a freeze or the policy turned off between the last assessment and the claim. The real
 * ledger CLI (PM freeze included), the real fact reader with the same lease-ended seam as the execution tests above, the spec file on
 * disk; only the worker transport is the fixture's. Each window must end with the claim voided (submitted→cancelled), no send, no create.
 */
describe("FB2 claim-hold-race: eligibility is re-proven after the claim, before any send / create", () => {
  type Race = "spec-hold" | "policy-off" | "freeze-after-plan" | "freeze-after-claim";
  /** Runs one takeover with the race injected at the given window; returns the outcome and what went out. */
  async function race(kind: "author" | "none", what: Race) {
    const p = await stuck(kind);
    let mode: "on" | "off" = "on";
    const h = harness(p, () => ({ mode, manualAfterMs: null }), { ended: true });
    const specPath = getTask(p.f.db, "T1")!.spec!;
    h.deps.manager = async (...args) => {
      if (args[1] === "scheduler-plan" && what === "spec-hold") writeFileSync(specPath, `人工验收：是\n${readFileSync(specPath, "utf8")}`);
      if (args[1] === "scheduler-plan" && what === "policy-off") mode = "off";
      const r = await p.cli("scheduler", ...args.slice(1));
      if (r.ok === true && args[1] === "scheduler-plan" && what === "freeze-after-plan") expect((await p.cli("pm", "freeze", "--reason", "owner pause", "--project", "p")).ok).toBe(true);
      if (r.ok === true && args[1] === "scheduler-settle" && args[6] === "submitted" && what === "freeze-after-claim") {
        expect((await p.cli("pm", "freeze", "--reason", "owner pause", "--project", "p")).ok).toBe(true);
      }
      return r;
    };
    const sent = p.f.sent.length;
    const out = await drive(p, h);
    return { p, h, out, sends: p.f.sent.length - sent, base: sent };
  }

  for (const kind of ["author", "none"] as const) {
    for (const what of ["spec-hold", "policy-off", "freeze-after-plan", "freeze-after-claim"] as const) {
      test(`${kind === "author" ? "bound author, dispatch claim" : "new author, ensure claim"}: ${what} → claim voided, nothing sent or created`, async () => {
        const { p, h, out, sends, base } = await race(kind, what);
        try {
          expect(out.step).toBe("replan");
          expect(sends).toBe(0);
          expect(h.ensured).toEqual([]);
          const last = p.f.intents().at(-1)!;
          expect(last).toMatchObject({ action: kind === "author" ? "dispatch" : "ensure_session", status: "cancelled" });
          // It was claimed and then voided: the claim is the ordering point, the void its receipt.
          const settles = p.events().filter((e) => e.data.op === "settle" && e.data.id === last.id).map((e) => `${e.data.from}→${e.data.to}`);
          expect(settles).toEqual(["pending→submitted", "submitted→cancelled"]);
          expect(getSchedulerSession(p.f.db, "T1", "author")?.agent ?? null).toBe(kind === "author" ? "agent-task-one" : null);
          // The next pass does not take it over while the hold / freeze / off stands.
          const next = await drive(p, harness(p, what === "policy-off" ? off : on, { ended: true }));
          expect(next.step).not.toBe("sent");
          expect(p.f.sent.length).toBe(base);
        } finally { p.f.close(); }
      }, E2E_MS);
    }
  }

  test("a voided claim is no lasting block: once the policy is on again the next pass takes over normally", async () => {
    const { p, out, sends, h, base } = await race("author", "policy-off");
    try {
      expect([out.step, sends]).toEqual(["replan", 0]);
      expect(await drive(p, h)).toMatchObject({ step: "off" });
      expect(await drive(p, harness(p, on, { ended: true }))).toMatchObject({ step: "sent" });
      expect(p.f.sent.slice(base)).toEqual([expect.objectContaining({ agent: "agent-task-one", route: "acp" })]);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("FB2 slot proof", () => {
  test("a bound local Codex author keeps its seat; a full pool or legacy slot count is no proof", async () => {
    const p = await ready();
    try {
      const f = readLocalFallbackFacts(p.f.db, getTask(p.f.db, "T1")!, { registry: [], maxWorkers: 2, now: p.f.tickDeps.now(),
        pool: { remote: p.policy.remote, borrow: BORROW } }, { slot: { ok: true }, quota: { ok: true } });
      expect(localCodexSlotProof(f.snapshot)).toEqual({ ok: true });
      expect(localCodexSlotProof({ ...f.snapshot, pool: { ...f.snapshot.pool!, remote: { ...f.snapshot.pool!.remote, agents: { claude: 1, codex: 0 } },
        localPool: undefined } as never })).toMatchObject({ ok: false, why: expect.stringContaining("Codex 写位已满") });
      expect(localCodexSlotProof({ ...f.snapshot, pool: null, workerCount: 2, maxWorkers: 2 })).toMatchObject({ ok: false });
      expect(localCodexSlotProof({ ...f.snapshot, pool: null, workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0" })).toEqual({ ok: true });
      expect(listEvents(p.f.db, { target: "T1" }).length).toBe(p.events().length);
    } finally { p.f.close(); }
  }, E2E_MS);
});

/**
 * grant-stale (review r2): the owner revokes this machine's Codex write seat through the formal config write (setLocalSlots: file +
 * project audit event) while the takeover is mid-pass. The pass's copy of the policy is no grant proof: the takeover reads the
 * project's grant from scheduler.json again (the `grant` port, production: readSchedulerConfig) for the eligibility facts, for the
 * fresh re-assessment, and once more after the claim. Real ledger CLI, real fact reader (no readFacts seam, no lease), real config write.
 */
describe("FB2 grant-stale: a revoked local grant is seen before and after the claim", () => {
  type When = "first-quota" | "fresh-quota" | "after-claim-unaudited";
  async function revoke(when: When) {
    const p = await blockFixture({ mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r", agents: { claude: 0, codex: 1 } });
    const db = p.f.db;
    db.run("UPDATE scheduler_sessions SET family = 'codex', transport = 'acp' WHERE taskId = 'T1' AND role = 'author'");
    db.run("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'");
    const reg = JSON.parse(readFileSync(p.f.registryPath, "utf8"));
    reg.agents["agent-task-one"] = { ...reg.agents["agent-task-one"], runtime: "codex", transport: "acp" };
    writeFileSync(p.f.registryPath, JSON.stringify(reg));
    writeFileSync(getTask(db, "T1")!.spec!, `规格：只改 src/lib/x.ts\nsecret ${randomBytes(32).toString("hex")}`);
    p.hello();
    expect(await p.tick()).toMatchObject({ step: "pool_refused" });
    recordHello(db, "mate2", null, { v: 1, proto: 2, boot: "mate2", seq: 1, slots: FREE, paused: null,
      grant: { until: p.f.tickDeps.now() + 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, p.f.tickDeps.now());
    const configPath = join(p.f.dir, "scheduler.json");
    writeFileSync(configPath, JSON.stringify({ enabled: true, pollMs: 6000, autoDispatch: true, projects: { p: { agents: { claude: 0, codex: 1 }, maxActiveWorkers: 2,
      requiredChecks: ["ci"], repoDir: p.f.dir, remote: { mode: "balance", roles: ["review", "write"], repo: "o/r" } } } }));
    const config = () => readSchedulerConfig(configPath);
    const remote = config().projects.p!.remote!;
    const borrow = ["mate", "mate2"].map((peer) => ({ peer, projects: ["p"], roles: ["review", "write"] as ("review" | "write")[], maxOpen: 3 }));
    const formal = async () => {
      const r = await setLocalSlots(db, p.f.at("owner"), { project: "p", set: { agents: { claude: 0, codex: 0 } }, reason: "owner revokes local write seat" }, { path: configPath });
      expect(r.event).toBeGreaterThan(0);
    };
    let q = 0;
    const h = harness(p, on, {
      borrow: async () => borrow,
      grant: (project) => liveGrant(project, config), // the production reader, on this fixture's scheduler.json
      codexQuota: async () => {
        q++;
        if ((when === "first-quota" && q === 1) || (when === "fresh-quota" && q === 2)) await formal();
        return quota(10);
      },
      ensure: async () => { throw new Error("bound author: no ensure expected"); },
    });
    if (when === "after-claim-unaudited") {
      h.deps.manager = async (...args) => {
        const r = await p.cli("scheduler", ...args.slice(1));
        if (r.ok === true && args[1] === "scheduler-settle" && args[6] === "submitted") {
          // A hand edit of scheduler.json: no audit event, so only a re-read of the grant after the claim can see it.
          const doc = JSON.parse(readFileSync(configPath, "utf8"));
          doc.projects.p.agents.codex = 0;
          writeFileSync(configPath, JSON.stringify(doc));
        }
        return r;
      };
    }
    const sent = p.f.sent.length;
    const out = await driveLocalTakeover(h.deps, getTask(db, "T1")!, { registry: [], maxWorkers: 2, now: p.f.tickDeps.now(), pool: { remote, borrow } });
    return { p, h, out, sends: p.f.sent.length - sent, codex: config().projects.p!.agents!.codex };
  }

  for (const when of ["first-quota", "fresh-quota", "after-claim-unaudited"] as const) {
    test(`grant revoked at ${when}: no work order goes out, the card is not taken over`, async () => {
      const { p, out, sends, codex } = await revoke(when);
      try {
        expect(codex).toBe(0);
        expect(sends).toBe(0);
        expect(out.step).not.toBe("sent");
        expect(p.f.intents().filter((i) => i.node === "write" && i.status !== "cancelled" && i.recipient === "agent-task-one")).toEqual([]);
      } finally { p.f.close(); }
    }, E2E_MS);
  }

  test("no grant port: blocked no_grant before any ledger write — the pass's policy copy is not a grant proof", async () => {
    const p = await stuck("author");
    try {
      const h = harness(p, on, { ended: true, grant: undefined });
      const before = state(p);
      expect(await drive(p, h)).toMatchObject({ step: "blocked", detail: expect.stringContaining("no_grant") });
      expect(state(p)).toEqual(before);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("FB2 maintenance-yield and the production grant reader", () => {
  test("the takeover pass checks yieldNow before every card: an update waiting stops it before the next card; the cursor resumes after the last one handled", async () => {
    const p = await ready();
    try {
      const h = harness(p, observe, { ended: true });
      const yielding = { cursor: {} as Record<string, string | undefined>, yieldNow: () => true };
      const before = state(p);
      expect(await localTakeoverTick(h.deps, { p: p.policy }, yielding)).toEqual({ cards: [], failed: [] });
      expect([state(p), h.observed, yielding.cursor]).toEqual([before, [], {}]);
      let asked = 0;
      const once = { cursor: {} as Record<string, string | undefined>, yieldNow: () => asked++ > 0 };
      expect((await localTakeoverTick(h.deps, { p: p.policy }, once)).cards).toEqual([expect.objectContaining({ taskId: "T1", step: "observe" })]);
      expect([asked, once.cursor.takeover]).toEqual([1, "p/T1"]);
      // S2D2: a card the pace routes to skip is passed over before anything of its own is read, recorded or sent
      const skipped: string[] = [], skip = { cursor: {} as Record<string, string | undefined>, yieldNow: () => false, skipTask: (id: string) => (skipped.push(id), true) };
      const observedBefore = h.observed.length, held = state(p);
      expect(await localTakeoverTick(h.deps, { p: p.policy }, skip)).toEqual({ cards: [], failed: [] });
      expect([skipped, skip.cursor, h.observed.length, state(p)]).toEqual([["T1"], {}, observedBefore, held]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("liveGrant reads the config each call; auto dispatch off, a missing project or a bad file give no grant", () => {
    const base = parseSchedulerConfig({ enabled: true, autoDispatch: true, projects: { p: { agents: { claude: 0, codex: 1 }, maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/r",
      remote: { mode: "balance", roles: ["review", "write"], repo: "o/r" } } } });
    expect(liveGrant("p", () => base)).toMatchObject({ maxActiveWorkers: 1, remote: { agents: { claude: 0, codex: 1 } } });
    expect(liveGrant("q", () => base)).toBeNull();
    expect(liveGrant("p", () => ({ ...base, autoDispatch: false }))).toBeNull();
    expect(liveGrant("p", () => ({ ...base, enabled: false }))).toBeNull();
    expect(() => liveGrant("p", () => { throw new Error("bad json"); })).toThrow("bad json"); // the takeover turns a throw into no_grant
  });
});
