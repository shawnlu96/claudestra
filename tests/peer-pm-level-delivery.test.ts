/**
 * agents-PEERLEVEL1 投递：peer 标 info（接收侧只给已认证 peer 的 info 放 meta.pmLevel）发给当班 PM 时与本机 info 同走摘要，
 * 不调底层 send、能在摘要里读到；peer action / 缺省、收件人不是当班 PM（执行者、调度助理 inbox）照旧立即送。
 * 摘要收下的 peer info 不挂 pending（转交后挪到当班 PM 名下的那份也摘掉）；PM 转交后仍重核 API scope。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { deliverPmLocal } from "../src/bridge/local-api/project-pm-delivery.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { settleDigestedPeerInfo } from "../src/bridge/api-message-policy.js";
import { pmDigest } from "../src/bridge/pm-digest.js";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import { classifyPmPush } from "../src/lib/pm-digest.js";
import { classifyPmRoute } from "../src/lib/pm-route.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import type { PrincipalsFile } from "../src/lib/principals.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { A, B, D, P, pmFixture } from "./pm-role-fixture.test.js";

const fixtures: ReturnType<typeof pmFixture>[] = [], defaults = { ...pmDigest.deps };
afterEach(() => { pmDigest.stop(); Object.assign(pmDigest.deps, defaults); for (const f of fixtures.splice(0)) f.close(); });
const ws = { send: () => {} } as unknown as LocalEndpoint["ws"];
const BODY = "agents-T1 交付了，请看一下进度"; // 正文像要紧事：标 info 仍进摘要（与本机 info 一致），不标照旧立即送
let seq = 0;

type Level = "info" | "action" | undefined;
function peerEnv(level: Level, to: { agentName: string; channelId: string } = { agentName: A, channelId: "channel-a" }, content = BODY, peer = true): Envelope {
  return {
    from: { kind: "api", tokenId: "tok_peer", name: "remote", ...(peer ? { peer: "remote" } : {}) },
    to: { kind: "local", ...to, ws }, intent: "request", content,
    meta: { messageId: `api_${++seq}`, triggerKind: "system", ts: "2026-10-16T00:00:00Z", threadId: `thr-${seq}`, skipInterAgentWatchdog: true,
      ...(level ? { pmLevel: level } : {}) },
  };
}

interface Receipt { tokenId: string; agentChannelId: string; agentName: string; messageId?: string; threadId?: string }
async function world(o: { route?: "on" | "observe" | "off"; digest?: "on" | "observe" | "off"; redirect?: boolean; scope?: string[]; inbox?: boolean } = {}) {
  const f = pmFixture(); fixtures.push(f);
  if (o.redirect) await switchProjectPm(f.db, P, B, { actor: "owner" }, f.deps);
  const store = new PmDigestStore(join(f.dir, "pm-digest.json"), join(f.dir, "pm-digest-mode.json"));
  writeFileSync(store.modePath, JSON.stringify({ projects: { [P]: o.digest ?? "on" }, routeProjects: { [P]: o.route ?? "on" }, pullProjects: { [P]: "on" } }));
  const state = await f.deps.read();
  const clients = new Map([["channel-a", { ws }], ["channel-b", { ws }], ["channel-d", { ws }], ["channel-w", { ws }]]);
  const agents = [...state.agents, { name: "agent-exec", projectId: P, channelId: "channel-w", status: "active" }] as typeof state.agents;
  Object.assign(pmDigest.deps, { store, db: () => f.db, now: () => 1_000_000, agents: () => agents, heldCarriers: () => new Set() });
  const sent: { to: string | undefined; content: string }[] = [];
  const send = async (e: Envelope, to: LocalEndpoint): Promise<Delivery> => (sent.push({ to: to.agentName, content: e.content }), { envelope: e, outcome: { kind: "sent" } });
  const file: PrincipalsFile = { principals: [{ id: "token:tok_peer", role: "external", peer: "remote", agents: o.scope ?? [A, B, D, "agent-exec"], secret: "x", createdAt: "2026-01-01" }] };
  const receipts = new Map<string, Receipt[]>();
  const facts = { db: f.db, agents, principals: async () => file, principalsSync: () => file, peerInbox: () => !!o.inbox, online: (ch: string) => clients.has(ch) };
  const deliver = (e: Envelope) => deliverPmLocal(e, e.to as LocalEndpoint, clients, new AgentCallBook(null), receipts, send, facts);
  pmDigest.start({ clients, deliver }, false);
  /** 照 api-routes 的顺序：先挂 pending 再投，投完交给 settleDigestedPeerInfo */
  const post = async (e: Envelope) => {
    const to = e.to as LocalEndpoint, key = `tok_peer|${to.channelId}`;
    const entry: Receipt = { tokenId: "tok_peer", agentChannelId: to.channelId, agentName: to.agentName!, messageId: e.meta.messageId, threadId: e.meta.threadId };
    receipts.set(key, [...(receipts.get(key) ?? []), entry]);
    const delivery = await deliver(e);
    return { delivery, quiet: settleDigestedPeerInfo(delivery, receipts, entry) };
  };
  return { store, sent, receipts, post };
}

