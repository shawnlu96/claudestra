/** T68f r1 regressions: each reviewer reproduction (T68f-r1-adv.md) as a test that fails with its fix reverted. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { getAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { createTask } from "../src/lib/ledger-write.js";
import { readRegistryAgentsSync } from "../src/lib/registry.js";
import { sessionGone } from "../src/lib/route-session.js";
import { boundRef } from "../src/lib/scheduler-auto-tick.js";
import { codexFailure, messagePort } from "../src/lib/scheduler-auto-ports.js";
import { ledgerResult, workOrderFor } from "../src/lib/scheduler-work-order.js";
import { createAcpWorker } from "../src/lib/worker-acp.js";
import { createChannelWorker } from "../src/lib/worker-message.js";
import { renderWorkOrder } from "../src/lib/worker-order.js";
import type { AdapterDeps } from "../src/lib/worker-ports.js";
import { autoFixture, H1, P2, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const realWs = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = realWs; });

/** A bridge double: records every frame that left and answers each with `reply(frame)`. */
function fakeBridge(reply: (m: Record<string, unknown>) => object) {
  const frames: Record<string, unknown>[] = [];
  class FakeWs {
    onopen?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void; onclose?: () => void;
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(s: string) {
      const m = JSON.parse(s);
      frames.push(m);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ requestId: m.requestId, ...reply(m) }) }));
    }
    close() { /* nothing to release in the double */ }
  }
  globalThis.WebSocket = FakeWs as never;
  return frames;
}

const adapter = (f: F): AdapterDeps => ({
  sessions: { bound: (t, role) => boundRef(f.db, t, role), create: async () => ({ ok: false, unknown: false, reason: "n/a" }), archive: async () => ({ ok: true, evidence: "x" }) },
  ledger: { result: (ref, probe) => ledgerResult(f.db, ref, probe) },
});
const row = (f: F) => (a: string) => readRegistryAgentsSync(f.registryPath).find((x) => x.name === a);

async function atReview(template: "code" | "ui" = "code"): Promise<F> {
  const f = autoFixture({ template });
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick();
  await f.tick();
  return f;
}

function reviewArgs(f: F, head = H1): string[] {
  const findings = join(f.dir, "none.json");
  writeFileSync(findings, "[]");
  return ["review", "T1", "--reviewer", "agent-rv-t1", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0",
    "--head", head, "--session", "s-rv", "--family", "codex", "--findings", findings, "--path", "reviews/T1-r1/report.md"];
}

describe("P1-1 only the bound reviewer, from the bound session as the registry runs it now, writes an auto verdict", () => {
  test("a restarted reviewer replaying the old session id and family is refused and the card does not reach merge", async () => {
    const f = await atReview();
    try {
      const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
      Object.assign(reg.agents["agent-rv-t1"], { sessionId: "s-restarted", runtime: "claude-code" });
      writeFileSync(f.registryPath, JSON.stringify(reg));
      const r = await f.cli("agent-rv-t1", ...reviewArgs(f));
      expect(r).toMatchObject({ ok: false, code: "forbidden", error: expect.stringContaining("审查员换过会话") });
      await f.tick();
      expect(f.task().stage).toBe("review");
    } finally { f.close(); }
  });

  test("the caller's own session, PM, an undispatched head, a checkout off the head, and a family change are all refused", async () => {
    const f = await atReview();
    try {
      expect(await f.cliWith({ callerSession: "s-other" }, "agent-rv-t1", ...reviewArgs(f))).toMatchObject({ ok: false, error: expect.stringContaining("调用方会话") });
      expect(await f.cliWith({ callerSession: undefined }, "agent-rv-t1", ...reviewArgs(f))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("pm", ...reviewArgs(f))).toMatchObject({ ok: false, error: expect.stringContaining("PM 要代记先 workflow-set --mode manual") });
      expect(await f.cli("agent-rv-t1", ...reviewArgs(f, "9".repeat(40)))).toMatchObject({ ok: false, error: expect.stringContaining("没有派给 agent-rv-t1") });
      f.reviewerCheckoutAt("8".repeat(40));
      expect(await f.cli("agent-rv-t1", ...reviewArgs(f))).toMatchObject({ ok: false, error: expect.stringContaining("不是被审的 head") });
      f.reviewerCheckoutAt(null);
      const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
      reg.agents["agent-rv-t1"].runtime = "claude-code";
      writeFileSync(f.registryPath, JSON.stringify(reg));
      expect(await f.cli("agent-rv-t1", ...reviewArgs(f))).toMatchObject({ ok: false, error: expect.stringContaining("不是绑定的 codex 家族") });
      expect(f.task().stage).toBe("review");
    } finally { f.close(); }
  });
});

