/** PROPINBOX1：中心待批提案进 owner「待你处理」，点按钮由系统代为批准 / 驳回。中心、凭据、openAsk、forwardDecision 全是 fake。 */
import { afterEach, describe, expect, test } from "bun:test";
import { getAsk, listAsks, openAsk, type Ask } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setAsksForTest, type CreateAskInput } from "../src/bridge/asks.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import { SharedLedgerUnavailable } from "../src/lib/shared-ledger-client-transport.js";
import { FeatureProposalRejected, type ProposalList, type ProposalRecord } from "../src/lib/shared-ledger-feature-proposals.js";
import { featureProposalError, type ProposalDecision } from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { APPROVE_BUTTON, inboxCard, PROPOSAL_INBOX_CREATOR, REJECT_BUTTON } from "../src/lib/center-proposal-inbox.js";
import { informOwner, onCenterProposalAnswered, pollCenterProposals, type ProposalInboxDeps } from "../src/bridge/center-proposal-inbox.js";

const NOW = 1_790_000_000_000;
const SCOPE = { centerId: "c1", teamId: "t1", projectId: "p1" };
const SELF = "person-owner";
const SECRET = "sk-SECRETSECRETSECRETSECRET123";

function rec(id: string, o: { rev?: number; by?: string; state?: ProposalRecord["operation"]["state"]; title?: string; description?: string; kind?: "new" | "revise" } = {}): ProposalRecord {
  const rev = o.rev ?? 1, digest = `${id}-digest-r${rev}`.padEnd(64, "0");
  const base = { schemaVersion: 1, ...SCOPE, operationId: `op-${id}`, title: o.title ?? `标题 ${id}`, description: o.description ?? `说明 ${id}`,
    ownerWords: null, nodes: [
      { key: "n1", oneLine: `节点一 ${id}`, deps: [], fileGlobs: [], estimate: "" },
      { key: "n2", oneLine: `节点二 ${id}`, deps: ["n1"], fileGlobs: [], estimate: "" }],
    homeInstanceId: "inst-a", expiresAt: NOW + 3_600_000 };
  const revise = { ...base, kind: "revise", featureId: "F1", baseVersion: 2, expectedRev: 3, baseDigest: "b".repeat(64) };
  const proposal = (o.kind === "revise" ? revise : { ...base, kind: "new" }) as ProposalRecord["proposal"];
  return { proposal, proposalId: id, proposalRev: rev, proposer: { type: "person", personId: o.by ?? "person-he", instanceId: "inst-b" },
    operation: { schemaVersion: 1, ...SCOPE, operationId: `op-${id}`, proposalDigest: digest, state: o.state ?? "pending_approval", proposalId: id, featureId: null, version: null, updatedAt: NOW } };
}
const listOf = (proposals: ProposalRecord[]): ProposalList & { selfPersonId: string } =>
  ({ policy: { schemaVersion: 1, ...SCOPE, approvers: "project_owner", setBy: null, rev: 0, updatedAt: 0 }, proposals, selfPersonId: SELF });

function harness(initial: ProposalRecord[]) {
  let center: ProposalRecord[] | Error = initial;
  const asks: Ask[] = [], decided: { proposalId: string; decision: ProposalDecision }[] = [], informed: string[] = [], logs: string[] = [];
  let listCalls = 0;
  let gate: Promise<void> | null = null;
  let decideImpl: (proposalId: string, d: ProposalDecision) => Promise<ProposalRecord> = async (proposalId, d) => {
    const r = rec(proposalId);
    return { ...r, operation: d.decision === "approve" ? { ...r.operation, state: "published", featureId: "feat-9", version: 1 } : { ...r.operation, state: "rejected" } };
  };
  const deps: ProposalInboxDeps = {
    now: () => NOW,
    projects: () => [{ localProjectId: "claudestra", scope: SCOPE }],
    list: async () => {
      listCalls++;
      const snap = center, wait = gate; // 发请求那一刻的中心状态；gate 只扣住下一次请求的响应（模拟迟到）
      gate = null;
      if (wait) await wait;
      if (snap instanceof Error) throw snap;
      return listOf(snap);
    },
    decide: async (_s, proposalId, d) => { decided.push({ proposalId, decision: d }); return decideImpl(proposalId, d); },
    openAsk: (input: CreateAskInput) => {
      const hit = asks.find(a => a.dedupKey === input.dedupKey);
      if (hit) return hit;
      const a = { id: `ask_${crypto.randomUUID()}`, fromAgent: null, fromChannelId: null, itemId: null, taskId: null, urgency: "normal", body: "", kindHint: null,
        chatId: "", threadId: null, discordMessageIds: [], state: "open", answer: null, outboxMessageId: null, createdAt: NOW, updatedAt: NOW, assignee: null,
        askKey: null, bind: null, supersedes: null, dedupKey: null, context: "", options: [], allowText: true, blocking: null, expiresAt: NOW, extra: {},
        ...input } as Ask;
      asks.push(a);
      return a;
    },
    openCards: () => asks.filter(a => a.state === "open" && a.createdBy === PROPOSAL_INBOX_CREATOR),
    closeAsk: (id) => { const a = asks.find(x => x.id === id)!; a.state = "cancelled"; },
    inform: async t => { informed.push(t); },
    log: l => { logs.push(l); },
  };
  const answer = (a: Ask, button: string, who: { owner?: boolean; external?: boolean } = { owner: true }): Ask => {
    a.state = "answered";
    a.answer = { choices: [`[button:${button}]`], labels: [button], text: "", principal: "owner", via: "web_card", at: NOW, final: true, ...who } as Ask["answer"];
    return a;
  };
  return { deps, asks, decided, informed, logs, answer, setCenter: (c: ProposalRecord[] | Error) => { center = c; },
    setDecide: (f: typeof decideImpl) => { decideImpl = f; }, listCalls: () => listCalls,
    hold: () => { let release!: () => void; gate = new Promise<void>(r => { release = r; }); return release; } };
}
const open = (h: ReturnType<typeof harness>) => h.asks.filter(a => a.state === "open");

