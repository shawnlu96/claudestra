/**
 * dispatch-recovery-MODELXP2 验收线 5 · 生产接法：auto tick 读 query_only 的 LedgerReader（同 src/scheduler.ts），写一律走真实台账 CLI 子进程
 * （调度身份、租约、最小环境、临时 HOME / TMPDIR / 状态目录，不连 bridge / peer / 真实模型）。只有建卡 → 交付 → 第一次挂池 → 对方领单这段
 * 准备工作在进程内走（同 tests/scheduler-pool.test.ts）。复现 PMDIR1 r2 形态：池审查单在 HedeMacBook-Pro（codex）被提供方策略拒审，
 * 出借方 release 带 failure.class = provider_policy。
 * 旧代码：单变 unknown，交 PM。新代码：撤单 → 记结果 → epoch → 规划器下一轮换家族（peer-b 的 claude，带豁免）重挂 → owner 只收一次通知。
 * 反例：旧对端不带类别 / usage / auth / 畸形类别 → 不动；豁免单再拒 → manual；去处是本机 → manual（原因码 + 单号）；observe 只记计划。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { failureReason } from "../src/lib/lend-health.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { EXEMPTION_TEXT } from "../src/lib/scheduler-model-outcome.js";
import { informKey } from "../src/lib/scheduler-model-wiring.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const MANAGER = resolve("src/manager.ts");
const HE = "HedeMacBook-Pro", PB = "peer-b";
const REMOTE: RemotePolicy = { mode: "balance", roles: ["review"], poolTimeoutMin: 15 };
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type Slots = { codex: number; claude: number };
const hello = (f: ReturnType<typeof autoFixture>, peer: string, s: Slots, seq: number) => recordHello(f.db, peer, null, { v: 1, proto: 2, boot: "b", seq, paused: null,
  slots: { codex: { total: s.codex, busy: 0 }, claude: { total: s.claude, busy: 0 } },
  grant: { until: Date.now() + 3_600_000, roles: ["review"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, Date.now());

async function setup(opts: { mode?: "on" | "observe"; peerB?: Slots } = {}) {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const f = autoFixture();
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); f.close(); errors.mockRestore(); });
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿\n");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  hello(f, HE, { codex: 2, claude: 0 }, 1);
  hello(f, PB, opts.peerB ?? { codex: 0, claude: 2 }, 1);
  const borrow: BorrowEntry[] = [HE, PB].map((peer) => ({ peer, projects: ["p"], roles: ["review"], maxOpen: 2 }));
  // 子进程的状态目录 = 夹具目录：台账、借入配置、联系人、项目、CFG 的 modelOutcome 都在这里
  const policy = JSON.stringify({ projects: { p: { keys: { modelOutcome: opts.mode ?? "on" } } } });
  writeFileSync(join(f.dir, "lend.json"), JSON.stringify({ version: 2, enabled: false, lend: [], borrow }));
  writeFileSync(join(f.dir, "peers.json"), JSON.stringify({ httpPeers: [HE, PB].map((name) => ({ name, addedAt: "" })), pendingInvites: [] }));
  writeFileSync(join(f.dir, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [f.dir], createdAt: "" }] }));
  writeFileSync(join(f.dir, "recovery-policy.json"), policy);
  // 调度进程这一侧（tick 读 modelOutcome、池单 tick 的默认只读 LedgerReader）读本进程的状态目录：链到夹具
  const shared = ["ledger.sqlite", "recovery-policy.json"].map((n) => join(STATE_DIR, n));
  const unlink = () => { for (const at of shared) rmSync(at, { force: true }); };
  unlink(); cleanup.push(unlink);
  symlinkSync(join(f.dir, "ledger.sqlite"), shared[0]);
  writeFileSync(shared[1], policy);
  // owner 的拒审规矩批准（同本地 MODELX，豁免文本带它的 id）
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1999);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true,
    via: "web_card", at: 2000, final: true });
  const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  cleanup.push(() => { singleton.release(); maintenance.release(); });
  const home = join(f.dir, "home"), tmp = join(f.dir, "tmp"), runtime = join(f.dir, "runtime");
  for (const d of [home, tmp, runtime]) mkdirSync(d);
  const env = testChildEnv({ HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: f.dir, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_TEST: "1",
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: maintenance.token } }) });
  const calls: string[] = [];
  /** 生产写口：`bun src/manager.ts ledger <sub> …` 独立子进程，JSON 输出 */
  const child: AutoTickDeps["manager"] = async (...args) => {
    calls.push(args[1]);
    const p = Bun.spawn([process.execPath, "--no-env-file", MANAGER, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    try { return JSON.parse(out) as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  const lend = { borrow: async () => borrow, notifyPm: async () => {} };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend } as never, actor, ...args) as Promise<Record<string, any>>;
  const pol = { p: { maxActiveWorkers: 0, remote: REMOTE } };
  const setupTick = async () => {
    const r = await schedulerAutoTick(f.db, pol, { ...f.tickDeps, manager: (...a) => cli("scheduler", ...a.slice(1)), borrow: async () => borrow } as AutoTickDeps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  /** 生产接法的一轮：只读句柄 + 子进程写口 */
  const tick = async () => {
    const ro = reader.get()!;
    expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    const r = await schedulerAutoTick(ro, pol, { ...f.tickDeps, manager: child, borrow: async () => borrow } as AutoTickDeps);
    expect(r.failed).toEqual([]);
    return r.cards[0];
  };
  const peerCall = (peer: string, ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", peer, JSON.stringify(body));
  const orders = () => listLendOrders(f.db, "T1");
  const claim = async (peer: string) => {
    const o = orders().at(-1)!;
    expect((await peerCall(peer, "claim", { v: 1, orderId: o.orderId, worker: "w1" })).ok).toBe(true);
    return o.orderId;
  };
  /** 出借方停单：detail 同 lend-drive（failureReason），failure 同 lenderFailureOf */
  const release = (peer: string, failure?: unknown, message = CYBER) => {
    const o = orders().at(-1)!;
    return peerCall(peer, "lease", { v: 1, orderId: o.orderId, gen: o.leaseGen, action: "release", reason: "stopped",
      detail: failureReason({ kind: "error", askId: "a", message }), ...(failure === undefined ? {} : { failure }) });
  };
  const ops = (op: string) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === op);
  const owner = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.audience === "owner");
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  expect(await setupTick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining(HE) });
  expect(orders()[0]).toMatchObject({ peer: HE, family: "codex", status: "pooled" });
  await claim(HE);
  expect(await setupTick()).toMatchObject({ step: "pool_claimed" });
  return { f, tick, calls, release, claim, orders, ops, owner, approvalId: ask.id, errors };
}

const policyFailure = (over: Record<string, unknown> = {}) => ({ class: "provider_policy", sessionId: "thr-1", failedAt: 5_000, ...over });

test("PMDIR1 r2 新绿：provider_policy → 撤单 → 记结果 → epoch → 规划器换 peer-b 的 claude 重挂（带豁免）→ owner 只收一次通知", async () => {
  const s = await setup();
  const first = s.orders()[0].orderId;
  expect((await s.release(HE, policyFailure())).ok).toBe(true);
  expect(s.orders()[0].status).toBe("unknown"); // 借入方收 release 照旧；下面的调度一轮才接续
  expect(await s.tick()).toMatchObject({ step: "pool_refusal", detail: expect.stringContaining("provider_policy_refusal") });
  expect(s.calls).toContain("scheduler-pool-refusal");
  expect(s.orders()[0]).toMatchObject({ orderId: first, status: "cancelled", reason: expect.stringContaining("provider_policy_refusal") });
  const [plan] = s.ops("pool_refusal_plan");
  expect(plan).toMatchObject({ actor: "scheduler", data: { mode: "on", orderId: first, plan: { kind: "replace", to: { machine: PB, family: "claude" } } } });
  const [epoch] = s.ops("pool_refusal_epoch");
  expect(epoch.data).toMatchObject({ orderId: first, toFamily: "claude", approvalId: s.approvalId, exemption: `${EXEMPTION_TEXT}(批准 ${s.approvalId})`, head: H1 });
  expect(s.f.intents().filter((i) => i.action === "review").at(-1)).toMatchObject({ status: "cancelled" });
  // 规划器下一轮按 epoch 的 toFamily 重挂
  expect(await s.tick()).toMatchObject({ step: "pool_pooled", detail: expect.stringContaining(PB) });
  const second = s.orders()[1];
  expect(second).toMatchObject({ peer: PB, family: "claude", status: "pooled", head: H1 });
  expect(second.text).toContain(`${EXEMPTION_TEXT}(批准 ${s.approvalId})`);
  expect(s.f.intents().at(-1)).toMatchObject({ action: "review", recipient: `peer:${PB}`, status: "pending" });
  // owner 只收一次（同类拒审），无只读报错
  expect(s.owner().map((e) => e.dedupKey)).toEqual([informKey("T1", "cyber_policy")]);
  expect(await s.tick()).toMatchObject({ step: "pool_pooled" });
  expect(s.ops("pool_refusal_plan")).toHaveLength(1);
  expect(s.owner()).toHaveLength(1);
  expect(s.errors.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => /readonly/.test(l))).toEqual([]);
});