describe("P1-3 / P1-4 the bridge is told which session, and only a typed pre-delivery refusal is 'not delivered'", () => {
  test("the order names the bound session; the bridge refuses a replaced one before routing", async () => {
    const f = autoFixture();
    try {
      const frames = fakeBridge(() => ({ result: { ok: true, targetChannelId: "ch-one" } }));
      expect(await messagePort(f.db, row(f)).send("agent-task-one", "s-one", "work", "k")).toMatchObject({ ok: true });
      expect(frames[0]).toMatchObject({ type: "route_to_agent", targetName: "agent-task-one", expectSession: "s-one" });
      const read = async () => [{ name: "agent-task-one", channelId: "ch-one", sessionId: "s-new" }];
      expect(await sessionGone("s-one", "ch-one", read)).toMatchObject({ rejected: "session_mismatch", error: expect.stringContaining("s-new") });
      expect(await sessionGone("s-new", "ch-one", read)).toBeNull();
      expect(await sessionGone(undefined, "ch-one", read)).toBeNull();
    } finally { f.close(); }
  });

  test("a generic bridge error after the send leaves the order unknown and it is never resent; a typed refusal replans", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      f.tickDeps.worker = () => createChannelWorker({ ...adapter(f), port: messagePort(f.db, row(f)) });
      let answer: object = { error: "post-delivery exception" };
      const frames = fakeBridge(() => answer);
      expect(await f.tick()).toMatchObject({ step: "held" });
      expect(f.intents().at(-1)).toMatchObject({ action: "dispatch", status: "unknown" });
      answer = { result: { ok: true } };
      f.advance(60 * 60_000);
      expect(await f.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("外部结果不明") });
      expect(frames).toHaveLength(1);
      expect(f.intents().filter((i) => i.node === "write")).toHaveLength(1);

      const g = autoFixture();
      try {
        await toBuild(g);
        g.tickDeps.worker = () => createChannelWorker({ ...adapter(g), port: messagePort(g.db, row(g)) });
        fakeBridge(() => ({ error: "目标换过会话", rejected: "session_mismatch" }));
        expect(await g.tick()).toMatchObject({ step: "replan" });
        expect(g.intents().at(-1)).toMatchObject({ action: "dispatch", status: "cancelled" });
      } finally { g.close(); }
    } finally { f.close(); }
  });
});

describe("P1-5 failures are tied to the order by its claim, and one that cannot be tied still reaches PM", () => {
  test("a Codex quota card opened between the send and the done receipt is this order's failure", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick();
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
      await f.tick(); // ensure reviewer
      const send = async (agent: string) => {
        const claimed = (f.db.query("SELECT updatedAt FROM scheduler_intents WHERE status = 'submitted'").get() as { updatedAt: number }).updatedAt;
        openAsk(f.db, { project: "p", fromAgent: agent, source: "codex", kind: "decide", title: "usage limit", extra: { quota: true } }, claimed + 1);
        return { ok: true as const, messageId: "m" };
      };
      f.tickDeps.worker = () => createAcpWorker({ ...adapter(f),
        port: { prompt: send, turnState: async (a) => ({ live: "idle", lastFailure: codexFailure(f.db, a) }), cancel: async () => ({ ok: true, evidence: "c" }) } });
      expect(await f.tick()).toMatchObject({ step: "sent" });
      expect(codexFailure(f.db, "agent-rv-t1")?.afterKey).toBe(f.intents().at(-1)!.id);
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("撞额度") });
      expect(f.notices).toHaveLength(1);
    } finally { f.close(); }
  });

  test("a Claude Code usage-limit wall hit after the claim fails the write order; one before any order still goes to PM", async () => {
    for (const before of [false, true]) {
      const f = autoFixture();
      try {
        await toBuild(f);
        const wallPath = join(f.dir, "quota-wall.json");
        const wall = (at: number) => writeFileSync(wallPath, JSON.stringify({ v: 1, wall: { id: "w1", enteredAt: at, source: "api_error", kind: "weekly",
          resetsAt: null, resetsText: "Oct 1 at 6am", hits: { "ch-one": { agent: "agent-task-one", at, error: "rate_limit" } } } }));
        if (before) wall(1);
        const port = messagePort(f.db, row(f), wallPath);
        f.tickDeps.worker = () => createChannelWorker({ ...adapter(f), port: { ...port, send: async () => ({ ok: true, messageId: "m" }), status: async () => "idle" } });
        expect(await f.tick()).toMatchObject({ step: "sent" });
        if (!before) wall(f.at("x").now);
        expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining(before ? "归不到派单上的失败" : "Claude Code 撞额度") });
        expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
        expect(f.notices).toHaveLength(1);
      } finally { f.close(); }
    }
  });
});