describe("PROPINBOX1 拉取开卡", () => {
  test("[验收线 1] 2 条他人 pending + 1 条本人：开 2 张卡，含提案人 / 标题 / 节点标题；同一 rev 重复轮询不重复开", async () => {
    const h = harness([rec("prop-a"), rec("prop-b", { kind: "revise" }), rec("prop-self", { by: SELF })]);
    await pollCenterProposals(h.deps);
    expect(h.asks.length).toBe(2);
    const [a, b] = h.asks as [Ask, Ask];
    expect(a.kind).toBe("authorize");
    expect(a.source).toBe("system");
    expect(a.title).toContain("标题 prop-a");
    expect(a.context).toContain("person-he");
    expect(a.context).toContain("节点一 prop-a");
    expect(a.context).toContain("节点二 prop-a");
    expect(a.context).toContain("新建");
    expect(b.context).toContain("修订");
    expect(JSON.stringify(a.options)).toContain(APPROVE_BUTTON);
    expect(JSON.stringify(a.options)).toContain(REJECT_BUTTON);
    expect(a.bind?.params).toEqual({ localProjectId: "claudestra", proposalId: "prop-a", proposalRev: 1, proposalDigest: rec("prop-a").operation.proposalDigest });
    expect(h.asks.some(x => x.title.includes("prop-self"))).toBe(false);
    await pollCenterProposals(h.deps);
    await pollCenterProposals(h.deps);
    expect(h.asks.length).toBe(2);
    expect(open(h).length).toBe(2);
  });

  test("[验收线 1] 说明只取前 300 字并脱敏，最多列 10 个节点", async () => {
    const r = rec("prop-long", { description: `token ${SECRET} ${"长".repeat(400)}` });
    r.proposal.nodes = Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, oneLine: `节点 ${i}`, deps: [], fileGlobs: [], estimate: "" }));
    const h = harness([r]);
    await pollCenterProposals(h.deps);
    const c = h.asks[0]!.context;
    expect(c).not.toContain(SECRET);
    expect(c).toContain("节点 9");
    expect(c).not.toContain("节点 10");
    expect(c).toContain("另 3 个");
    expect(c).not.toContain("长".repeat(301));
  });

  test("[验收线 1] 先对说明全文脱敏再截断：跨第 300 字边界的私钥块不进卡", async () => {
    const body = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(12);
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    const r = rec("prop-pem", { description: `见附件 ${pem} 结尾` });
    expect(r.proposal.description.indexOf("-----END")).toBeGreaterThan(300);
    const c = inboxCard("claudestra", r).context;
    expect(c).not.toContain(body.slice(0, 40));
    expect(c).not.toContain("BEGIN PRIVATE KEY");
  });
});

