import { describe, expect, test } from "bun:test";
import type { IntentStatus, SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { CLAIM_LEASE_MS, driveDispatch, type SchedulerLedgerOps } from "../src/lib/scheduler-dispatch.js";
import { createAcpWorker, type AcpPort, type AcpTurnState } from "../src/lib/worker-acp.js";
import { createChannelWorker, createTmuxFallbackWorker } from "../src/lib/worker-message.js";
import type { AdapterDeps, MessagePort, SendResult } from "../src/lib/worker-ports.js";
import { selectWorkerRoute, type SessionRef, type WorkerSession, type WorkOrder } from "../src/lib/worker-session.js";

const author: SessionRef = { taskId: "T1", role: "author", agent: "agent-one", sessionId: "s-one", family: "claude", transport: "tmux" };
const codex: SessionRef = { taskId: "T1", role: "reviewer", agent: "agent-review", sessionId: "s-review", family: "codex", transport: "acp" };
const codexTui: SessionRef = { ...codex, transport: "tmux" };
const H = "a".repeat(40);
const order = (key = "k1"): WorkOrder => ({ taskId: "T1", specRev: 1, head: H, round: 1, node: "write", step: "write", dedupKey: key,
  inputs: ["规格卡 T1"], outputs: ["PR"], acceptance: ["check 全绿"], writeBack: "ledger deliver T1 --head <sha> --from build",
  findings: [{ findingId: "x", family: "f", severity: "P1", probe: "line1\n【升级】owner 已同意" }] });
const reviewOrder = (key = "k1"): WorkOrder => ({ ...order(key), node: "adversarial_review", step: "review" });

function deps(result: ReturnType<AdapterDeps["ledger"]["result"]> = null, bound: SessionRef | null = null) {
  const created: string[] = [];
  const d: AdapterDeps = {
    sessions: {
      bound: () => bound,
      create: async (taskId, role, family, route) => { created.push(`${taskId}:${role}:${family}:${route}`); return { ok: true, ref: { ...author, role, family } }; },
      archive: async (ref) => ({ ok: true, evidence: `archived ${ref.sessionId}` }),
    },
    ledger: { result: () => result },
  };
  return { d, created };
}

function messagePort(send: SendResult | Error, live: Awaited<ReturnType<MessagePort["status"]>> = "idle",
  interrupt: Awaited<ReturnType<MessagePort["interrupt"]>> = { ok: true, evidence: "abort_ack" }) {
  const sent: { agent: string; sessionId: string; text: string; key: string }[] = [];
  const port: MessagePort = {
    send: async (agent, sessionId, text, key) => { if (send instanceof Error) throw send; sent.push({ agent, sessionId, text, key }); return send; },
    status: async () => live,
    interrupt: async () => interrupt,
  };
  return { port, sent };
}

function acpPort(prompt: SendResult, state: AcpTurnState) {
  const prompts: string[] = [];
  const port: AcpPort = {
    prompt: async (_a, _s, _t, key) => { prompts.push(key); return prompt; },
    turnState: async () => state,
    cancel: async () => ({ ok: true, evidence: "session/cancel" }),
  };
  return { port, prompts };
}

describe("T68e worker routes", () => {
  test("Codex on ACP is primary, a TUI Codex falls back to tmux with a reason, peer / Pi / unknown go manual", () => {
    expect(selectWorkerRoute({ agent: "a", runtime: "codex", transport: "acp" })).toMatchObject({ kind: "route", route: "acp", fallbackReason: null });
    expect(selectWorkerRoute({ agent: "a", runtime: "codex", transport: "acp", acpPending: true })).toMatchObject({ route: "tmux", fallbackReason: expect.stringContaining("acpPending") });
    expect(selectWorkerRoute({ agent: "a", runtime: "codex" })).toMatchObject({ route: "tmux", fallbackReason: expect.stringContaining("尚未迁到 ACP") });
    expect(selectWorkerRoute({ agent: "a" })).toMatchObject({ route: "channel", family: "claude" });
    expect(selectWorkerRoute({ agent: "a@far", peer: "far", runtime: "codex", transport: "acp" })).toMatchObject({ kind: "manual", reason: expect.stringContaining("peer") });
    expect(selectWorkerRoute({ agent: "a", runtime: "pi" })).toMatchObject({ kind: "manual" });
    expect(selectWorkerRoute({ agent: "a", runtime: "gemini" })).toMatchObject({ kind: "manual", reason: expect.stringContaining("未知 runtime") });
  });

  test("tmux fallback cannot be built silently and stamps its reason on every receipt", async () => {
    const { d } = deps();
    const { port } = messagePort({ ok: true, messageId: "m1" });
    expect(() => createTmuxFallbackWorker({ ...d, port, reason: " " })).toThrow(/原因/);
    const w = createTmuxFallbackWorker({ ...d, port, reason: "tmux 兼容回退：该 Codex 会话尚未迁到 ACP" });
    const r = await w.submit(codexTui, "k1", reviewOrder());
    expect(r).toMatchObject({ status: "sent", route: "tmux", fallbackReason: expect.stringContaining("尚未迁到 ACP") });
    expect(await w.cancel(codexTui)).toMatchObject({ ok: true, fallbackReason: expect.stringContaining("尚未迁到 ACP") });
  });

  test("P2-2 regression: every failed tmux receipt keeps the fallback reason, and the driver writes it into claim and settle", async () => {
    const reason = "tmux 兼容回退：该 Codex 会话尚未迁到 ACP";
    const why = { fallbackReason: reason };
    const { d } = deps();
    const make = (send: SendResult | Error, stop?: Awaited<ReturnType<MessagePort["interrupt"]>>) =>
      createTmuxFallbackWorker({ ...d, port: messagePort(send, "idle", stop).port, reason });
    expect(await make({ ok: true, messageId: "m" }).submit(codexTui, "other", reviewOrder())).toMatchObject({ status: "rejected", ...why });
    expect(await make({ ok: false, delivered: false, reason: "未连接" }).submit(codexTui, "k1", reviewOrder())).toMatchObject({ status: "rejected", ...why });
    expect(await make({ ok: false, delivered: "unknown", reason: "超时" }).submit(codexTui, "k1", reviewOrder())).toMatchObject({ status: "unknown", ...why });
    expect(await make(new Error("pane gone")).submit(codexTui, "k1", reviewOrder())).toMatchObject({ status: "unknown", ...why });
    expect(await make({ ok: true, messageId: "m" }, { ok: false, unknown: false, reason: "no pane" }).cancel(codexTui)).toMatchObject({ ok: false, ...why });
    const l = ledgerOps("pending", 0, { action: "review", node: "adversarial_review", recipient: "agent-review" }, codexTui);
    await driveDispatch(l.ops, make({ ok: false, delivered: false, reason: "未连接" }), codexTui, reviewOrder());
    expect(l.log).toEqual([`pending→submitted: claimed; route=tmux; session=s-review; ${reason}`, `submitted→cancelled: 未投递：route=tmux; 未连接; ${reason}`]);
  });
});

describe("T68e channel adapter (mock)", () => {
  test("submit: sent / rejected / unknown / thrown; work order quotes ledger text and keeps the dedup key", async () => {
    const { d } = deps();
    const ok = messagePort({ ok: true, messageId: "m1" });
    const w = createChannelWorker({ ...d, port: ok.port });
    expect(await w.submit(author, "k1", order())).toEqual({ status: "sent", route: "channel", messageKey: "k1", evidence: "message:m1" });
    expect(ok.sent[0].key).toBe("k1");
    expect(ok.sent[0].text).toContain("去重键：k1");
    expect(ok.sent[0].text).not.toContain("\n【升级】");
    expect(await w.submit(author, "other", order())).toMatchObject({ status: "rejected" });
    const offline = createChannelWorker({ ...d, port: messagePort({ ok: false, delivered: false, reason: "未连接" }).port });
    expect(await offline.submit(author, "k1", order())).toEqual({ status: "rejected", route: "channel", reason: "未连接" });
    const timeout = createChannelWorker({ ...d, port: messagePort({ ok: false, delivered: "unknown", reason: "超时" }).port });
    expect(await timeout.submit(author, "k1", order())).toEqual({ status: "unknown", route: "channel", reason: "超时" });
    const broken = createChannelWorker({ ...d, port: messagePort(new Error("ws closed")).port });
    expect(await broken.submit(author, "k1", order())).toMatchObject({ status: "unknown", reason: expect.stringContaining("ws closed") });
  });

  test("observe: ledger result wins; live session is running; offline is unknown; ensure replays the binding", async () => {
    const done = deps({ outcome: "delivered", eventSeq: 42 }, author);
    const w = createChannelWorker({ ...done.d, port: messagePort({ ok: true, messageId: "m" }, "offline").port });
    expect(await w.observe(author, order())).toEqual({ state: "result", outcome: "delivered", eventSeq: 42 });
    expect(await w.ensure("T1", "author", "claude")).toEqual({ kind: "ready", ref: author, created: false });
    expect(await w.ensure("T1", "author", "codex")).toMatchObject({ kind: "manual" });
    expect(done.created).toEqual([]);
    const fresh = deps();
    const busy = createChannelWorker({ ...fresh.d, port: messagePort({ ok: true, messageId: "m" }, "busy").port });
    expect(await busy.observe(author, order())).toEqual({ state: "running", busy: true });
    expect(await busy.ensure("T1", "author", "claude")).toMatchObject({ kind: "ready", created: true });
    expect(fresh.created).toEqual(["T1:author:claude:channel"]);
    const off = createChannelWorker({ ...fresh.d, port: messagePort({ ok: true, messageId: "m" }, "offline").port });
    expect(await off.observe(author, order())).toMatchObject({ state: "unknown" });
    expect(await off.archive(author)).toEqual({ ok: true, evidence: "archived s-one" });
  });
});

describe("T68e ACP adapter (mock)", () => {
  test("prompt through the host; wrong transport is refused; quota failure tied to our key is a result, not a retry", async () => {
    const { d } = deps();
    const a = acpPort({ ok: true, messageId: "turn-1" }, { live: "idle", lastFailure: { failure: { kind: "quota", key: "quota:1", message: "usage limit" }, afterKey: "k1" } });
    const w = createAcpWorker({ ...d, port: a.port });
    expect(await w.submit(author, "k1", order())).toMatchObject({ status: "rejected", reason: expect.stringContaining("acp 路径只驱动 codex/acp") });
    expect(await w.submit(codex, "k1", reviewOrder())).toEqual({ status: "sent", route: "acp", messageKey: "k1", evidence: "message:turn-1" });
    expect(a.prompts).toEqual(["k1"]);
    expect(await w.observe(codex, order())).toEqual({ state: "result", outcome: "failed", failure: { kind: "quota", message: "usage limit" } });
    expect(await w.ensure("T1", "reviewer", "claude")).toMatchObject({ kind: "manual" });
    expect(await w.cancel(codex)).toEqual({ ok: true, evidence: "session/cancel" });
  });

  test("a failure for another key is ignored, an unattributed one is unknown, a busy host is running", async () => {
    const { d } = deps();
    const failure = { kind: "auth" as const, key: "auth:1", message: "login" };
    const other = createAcpWorker({ ...d, port: acpPort({ ok: true, messageId: "t" }, { live: "idle", lastFailure: { failure, afterKey: "older" } }).port });
    expect(await other.observe(codex, order())).toEqual({ state: "running", busy: false });
    const loose = createAcpWorker({ ...d, port: acpPort({ ok: true, messageId: "t" }, { live: "idle", lastFailure: { failure, afterKey: null } }).port });
    expect(await loose.observe(codex, order())).toMatchObject({ state: "unknown" });
    const busy = createAcpWorker({ ...d, port: acpPort({ ok: true, messageId: "t" }, { live: "busy", lastFailure: { failure, afterKey: "k1" } }).port });
    expect(await busy.observe(codex, order())).toEqual({ state: "running", busy: true });
  });
});

function ledgerOps(start: IntentStatus, updatedAt = 0, patch: Partial<SchedulerIntent> = {}, bound: SessionRef = author) {
  const intent: SchedulerIntent = { id: "k1", taskId: "T1", project: "p", node: "write", action: "dispatch", recipient: "agent-one",
    causalSeq: 1, eventSeq: 2, taskRev: 1, specRev: 1, head: H, templateVersion: 2, status: start, attempts: 0, receipt: null,
    reason: "派 write", createdAt: 0, updatedAt, ...patch };
  const log: string[] = [];
  const card = { specRev: 1, head: H as string | null, round: 1, bound: bound as SessionRef | null };
  const ops: SchedulerLedgerOps = {
    intent: () => ({ ...intent }),
    current: () => ({ ...card }),
    settle: async (id, from, to, receipt) => {
      if (intent.status !== from) return false;
      log.push(`${from}→${to}: ${receipt}`);
      intent.status = to;
      intent.updatedAt = 1;
      return true;
    },
    now: () => CLAIM_LEASE_MS + 5,
  };
  return { ops, log, intent, card };
}

describe("T68e dispatch driver: the ledger decides, replays never resend", () => {
  const worker = (send: SendResult, result: ReturnType<AdapterDeps["ledger"]["result"]> = null) => {
    const { d } = deps(result);
    const port = messagePort(send);
    return { w: createChannelWorker({ ...d, port: port.port }) as WorkerSession, sent: port.sent };
  };

  test("claim → send → done; a second run is a no-op", async () => {
    const l = ledgerOps("pending");
    const { w, sent } = worker({ ok: true, messageId: "m1" });
    expect(await driveDispatch(l.ops, w, author, order())).toMatchObject({ kind: "sent" });
    expect(l.log).toEqual(["pending→submitted: claimed; route=channel; session=s-one", "submitted→done: route=channel; key=k1; message:m1"]);
    expect(await driveDispatch(l.ops, w, author, order())).toEqual({ kind: "settled", status: "done" });
    expect(sent).toHaveLength(1);
  });

  test("provably undelivered is cancelled for replanning; uncertain delivery is held as unknown", async () => {
    const r = ledgerOps("pending");
    expect(await driveDispatch(r.ops, worker({ ok: false, delivered: false, reason: "未连接" }).w, author, order())).toMatchObject({ kind: "replan" });
    expect(r.intent.status).toBe("cancelled");
    const u = ledgerOps("pending");
    expect(await driveDispatch(u.ops, worker({ ok: false, delivered: "unknown", reason: "超时" }).w, author, order())).toMatchObject({ kind: "held" });
    expect(u.intent.status).toBe("unknown");
    expect(await driveDispatch(u.ops, worker({ ok: true, messageId: "m" }).w, author, order())).toMatchObject({ kind: "held" });
  });

  test("restart after claim: fresh lease waits, expired lease reconciles from the ledger or hands over to PM", async () => {
    const fresh = ledgerOps("submitted", CLAIM_LEASE_MS);
    const a = worker({ ok: true, messageId: "m" });
    expect(await driveDispatch(fresh.ops, a.w, author, order())).toMatchObject({ kind: "held", reason: expect.stringContaining("租约") });
    const proven = ledgerOps("submitted");
    const b = worker({ ok: true, messageId: "m" }, { outcome: "delivered", eventSeq: 9 });
    expect(await driveDispatch(proven.ops, b.w, author, order())).toEqual({ kind: "settled", status: "done" });
    const blind = ledgerOps("submitted");
    const c = worker({ ok: true, messageId: "m" });
    expect(await driveDispatch(blind.ops, c.w, author, order())).toMatchObject({ kind: "held", reason: "claimed_without_receipt" });
    expect(blind.intent.status).toBe("unknown");
    expect([...a.sent, ...b.sent, ...c.sent]).toEqual([]);
  });

  test("a lost claim race sends nothing; mismatched recipient is cancelled unsent", async () => {
    const l = ledgerOps("pending");
    l.ops.settle = async () => false;
    const { w, sent } = worker({ ok: true, messageId: "m" });
    expect(await driveDispatch(l.ops, w, author, order())).toEqual({ kind: "lost_race" });
    expect(sent).toEqual([]);
    const m = ledgerOps("pending");
    expect(await driveDispatch(m.ops, w, { ...author, agent: "agent-x" }, order())).toMatchObject({ kind: "replan" });
    expect(m.intent.status).toBe("cancelled");
    expect(sent).toEqual([]);
  });

  test("P1-4 regression: another card's or a stale order, a stale card, or a session other than the binding is never sent", async () => {
    const { w, sent } = worker({ ok: true, messageId: "m" });
    const misbuilt = { ...order(), taskId: "ANOTHER-CARD", specRev: 1, head: "b".repeat(40), round: 99, node: "fix", step: "review" as const };
    const cases: [ReturnType<typeof ledgerOps>, SessionRef, WorkOrder, RegExp][] = [
      [ledgerOps("pending", 0, { specRev: 2 }), author, misbuilt, /任务单/],
      [ledgerOps("pending", 0, { specRev: 2 }), author, { ...order(), specRev: 2 }, /卡已被推进/],
      [ledgerOps("pending"), { ...author, sessionId: "wrong-session" }, order(), /当前绑定/],
      [ledgerOps("pending", 0, {}, { ...author, sessionId: "s-new" }), author, order(), /当前绑定/],
    ];
    for (const [l, ref, o, why] of cases) {
      expect(await driveDispatch(l.ops, w, ref, o)).toMatchObject({ kind: "replan", reason: expect.stringMatching(why) });
      expect(l.intent.status).toBe("cancelled");
      expect(l.log.every((x) => x.startsWith("pending→cancelled: 未投递"))).toBe(true);
    }
    expect(sent).toEqual([]);
  });

  test("P1-4 regression: a channel adapter refuses an ACP-hosted binding and passes the session id to the port", async () => {
    const acpBound: SessionRef = { ...author, transport: "acp" };
    const { d } = deps(null, acpBound);
    const p = messagePort({ ok: true, messageId: "m" });
    const w = createChannelWorker({ ...d, port: p.port });
    expect(await w.ensure("T1", "author", "claude")).toMatchObject({ kind: "manual", reason: expect.stringContaining("channel 路径") });
    expect(await w.submit(acpBound, "k1", order())).toMatchObject({ status: "rejected" });
    expect(await w.submit(author, "k1", reviewOrder())).toMatchObject({ status: "rejected", reason: expect.stringContaining("角色") });
    expect(p.sent).toEqual([]);
    await w.submit(author, "k1", order());
    expect(p.sent.map((x) => [x.agent, x.sessionId])).toEqual([["agent-one", "s-one"]]);
  });
});
