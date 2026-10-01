import { afterEach, beforeEach, expect, test } from "bun:test";
import { admitOrders, TICK_KEY } from "../src/lib/lend-inbox.js";
import { claudeLendSlots, CLAUDE_LEND_TOKEN, lendPollCapacity } from "../src/lib/lend-claude-worker-capacity.js";
import { lendRuntimeArgs } from "../src/lib/lend-claude-worker-routing.js";
import { claimProblem } from "../src/lib/lend-drive.js";
import { helloBody } from "../src/lib/lend-hello.js";
import { pauseForQuota } from "../src/lib/lend-health.js";
import { advance, getOrder, setMeta } from "../src/lib/lend-journal.js";
import { submitLendResult, submitLendWork, type SubmitterDeps } from "../src/lib/lend-submit.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { FP, HEAD, harness, polled, sha, TEXT, toStarted, wire } from "./lend-harness.js";

const original = process.env[CLAUDE_LEND_TOKEN];
beforeEach(() => { process.env[CLAUDE_LEND_TOKEN] = "fake-lend-token"; });
afterEach(() => { if (original === undefined) delete process.env[CLAUDE_LEND_TOKEN]; else process.env[CLAUDE_LEND_TOKEN] = original; });
const caller = { peer: "team-a", fp: FP };
const claude = (id: string) => ({ ...polled(id), family: "claude" });
function both() {
  const h = harness({ entry: { families: { claude: 1, codex: 1 }, roles: ["review", "write"], ordersPerDay: 20 } });
  setMeta(h.db, TICK_KEY, String(h.d.now()));
  return h;
}

test("缺省/零 Claude 授权拒收；缺 token hello 为 0 并提示 owner，Codex 不变", async () => {
  for (const families of [{ codex: 1 }, { codex: 1, claude: 0 }]) {
    const h = harness({ entry: { families } });
    expect((await admitOrders(h.d, caller, [claude("c")], "poll")).refused).toEqual([{ orderId: "c", code: "no_slot" }]);
    expect(helloBody(h.db, h.lend.lend[0], h.d.now()).slots.claude.total).toBe(0);
  }
  const h = both();
  const logs: string[] = [];
  expect(claudeLendSlots(h.lend.lend[0])).toBe(1);
  expect(claudeLendSlots(h.lend.lend[0], {}, (text) => logs.push(text))).toBe(0);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("claude setup-token");
  delete process.env[CLAUDE_LEND_TOKEN];
  expect(helloBody(h.db, h.lend.lend[0], h.d.now()).slots).toEqual({ codex: { total: 1, busy: 0 }, claude: { total: 0, busy: 0 } });
  expect(await admitOrders(h.d, caller, [claude("c"), polled("x")], "push")).toEqual({ accepted: ["x"], refused: [{ orderId: "c", code: "no_slot" }] });
});

test("按家族占槽，asked 也算 busy；claim 与 v1/v2 容量各自隔离", async () => {
  const h = both();
  expect(await admitOrders(h.d, caller, [claude("c1"), polled("x1"), claude("c2"), polled("x2")], "push"))
    .toEqual({ accepted: ["c1", "x1"], refused: [{ orderId: "c2", code: "no_slot" }, { orderId: "x2", code: "no_slot" }] });
  expect(helloBody(h.db, h.lend.lend[0], h.d.now()).slots).toEqual({ codex: { total: 1, busy: 1 }, claude: { total: 1, busy: 1 } });
  const x = advance(h.db, "x1", "asked", "claimed", { leaseUntil: h.d.now() + 60_000 });
  expect(claimProblem(getOrder(h.db, "c1")!, h.lend.lend[0], h.db, h.d.now())).toBeNull();
  expect(claimProblem(x, h.lend.lend[0], h.db, h.d.now())).toBe("wait");
  expect(lendPollCapacity(h.lend.lend[0], h.db, h.d.now())).toMatchObject({ families: { codex: 1, claude: 1 }, busy: { codex: 1, claude: 0 } });
  expect(lendRuntimeArgs(h.db, "c1")).toEqual(["--runtime", "claude-code"]);
  expect(lendRuntimeArgs(h.db, "x1")).toEqual(["--runtime", "codex", "--transport", "acp"]);
  expect(() => lendRuntimeArgs(h.db, "missing")).toThrow("家族缺失");
});

test("并行 push/poll 仍不超各族名额", async () => {
  const h = both();
  const [a, b] = await Promise.all([
    admitOrders(h.d, caller, [claude("c1"), polled("x1")], "push"),
    admitOrders(h.d, caller, [claude("c2"), polled("x2")], "poll"),
  ]);
  expect(a.accepted.length + b.accepted.length).toBe(2);
  expect(a.refused.length + b.refused.length).toBe(2);
});

test("Codex 撞额度时 Claude 仍能收、poll、claim", async () => {
  const h = both();
  pauseForQuota(h.db, "quota", { observedAt: 1, full: true, resetsAt: h.d.now() + 60_000 }, h.d.now(), () => {});
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [claude("c1"), polled("x1")], pollAfterMs: 30_000 } });
  await h.tick();
  expect(h.calls.find((c) => c.op === "poll")?.body).toMatchObject({ capacity: { families: { codex: 0, claude: 1 } } });
  await h.tick();
  expect(getOrder(h.db, "c1")?.state).toBe("claimed");
  expect(getOrder(h.db, "x1")).toBeNull();
});

for (const step of ["write", "fix", "review"] as const) test(`Claude ${step}：收单 → 领单 → 启动 → 交付 → 通知与记账`, async () => {
  const h = both();
  const writing = step !== "review";
  const order = { ...claude("o1"), step, pr: writing ? null : 270 };
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [order], pollAfterMs: 30_000 } });
  h.A.claim = () => ({ status: 200, body: { ok: true, v: 1, order: { ...wire(), step, pr: order.pr }, text: TEXT, sha256: sha(TEXT),
    lease: { gen: 1, expiresAt: 0, ms: 600_000 }, ...(writing ? { write: { branch: lendBranch("T93", FP), base: "main" } } : {}) } });
  let runtime: string[] = [];
  const create = h.d.worker.create;
  h.d.worker.create = (...args) => { runtime = lendRuntimeArgs(h.db, args[4]); return create(...args); };
  await toStarted(h);
  expect(runtime).toEqual(["--runtime", "claude-code"]);
  expect(h.log.created).toHaveLength(1);
  expect(h.log.notices[0].family).toBe("claude");
  const row = getOrder(h.db, "o1")!;
  const submitter: SubmitterDeps = { cwd: row.dir!, pid: 2, agentSession: () => row.sessionId!, panePid: async () => 1, ancestors: async () => [1],
    headOf: async () => "f".repeat(40) };
  const result = writing ? await submitLendWork(h.db, "o1", { summary: "implemented", selfCheck: "checked" }, submitter)
    : await submitLendResult(h.db, "o1", { verdict: "pass", findings: [], report: "reviewed" }, submitter);
  expect(result.ok).toBe(true);
  await h.tick();
  expect(getOrder(h.db, "o1")?.state).toBe("acked");
  expect(h.calls.find((c) => c.op === "result")?.body.session).toEqual({ id: row.sessionId, family: "claude" });
  expect(h.log.receipts[0].family).toBe("claude");
  expect(h.log.killed).toEqual([row.agent!]);
  expect(h.log.removed).toEqual(["o1"]);
});