describe("PROPINBOX1 答复执行", () => {
  test("[验收线 2] owner 点「批准」：forwardDecision 一次，带卡上 proposalId / rev / digest，decision=approve；回结果", async () => {
    const h = harness([rec("prop-a")]);
    await pollCenterProposals(h.deps);
    await onCenterProposalAnswered(h.answer(h.asks[0]!, APPROVE_BUTTON), h.deps);
    expect(h.decided.length).toBe(1);
    expect(h.decided[0]!.proposalId).toBe("prop-a");
    expect(h.decided[0]!.decision).toMatchObject({ proposalId: "prop-a", proposalRev: 1, proposalDigest: rec("prop-a").operation.proposalDigest, decision: "approve" });
    expect(h.asks[0]!.state).toBe("answered");
    expect(h.informed.length).toBe(1);
    expect(h.informed[0]).toContain("feat-9");
    await onCenterProposalAnswered(h.asks[0]!, h.deps); // 同一答复再到钩子：不再转发
    expect(h.decided.length).toBe(1);
  });

  test("[验收线 2] owner 点「驳回」：decision=reject，带非空 reason；回「已驳回」", async () => {
    const h = harness([rec("prop-a")]);
    await pollCenterProposals(h.deps);
    await onCenterProposalAnswered(h.answer(h.asks[0]!, REJECT_BUTTON), h.deps);
    expect(h.decided.length).toBe(1);
    expect(h.decided[0]!.decision.decision).toBe("reject");
    expect(h.decided[0]!.decision.reason.length).toBeGreaterThan(0);
    expect(h.informed[0]).toContain("已驳回");
  });

  test("[验收线 3] guest / peer 答、bind 被改、别的卡的答复：不调 forwardDecision", async () => {
    const h = harness([rec("prop-a"), rec("prop-b"), rec("prop-c")]);
    await pollCenterProposals(h.deps);
    const [a, b, c] = h.asks as [Ask, Ask, Ask];
    await onCenterProposalAnswered(h.answer(a, APPROVE_BUTTON, { owner: false }), h.deps);
    await onCenterProposalAnswered(h.answer(b, APPROVE_BUTTON, { owner: true, external: true }), h.deps);
    h.answer(c, APPROVE_BUTTON);
    c.bind = { ...c.bind!, params: { ...(c.bind!.params as object), proposalRev: 99 } };
    await onCenterProposalAnswered(c, h.deps);
    const other = { ...h.asks[0]!, id: "ask_other", createdBy: "system:shared-ledger-join-offer" } as Ask;
    await onCenterProposalAnswered(h.answer(other, APPROVE_BUTTON), h.deps);
    expect(h.decided.length).toBe(0);
  });

  test("[验收线 4] 中心回 conflict：重拉一次，按新 rev 开新卡，结果里说明", async () => {
    const h = harness([rec("prop-a")]);
    await pollCenterProposals(h.deps);
    h.setCenter([rec("prop-a", { rev: 2 })]);
    h.setDecide(async () => { throw new FeatureProposalRejected(409, featureProposalError("conflict")); });
    const before = h.listCalls();
    await onCenterProposalAnswered(h.answer(h.asks[0]!, APPROVE_BUTTON), h.deps);
    expect(h.decided.length).toBe(1);
    expect(h.listCalls()).toBe(before + 1);
    const fresh = open(h);
    expect(fresh.length).toBe(1);
    expect((fresh[0]!.bind!.params as { proposalRev: number }).proposalRev).toBe(2);
    expect(h.informed[0]).toContain("rev 2");
  });

  test("[验收线 4] 中心回其他错误：不重试，结果里有错误码", async () => {
    const h = harness([rec("prop-a")]);
    await pollCenterProposals(h.deps);
    h.setDecide(async () => { throw new FeatureProposalRejected(403, featureProposalError("forbidden")); });
    await onCenterProposalAnswered(h.answer(h.asks[0]!, APPROVE_BUTTON), h.deps);
    expect(h.decided.length).toBe(1);
    expect(h.informed[0]).toContain("forbidden");
    expect(open(h).length).toBe(0);
    const h2 = harness([rec("prop-b")]);
    h2.setDecide(async () => { throw new SharedLedgerUnavailable(); });
    await pollCenterProposals(h2.deps);
    await onCenterProposalAnswered(h2.answer(h2.asks[0]!, REJECT_BUTTON), h2.deps);
    expect(h2.decided.length).toBe(1);
    expect(h2.informed[0]).toContain("center_unavailable");
  });
});

