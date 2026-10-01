import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askOrder, openOrderAsk, type AskDeps } from "../src/lib/order-ask.js";
import { ASK_DEFAULT_MS, recordDefaultPmReply, sweepAskDefaults } from "../src/lib/order-ask-default.js";
import { prepareDefaultSpec } from "../src/lib/order-ask-default-spec.js";
import { answerAsk, getAsk, listAsks, openAskFull, patchAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setMeta } from "../src/lib/ledger-write.js";
import { parseAskWire } from "../src/lib/order-wire.js";

let db: Database, dir: string, dbPath: string, spec: string;
let notices: string[];
const now = 1_000_000;
const original = "# 原规格\r\n不可改写\r\n";
const who = { agent: "agent-author", sessionId: "s", channelId: "ch", family: "codex" };
const wire = { v: 1, orderId: "T1:write:r0", question: "怎么做？\n<未知输入>", class: "design", default: "保留两边", options: [] };
const deps = (): AskDeps => ({ db, open: (x) => openAskFull(db, x, now),
  notify: async (_to, text) => (notices.push(text), { handed: true, note: "queued" }),
  markHanded: (id) => patchAsk(db, id, { extra: { notice: "handed" } }), record: (ctx, x) => void appendEvent(db, ctx, x) });
const ask = async (extra = {}) => {
  const r = await askOrder(who, { ...wire, ...extra }, deps());
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return getAsk(db, r.askId as string)!;
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ask-default-")); dbPath = join(dir, "ledger.db"); spec = join(dir, "T1.md");
  writeFileSync(spec, original); db = openLedger(dbPath); notices = [];
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "默认", kind: "code", agent: who.agent, pm: "agent-pm", spec });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
});
afterEach(() => { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });

test("design/scope return continue, notify PM with quoted default, and reject missing defaults", async () => {
  for (const kind of ["design", "scope"]) {
    const r = await askOrder(who, { ...wire, class: kind }, deps());
    expect(r).toMatchObject({ ok: true, blocking: false, message: "已登记，按你的默认做法继续", notified: true });
    if (!r.ok) throw new Error(r.error);
    expect(getAsk(db, r.askId as string)?.blocking).toBe(false);
    expect(await askOrder(who, { v: 1, orderId: wire.orderId, question: "q", class: kind }, deps())).toMatchObject({ ok: false, code: "invalid_wire" });
  }
  expect(notices[0]).toContain("正文带 ask ask_");
  expect(notices[0]).toContain("15 分钟没回按默认定");
  expect(notices[0]).toContain("「保留两边」");
});

test("wire accepts old shape and counts up to 600 Unicode codepoints, refuses malformed fields", () => {
  expect(parseAskWire({ v: 1, orderId: "o", question: "q" })).toMatchObject({ ok: true, value: { options: [] } });
  expect(parseAskWire({ ...wire, default: "🙂".repeat(600) }).ok).toBe(true);
  for (const extra of [{ default: "🙂".repeat(601) }, { default: " " }, { default: null }, { class: "secret" }, { default: "a\u0000" }]) {
    expect(parseAskWire({ ...wire, ...extra }).ok).toBe(false);
  }
});

test("explicit blockers, old local asks, and all pool writes keep blocking", async () => {
  expect((await ask({ class: "blocker" })).blocking).toBe(true);
  const old = await askOrder(who, { v: 1, orderId: wire.orderId, question: "旧版" }, deps());
  expect(old).toMatchObject({ ok: true, blocking: true });
  // Pool classification uses the trusted order row, not the sender-controlled payload.
  db.run("DROP TABLE lend_orders");
  db.run("CREATE TABLE lend_orders (orderId TEXT, step TEXT)");
  db.run("INSERT INTO lend_orders (orderId, step) VALUES ('pool', 'write')");
  const r = await openOrderAsk(db, deps(), { task: getTask(db, "T1")!, orderId: "pool", from: "worker@peer", keyPrefix: "lend" },
    { question: "远端", options: [], class: "scope", default: "直接做" });
  expect(r).toMatchObject({ blocking: true });
  sweepAskDefaults(db, now + ASK_DEFAULT_MS);
  expect(listAsks(db, { states: ["answered"] })).toHaveLength(0);
});