test("P1-6 auto is only switched on for a project the scheduler service is running", async () => {
  const f = autoFixture();
  try {
    const t2 = createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "new", kind: "code" }).row;
    const args = ["workflow-set", "T2", "--rev", String(t2.rev), "--template", "code", "--version", "2", "--mode", "auto", "--author-family", "claude", "--fallback", "退回人工"];
    const refused = { ok: false, code: "forbidden", error: expect.stringContaining("调度服务没对项目 p 开") };
    expect(await f.cliWith({ autoProjects: undefined }, "pm", ...args)).toMatchObject(refused);
    expect(await f.cliWith({ autoProjects: () => ["other"] }, "pm", ...args)).toMatchObject(refused);
    expect(await f.cliWith({ autoProjects: undefined }, "pm", ...args.map((a) => (a === "auto" ? "observe" : a)))).toMatchObject({ ok: true });
    const t2b = f.db.query("SELECT rev FROM tasks WHERE id = 'T2'").get() as { rev: number };
    const again = args.map((a, i) => (args[i - 1] === "--rev" ? String(t2b.rev) : a));
    expect(await f.cliWith({ autoProjects: () => ["p"] }, "pm", ...again, "--workflow-rev", "1")).toMatchObject({ ok: true });
  } finally { f.close(); }
});

test("T68f r6: auto is refused while scheduler.json autoDispatch is not true; manual and observe are unaffected", async () => {
  const f = autoFixture();
  try {
    const t2 = createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "new", kind: "code" }).row;
    const args = ["workflow-set", "T2", "--rev", String(t2.rev), "--template", "code", "--version", "2", "--mode", "auto", "--author-family", "claude", "--fallback", "退回人工"];
    const refused = { ok: false, code: "forbidden", error: "自动派单未开启（scheduler.json autoDispatch），见 T68h" };
    expect(await f.cliWith({ autoDispatch: undefined }, "pm", ...args)).toMatchObject(refused);
    expect(await f.cliWith({ autoDispatch: () => false }, "pm", ...args)).toMatchObject(refused);
    expect(f.db.query("SELECT COUNT(*) AS n FROM task_workflows WHERE taskId = 'T2'").get()).toEqual({ n: 0 });
    expect(await f.cliWith({ autoDispatch: () => false }, "pm", ...args.map((a) => (a === "auto" ? "observe" : a)))).toMatchObject({ ok: true });
  } finally { f.close(); }
});

describe("r1 P2s", () => {
  test("P2-1 an expired screenshot ask goes to PM instead of waiting forever", async () => {
    const f = await atReview("ui");
    try {
      await f.review("pass", H1, []);
      const opened = await f.tick();
      const ask = getAsk(f.db, String(opened?.detail).replace("ask ", ""))!;
      f.advance(ask.expiresAt + 1);
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("截图 ask 已过期") });
      expect(f.notices).toHaveLength(1);
    } finally { f.close(); }
  });

  test("P2-3 the reviewer's write-back command is rendered whole even with long paths", () => {
    const f = autoFixture();
    try {
      const intent = { id: "t68:s1:r1:adversarial_review:a0", node: "adversarial_review", head: H1, specRev: 1 } as never;
      const ref = { taskId: "T1", role: "reviewer" as const, agent: "agent-rv-t1", sessionId: "s".repeat(36), family: "codex" as const, transport: "acp" as const };
      const text = renderWorkOrder(workOrderFor(f.task(), intent, null, ref, "/x".repeat(80))!);
      expect(text).toContain("（不要带 --to，阶段由调度器推）");
      expect(text).toContain(`--session ${"s".repeat(36)} --family codex`);
    } finally { f.close(); }
  });

  test("P2-4 no screenshot ask without before / after images on disk: the card goes to PM", async () => {
    const f = await atReview("ui");
    try {
      await f.cli("owner", "task-set", "T1", "--rev", String(f.task().rev), "--extra", JSON.stringify({ ...f.task().extra, screenshots: [] }));
      await f.review("pass", H1, [P2]);
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("没有前后两张截图") });
      expect(f.db.query("SELECT COUNT(*) AS n FROM asks WHERE kind = 'authorize'").get()).toEqual({ n: 0 });
    } finally { f.close(); }
  });
});