describe("PROPINBOX1 并发与结果投递", () => {
  test("[验收线 4] 迟到的旧轮询快照不撤 conflict 后按新 rev 开的卡", async () => {
    const h = harness([rec("prop-a")]);
    await pollCenterProposals(h.deps);
    const release = h.hold();
    const stalePoll = pollCenterProposals(h.deps); // 读到 rev 1，响应被扣住
    h.setCenter([rec("prop-a", { rev: 2 })]);
    h.setDecide(async () => { throw new FeatureProposalRejected(409, featureProposalError("conflict")); });
    const answered = onCenterProposalAnswered(h.answer(h.asks[0]!, APPROVE_BUTTON), h.deps);
    await Bun.sleep(5); // 旧实现里 conflict 重拉此时已按 rev 2 开卡
    release();
    await Promise.all([stalePoll, answered]);
    await pollCenterProposals(h.deps);
    const now = open(h);
    expect(now.length).toBe(1);
    expect((now[0]!.bind!.params as { proposalRev: number }).proposalRev).toBe(2);
    expect(h.informed[0]).toContain("rev 2");
  });

  test("[验收线 4] 晚于新卡的旧 rev 快照：不撤新卡、不重开旧 rev", async () => {
    const h = harness([rec("prop-a", { rev: 2 })]);
    await pollCenterProposals(h.deps);
    h.setCenter([rec("prop-a", { rev: 1 })]);
    await pollCenterProposals(h.deps);
    expect(h.asks.length).toBe(1);
    expect(open(h).length).toBe(1);
  });

  test("[验收线 2] 绑定状态读不出：结果错误码 binding_state_unreadable，日志有错误名", async () => {
    const h = harness([rec("prop-a")]);
    await pollCenterProposals(h.deps);
    h.deps.projects = () => { throw new SyntaxError("bad json"); };
    await onCenterProposalAnswered(h.answer(h.asks[0]!, APPROVE_BUTTON), h.deps);
    expect(h.decided.length).toBe(0);
    expect(h.informed[0]).toContain("binding_state_unreadable");
    expect(h.logs.some(l => l.includes("SyntaxError"))).toBe(true);
  });
});

describe("PROPINBOX1 结果给网页 owner（真实 SQLite + 事件总线）", () => {
  let path = "";
  afterEach(() => { setAsksForTest(undefined); if (path) closeLedger(path); });

  test("[验收线 2] 结果写回原卡 + 「待你处理」开结果卡，都发 SSE；控制频道另投一份", async () => {
    path = tempLedgerPath("proposal-inbox-");
    const sent: string[] = [];
    setAsksForTest({ path, registry: [], deps: { clients: new Map(), controlChannelId: "999", hold: () => {},
      deliver: async env => { sent.push(env.content); return { envelope: env, outcome: { kind: "sent" } }; } } });
    const card = openAsk(openLedger(path), inboxCard("claudestra", rec("prop-a")));
    const events: BridgeEvent[] = [];
    const off = subscribeEvents({ allow: e => e.type === "ask" }, e => events.push(e));
    try { await informOwner("成员提案「标题」：已批准并发布，featureId feat-9 v1。", { askId: card.id, title: "标题" }); }
    finally { off(); }
    const db = openLedger(path);
    expect(String(getAsk(db, card.id)!.extra.centerProposalResult)).toContain("feat-9");
    const results = listAsks(db, { source: "system", states: ["open"] }).filter(a => a.extra.centerProposalResultOf === card.id);
    expect(results.length).toBe(1);
    expect(results[0]!.context).toContain("feat-9");
    expect(results[0]!.options).toEqual([]);
    const ids = events.map(e => (e.data as { askId?: string }).askId);
    expect(ids).toContain(card.id);
    expect(ids).toContain(results[0]!.id);
    expect(sent[0]).toContain("feat-9");
  });
});

describe("PROPINBOX1 收卡与容错", () => {
  test("[验收线 5] 提案在中心已不 pending：下一轮撤掉未答卡；新 rev 取代旧卡", async () => {
    const h = harness([rec("prop-a"), rec("prop-b")]);
    await pollCenterProposals(h.deps);
    expect(open(h).length).toBe(2);
    h.setCenter([rec("prop-a", { state: "published" }), rec("prop-b", { rev: 3 })]);
    await pollCenterProposals(h.deps);
    const now = open(h);
    expect(now.length).toBe(1);
    expect((now[0]!.bind!.params as { proposalId: string; proposalRev: number })).toMatchObject({ proposalId: "prop-b", proposalRev: 3 });
    expect(h.asks.filter(a => a.state === "cancelled").length).toBe(2);
  });

  test("[验收线 5] 凭据缺失 / 中心不可达：不开卡、不抛错、已有卡不动、日志不含凭据", async () => {
    const h = harness([rec("prop-a")]);
    await pollCenterProposals(h.deps);
    h.setCenter(new FeatureProposalRejected(403, null));
    await pollCenterProposals(h.deps);
    const e = new SharedLedgerUnavailable();
    e.message = `connect failed Bearer ${SECRET}`;
    h.setCenter(e);
    await pollCenterProposals(h.deps);
    expect(open(h).length).toBe(1);
    expect(h.logs.length).toBe(2);
    for (const l of h.logs) expect(l).not.toContain(SECRET);
    const fresh = harness([]);
    fresh.setCenter(e);
    await expect(pollCenterProposals(fresh.deps)).resolves.toBeUndefined();
    expect(fresh.asks.length).toBe(0);
  });
});