test("豁免单再被拒 → manual：不撤单、不再换家族，owner 收一条待办，单照旧停给 PM（unknown）", async () => {
  const s = await setup();
  await s.release(HE, policyFailure());
  await s.tick();
  await s.tick();
  await s.claim(PB);
  expect(await s.tick()).toMatchObject({ step: "pool_claimed" });
  expect((await s.release(PB, policyFailure({ sessionId: "thr-2" }))).ok).toBe(true);
  expect(await s.tick()).toMatchObject({ step: "pool_unknown" });
  expect(s.orders()[1].status).toBe("unknown");
  expect(s.ops("pool_refusal_plan").map((e) => (e.data.plan as { kind: string }).kind)).toEqual(["replace", "manual"]);
  expect(s.ops("pool_refusal_epoch")).toHaveLength(1);
  expect(s.owner().map((e) => e.dedupKey)).toEqual([informKey("T1", "cyber_policy"), "model-refusal-manual:T1"]);
  expect(s.orders()).toHaveLength(2);
});

test("反例：旧对端不带类别 / usage / auth → 不动，单变 unknown 交 PM（同旧代码）", async () => {
  for (const failure of [undefined, policyFailure({ class: "usage" }), policyFailure({ class: "auth" })]) {
    const s = await setup();
    expect((await s.release(HE, failure)).ok).toBe(true);
    expect(await s.tick()).toMatchObject({ step: "pool_unknown" });
    expect(s.orders()).toHaveLength(1);
    expect(s.orders()[0].status).toBe("unknown");
    expect(s.ops("pool_refusal_plan")).toEqual([]);
    expect(s.calls).not.toContain("scheduler-pool-refusal");
    for (const c of cleanup.splice(0).reverse()) c();
  }
});

