/**
 * 「待你处理」权限矩阵（T11b 验收第 1 条）：lib/ask-access.ts 的看 / 答，逐个凭据 × 逐类 ask；再断言列表（local-api/asks.ts）、
 * SSE（ledger-feed.ts sseEventAllow）、推送（push/dispatcher.ts onAsk）、卡片作答（ask-entry.ts）四处和它一致——同一张表驱动。
 * 凭据：owner 设备（不含 / 含 master）、assignee 本人的 guest、别的 guest、部分 scope 的 owner 设备、web-ui token、老的「*」Bearer、peer。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerFromCard } from "../src/bridge/ask-entry.js";
import { publishAsk, setAsksForTest } from "../src/bridge/asks.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import { setLedgerFeedForTest, sseEventAllow } from "../src/bridge/ledger-feed.js";
import { handleAsksApi } from "../src/bridge/local-api/asks.js";
import { createDispatcher } from "../src/bridge/push/dispatcher.js";
import type { PushSender } from "../src/bridge/push/sender.js";
import { canAnswerAsk, canSeeAsk } from "../src/lib/ask-access.js";
import { openAsk, type Ask, type NewAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { Principal } from "../src/lib/principals.js";
import { saveApnsDevice, savePushSubscription, type PushSubscriber } from "../src/lib/push-store.js";
import { closeWebState, openWebState } from "../src/lib/web-state.js";
import { at, guest, LEGACY_STAR_TOKEN, owner, ownerWithMaster, PEER } from "./asks-test-kit.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const G1 = guest("aa11");
const WEB_UI: Principal = { id: "token:tok_web", role: "owner", name: "web-ui", agents: ["*"], createdAt: at };
const WHO: Record<string, Principal> = {
  owner: owner(),
  ownerMaster: ownerWithMaster(),
  assigneeGuest: G1,
  otherGuest: guest("bb22"),
  scopedOwner: owner({ agents: ["agent-x"], terminal: false, manage: true }),
  webUi: WEB_UI,
  legacyStar: LEGACY_STAR_TOKEN,
  peer: PEER,
};

/** 四类 ask：agent 发的、大总管发的、人发起指给 G1 的指派事项、agent 发但指给 G1 的 */
const KINDS: Record<string, Partial<NewAsk>> = {
  agent: { fromAgent: "agent-x", fromChannelId: "111", source: "reply" },
  master: { fromAgent: "master", fromChannelId: "999", source: "reply", project: "master" },
  assigned: { source: "human", createdBy: "owner:self", kind: "assigned", assignee: "local:guest:aa11", taskId: "T1" },
  agentToGuest: { fromAgent: "agent-x", fromChannelId: "111", source: "reply", assignee: "local:guest:aa11" },
};

/** 期望：看 / 答（按上面 KINDS 的顺序）。y = 能，n = 不能 */
const MATRIX: Record<string, { see: string; answer: string }> = {
  owner: { see: "ynyy", answer: "ynyy" },
  ownerMaster: { see: "yyyy", answer: "yyyy" },
  assigneeGuest: { see: "nnyy", answer: "nnyy" },
  otherGuest: { see: "nnnn", answer: "nnnn" },
  scopedOwner: { see: "nnnn", answer: "nnnn" },
  webUi: { see: "ynyy", answer: "ynyy" },
  legacyStar: { see: "ynyy", answer: "nnnn" },
  peer: { see: "nnnn", answer: "nnnn" },
};

let path = "";
const asks: Record<string, Ask> = {};
beforeAll(() => {
  path = tempLedgerPath("ask-access-");
  const db = openLedger(path);
  for (const [k, v] of Object.entries(KINDS)) asks[k] = openAsk(db, { project: "p", kind: "decide", title: k, options: [{ type: "buttons", buttons: [{ id: "go", label: "好" }] }], ...v } as NewAsk);
  setAsksForTest({
    path, registry: [], ownerChats: ["api:owner:self"],
    deps: { clients: new Map(), controlChannelId: "999", deliver: async (env) => ({ envelope: env, outcome: { kind: "sent" } }), hold: () => {} },
  });
  setLedgerFeedForTest({ path, emit: () => {} });
});
afterAll(() => {
  setAsksForTest(undefined);
  setLedgerFeedForTest(undefined);
  closeLedger(path);
});

