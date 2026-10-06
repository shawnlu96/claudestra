/** dispatch-recovery-LCFG1, lender side: classification, mode, one notice per peer + family, explicit CAS recovery, live orders kept. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getOrder, openLendJournal } from "../src/lib/lend-journal.js";
import { pausedUntil } from "../src/lib/lend-health.js";
import { noteClaudeReadiness } from "../src/lib/lend-claude-worker-capacity.js";
import {
  classifyConfigFailure, configFailureMode, noteStartConfigFailure, providerConfigFailure, providerFamilyUnavailable,
  configFailureSlots, recoverProviderConfigFailure, setConfigFailurePolicy, startConfigRefusal,
} from "../src/lib/lend-config-failure.js";
import { recoveryPolicy } from "../src/lib/recovery-policy.js";
import { helloBody } from "../src/lib/lend-hello.js";
import { harness, polled, toStarted } from "./lend-harness.js";

const MODEL_400 = "创建失败: Codex（ACP）引导轮失败：400 Bad Request {\"error\":{\"code\":\"model_not_enabled\",\"message\":\"The model `gpt-9` is not enabled for this account.\"}}";

const setMode = (mode: "on" | "observe" | "off") => setConfigFailurePolicy(() => ({ mode, manualAfterMs: null, source: "config" }));
const journals: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const h of journals.splice(0)) h.db.close();
  setConfigFailurePolicy(null);
  noteClaudeReadiness(null);
});
function setup() {
  noteClaudeReadiness({ ready: true, reason: null, at: Date.now() });
  const h = harness({ entry: { families: { codex: 2, claude: 1 }, ordersPerDay: 20 } });
  journals.push(h);
  return h;
}
let creates = 0;
async function failStart(h: ReturnType<typeof harness>, orderId: string, error = MODEL_400, family = "codex") {
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [{ ...polled(orderId), family }], pollAfterMs: 30_000 } });
  h.d.worker.create = async () => (creates++, { ok: false, error });
  h.advanceTime(60_000);
  for (let i = 0; i < 4; i++) await h.tick();
  expect(getOrder(h.db, orderId)?.state).toBe("released");
}
const configNotices = (h: ReturnType<typeof harness>) => h.log.notices.filter((n) => n.why?.startsWith("配置不可用"));

test("classifier: only explicit model-not-enabled; quota, capacity, network, auth and cyber refusals are never config", () => {
  expect(classifyConfigFailure(MODEL_400)).toBe("model_not_enabled");
  expect(classifyConfigFailure("400 model_not_enabled")).toBe("model_not_enabled");
  expect(classifyConfigFailure("The model claude-x has not been enabled")).toBe("model_not_enabled");
  expect(classifyConfigFailure("Error: model 'o9' is not enabled for your organization")).toBe("model_not_enabled");
  for (const e of [
    "You've hit your usage limit. model_not_enabled", "429 Too Many Requests", "server overloaded (529)", "fetch failed: ECONNRESET",
    "Authentication required", "This content was flagged for possible cybersecurity risk; model_not_enabled", "cyber_policy model not enabled",
    "request refused by safety system: model is not enabled", "clone failed", "", "feature not enabled",
  ]) expect(classifyConfigFailure(e)).toBeNull();
});

test("mode: the one recovery policy (lend / lendConfigFailure), default observe; illegal or throwing port answers off", () => {
  expect(configFailureMode()).toBe("observe"); // test-guard state dir: no recovery-policy.json
  const reads: unknown[] = [];
  setConfigFailurePolicy((project, key) => (reads.push([project, key]), { mode: "on", manualAfterMs: null, source: "config" }));
  expect(configFailureMode()).toBe("on");
  expect(reads).toEqual([["lend", "lendConfigFailure"]]);
  setConfigFailurePolicy((() => ({ mode: "bogus" })) as never);
  expect(configFailureMode()).toBe("off");
  setConfigFailurePolicy(() => { throw new Error("x"); });
  expect(configFailureMode()).toBe("off");
  const dir = mkdtempSync(join(tmpdir(), "lcfg1-policy-"));
  try { // the real file-backed reader knows the key: on / off per the file, a typo'd file stops (off)
    const path = join(dir, "recovery-policy.json");
    setConfigFailurePolicy((p, k) => recoveryPolicy(p, k, path));
    expect(configFailureMode()).toBe("observe");
    writeFileSync(path, JSON.stringify({ projects: { lend: { keys: { lendConfigFailure: "on" } } } }));
    expect(configFailureMode()).toBe("on");
    writeFileSync(path, JSON.stringify({ projects: { lend: { mode: "on", keys: { lendConfigFailure: "off" } } } }));
    expect(configFailureMode()).toBe("off");
    writeFileSync(path, JSON.stringify({ projects: { lend: { keys: { lendConfigFailur: "on" } } } }));
    expect(configFailureMode()).toBe("off");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("observe (default): would-pause logged, no registration, no notice; off: nothing", async () => {
  const h = setup();
  await failStart(h, "o1");
  expect(providerConfigFailure(h.db, "team-a", "codex")).toBeNull();
  expect(configNotices(h)).toEqual([]);
  expect(h.log.lines.some((l) => l.includes("配置故障观察（observe）"))).toBe(true);
  setMode("off");
  const before = h.log.lines.length;
  await failStart(h, "o2");
  expect(providerConfigFailure(h.db, "team-a", "codex")).toBeNull();
  expect(h.log.lines.slice(before).some((l) => l.includes("配置故障"))).toBe(false);
});

test("on: two orders of one family → one start, one registration, exactly one owner notice; the second is refused before create", async () => {
  setMode("on");
  const h = setup();
  creates = 0;
  await failStart(h, "o1");
  await failStart(h, "o2");
  expect(creates).toBe(1);
  expect(h.log.created).toEqual([]);
  const f = providerConfigFailure(h.db, "team-a", "codex")!;
  expect(f).toMatchObject({ gen: 1, category: "model_not_enabled", notice: { state: "sent" }, recoveredAt: null });
  expect(f.evidence.map((e) => e.orderId)).toEqual(["o1"]);
  expect(f.evidence[0].excerpt).toContain("model_not_enabled");
  expect(configNotices(h)).toHaveLength(1);
  const why = configNotices(h)[0].why!;
  expect(why).toContain("是否修改模型由你决定");
  expect(why).not.toMatch(/ledger |codex config|--model|点|按钮/);
  expect(pausedUntil(h.db, h.d.now())).toBeNull(); // not a quota pause
  // Both releases reach A as not_started with the original start error (the borrower's classifier sees one fault class).
  const rels = h.calls.filter((c) => c.op === "lease" && c.body.action === "release");
  expect(rels.map((c) => [c.body.orderId, c.body.reason])).toEqual([["o1", "not_started"], ["o2", "not_started"]]);
  expect(getOrder(h.db, "o1")?.reason).toContain("model_not_enabled");
  expect(getOrder(h.db, "o2")?.reason).toMatch(/^起 worker 失败：配置故障未恢复，没有再启动（第 1 代，单 o1）：.*model_not_enabled/);
  expect(classifyConfigFailure(String(getOrder(h.db, "o2")?.reason).slice("起 worker 失败：".length))).toBe("model_not_enabled");
});

test("on: hello withdraws only the faulty family for that peer; restart keeps it; only the owner's explicit recovery re-offers", async () => {
  setMode("on");
  const h = setup();
  const entry = h.lend.lend[0];
  expect(helloBody(h.db, entry, h.d.now()).slots.codex.total).toBe(2);
  await failStart(h, "o1");
  const body = helloBody(h.db, entry, h.d.now());
  expect(body.slots.codex.total).toBe(0);
  expect(body.slots.claude).toEqual(helloBody(h.db, { ...entry, peer: "team-b" }, h.d.now()).slots.claude);
  expect(helloBody(h.db, { ...entry, peer: "team-b" }, h.d.now()).slots.codex.total).toBe(2); // other peer untouched
  expect(configFailureSlots(h.db, "team-a", { codex: { total: 3, busy: 2 }, claude: { total: 1, busy: 0 } }))
    .toEqual({ codex: { total: 0, busy: 2 }, claude: { total: 1, busy: 0 } }); // busy (live orders) kept
  h.advanceTime(3 * 86400_000); // time alone never recovers (the grant runs 6 days)
  expect(helloBody(h.db, entry, h.d.now()).slots.codex.total).toBe(0);
  setMode("observe");
  expect(helloBody(h.db, entry, h.d.now()).slots.codex.total).toBe(2); // observe never withdraws
  setMode("on");
  expect(recoverProviderConfigFailure(h.db, "team-a", "codex", 1, h.d.now())).toBe(true);
  expect(helloBody(h.db, entry, h.d.now()).slots.codex.total).toBe(2);
  creates = 0;
  h.d.worker.create = async (n, dir) => (creates++, h.registry.set(n, { sessionId: "thr-2", cwd: dir }), { ok: true });
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [polled("o9")], pollAfterMs: 30_000 } });
  h.advanceTime(60_000);
  for (let i = 0; i < 4; i++) await h.tick();
  expect(creates).toBe(1);
  expect(getOrder(h.db, "o9")?.state).toBe("started");
});

test("observe: a registered fault refuses nothing (create runs) and only logs the would-be refusal; off logs nothing", async () => {
  setMode("on");
  const h = setup();
  await failStart(h, "o1");
  setMode("observe");
  creates = 0;
  await failStart(h, "o2");
  expect(creates).toBe(1);
  expect(h.log.lines.some((l) => l.includes("本会因 team-a 的 codex 配置故障（第 1 代）不起 o2"))).toBe(true);
  setMode("off");
  const row = getOrder(h.db, "o2")!;
  const lines: string[] = [];
  expect(startConfigRefusal({ db: h.db, log: (m) => lines.push(m) }, row)).toBeNull();
  expect(lines).toEqual([]);
});

test("on: other family and other peer are independent", async () => {
  setMode("on");
  const h = setup();
  await failStart(h, "o1");
  expect(providerFamilyUnavailable(h.db, "team-a", "codex")).toBe(true);
  expect(providerFamilyUnavailable(h.db, "team-a", "claude")).toBe(false);
  expect(providerFamilyUnavailable(h.db, "team-b", "codex")).toBe(false);
  await failStart(h, "c1", MODEL_400, "claude");
  expect(providerConfigFailure(h.db, "team-a", "claude")?.gen).toBe(1);
  expect(configNotices(h).map((n) => n.family)).toEqual(["codex", "claude"]);
});

test("on: concurrent failures send one notice; a failed send is retried by the next failure only", async () => {
  setMode("on");
  const db = openLendJournal(":memory:");
  const sent: string[] = [];
  let ok = false;
  const notify = async (p: { orderId: string }) => {
    await Bun.sleep(1);
    sent.push(p.orderId);
    return ok ? { ok: true as const } : { ok: false as const, error: "bridge 不在" };
  };
  const d = { db, now: () => 5, log: () => {}, notify };
  const row = (orderId: string) => ({ orderId, peer: "team-a", family: "codex", fp: null, preview: {}, wire: null }) as never;
  await Promise.all([noteStartConfigFailure(d, row("a"), MODEL_400), noteStartConfigFailure(d, row("b"), MODEL_400)]);
  expect(sent).toEqual(["a"]);
  expect(providerConfigFailure(db, "team-a", "codex")?.notice).toBeNull();
  ok = true;
  await Promise.all([noteStartConfigFailure(d, row("c"), MODEL_400), noteStartConfigFailure(d, row("d"), MODEL_400)]);
  expect(sent).toEqual(["a", "c"]);
  await noteStartConfigFailure(d, row("e"), MODEL_400);
  expect(sent).toEqual(["a", "c"]);
  expect(providerConfigFailure(db, "team-a", "codex")?.evidence.map((e) => e.orderId)).toEqual(["a", "b", "c", "d", "e"]);
  db.close();
});

test("on: restart keeps the registration and does not notify again", async () => {
  setMode("on");
  const dir = mkdtempSync(join(tmpdir(), "lcfg1-"));
  try {
    const path = join(dir, "journal.sqlite");
    const sent: string[] = [];
    const deps = (db: ReturnType<typeof openLendJournal>) => ({ db, now: () => 9, log: () => {}, notify: async (p: { orderId: string }) => (sent.push(p.orderId), { ok: true as const }) });
    const row = (orderId: string) => ({ orderId, peer: "team-a", family: "codex", fp: null, preview: {}, wire: null }) as never;
    let db = openLendJournal(path);
    await noteStartConfigFailure(deps(db), row("a"), MODEL_400);
    db.close();
    db = openLendJournal(path);
    await noteStartConfigFailure(deps(db), row("b"), MODEL_400);
    expect(sent).toEqual(["a"]);
    expect(providerConfigFailure(db, "team-a", "codex")?.evidence).toHaveLength(2);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit owner recovery is CAS on the generation; old generation / late notify result never clear a newer fault", async () => {
  setMode("on");
  const db = openLendJournal(":memory:");
  let release: (() => void) | null = null;
  const sent: string[] = [];
  const d = { db, now: () => 7, log: () => {}, notify: async (p: { orderId: string }) => {
    sent.push(p.orderId);
    if (p.orderId === "a") await new Promise<void>((r) => { release = r; });
    return { ok: true as const };
  } };
  const row = (orderId: string) => ({ orderId, peer: "team-a", family: "codex", fp: null, preview: {}, wire: null }) as never;
  const slow = noteStartConfigFailure(d, row("a"), MODEL_400);
  await Bun.sleep(1);
  expect(recoverProviderConfigFailure(db, "team-a", "codex", 2, 8)).toBe(false); // wrong generation
  expect(recoverProviderConfigFailure(db, "team-a", "codex", 1, 8)).toBe(true);
  expect(recoverProviderConfigFailure(db, "team-a", "codex", 1, 9)).toBe(false); // already recovered
  expect(providerFamilyUnavailable(db, "team-a", "codex")).toBe(false);
  await noteStartConfigFailure(d, row("b"), MODEL_400); // a new fault after recovery: generation 2, its own notice
  expect(providerConfigFailure(db, "team-a", "codex")).toMatchObject({ gen: 2, recoveredAt: null, notice: { state: "sent" } });
  release!();
  await slow; // generation 1's late notify result
  expect(providerConfigFailure(db, "team-a", "codex")).toMatchObject({ gen: 2, recoveredAt: null, notice: { state: "sent" } });
  expect(recoverProviderConfigFailure(db, "team-a", "codex", 1, 10)).toBe(false);
  expect(providerFamilyUnavailable(db, "team-a", "codex")).toBe(true);
  expect(sent).toEqual(["a", "b"]);
  db.close();
});

test("on: a started order is not stopped by a later start failure of another order", async () => {
  setMode("on");
  const h = setup();
  await toStarted(h);
  const live = getOrder(h.db, "o1")!;
  await failStart(h, "o2");
  expect(providerFamilyUnavailable(h.db, "team-a", "codex")).toBe(true);
  expect(getOrder(h.db, "o1")).toMatchObject({ state: "started", agent: live.agent, sessionId: live.sessionId, leaseGen: live.leaseGen });
  expect(h.log.killed).toEqual([]);
});

test("ordinary start failures stay out of the mechanism under on", async () => {
  setMode("on");
  const h = setup();
  await failStart(h, "o1", "This content was flagged for possible cybersecurity risk; model_not_enabled");
  await failStart(h, "o2", "fetch failed: ETIMEDOUT");
  await failStart(h, "o3", "You've hit your usage limit. Try again later."); // last: it pauses Codex claims
  expect(providerConfigFailure(h.db, "team-a", "codex")).toBeNull();
  expect(configNotices(h)).toEqual([]);
});
