/**
 * i28-ASK1：审查单上的 ask 不转 PM——不开 ask、不发通知，当场回分级规则，卡上记一条 note（含问题原文）。
 * 本机：take_review 的单（slotByOrderId 认）；远端：lend_orders.step = review 的单，在本机判。写单 / 修复单照旧（tests/order-ask.test.ts、order-executor.test.ts）。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listAsks, openAskFull, patchAsk } from "../src/lib/ledger-asks.js";
import type { WriteCtx } from "../src/lib/ledger-checks.js";
import { remoteCaller, type RemoteCaller } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { appendEvent, createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { askOrder, openOrderAsk } from "../src/lib/order-ask.js";
import { REVIEW_ASK_REPLY } from "../src/lib/order-standard-answers.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H = "a".repeat(40);
const OWNER = { actor: "owner", now: 1_000 };
let db: Database;
let sent: string[];
let now: number;
const dir = mkdtempSync(join(tmpdir(), "order-ask-review-"));

const askDeps = () => ({
  db,
  open: (input: Parameters<typeof openAskFull>[1]) => openAskFull(db, input, now),
  notify: async (to: string) => (sent.push(to), { handed: true, note: "delivered" }),
  markHanded: (id: string) => void patchAsk(db, id, { extra: { notice: "handed" } }),
  record: (ctx: WriteCtx, input: Parameters<typeof appendEvent>[2]) => void appendEvent(db, ctx, input),
});
const notes = (taskId: string) => listEvents(db, { project: P, target: taskId }).filter((e) => e.kind === "note" && e.data.op === "review_ask");
const Y: VerifiedCall = { agent: "agent-y", sessionId: "sy", family: "codex", channelId: "ch-y" };
const X: VerifiedCall = { agent: "agent-x", sessionId: "sx", family: "claude-code", channelId: "ch-x" };

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  sent = [];
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

describe("本机审查单（take_review）", () => {
  beforeEach(() => {
    createTask(db, OWNER, { project: P, id: "T60", title: "卡", kind: "code" });
    setTask(db, OWNER, { id: "T60", rev: 1, patch: { agent: "agent-x" } });
    db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T60'`);
    assignStep(db, { actor: "agent-pm", now: 1_300 }, { taskId: "T60", step: "review", executor: "agent-y", executorKind: "agent", round: 1 });
  });

  test("当场回规则：不开 ask、不发通知；卡上一条 note 带问题原文；同一问题重试只记一条", async () => {
    const q = { v: 1, orderId: "T60:review:r1", question: "这条算 P1 吗？\n验收线以外的", options: ["P1", "P2"] };
    const r = await askOrder(Y, q, askDeps());
    expect(r).toEqual({ ok: true, answered: REVIEW_ASK_REPLY });
    expect(listAsks(db, {})).toEqual([]);
    expect(sent).toEqual([]);
    const [n] = notes("T60");
    expect(n).toMatchObject({ actor: "agent-y", text: expect.stringContaining("T60 审查员提问：这条算 P1 吗？"),
      data: { orderId: "T60:review:r1", from: "agent-y", question: q.question, options: ["P1", "P2"] } });
    expect(await askOrder(Y, q, askDeps())).toEqual({ ok: true, answered: REVIEW_ASK_REPLY });
    expect(notes("T60").length).toBe(1);
  });

  test("不是这一步审查员的，照旧拒 not_current_order，什么都不记", async () => {
    const r = await askOrder(X, { v: 1, orderId: "T60:review:r1", question: "我能问吗？", options: [] }, askDeps());
    expect(r).toMatchObject({ ok: false, code: "not_current_order" });
    expect(notes("T60")).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("出借池审查单（远端）", () => {
  const ldeps = (actor: string) => ({
    db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
    lend: {
      borrow: async () => [{ peer: "mate", projects: [P], roles: ["review" as const], maxOpen: 3 }], notifyPm: async () => {},
      result: { reportDir: () => dir, writeReport: () => {}, sign: () => null, peerFp: async () => null },
    },
  });
  const run = (args: string[], actor = "agent-pm") => runLedger(args, ldeps(actor)) as Promise<Record<string, any>>;
  let orderId: string;

  beforeEach(async () => {
    const spec = join(dir, "T9.md");
    writeFileSync(spec, "T9 的规格");
    createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "出借这一张", kind: "code", spec, pm: "agent-pm" });
    db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T9'`);
    orderId = (await run(["lend-offer", "T9", "--peer", "mate", "--repo", "o/r", "--pr", "3"])).orderId;
    expect((await run(["lend-claim", "--", "mate", JSON.stringify({ v: 1, orderId, worker: "agent-lend-0123456789" })], "owner")).ok).toBe(true);
  });

  test("按 lend_orders.step 在本机判：当场回规则，不开 ask、不发通知，卡上记 note（提问人 worker@peer）", async () => {
    const who = remoteCaller(db, "mate", { orderId, gen: 1 }, now) as RemoteCaller;
    const r = await openOrderAsk(db, askDeps(), { task: getTask(db, "T9")!, orderId, from: `${who.worker}@${who.peer}`, keyPrefix: "lend-ask:g1" },
      { question: "截图没有，怎么审？", options: [] });
    expect(r).toEqual({ answered: REVIEW_ASK_REPLY });
    expect(listAsks(db, {})).toEqual([]);
    expect(sent).toEqual([]);
    expect(notes("T9")).toMatchObject([{ actor: "agent-lend-0123456789@mate", data: { orderId, question: "截图没有，怎么审？" } }]);
  });
});