const kinds = Object.keys(KINDS);
const yn = (f: (k: string) => boolean) => kinds.map((k) => (f(k) ? "y" : "n")).join("");

describe("lib/ask-access.ts 的矩阵", () => {
  for (const [name, want] of Object.entries(MATRIX)) {
    test(`${name}：看 ${want.see} / 答 ${want.answer}`, () => {
      expect(yn((k) => canSeeAsk(WHO[name], asks[k]))).toBe(want.see);
      expect(yn((k) => canAnswerAsk(WHO[name], asks[k]))).toBe(want.answer);
    });
  }
});

test("大总管的两种写法（master / agent-master）都要 scope 含 master 才看得见（adv2 附带）", () => {
  const viaKey = { fromAgent: "agent-master", assignee: null };
  expect([canSeeAsk(WHO.owner, viaKey), canSeeAsk(WHO.webUi, viaKey), canSeeAsk(WHO.ownerMaster, viaKey)]).toEqual([false, false, true]);
});

describe("四处同一口径", () => {
  test("列表：GET /asks 给的正好是看得见的，每行 canAnswer 和答的判定一致；读不了台账又不是设备凭据的整个 403", async () => {
    for (const [name, p] of Object.entries(WHO)) {
      const res = (await handleAsksApi(new Request("http://x/api/v1/asks"), "/asks", p))!;
      if (MATRIX[name].see === "nnnn" && !p.credential) {
        expect(res.status).toBe(403);
        continue;
      }
      const rows = ((await res.json()) as { asks: (Ask & { canAnswer: boolean })[] }).asks;
      expect(yn((k) => rows.some((r) => r.id === asks[k].id))).toBe(MATRIX[name].see);
      for (const r of rows) expect(r.canAnswer).toBe(canAnswerAsk(p, r));
    }
  });

  test("SSE：publishAsk 发出的 ask 事件，每个凭据的 /events 过滤收到的正好是看得见的", () => {
    const got: BridgeEvent[] = [];
    const unsub = subscribeEvents({}, (e) => void (e.type === "ask" && got.push(e)));
    for (const k of kinds) publishAsk(asks[k]);
    unsub();
    for (const [name, p] of Object.entries(WHO)) {
      const allow = sseEventAllow(p, ["ask"]);
      expect(yn((k) => got.some((e) => (e.data as { askId: string }).askId === asks[k].id && allow(e)))).toBe(MATRIX[name].see);
    }
  });

  test("推送：每条 ask 推到的订阅，订阅者都看得见它（owner 那一路按订阅时的凭据收窄；guest 只收指给自己的）", async () => {
    // 自己的临时文件：":memory:" 是进程内共享的缓存连接，别的测试文件也在用
    const wsPath = join(mkdtempSync(join(tmpdir(), "ask-access-push-")), "web-state.sqlite");
    const db = openWebState(wsPath);
    const sent: { endpoint: string }[] = [];
    const apns: string[] = [];
    const sender = {
      config: () => ({ webPush: { vapidPublicKey: "K" }, apns: true, mode: "direct" }),
      webPushKeys: () => ["K"],
      sendWebPush: async (s: { endpoint: string }) => (sent.push({ endpoint: s.endpoint }), { ok: true }),
      sendApns: async (token: string) => (apns.push(token), { ok: true }),
    } as unknown as PushSender;
    // 订阅者：能过推送路由的才有订阅（peer 不行）；canManage 的记 owner，其余设备记 guest（push/routes.ts）
    const subs: [string, PushSubscriber][] = [
      ["owner", { audience: "owner", principal: "owner:self", credential: "dev_1" }],
      ["scopedOwner", { audience: "owner", principal: "owner:self", credential: "dev_scoped" }],
      ["assigneeGuest", { audience: "guest", principal: "guest:aa11", credential: "dev_aa11" }],
      ["otherGuest", { audience: "guest", principal: "guest:bb22", credential: "dev_bb22" }],
    ];
    for (const [name, who] of subs) savePushSubscription(db, { endpoint: `https://push.example/${name}`, keys: { p256dh: "p", auth: "a" } }, "Mac", "K", new Date(), who);
    // APNs（owner 的 App）同一个判定：按登记时的凭据收窄；凭据撤了的什么都不推；老行没记 principal 的按 owner:self
    const devices: [string, PushSubscriber | undefined][] = [
      ["owner", subs[0][1]], ["scopedowner", subs[1][1]], ["revoked", { audience: "owner", principal: "owner:self", credential: "dev_gone" }], ["legacy", undefined],
    ];
    for (const [name, who] of devices) saveApnsDevice(db, name, "iPhone", new Date(), who);
    const apnsWho: Record<string, Principal> = { owner: WHO.owner, scopedowner: WHO.scopedOwner, legacy: WHO.ownerMaster };
    const byCredential: Record<string, Principal> = { dev_1: WHO.owner, dev_scoped: WHO.scopedOwner, dev_aa11: G1, dev_bb22: WHO.otherGuest };
    const d = createDispatcher({ db, sender, isOwnerChat: () => false, resolvePrincipal: (_pid, cid) => (cid ? byCredential[cid] ?? null : null) });
    for (const k of kinds) {
      sent.length = 0;
      apns.length = 0;
      await d.onAsk({ ...asks[k], blocking: true }, "away");
      for (const n of apns) expect(canSeeAsk(apnsWho[n], asks[k])).toBe(true);
      expect(apns).not.toContain("revoked");
      const names = sent.map((s) => s.endpoint.split("/").pop()!);
      for (const n of names) expect(canSeeAsk(WHO[n], asks[k])).toBe(true);
      // 指给 G1 的一定推到 G1；别的 guest 一条也收不到
      if (asks[k].assignee) expect(names).toContain("assigneeGuest");
      expect(names).not.toContain("otherGuest");
      // owner 自己一定收到（卡活 + 不在）；部分 scope 的 owner 设备看不见就收不到
      if (k === "agent") expect([names.sort(), apns.sort()]).toEqual([["owner"], ["legacy", "owner"]]);
      if (k === "master") expect(apns).toEqual(["legacy"]); // 部分 scope 的 owner 设备收不到大总管的
    }
    d.stop();
    closeWebState(wsPath);
  });

  test("卡片作答：答得了的才 202，看不见的 404、看得见答不了的 403", async () => {
    for (const k of ["agent", "master"]) {
      for (const [name, p] of Object.entries(WHO)) {
        if (MATRIX[name].answer[kinds.indexOf(k)] === "y") continue; // 能答的在 asks-v2 里另测（答一次就结案了）
        const r = await answerFromCard(asks[k].project, asks[k].id, { choices: ["[button:go]"] }, p);
        expect(r.status).toBe(canSeeAsk(p, asks[k]) ? 403 : 404);
      }
    }
  });
});

test("被禁用的 principal 什么都看不见、答不了（纵深防御，adv1 P2-7）", () => {
  for (const p of [{ ...WHO.owner, disabled: true }, { ...G1, disabled: true }]) expect(kinds.some((k) => canSeeAsk(p, asks[k]) || canAnswerAsk(p, asks[k]))).toBe(false);
});

test("矩阵表自己不自相矛盾：答得了的一定看得见", () => {
  for (const want of Object.values(MATRIX)) for (let i = 0; i < kinds.length; i++) if (want.answer[i] === "y") expect(want.see[i]).toBe("y");
});
