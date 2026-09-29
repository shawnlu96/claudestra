/**
 * 注入 setAskAssigneesOf（initHumanNode）后「待你处理」的权限矩阵，列表 / SSE / 推送 / 作答四处同一口径（T28a 第 1 轮审查写的矩阵）。
 * 凭据：owner 设备、assignee 本人（aa）、合并进 aa 的另一台（a2）、别的 guest（bb）、部分 scope 的 owner 设备、scoped 集成 token、
 * web-ui token、老的 "*" Bearer、peer。ask：human 节点开的指派（指给 local:guest:aa）、手工指给别名 local:guest:a2 的、agent 的 reply。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { answerFromCard } from "../src/bridge/ask-entry.js";
import { publishAsk, setAsksForTest, setOnAssignedAnswer, setPrepareAssigned, type AsksDeps } from "../src/bridge/asks.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import { initHumanNode } from "../src/bridge/human-node.js";
import { setLedgerFeedForTest, sseEventAllow } from "../src/bridge/ledger-feed.js";
import { handleAsksApi } from "../src/bridge/local-api/asks.js";
import { createDispatcher } from "../src/bridge/push/dispatcher.js";
import type { PushSender } from "../src/bridge/push/sender.js";
import { setTalkForTest, talkDb } from "../src/bridge/talk.js";
import { canAnswerAsk, canSeeAsk, humanAssignee, setAskAssigneesOf } from "../src/lib/ask-access.js";
import { listAsks, openAsk, type Ask } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import type { Principal } from "../src/lib/principals.js";
import { savePushSubscription, type PushSubscriber } from "../src/lib/push-store.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { ensureLocalPerson, mergePeople, unmergePerson } from "../src/lib/talk-people.js";
import { closeWebState, openWebState } from "../src/lib/web-state.js";
import { at, guest, LEGACY_STAR_TOKEN, owner, PEER } from "./asks-test-kit.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const PMCTX = { actor: "agent-pm" };
const AA = guest("aa");
const A2 = guest("a2");
const BB = guest("bb");
const WHO: Record<string, Principal> = {
  owner: owner(),
  assignee: AA,
  mergedDevice: A2,
  otherGuest: BB,
  scopedOwner: owner({ agents: ["agent-x"], terminal: false, manage: true }),
  scopedToken: { id: "token:tok_scoped", role: "external", name: "ci", agents: ["agent-x"], createdAt: at },
  webUi: { id: "token:tok_web", role: "owner", name: "web-ui", agents: ["*"], createdAt: at },
  legacyStar: LEGACY_STAR_TOKEN,
  peer: PEER,
};
const KINDS = ["assigned", "toAlias", "agent"] as const;
/** 看 / 答（按 KINDS 顺序） */
const MATRIX: Record<string, { see: string; answer: string }> = {
  owner: { see: "yyy", answer: "yyy" },
  assignee: { see: "yyn", answer: "yyn" },
  mergedDevice: { see: "yyn", answer: "yyn" },
  otherGuest: { see: "nnn", answer: "nnn" },
  scopedOwner: { see: "nnn", answer: "nnn" },
  scopedToken: { see: "nnn", answer: "nnn" },
  webUi: { see: "yyy", answer: "yyy" },
  legacyStar: { see: "yyy", answer: "nnn" },
  peer: { see: "nnn", answer: "nnn" },
};