describe("[验收线 3] 分类器：只为 API 来源 + info 开口子", () => {
  const input = (level: Level, fromKind: "api" | "user" = "api") =>
    ({ fromKind, sender: "remote", intent: "request", triggerKind: "system", oneShot: true, body: BODY, ...(level ? { level } : {}) });
  test("api + info → 摘要；api + action / 缺省、user + info → 照旧立即送 / 受保护", () => {
    expect(classifyPmPush(input("info"))).toMatchObject({ send: "digest", reason: "发送方标 info", levelSource: "structured" });
    expect(classifyPmRoute(input("info"))).toEqual({ tags: [{ route: "digest", rule: "level.info", reason: "peer 标为常规：进摘要" }] });
    for (const m of [input("action"), input(undefined), input("info", "user")]) {
      expect(classifyPmPush(m)).toEqual({ send: "now", reason: "owner / 人类 / peer 的消息" });
      expect(classifyPmRoute(m)).toEqual({ tags: [{ route: "owner", rule: "protect.owner", reason: "人类或 peer 对话" }], immediate: true });
    }
  });
});

describe("[验收线 3] 投递：pull on，路由 on / observe", () => {
  for (const route of ["on", "observe"] as const) {
    test(`路由 ${route}：发给当班 PM 的 peer info 不调 send、摘要里读得到；action / 缺省照旧立即送`, async () => {
      const w = await world({ route });
      const info = await w.post(peerEnv("info"));
      expect(w.sent).toEqual([]);
      expect(info.delivery.outcome).toMatchObject({ kind: "sent", note: "digest" });
      expect(w.store.queued(P).map((e) => e.firstLine)).toEqual([BODY]);
      for (const level of ["action", undefined] as const) {
        const r = await w.post(peerEnv(level));
        expect(r.quiet).toBe(false);
        expect(w.sent.at(-1)).toEqual({ to: A, content: BODY });
      }
      expect(w.sent).toHaveLength(2);
      expect(w.store.queued(P)).toHaveLength(1);
    });
  }

  test("收件人不是当班 PM（执行者、调度助理 inbox）：peer info 照旧立即送", async () => {
    const w = await world({ inbox: true });
    await w.post(peerEnv("info", { agentName: "agent-exec", channelId: "channel-w" }));
    expect(w.sent.at(-1)).toEqual({ to: "agent-exec", content: BODY });
    const machine = "[Claudestra 调度器] agents-T1 进度"; // 机器消息 + peer inbox 开：转给调度助理
    await w.post(peerEnv("info", undefined, machine));
    expect(w.sent.at(-1)?.to).toBe(D);
    expect(w.sent).toHaveLength(2);
    expect(w.store.queued(P)).toEqual([]);
  });

  test("摘要开关 off / observe：peer info 照旧立即送（与本机 info 一致）", async () => {
    for (const digest of ["off", "observe"] as const) {
      const w = await world({ route: "observe", digest });
      const r = await w.post(peerEnv("info"));
      expect(r.quiet).toBe(false);
      expect(w.sent).toEqual([{ to: A, content: BODY }]);
    }
  });
});

describe("[验收线 4] 收尾：摘要收下不挂 pending；转交后仍重核 scope", () => {
  test("直接发给当班 PM：quiet，pending 摘掉；立即送的 action 留着", async () => {
    const w = await world();
    expect((await w.post(peerEnv("info"))).quiet).toBe(true);
    expect(w.receipts.get("tok_peer|channel-a")).toBeUndefined();
    expect((await w.post(peerEnv("action"))).quiet).toBe(false);
    expect(w.receipts.get("tok_peer|channel-a")).toHaveLength(1);
  });

  test("发给前任 PM、转交当班 PM 后进摘要：挪过去的 pending 也摘掉", async () => {
    const w = await world({ redirect: true });
    const r = await w.post(peerEnv("info"));
    expect(r.quiet).toBe(true);
    expect(w.sent).toEqual([]);
    expect([...w.receipts.values()].flat()).toEqual([]);
  });

  test("转交后 scope 不含当班 PM：照旧拒收（发拒收通知，不进摘要）", async () => {
    const w = await world({ redirect: true, scope: [A] });
    const r = await w.post(peerEnv("info"));
    expect(r.quiet).toBe(false);
    expect(r.delivery.outcome.kind).toBe("dropped");
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.content).toContain("被拒收");
    expect(w.store.queued(P)).toEqual([]);
  });

  test("非 peer 的 API 信封即便带了 info 也不算（settle 只认 from.peer）", () => {
    const e = peerEnv("info", undefined, BODY, false), entry = {}, pending = new Map([["k", [entry]]]);
    expect(settleDigestedPeerInfo({ envelope: e, outcome: { kind: "sent", note: "digest" } }, pending, entry)).toBe(false);
    expect(pending.get("k")).toEqual([entry]);
  });
});