test("反例：畸形类别 → 借入方整条 invalid，不入账，不撤单不换家族", async () => {
  const s = await setup();
  for (const bad of [{ ...policyFailure(), class: "cyber_policy" }, { class: "provider_policy" }, "provider_policy"]) {
    expect(await s.release(HE, bad)).toMatchObject({ ok: false, code: "invalid" });
  }
  expect(s.orders()[0].status).toBe("claimed");
  expect(await s.tick()).toMatchObject({ step: "pool_claimed" });
  expect(s.ops("pool_refusal_plan")).toEqual([]);
  expect(s.orders()).toHaveLength(1);
});

test("去处是本机（池里另一家族没空位）→ 撤单、epoch 后规划器转 manual：原因码 model_safety_hold + 单号，不同模型重试", async () => {
  const s = await setup({ peerB: { codex: 0, claude: 0 } });
  const first = s.orders()[0].orderId;
  await s.release(HE, policyFailure());
  expect(await s.tick()).toMatchObject({ step: "pool_refusal" });
  expect(s.ops("pool_refusal_epoch")[0].data).toMatchObject({ to: { machine: "local", family: "claude" } });
  const next = await s.tick();
  expect(JSON.stringify(next)).toContain("model_safety_hold");
  expect(JSON.stringify(next)).toContain(first);
  expect(s.orders()).toHaveLength(1); // 没有再挂池，更没有 codex 重派
  expect(s.f.intents().filter((i) => i.action === "review" && i.status !== "cancelled")).toEqual([]);
});

test("开关 observe：只记计划事件（mode observe），不撤单、不开 epoch，单照旧停给 PM", async () => {
  const s = await setup({ mode: "observe" });
  await s.release(HE, policyFailure());
  expect(await s.tick()).toMatchObject({ step: "pool_unknown" });
  expect(s.ops("pool_refusal_plan").map((e) => e.data.mode)).toEqual(["observe"]);
  expect(s.ops("pool_refusal_epoch")).toEqual([]);
  expect(s.orders()[0].status).toBe("unknown");
  expect(s.owner()).toEqual([]);
});