let dir = "";
let path = "";
let db: Database;
let sent: string[] = [];
let stop = () => {};
const asks: Record<string, Ask> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rv-t28a-"));
  path = tempLedgerPath("rv-t28a-");
  db = openLedger(path);
  sent = [];
  const deps: AsksDeps = {
    clients: new Map([["222", { ws: { tag: "ws" } as never }]]),
    controlChannelId: "999",
    deliver: async (env) => (sent.push(env.content), { envelope: env, outcome: { kind: "sent" } }),
    hold: () => {},
  };
  setAsksForTest({ path, deps, registry: [{ name: "agent-pm", channelId: "222", status: "active", projectId: "p" } as RegistryAgent], ownerChats: ["api:owner:self"] });
  setLedgerFeedForTest({ path, emit: () => {} });
  setTalkForTest({ dbPath: join(dir, "talk.sqlite"), attDir: join(dir, "att"), fp: () => "aaaa-bbbb", principals: async () => ({ principals: [owner(), AA, A2, BB, WHO.webUi] }) });
  for (const p of ["guest:aa", "guest:a2", "guest:bb"]) ensureLocalPerson(talkDb(), p);
  mergePeople(talkDb(), "local:guest:a2", "local:guest:aa");
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, PMCTX, { project: "p", id: "T1", title: "t", kind: "code", assigneeKind: "human", assignee: "local:guest:aa", pm: "agent-pm" });
  moveStage(db, PMCTX, { taskId: "T1", from: "spec", to: "restate" });
  moveStage(db, PMCTX, { taskId: "T1", from: "restate", to: "build" });
  stop = initHumanNode();
  asks.assigned = listAsks(db, { assignee: "local:guest:aa" })[0];
  const btn = [{ type: "buttons", buttons: [{ id: "go", label: "好" }] }];
  asks.toAlias = openAsk(db, { project: "p", kind: "assigned", source: "human", createdBy: "owner:self", assignee: "local:guest:a2", title: "alias", options: btn } as never);
  asks.agent = openAsk(db, { project: "p", kind: "decide", source: "reply", fromAgent: "agent-x", fromChannelId: "111", title: "agent", options: btn } as never);
});
afterEach(() => {
  stop();
  setOnAssignedAnswer(null);
  setPrepareAssigned(null);
  setAskAssigneesOf((id) => [humanAssignee(id)]);
  setAsksForTest(undefined);
  setLedgerFeedForTest(undefined);
  setTalkForTest(undefined);
  closeLedger(path);
  rmSync(dir, { recursive: true, force: true });
});

const yn = (f: (k: (typeof KINDS)[number]) => boolean) => KINDS.map((k) => (f(k) ? "y" : "n")).join("");
const wire = (k: string) => (k === "assigned" ? "[button:assign_done]" : "[button:go]");

describe("注入后的矩阵（lib 判定）", () => {
  for (const [name, want] of Object.entries(MATRIX)) {
    test(`${name}: 看 ${want.see} / 答 ${want.answer}`, () => {
      expect(yn((k) => canSeeAsk(WHO[name], asks[k]))).toBe(want.see);
      expect(yn((k) => canAnswerAsk(WHO[name], asks[k]))).toBe(want.answer);
    });
  }
});

