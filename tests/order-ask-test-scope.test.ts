/**
 * i28-ASK4：远端出借写单上的测试类扩围提问（files 全在 tests/、reason 合法）15 分钟没回自动批准——规格追加「自动定」、卡的 fileGlobs
 * 追加这些文件、结论发给执行者；有非测试文件 / 没填 / PM 先答了都不定。wire 新字段可选、旧报文照常解析；给 PM 的提问通知 check_inbox 领得到。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { tellAsker } from "../src/bridge/ask-default-tell.js";
import { HeldQueue, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { answerAsk, getAsk, openAskFull, patchAsk, type Ask } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { parseV2Request } from "../src/lib/lend-wire-v2.js";
import { openOrderAsk, type AskDeps } from "../src/lib/order-ask.js";
import { ASK_DEFAULT_MS, isTestScopeAsk, recordDefaultPmReply, sweepAskDefaults } from "../src/lib/order-ask-default.js";
import { standardAnswers } from "../src/lib/order-standard-answers.js";
import { parseAskWire } from "../src/lib/order-wire.js";

let db: Database, dir: string, dbPath: string, spec: string;
let told: { id: string; text: string }[];
let tellOk: boolean;
const now = 1_000_000;
const original = "# 原规格\n";
const due = now + ASK_DEFAULT_MS;
const deps = (): Omit<AskDeps, "db"> => ({ open: (x) => openAskFull(db, x, now), notify: async () => ({ handed: true, note: "queued" }),
  markHanded: (id) => patchAsk(db, id, { extra: { notice: "handed" } }), record: (ctx, x) => void appendEvent(db, ctx, x) });
const tell = async (a: Ask, text: string) => (told.push({ id: a.id, text }), tellOk);
const globs = () => getTask(db, "T1")!.extra.fileGlobs;

async function remoteAsk(q: Record<string, unknown> = {}, orderId = "pool"): Promise<Ask> {
  const r = await openOrderAsk(db, deps(), { task: getTask(db, "T1")!, orderId, from: "worker@peer", keyPrefix: "lend-ask:g1" },
    { question: "tests/a.test.ts 第 3 条断言被本规格替代，申请加进范围", options: [], files: ["tests/a.test.ts", "tests/b.test.ts"], reason: "superseded_assertion", ...q } as never);
  if (!("askId" in r)) throw new Error(JSON.stringify(r));
  return getAsk(db, r.askId)!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ask-scope-")); dbPath = join(dir, "ledger.db"); spec = join(dir, "T1.md");
  writeFileSync(spec, original); db = openLedger(dbPath); told = []; tellOk = true;
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "扩围", kind: "code", agent: "agent-author", pm: "agent-pm", spec });
  setTask(db, { actor: "owner" }, { id: "T1", rev: getTask(db, "T1")!.rev, patch: { extra: { fileGlobs: ["src/lib/x*.ts", "tests/b.test.ts"], keep: 1 } } });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
  db.run("DROP TABLE IF EXISTS lend_orders");
  db.run("CREATE TABLE lend_orders (orderId TEXT PRIMARY KEY, step TEXT)");
  db.run("INSERT INTO lend_orders (orderId, step) VALUES ('pool', 'write'), ('rv', 'review'), ('fx', 'fix')");
});
afterEach(() => { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });

describe("测试类扩围自动定", () => {
  test("15 分钟后批准：规格追加「自动定」、fileGlobs 追加（不重复、其余 extra 不动）、执行者收到结论；重复扫描不重复", async () => {
    const a = await remoteAsk();
    expect(a.blocking).toBeNull(); // 远端写单照旧等回复，只是到点自动定
    expect(a.extra).toMatchObject({ files: ["tests/a.test.ts", "tests/b.test.ts"], reason: "superseded_assertion", class: "blocker" });
    expect(await sweepAskDefaults(db, due - 1, { tell })).toBe(0);
    expect(getAsk(db, a.id)!.state).toBe("open");
    expect(await sweepAskDefaults(db, due, { tell })).toBe(1);
    expect(getAsk(db, a.id)).toMatchObject({ state: "answered", answer: { text: "测试类扩围自动批准（文件全在 tests/）" } });
    expect(globs()).toEqual(["src/lib/x*.ts", "tests/b.test.ts", "tests/a.test.ts"]);
    expect(getTask(db, "T1")!.extra.keep).toBe(1);
    const text = readFileSync(spec, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("## 自动定（");
    expect(text).toContain("- `tests/a.test.ts`");
    expect(text).toContain("被本规格替代的旧断言");
    expect(text).toContain("以上文件已追加进本卡 fileGlobs");
    expect(told).toHaveLength(1);
    expect(told[0].text).toContain(`ask ${a.id}`);
    expect(told[0].text).toContain("tests/a.test.ts、tests/b.test.ts");
    expect(getAsk(db, a.id)!.extra.tell).toBe("told");
    await sweepAskDefaults(db, due + ASK_DEFAULT_MS, { tell });
    expect(readFileSync(spec, "utf8")).toBe(text);
    expect(told).toHaveLength(1);
    expect(globs()).toEqual(["src/lib/x*.ts", "tests/b.test.ts", "tests/a.test.ts"]);
  });

  test("new_test 理由、fix 单、执行者标 scope 也算", async () => {
    const a = await remoteAsk({ reason: "new_test", class: "scope", default: "加", files: ["tests/new.test.ts"] }, "fx");
    expect(isTestScopeAsk(db, a)).toBe(true);
    await sweepAskDefaults(db, due, { tell });
    expect(getAsk(db, a.id)!.state).toBe("answered");
    expect(readFileSync(spec, "utf8")).toContain("为本卡新行为补测试");
  });

  test("不自动定：有非测试文件、没填 files / reason、审查单、本机的单", async () => {
    const mixed = await remoteAsk({ files: ["tests/a.test.ts", "src/lib/order-ask.ts"], question: "q1" });
    const bare = await remoteAsk({ files: undefined, reason: undefined, question: "q2" });
    const local = await remoteAsk({ question: "q3" }, "local-order");
    for (const a of [mixed, bare, local]) expect(isTestScopeAsk(db, a)).toBe(false);
    await sweepAskDefaults(db, due * 2, { tell });
    for (const a of [mixed, bare, local]) expect(getAsk(db, a.id)!.state).toBe("open");
    expect(globs()).toEqual(["src/lib/x*.ts", "tests/b.test.ts"]);
    expect(readFileSync(spec, "utf8")).toBe(original);
    expect(told).toEqual([]);
    // 审查单上的提问当场回规则，不开 ask
    const r = await openOrderAsk(db, deps(), { task: getTask(db, "T1")!, orderId: "rv", from: "worker@peer", keyPrefix: "x" },
      { question: "q4", options: [], files: ["tests/a.test.ts"], reason: "new_test" } as never);
    expect("answered" in r).toBe(true);
  });

  test("PM 15 分钟内答过不自动定：send_to_agent 回 worker@peer 带 ask id，或网页卡片作答", async () => {
    const viaMsg = await remoteAsk({ question: "q1" });
    const viaWeb = await remoteAsk({ question: "q2" });
    const pm = { verified: true, agent: "agent-pm" };
    expect(recordDefaultPmReply(() => db, { verified: true, agent: "agent-other" }, "worker@peer", `ask ${viaMsg.id} 不行`, now + 1)).toEqual([]);
    expect(recordDefaultPmReply(() => db, pm, "worker@peer", `ask ${viaMsg.id} 别改这个文件`, now + 1)).toEqual([viaMsg.id]);
    answerAsk(db, viaWeb.id, { choices: [], labels: ["不批"], text: "不批", principal: "owner", via: "web_card", at: now + 2, final: true });
    await sweepAskDefaults(db, due, { tell });
    expect(getAsk(db, viaMsg.id)!.answer?.labels).toEqual(["PM 已回复"]);
    expect(getAsk(db, viaWeb.id)!.answer?.text).toBe("不批");
    expect(globs()).toEqual(["src/lib/x*.ts", "tests/b.test.ts"]);
    expect(readFileSync(spec, "utf8")).toBe(original);
    expect(told).toEqual([]);
  });

  test("结论没发出去下次扫描重发，连续 10 次失败停下并在卡上记 note", async () => {
    tellOk = false;
    const a = await remoteAsk();
    for (let i = 0; i < 12; i++) await sweepAskDefaults(db, due + i * 60_000, { tell });
    expect(told).toHaveLength(10);
    expect(getAsk(db, a.id)!.extra).toMatchObject({ tell: "failed", tellTries: 10 });
    expect(listEvents(db, { project: "p" }).some((e) => e.data.op === "ask_default_tell_failed")).toBe(true);
  });
});

describe("wire", () => {
  test("parseAskWire：files / reason 可选、要一起给；路径不许通配、..、绝对路径", () => {
    const base = { v: 1, orderId: "o", question: "q" };
    expect(parseAskWire(base)).toMatchObject({ ok: true });
    expect(parseAskWire({ ...base, files: ["tests/a.test.ts", "tests/a.test.ts"], reason: "new_test" }))
      .toMatchObject({ ok: true, value: { files: ["tests/a.test.ts"], reason: "new_test" } });
    for (const bad of [{ files: ["tests/a.ts"] }, { reason: "new_test" }, { files: ["tests/a.ts"], reason: "x" }, { files: [], reason: "new_test" },
      { files: ["tests/../src/a.ts"], reason: "new_test" }, { files: ["tests/*.ts"], reason: "new_test" }, { files: ["/etc/x"], reason: "new_test" }]) {
      expect(parseAskWire({ ...base, ...bad }).ok).toBe(false);
    }
  });

  test("lend/ask：不带新字段的旧报文照常解析；带了就原样带过去", () => {
    const old = { v: 1 as const, orderId: "T1:write:r0", gen: 1, question: "q", options: [] as string[] };
    const r0 = parseV2Request("ask", old);
    expect(r0.ok && r0.value).toEqual({ ...old });
    const r1 = parseV2Request("ask", { ...old, files: ["tests/a.test.ts"], reason: "superseded_assertion" });
    expect(r1.ok && r1.value).toMatchObject({ files: ["tests/a.test.ts"], reason: "superseded_assertion" });
    expect(parseV2Request("ask", { ...old, files: ["tests/a.test.ts"] }).ok).toBe(false);
  });

  test("派单模板告诉执行者测试类扩围填 files / reason 会自动批准", () => {
    const s = standardAnswers("author");
    expect(s).toContain("files");
    expect(s).toContain("reason=superseded_assertion / new_test");
    expect(s).toContain("自动批准");
  });
});

describe("结论发给远端执行者（ask-default-tell）", () => {
  test("worker@peer 发到对方 agent 的 messages，只要回执；本机执行者不发；peer 不在 = 没发出去", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => (calls.push({ url, body: String(init.body) }), new Response("{}", { status: 202 }))) as unknown as typeof fetch;
    const peer = { name: "peer", baseUrl: "http://peer.test/", outToken: "tok" } as never;
    const a = { fromAgent: "worker@peer" } as Ask;
    expect(await tellAsker(a, "结论", { findPeer: async () => peer, fetchImpl })).toBe(true);
    expect(calls[0].url).toBe("http://peer.test/api/v1/agents/worker/messages");
    expect(JSON.parse(calls[0].body)).toMatchObject({ text: "结论", wait: 0 });
    expect(await tellAsker({ fromAgent: "agent-local" } as Ask, "x", { findPeer: async () => peer, fetchImpl })).toBe(true);
    expect(await tellAsker(a, "x", { findPeer: async () => null, fetchImpl })).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("check_inbox 领给 PM 的执行者提问通知", () => {
  const me = { tag: "ws" } as never;
  const to = { kind: "local", agentName: "agent-pm", channelId: "c-pm", ws: me } as LocalEndpoint;
  const mk = (content: string, from: Envelope["from"], messageId: string, triggerKind = "agent_tool"): HeldItem =>
    ({ env: { from, to, intent: "notification", content, meta: { messageId, triggerKind, ts: "2026-10-02T00:00:00Z", threadId: `t-${content}` } } as Envelope, to, heldAt: 0 });

  test("PM 回合中押着的 ledger-ask 通知领得到、排批首；其它 bridge 通知仍不领", async () => {
    const held = new HeldQueue(null);
    held.set("c-pm", [
      mk("同事消息", { kind: "local", agentName: "agent-codex", channelId: "c-codex", ws: me }, "m-a1"),
      mk("其它台账通知", { kind: "bridge", label: "ledger" }, "ask-default-failed:ask_x", "bridge_synth"),
      mk("【执行者提问】C6", { kind: "bridge", label: "ledger" }, "ledger-ask:ask_abc123", "bridge_synth"),
    ]);
    initInbox({ clients: new Map([["c-pm", { ws: me }]]), held, calls: new AgentCallBook(null), render: async (env) => String(env.content), emitIn: () => {} });
    const r = await takeInbox(me, 60_000);
    if ("error" in r) throw new Error(r.error);
    expect(r.result.n).toBe(2);
    const order = [...r.result.text.matchAll(/message_id=(\S+)/g)].map((m) => m[1]);
    expect(order).toEqual(["ledger-ask:ask_abc123", "m-a1"]);
    expect(r.result.text).toContain("来自 台账（执行者提问） · message_id=ledger-ask:ask_abc123 · 排队 1 分钟 ──\n【执行者提问】C6");
    expect(r.result.text).not.toContain("其它台账通知");
    expect(held.get("c-pm")!.find((i) => i.env.meta.messageId === "ledger-ask:ask_abc123")!.lease).toBeDefined(); // 租约中 Stop 不再投
  });
});