test("15-minute boundary, restart and repeated scans append exactly once and preserve every original byte", async () => {
  const a = await ask();
  expect(sweepAskDefaults(db, now + ASK_DEFAULT_MS - 1)).toBe(0);
  expect(readFileSync(spec, "utf8")).toBe(original);
  expect(sweepAskDefaults(db, now + ASK_DEFAULT_MS)).toBe(1);
  const appended = readFileSync(spec, "utf8");
  expect(appended.startsWith(original)).toBe(true);
  expect(appended).toContain("## 自动定(");
  expect(appended).toContain("PM 若已另行答复，以规格里 PM 定为准");
  expect(getAsk(db, a.id)).toMatchObject({ state: "answered", answer: { text: "按执行者默认做法定" } });
  closeLedger(dbPath); db = openLedger(dbPath);
  expect(sweepAskDefaults(db, now + ASK_DEFAULT_MS * 3)).toBe(0);
  expect(readFileSync(spec, "utf8")).toBe(appended);
});

test("only the verified PM's explicit ask id to this executor closes that ask; web answers also suppress auto append", async () => {
  const a = await ask();
  const b = await ask({ question: "第二个" });
  const pm = { agent: "agent-pm", verified: true };
  for (const [identity, target, body] of [
    [{ ...pm, verified: false }, who.agent, `ask ${a.id}`], [{ ...pm, agent: "agent-fake" }, who.agent, `ask ${a.id}`],
    [pm, "agent-other", `ask ${a.id}`], [pm, who.agent, "照这个做"], [pm, who.agent, `${a.id}`],
  ] as const) expect(recordDefaultPmReply(db, identity, target, body, now + 1)).toEqual([]);
  expect(recordDefaultPmReply(db, pm, who.agent, `ask ${a.id} 换一种做法`, now + 2)).toEqual([a.id]);
  expect(getAsk(db, b.id)?.state).toBe("open");
  answerAsk(db, b.id, { choices: [], labels: [], text: "网页回复", principal: "owner", via: "web_card", at: now + 3, final: true });
  expect(sweepAskDefaults(db, now + ASK_DEFAULT_MS)).toBe(0);
  expect(readFileSync(spec, "utf8")).toBe(original);
});

test("durable append jobs recover partial UTF-8 and a crash after the complete append without duplication", async () => {
  const a = await ask();
  const at = now + ASK_DEFAULT_MS;
  answerAsk(db, a.id, { choices: [], labels: [], text: "按执行者默认做法定", principal: "system:ask-default", via: "terminal", at, final: true });
  patchAsk(db, a.id, { extra: { defaultAppend: "pending", defaultAt: at } });
  prepareDefaultSpec(db, getAsk(db, a.id)!);
  const plan = getAsk(db, a.id)!.extra.defaultAppendPlan as { section: string };
  appendFileSync(spec, Buffer.from(plan.section).subarray(0, 77));
  closeLedger(dbPath); db = openLedger(dbPath);
  expect(sweepAskDefaults(db, at)).toBe(1);
  expect(readFileSync(spec, "utf8")).toBe(original + plan.section);
  patchAsk(db, a.id, { extra: { defaultAppend: "pending" } });
  expect(sweepAskDefaults(db, at)).toBe(1);
  expect(readFileSync(spec, "utf8")).toBe(original + plan.section);
  expect(listEvents(db, { target: "T1" }).filter((e) => e.kind === "decision")).toHaveLength(1);
});

test("missing specs retain a recoverable job; PM content added after a completed section is untouched", async () => {
  const a = await ask();
  rmSync(spec);
  expect(sweepAskDefaults(db, now + ASK_DEFAULT_MS)).toBe(0);
  expect(getAsk(db, a.id)).toMatchObject({ state: "answered", extra: { defaultAppend: "pending" } });
  writeFileSync(spec, original);
  expect(sweepAskDefaults(db, now + ASK_DEFAULT_MS + 1)).toBe(1);
  const written = readFileSync(spec, "utf8");
  appendFileSync(spec, "\n## PM 定\n用新版\n");
  patchAsk(db, a.id, { extra: { defaultAppend: "pending" } });
  expect(sweepAskDefaults(db, now + ASK_DEFAULT_MS + 2)).toBe(1);
  expect(readFileSync(spec, "utf8")).toBe(written + "\n## PM 定\n用新版\n");
});

test("notification failure does not park a default ask; retry reuses the registered ask and hands it to PM", async () => {
  const d = { ...deps(), notify: async () => { throw new Error("offline"); } };
  const r = await askOrder(who, wire, d);
  expect(r).toMatchObject({ ok: true, blocking: false, notified: false });
  const retry = await askOrder(who, wire, deps());
  expect(retry).toMatchObject({ ok: true, blocking: false, notified: true, duplicate: true });
  expect(listAsks(db)).toHaveLength(1);
});