describe("四处同一口径", () => {
  test("列表：返回集合 = 看得见；canAnswer = 答的判定", async () => {
    for (const [name, p] of Object.entries(WHO)) {
      const res = (await handleAsksApi(new Request("http://x/api/v1/asks"), "/asks", p))!;
      if (res.status === 403) {
        expect([name, MATRIX[name].see]).toEqual([name, "nnn"]);
        continue;
      }
      const rows = ((await res.json()) as { asks: (Ask & { canAnswer: boolean })[] }).asks;
      expect([name, yn((k) => rows.some((r) => r.id === asks[k].id))]).toEqual([name, MATRIX[name].see]);
      for (const r of rows) expect([name, r.id, r.canAnswer]).toEqual([name, r.id, canAnswerAsk(p, r)]);
    }
  });

  test("SSE：收到的 ask 事件 = 看得见", () => {
    const got: BridgeEvent[] = [];
    const unsub = subscribeEvents({}, (e) => void (e.type === "ask" && got.push(e)));
    for (const k of KINDS) publishAsk(asks[k]);
    unsub();
    for (const [name, p] of Object.entries(WHO)) {
      const allow = sseEventAllow(p, ["ask"]);
      expect([name, yn((k) => got.some((e) => (e.data as { askId: string }).askId === asks[k].id && allow(e)))]).toEqual([name, MATRIX[name].see]);
    }
  });

  test("推送：指给 aa 的推到 aa 与合并设备 a2，不推 bb；指给别名 a2 的同样推到两台", async () => {
    const wsPath = join(dir, "web-state.sqlite");
    const wdb = openWebState(wsPath);
    const hits: string[] = [];
    const sender = {
      config: () => ({ webPush: { vapidPublicKey: "K" }, apns: false, mode: "direct" }),
      webPushKeys: () => ["K"],
      sendWebPush: async (s: { endpoint: string }) => (hits.push(s.endpoint.split("/").pop()!), { ok: true }),
      sendApns: async () => ({ ok: true }),
    } as unknown as PushSender;
    const subs: [string, PushSubscriber][] = [
      ["aa", { audience: "guest", principal: "guest:aa", credential: "dev_aa" }],
      ["a2", { audience: "guest", principal: "guest:a2", credential: "dev_a2" }],
      ["bb", { audience: "guest", principal: "guest:bb", credential: "dev_bb" }],
    ];
    for (const [n, who] of subs) savePushSubscription(wdb, { endpoint: `https://push.example/${n}`, keys: { p256dh: "p", auth: "a" } }, "Mac", "K", new Date(), who);
    const by: Record<string, Principal> = { dev_aa: AA, dev_a2: A2, dev_bb: BB };
    const d = createDispatcher({ db: wdb, sender, isOwnerChat: () => false, resolvePrincipal: (_p, c) => (c ? by[c] ?? null : null) });
    for (const k of ["assigned", "toAlias"] as const) {
      hits.length = 0;
      await d.onAsk({ ...asks[k], blocking: true }, "away");
      expect([k, hits.sort()]).toEqual([k, ["a2", "aa"]]);
    }
    d.stop();
    closeWebState(wsPath);
  });

  test("作答：看不见的一律 404（含别的 guest 按 id 答），看得见答不了的 403", async () => {
    for (const k of KINDS) {
      for (const [name, p] of Object.entries(WHO)) {
        if (MATRIX[name].answer[KINDS.indexOf(k)] === "y") continue;
        const r = await answerFromCard("p", asks[k].id, { choices: [wire(k)], text: "x" }, p);
        expect([k, name, r.status]).toEqual([k, name, canSeeAsk(p, asks[k]) ? 403 : 404]);
      }
    }
    expect(sent).toEqual([]);
    expect(getTask(db, "T1")!.stage).toBe("build");
  });
});

describe("能答的每一个真答一次（各自独立的库）", () => {
  for (const name of ["owner", "assignee", "mergedDevice", "webUi"]) {
    test(`${name} 在指派上点完成 → 202、到 review、PM 只收固定模板`, async () => {
      const r = await answerFromCard("p", asks.assigned.id, { choices: ["[button:assign_done]"], text: "秘密说明 SECRET-XYZ" }, WHO[name]);
      expect(r.status).toBe(202);
      expect(getTask(db, "T1")!.stage).toBe("review");
      expect(sent).toEqual(["[台账] T1 指派给 local:guest:aa 的事项已完成，已推到 review。"]);
      expect(sent.join("\n")).not.toContain("SECRET");
    });
  }
});

describe("没注入 / 撤销合并", () => {
  test("恢复默认注入 = main 的口径：只认 local:<本人>，合并设备 a2 看不见 aa 的指派", () => {
    setAskAssigneesOf((id) => [humanAssignee(id)]);
    expect(canSeeAsk(A2, asks.assigned)).toBe(false);
    expect(canSeeAsk(AA, asks.toAlias)).toBe(false);
    expect(canSeeAsk(AA, asks.assigned)).toBe(true);
  });

  test("拆开合并后立刻失去对方的指派", async () => {
    unmergePerson(talkDb(), "local:guest:a2");
    expect(canSeeAsk(A2, asks.assigned)).toBe(false);
    expect((await answerFromCard("p", asks.assigned.id, { choices: ["[button:assign_done]"] }, A2)).status).toBe(404);
  });

  test("停用的合并设备什么都看不见", () => {
    const off = { ...A2, disabled: true };
    expect(canSeeAsk(off, asks.assigned) || canAnswerAsk(off, asks.assigned)).toBe(false);
  });
});
