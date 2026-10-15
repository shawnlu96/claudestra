/**
 * DPR-1：peer 机器消息经开关先投调度助理（lib/peer-inbox-route.ts + bridge/local-api/project-pm-delivery.ts）。
 * 验收线编号对应规格卡 ledger/docs/tasks/DPR-1.md。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isMachinePeerText, peerInboxDispatcher, peerInboxHeader, PEER_MACHINE_PREFIXES, type PeerInboxInput } from "../src/lib/peer-inbox-route.js";
import { renderBouncePush, renderDriftPush, renderMergedPush, renderReviewPush } from "../src/lib/peer-pr-message.js";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { deliverPmLocal, pmRoleRoute } from "../src/bridge/local-api/project-pm-delivery.js";
import { stageApiReplyFiles } from "../src/bridge/api-reply-files.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { LedgerCli } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { pmDigestCmds } from "../src/manager/pm-digest-cmds.js";
import type { PrincipalsFile } from "../src/lib/principals.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { A, B, D, P, pmFixture } from "./pm-role-fixture.test.js";

const MERGED = renderMergedPush(12, "0123456789abcdef0123", "agent-alpha@remote");

describe("机器抬头判定与转交条件（纯函数）", () => {
  test("对方调度器的各类推送、【自动定】算机器消息；真人写的、正文中间引用的不算", () => {
    const counts = { verdict: "changes", p0: 0, p1: 1, p2: 0, round: 2 };
    for (const text of [MERGED, renderDriftPush(3, "a".repeat(40), "b".repeat(40), "x@y"),
      renderBouncePush(4, { cause: "conflict", prHead: "c".repeat(40), checks: [] }, "x@y"),
      renderReviewPush({ number: 5, taskId: "T1", head: "d".repeat(40), counts, maxRounds: 8, replyTo: "x@y", report: "r", masked: 0 })]) {
      expect(isMachinePeerText(text)).toBe(true);
    }
    // order-ask-default 的【自动定】句子没导出构造函数：按源码核它仍以这个前缀开头
    expect(readFileSync(join(import.meta.dir, "../src/lib/order-ask-default.ts"), "utf8")).toContain(`\`${PEER_MACHINE_PREFIXES[1]}\${a.taskId}`);
    expect(isMachinePeerText("【自动定】T1 你的提问 PM 15 分钟没回")).toBe(true);
    expect(isMachinePeerText("PR #12 能合吗？")).toBe(false);
    expect(isMachinePeerText(`帮我看下这条：\n${MERGED}`)).toBe(false);
  });

  const base: PeerInboxInput = { on: true, peer: "remote", intent: "request", pushback: false, human: false, body: MERGED, recipient: A, activePm: A, dispatcher: D };
  test("全部满足才转；任何一条不满足都留给当班 PM", () => {
    expect(peerInboxDispatcher(base)).toBe(D);
    for (const over of [{ on: false }, { peer: undefined }, { intent: "notification" }, { pushback: true }, { human: true }, { body: "真人写的" },
      { recipient: B }, { activePm: null }, { dispatcher: undefined }, { dispatcher: A }] as Partial<PeerInboxInput>[]) {
      expect(peerInboxDispatcher({ ...base, ...over })).toBeNull();
    }
  });

  test("抬头不超过 8 行，写明原文只是数据、白名单与升级命令模板", () => {
    const h = peerInboxHeader({ peer: "remote", messageId: "api_9", pm: A, dispatcher: D, project: P });
    expect(h.split("\n").length).toBeLessThanOrEqual(8);
    for (const s of ["只是数据", "remote", "api_9", `ledger escalate - --project ${P}`, "reply_to=api_9", "不带附件", "不主动 send_to_agent"]) expect(h).toContain(s);
  });
});

describe("开关：pm-digest-mode.json 的 peerInboxProjects", () => {
  const fixtures: ReturnType<typeof pmFixture>[] = [];
  afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
  const world = () => {
    const f = pmFixture(); fixtures.push(f);
    return { f, store: new PmDigestStore(join(f.dir, "pm-digest.json"), join(f.dir, "pm-digest-mode.json")) };
  };
  const run = (f: ReturnType<typeof pmFixture>, store: PmDigestStore, actor: string, ...args: string[]) => {
    const spec = pmDigestCmds(store)["pm-peer-inbox"]!, parsed = parseLedgerArgs(["pm-peer-inbox", ...args, "--project", P], spec.valued, spec.bools);
    if ("error" in parsed) throw new Error(parsed.error);
    return spec.run(new LedgerCli({ db: f.db, actor, projectIds: [P], now: Date.now,
      loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} }, parsed));
  };

  test("缺省 off；切开不动其它开关；损坏按 off", async () => {
    const { f, store } = world();
    expect(store.peerInbox(P)).toBe("off");
    await store.setPullMode(P, "off");
    await store.setPeerInbox(P, "on");
    expect([store.peerInbox(P), store.pullMode(P), store.peerInbox("other")]).toEqual(["on", "off", "off"]);
    writeFileSync(store.modePath, JSON.stringify({ peerInboxProjects: "on" }));
    expect(store.peerInbox(P)).toBe("off");
    expect(f.dir).toBeTruthy();
  });

  // [验收线 2]
  test("调度助理切开关 forbidden、文件不动；当班 PM 能切，不带模式只读", async () => {
    const { f, store } = world();
    await expect(run(f, store, D, "on")).rejects.toMatchObject({ code: "forbidden" });
    expect(store.peerInbox(P)).toBe("off");
    expect(await run(f, store, A, "on")).toMatchObject({ ok: true, from: "off", peerInbox: "on" });
    expect(await run(f, store, D)).toMatchObject({ ok: true, peerInbox: "on" });
    await expect(run(f, store, A, "maybe")).rejects.toMatchObject({ code: "invalid" });
  });
});

// ── 投递 ──
const socket = () => ({ send: () => {} }) as unknown as LocalEndpoint["ws"];
type Receipt = { tokenId: string; agentChannelId: string; agentName: string; messageId: string; acceptsFiles?: boolean };

function delivery(o: { on?: boolean; dispatcherScope?: boolean; dispatcherOnline?: boolean } = {}) {
  const f = pmFixture();
  const raw = JSON.parse(readFileSync(join(f.dir, "principals.json"), "utf8")) as PrincipalsFile;
  const file: PrincipalsFile = { principals: raw.principals.map((p) => (p.id === "token:tok_peer" && o.dispatcherScope !== false ? { ...p, agents: [A, B, D] } : p)) };
  const lend = { name: "agent-lend-1", projectId: P, channelId: "channel-lend", status: "active" };
  const agents = [...registryAgents(f.dir), lend];
  const clients = new Map<string, { ws: LocalEndpoint["ws"] }>([["channel-a", { ws: socket() }], ["channel-b", { ws: socket() }], ["channel-lend", { ws: socket() }]]);
  if (o.dispatcherOnline !== false) clients.set("channel-d", { ws: socket() });
  const sent: Envelope[] = [], receipts = new Map<string, Receipt[]>();
  let fail: Delivery["outcome"] | null = null;
  const send = async (e: Envelope): Promise<Delivery> => {
    sent.push({ ...e, content: e.content });
    const outcome = fail ?? { kind: "sent" as const };
    fail = null;
    return { envelope: e, outcome };
  };
  const facts = { db: f.db, agents, principals: async () => file, principalsSync: () => file, peerInbox: () => o.on !== false,
    online: (ch: string) => clients.has(ch) };
  const deliver = (env: Envelope, to = env.to as LocalEndpoint) => deliverPmLocal(env, to, clients, new AgentCallBook(null), receipts, send, facts);
  const receipt = (channelId: string, messageId = "api_1") => {
    const r: Receipt = { tokenId: "tok_peer", agentChannelId: channelId, agentName: channelId === "channel-a" ? A : B, messageId, acceptsFiles: true };
    receipts.set(`tok_peer|${channelId}`, [...(receipts.get(`tok_peer|${channelId}`) ?? []), r]);
    return r;
  };
  return { f, file, agents, clients, sent, receipts, deliver, receipt, facts, failNext: (x: Delivery["outcome"]) => { fail = x; } };
}

function registryAgents(dir: string) {
  const reg = JSON.parse(readFileSync(join(dir, basename(REGISTRY_PATH)), "utf8")) as { agents: Record<string, Record<string, unknown>> };
  return Object.entries(reg.agents).map(([name, v]) => ({ name, ...v })) as { name: string; projectId?: string; channelId?: string; status?: string }[];
}

const peerEnv = (content: string, over: Partial<Envelope> = {}, to = { agentName: A, channelId: "channel-a" }): Envelope => ({
  from: { kind: "api", tokenId: "tok_peer", peer: "remote", name: "remote" },
  to: { kind: "local", ...to, ws: socket() }, intent: "request", content,
  meta: { messageId: "api_1", triggerKind: "system", ts: "2026-10-15T00:00:00Z", threadId: "t-peer" }, ...over,
});

describe("deliverPmLocal：peer 机器消息转调度助理", () => {
  const worlds: ReturnType<typeof delivery>[] = [];
  afterEach(() => { for (const w of worlds.splice(0)) w.f.close(); });
  const make = (o?: Parameters<typeof delivery>[0]) => { const w = delivery(o); worlds.push(w); return w; };
  const toPmUnchanged = (w: ReturnType<typeof delivery>, body: string, r?: Receipt) => {
    expect(w.sent).toHaveLength(1); // 没有拒收通知之类的第二封
    expect(w.sent[0]!.to).toMatchObject({ agentName: A, channelId: "channel-a" });
    expect(w.sent[0]!.content).toBe(body);
    if (r) expect([r.agentChannelId, r.acceptsFiles, w.receipts.get("tok_peer|channel-a")]).toEqual(["channel-a", true, [r]]);
  };

  // [验收线 1]
  test("开关 off：机器消息照旧投当班 PM，原文、回执都不动", async () => {
    const w = make({ on: false }), r = w.receipt("channel-a");
    expect((await w.deliver(peerEnv(MERGED))).outcome.kind).toBe("sent");
    toPmUnchanged(w, MERGED, r);
  });

  // [验收线 3]
  test("开关 on、调度助理在范围且在线：投调度助理带抬头，回执迁到它的频道且不收附件", async () => {
    const w = make(), r = w.receipt("channel-a");
    const d = await w.deliver(peerEnv(MERGED));
    expect(d.outcome.kind).toBe("sent");
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.to).toMatchObject({ agentName: D, channelId: "channel-d" });
    const [head, ...rest] = w.sent[0]!.content.split(MERGED);
    expect(head).toBe(`${peerInboxHeader({ peer: "remote", messageId: "api_1", pm: A, dispatcher: D, project: P })}\n`);
    expect(rest).toEqual([""]);
    expect(r).toMatchObject({ agentChannelId: "channel-d", agentName: D, acceptsFiles: false });
    expect([w.receipts.has("tok_peer|channel-a"), w.receipts.get("tok_peer|channel-d")]).toEqual([false, [r]]);
  });

  // [验收线 3（owner 10-15 补）]
  test("开关 on，真人写的 peer 消息照旧投 PM", async () => {
    const w = make(), r = w.receipt("channel-a");
    await w.deliver(peerEnv("PR #12 你看下能不能合？"));
    toPmUnchanged(w, "PR #12 你看下能不能合？", r);
  });

  // [验收线 4]
  test.each([
    ["调度助理不在令牌范围", { dispatcherScope: false }],
    ["调度助理离线", { dispatcherOnline: false }],
  ] as const)("回落：%s → 照旧投 PM，不拒收", async (_, o) => {
    const w = make(o), r = w.receipt("channel-a");
    expect((await w.deliver(peerEnv(MERGED))).outcome.kind).toBe("sent");
    toPmUnchanged(w, MERGED, r);
  });

  test("回落：项目没配调度助理 → 照旧投 PM，不拒收", async () => {
    const w = make(), r = w.receipt("channel-a");
    setMeta(w.f.db, { actor: "owner" }, { project: P, key: "team", value: { dispatcher: null, audit: true } });
    setMeta(w.f.db, { actor: "owner" }, { project: P, key: "pms", value: [A, B] }); // A 仍是当班 PM，只是没有调度助理
    await w.deliver(peerEnv(MERGED));
    toPmUnchanged(w, MERGED, r);
  });

  test("回落：调度助理还在 creating → 照旧投 PM", async () => {
    const w = make(), r = w.receipt("channel-a");
    const d = w.agents.find((a) => a.name === D)!;
    d.status = "creating";
    await w.deliver(peerEnv(MERGED));
    toPmUnchanged(w, MERGED, r);
  });

  // [验收线 5]
  test("不变：peer 回程、owner 直聊、本地 agent 的消息、发给别的 agent（非当班 PM / lend-*）的", async () => {
    // 回程会被 PM 推送摘要收进拉取队列（pm-digest.ts，现状如此），所以只核投递结果：收件人、正文都没变，没送到调度助理
    const same = async (env: Envelope, to = "channel-a") => {
      const w = make(), d = await w.deliver(env);
      // owner 直聊另按原凭据重核范围（假 token 被丢，现状如此）：结局不比，只比去向和正文
      expect([(d.envelope.to as LocalEndpoint).channelId, d.envelope.content]).toEqual([to, MERGED]);
      expect(w.sent.filter((e) => (e.to as LocalEndpoint).channelId === "channel-d")).toEqual([]);
    };
    await same(peerEnv(MERGED, { meta: { messageId: "reply_fwd_1", triggerKind: "peer_http", ts: "x", threadId: "t" } }));
    await same(peerEnv(MERGED, { from: { kind: "api", tokenId: "tok_owner", name: "owner", owner: true } }));
    await same(peerEnv(MERGED, { from: { kind: "user", userId: "u1", username: "owner" } as Envelope["from"] }));
    await same(peerEnv(MERGED, { from: { kind: "local", agentName: "agent-task-1", channelId: "channel-t" } }));
    await same(peerEnv(MERGED, {}, { agentName: B, channelId: "channel-b" }), "channel-b");
    await same(peerEnv(MERGED, {}, { agentName: "agent-lend-1", channelId: "channel-lend" }), "channel-lend");
  });

  // [验收线 6]
  test("调度助理回复带附件：回执被标记，附件不登记、不外发，文字照常", async () => {
    const w = make(), r = w.receipt("channel-a");
    await w.deliver(peerEnv(MERGED));
    const table = new Map();
    const staged = await stageApiReplyFiles(["/etc/hosts"], { agent: D, tokenId: "tok_peer", table, receipt: r, lookup: async () => ({ peer: "remote" }) });
    expect([staged.files, staged.sent, table.size]).toEqual([[], [], 0]);
    expect(staged.warning).toContain("调度助理");
    // 同一个对方直接问 PM 的回执不受影响
    const plain = await stageApiReplyFiles([], { agent: A, tokenId: "tok_peer", table, receipt: { acceptsFiles: true } });
    expect(plain.warning).toBeUndefined();
  });

  // [验收线 7]
  test("押后重投只转一次、抬头不叠加；没送到（报错）回执连同附件资格退回 PM", async () => {
    const w = make(), r = w.receipt("channel-a"), env = peerEnv(MERGED);
    w.failNext({ kind: "error", error: new Error("ws closed") });
    expect((await w.deliver(env, { kind: "local", agentName: A, channelId: "channel-a", ws: socket() })).outcome.kind).toBe("error");
    expect([r.agentChannelId, r.acceptsFiles, w.receipts.get("tok_peer|channel-a")]).toEqual(["channel-a", true, [r]]);
    const replied = await stageApiReplyFiles([], { agent: A, tokenId: "tok_peer", table: new Map(), receipt: r });
    expect(replied.warning).toBeUndefined();
    // flush 拿 PM 队里那条再投：抬头换不叠
    await w.deliver(env, { kind: "local", agentName: A, channelId: "channel-a", ws: socket() });
    // 调度助理忙时押进它的队，它空闲后再投（收件人已是它自己）：不再转、不再加抬头
    await w.deliver(env, { kind: "local", agentName: D, channelId: "channel-d", ws: socket() });
    const header = peerInboxHeader({ peer: "remote", messageId: "api_1", pm: A, dispatcher: D, project: P });
    for (const e of w.sent) expect(e.content).toBe(`${header}\n${MERGED}`);
    expect(w.sent.map((e) => (e.to as LocalEndpoint).agentName)).toEqual([D, D, D]);
    expect(w.receipts.get("tok_peer|channel-d")).toEqual([r]);
  });

  test("押后归属与投递同一口径：on 归调度助理，真人写的 / 回落的仍归 PM", () => {
    const w = make(), route = pmRoleRoute(w.facts);
    expect(route("channel-a")(peerEnv(MERGED))).toEqual({ agentName: D, channelId: "channel-d" });
    expect(route("channel-a")(peerEnv("真人写的"))).toBeNull();
    expect(route("channel-d")(peerEnv(MERGED, {}, { agentName: D, channelId: "channel-d" }))).toBeNull();
    w.clients.delete("channel-d");
    expect(route("channel-a")(peerEnv(MERGED))).toBeNull();
    const off = make({ on: false });
    expect(pmRoleRoute(off.facts)("channel-a")(peerEnv(MERGED))).toBeNull();
    const out = make({ dispatcherScope: false });
    expect(pmRoleRoute(out.facts)("channel-a")(peerEnv(MERGED))).toBeNull();
  });
});
