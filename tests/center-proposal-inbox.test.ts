/** PROPINBOX1：中心待批提案进 owner「待你处理」，点按钮由系统代为批准 / 驳回。中心、凭据、openAsk、forwardDecision 全是 fake。 */
import { afterEach, describe, expect, test } from "bun:test";
import { answerAsk, getAsk, listAsks, openAsk, type Ask } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setAsksForTest, type CreateAskInput } from "../src/bridge/asks.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import { SharedLedgerUnavailable } from "../src/lib/shared-ledger-client-transport.js";
import { FeatureProposalRejected, type ProposalList, type ProposalRecord } from "../src/lib/shared-ledger-feature-proposals.js";
import { featureProposalError, type ProposalDecision } from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { APPROVE_BUTTON, inboxCard, PROPOSAL_INBOX_CREATOR, REJECT_BUTTON, RESULT_ACK_BUTTON, RESULT_MASTER_BUTTON } from "../src/lib/center-proposal-inbox.js";
import { informOwner, onCenterProposalAnswered, pollCenterProposals, type ProposalInboxDeps } from "../src/bridge/center-proposal-inbox.js";

const NOW = 1_790_000_000_000;
const SCOPE = { centerId: "c1", teamId: "t1", projectId: "p1" };
const SELF = "person-owner";
const SECRET = "sk-SECRETSECRETSECRETSECRET123";

function rec(id: string, o: { rev?: number; by?: string; state?: ProposalRecord["operation"]["state"]; title?: string; description?: string; kind?: "new" | "revise";
  via?: "service" } = {}): ProposalRecord {
  const rev = o.rev ?? 1, digest = `${id}-digest-r${rev}`.padEnd(64, "0");
  const base = { schemaVersion: 1, ...SCOPE, operationId: `op-${id}`, title: o.title ?? `标题 ${id}`, description: o.description ?? `说明 ${id}`,
    ownerWords: null, nodes: [
      { key: "n1", oneLine: `节点一 ${id}`, deps: [], fileGlobs: [], estimate: "" },
      { key: "n2", oneLine: `节点二 ${id}`, deps: ["n1"], fileGlobs: [], estimate: "" }],
    homeInstanceId: "inst-a", expiresAt: NOW + 3_600_000 };
  const revise = { ...base, kind: "revise", featureId: "F1", baseVersion: 2, expectedRev: 3, baseDigest: "b".repeat(64) };
  const proposal = (o.kind === "revise" ? revise : { ...base, kind: "new" }) as ProposalRecord["proposal"];
  return { proposal, proposalId: id, proposalRev: rev, proposer: { type: o.via ?? "person", personId: o.by ?? "person-he", instanceId: "inst-b" } as ProposalRecord["proposer"],
    operation: { schemaVersion: 1, ...SCOPE, operationId: `op-${id}`, proposalDigest: digest, state: o.state ?? "pending_approval", proposalId: id, featureId: null, version: null, updatedAt: NOW } };
}
const listOf = (proposals: ProposalRecord[]): ProposalList & { selfPersonId: string } =>
  ({ policy: { schemaVersion: 1, ...SCOPE, approvers: "project_owner", setBy: null, rev: 0, updatedAt: 0 }, proposals, selfPersonId: SELF });

function harness(initial: ProposalRecord[]) {
  let center: ProposalRecord[] | Error = initial;
  const asks: Ask[] = [], decided: { proposalId: string; decision: ProposalDecision }[] = [], informed: string[] = [], resultCards: boolean[] = [], logs: string[] = [];
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
    members: async () => [{ personId: SELF, role: "owner", status: "active" }], // PROPRESULT1：本人是项目 owner，原有用例照旧开卡
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
    inform: async (t, card) => { informed.push(t); resultCards.push(card.resultCard); },
    handoff: async () => {},
    log: l => { logs.push(l); },
  };
  const answer = (a: Ask, button: string, who: { owner?: boolean; external?: boolean } = { owner: true }): Ask => {
    a.state = "answered";
    a.answer = { choices: [`[button:${button}]`], labels: [button], text: "", principal: "owner", via: "web_card", at: NOW, final: true, ...who } as Ask["answer"];
    return a;
  };
  return { deps, asks, decided, informed, resultCards, logs, answer, setCenter: (c: ProposalRecord[] | Error) => { center = c; },
    setDecide: (f: typeof decideImpl) => { decideImpl = f; }, listCalls: () => listCalls,
    hold: () => { let release!: () => void; gate = new Promise<void>(r => { release = r; }); return release; } };
}
const open = (h: ReturnType<typeof harness>) => h.asks.filter(a => a.state === "open");

describe("PROPINBOX1 拉取开卡", () => {
  test("[验收线 1] 2 条他人 pending + 1 条本人：开 3 张卡（UXINBOX1 起本人提的也开），含提案人 / 标题 / 节点标题；同一 rev 重复轮询不重复开", async () => {
    const h = harness([rec("prop-a"), rec("prop-b", { kind: "revise" }), rec("prop-self", { by: SELF })]);
    await pollCenterProposals(h.deps);
    expect(h.asks.length).toBe(3);
    const [a, b] = h.asks as [Ask, Ask, Ask];
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
    expect(h.asks.filter(x => x.title.includes("prop-self")).length).toBe(1);
    await pollCenterProposals(h.deps);
    await pollCenterProposals(h.deps);
    expect(h.asks.length).toBe(3);
    expect(open(h).length).toBe(3);
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

describe("UXINBOX1 本人提的待批提案也开授权卡", () => {
  /** main 上别人提的卡的原文（逐字）：本卡不许改它 */
  const OTHERS_CONTEXT = ["提案人：成员 person-he", "项目：claudestra", "类型：新建 feature", "节点：2 个", "  - 节点一 prop-a", "  - 节点二 prop-a",
    "说明：说明 prop-a", "到期：2026-09-21 15:13 UTC", "点「批准」由系统用你的凭据去中心批准（算你本人批）。"].join("\n");

  test("[验收线 1] person 凭据的本人提案：标题「提案待你批准：」，提案人行「你本人」，不带 personId；别人提的卡与 main 逐字一致", async () => {
    const h = harness([rec("prop-self", { by: SELF }), rec("prop-a")]);
    await pollCenterProposals(h.deps);
    const [mine, his] = h.asks as [Ask, Ask];
    expect(mine.title).toBe("提案待你批准：标题 prop-self");
    expect(mine.context.split("\n")[0]).toBe("提案人：你本人");
    expect(mine.context).not.toContain(SELF);
    expect(mine.kind).toBe("authorize");
    expect(mine.project).toBe("master");
    expect(mine.extra.centerProposal).toEqual(mine.bind!.params);
    expect(JSON.stringify(mine.options)).toContain(APPROVE_BUTTON);
    expect(his.title).toBe("成员提案待批：标题 prop-a");
    expect(his.context).toBe(OTHERS_CONTEXT);
    expect(inboxCard("claudestra", rec("prop-a"))).toEqual(inboxCard("claudestra", rec("prop-a"), SELF));
  });

  test("[验收线 1] service 凭据（本人 PM 代提）：提案人行「你本人（经你的 PM）」；别人的 service 提案照旧「（经其 PM）」", async () => {
    const h = harness([rec("prop-self", { by: SELF, via: "service" }), rec("prop-a", { via: "service" })]);
    await pollCenterProposals(h.deps);
    const [mine, his] = h.asks as [Ask, Ask];
    expect(mine.title.startsWith("提案待你批准：")).toBe(true);
    expect(mine.context.split("\n")[0]).toBe("提案人：你本人（经你的 PM）");
    expect(his.title.startsWith("成员提案待批：")).toBe(true);
    expect(his.context.split("\n")[0]).toBe("提案人：成员 person-he（经其 PM）");
  });

  test("[验收线 1] 同 rev 再轮询不重复开；提案不再待批时撤卡；新 rev 取代旧卡", async () => {
    const h = harness([rec("prop-self", { by: SELF })]);
    await pollCenterProposals(h.deps);
    await pollCenterProposals(h.deps);
    expect(h.asks.length).toBe(1);
    h.setCenter([rec("prop-self", { by: SELF, rev: 2 })]);
    await pollCenterProposals(h.deps);
    expect(h.asks.map(a => a.state)).toEqual(["cancelled", "open"]);
    expect(h.asks[1]!.title).toBe("提案待你批准：标题 prop-self");
    h.setCenter([rec("prop-self", { by: SELF, rev: 2, state: "published" })]);
    await pollCenterProposals(h.deps);
    expect(open(h).length).toBe(0);
  });

  test("[验收线 1] owner 点「批准」走原执行路径：转发一次，结果文字 / 结果卡标题去掉「提案待你批准：」前缀", async () => {
    const h = harness([rec("prop-self", { by: SELF, via: "service" })]);
    const cards: { title: string }[] = [];
    h.deps.inform = async (t, card) => { h.informed.push(t); cards.push(card); };
    await pollCenterProposals(h.deps);
    await onCenterProposalAnswered(h.answer(h.asks[0]!, APPROVE_BUTTON), h.deps);
    expect(h.decided.map(d => [d.proposalId, d.decision.decision, d.decision.proposalRev])).toEqual([["prop-self", "approve", 1]]);
    expect(h.informed[0]!.startsWith("成员提案「标题 prop-self」（prop-self rev 1）：已批准并发布")).toBe(true);
    expect(cards[0]!.title).toBe("标题 prop-self");
    // guest 答的本人卡同样不执行
    const g = harness([rec("prop-self", { by: SELF })]);
    await pollCenterProposals(g.deps);
    await onCenterProposalAnswered(g.answer(g.asks[0]!, APPROVE_BUTTON, { owner: false }), g.deps);
    expect(g.decided.length).toBe(0);
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
    expect(h.resultCards).toEqual([false]); // PROPRES1：办成了不开结果卡
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
    expect(h.resultCards).toEqual([false]);
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
    expect(h.informed.length).toBe(3); // 三张本模块的卡都回「未执行」，都开结果卡
    expect(h.informed.every(t => t.includes("未执行"))).toBe(true);
    expect(h.resultCards).toEqual([true, true, true]);
  });

  test("[PROPRES1] done 但中心状态不是 published / approved / rejected：照旧开结果卡；approved 不开", async () => {
    const h = harness([rec("prop-a"), rec("prop-b")]);
    await pollCenterProposals(h.deps);
    h.setDecide(async id => rec(id, { state: id === "prop-a" ? "pending_approval" : "approved" }));
    await onCenterProposalAnswered(h.answer(h.asks[0]!, APPROVE_BUTTON), h.deps);
    await onCenterProposalAnswered(h.answer(h.asks[1]!, APPROVE_BUTTON), h.deps);
    expect(h.informed[0]).toContain("中心当前状态 pending_approval");
    expect(h.informed[1]).toContain("等中心发布");
    expect(h.resultCards).toEqual([true, false]);
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
    expect(h.resultCards).toEqual([true]);
  });

  test("[验收线 4] 中心回其他错误：不重试，结果里有错误码", async () => {
    const h = harness([rec("prop-a")]);
    await pollCenterProposals(h.deps);
    h.setDecide(async () => { throw new FeatureProposalRejected(403, featureProposalError("forbidden")); });
    await onCenterProposalAnswered(h.answer(h.asks[0]!, APPROVE_BUTTON), h.deps);
    expect(h.decided.length).toBe(1);
    expect(h.informed[0]).toContain("forbidden");
    expect(h.resultCards).toEqual([true]);
    expect(open(h).length).toBe(0);
    const h2 = harness([rec("prop-b")]);
    h2.setDecide(async () => { throw new SharedLedgerUnavailable(); });
    await pollCenterProposals(h2.deps);
    await onCenterProposalAnswered(h2.answer(h2.asks[0]!, REJECT_BUTTON), h2.deps);
    expect(h2.decided.length).toBe(1);
    expect(h2.informed[0]).toContain("center_unavailable");
    expect(h2.resultCards).toEqual([true]);
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

  test("[验收线 4] conflict 重拉撞回新 rev 已收口的卡：不说已开新卡、不重试", async () => {
    const h = harness([rec("prop-a")]);
    await pollCenterProposals(h.deps);
    const card1 = h.asks[0]!;
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    h.setDecide(async () => { await held; throw new FeatureProposalRejected(409, featureProposalError("conflict")); });
    const answered = onCenterProposalAnswered(h.answer(card1, APPROVE_BUTTON), h.deps); // rev 1 的决定挂起
    h.setCenter([rec("prop-a", { rev: 2 })]);
    await pollCenterProposals(h.deps);
    const card2 = open(h)[0]!;
    expect((card2.bind!.params as { proposalRev: number }).proposalRev).toBe(2);
    h.answer(card2, APPROVE_BUTTON); // rev 2 的卡已被答（例如中心回了别的错误）
    release();
    await answered;
    expect(h.decided.length).toBe(1);
    expect(open(h).length).toBe(0);
    expect(h.informed[0]).not.toContain("开了新卡");
    expect(h.informed[0]).toContain("rev 2");
    expect(h.informed[0]).toContain("answered");
    expect(h.informed[0]).toContain("未重试");
    expect(h.resultCards).toEqual([true]);
  });

  test("[验收线 4] conflict 重拉到的新 rev 已到期：不开卡，结果不说已开新卡", async () => {
    const h = harness([rec("prop-a")]);
    await pollCenterProposals(h.deps);
    const r2 = rec("prop-a", { rev: 2 });
    h.setCenter([{ ...r2, proposal: { ...r2.proposal, expiresAt: NOW - 1 } }]);
    h.setDecide(async () => { throw new FeatureProposalRejected(409, featureProposalError("conflict")); });
    await onCenterProposalAnswered(h.answer(h.asks[0]!, APPROVE_BUTTON), h.deps);
    expect(open(h).length).toBe(0);
    expect(h.informed[0]).not.toContain("开了新卡");
    expect(h.informed[0]).toContain("未能开出新卡");
    expect(h.resultCards).toEqual([true]);
  });

  test("[验收线 4] conflict 重拉后另一提案开卡失败：目标新 rev 卡已开，结果照实说已开新卡", async () => {
    const h = harness([rec("prop-a")]);
    await pollCenterProposals(h.deps);
    h.setCenter([rec("prop-a", { rev: 2 }), rec("prop-b")]);
    h.setDecide(async () => { throw new FeatureProposalRejected(409, featureProposalError("conflict")); });
    const realOpen = h.deps.openAsk;
    h.deps.openAsk = input => {
      if ((input.bind?.params as { proposalId?: string } | undefined)?.proposalId === "prop-b") throw new Error("disk I/O error");
      return realOpen(input);
    };
    await onCenterProposalAnswered(h.answer(h.asks[0]!, APPROVE_BUTTON), h.deps);
    expect(h.decided.length).toBe(1);
    const now = open(h);
    expect(now.length).toBe(1);
    expect((now[0]!.bind!.params as { proposalRev: number }).proposalRev).toBe(2);
    expect(h.informed[0]).toContain("开了新卡");
    expect(h.informed[0]).not.toContain("未能开出新卡");
    expect(h.logs.some(l => l.includes("prop-b"))).toBe(true);
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
    expect(h.resultCards).toEqual([true]);
    expect(h.logs.some(l => l.includes("SyntaxError"))).toBe(true);
  });
});

describe("PROPINBOX1 结果给网页 owner（真实 SQLite + 事件总线）", () => {
  let path = "";
  afterEach(() => { setAsksForTest(undefined); if (path) closeLedger(path); });

  /** 真账本上开授权卡、owner 点按钮，走 onCenterProposalAnswered → 真 informOwner；返回原卡结果、结果卡、SSE 的卡 id、控制频道内容 */
  async function live(button: string, decide: (r: ProposalRecord) => ProposalRecord | Error, tamper = false) {
    path = tempLedgerPath("proposal-inbox-");
    const sent: string[] = [];
    setAsksForTest({ path, registry: [], deps: { clients: new Map(), controlChannelId: "999", hold: () => {},
      deliver: async env => { sent.push(env.content); return { envelope: env, outcome: { kind: "sent" } }; } } });
    const db = openLedger(path);
    const card = openAsk(db, inboxCard("claudestra", rec("prop-a")));
    const answered = answerAsk(db, card.id, { choices: [`[button:${button}]`], labels: [button], text: "", principal: "owner", via: "web_card", at: NOW, final: true, owner: true } as never)!;
    expect(answered.state).toBe("answered");
    if (tamper) answered.bind = { ...answered.bind!, params: { ...(answered.bind!.params as object), proposalRev: 99 } };
    const h = harness([rec("prop-a")]);
    h.setDecide(async id => { const out = decide(rec(id)); if (out instanceof Error) throw out; return out; });
    h.setCenter([]); // conflict 重拉：中心已不再待批
    const events: BridgeEvent[] = [];
    const off = subscribeEvents({ allow: e => e.type === "ask" }, e => events.push(e));
    try { await onCenterProposalAnswered(answered, { ...h.deps, inform: informOwner }); }
    finally { off(); }
    const results = listAsks(db, { source: "system" }).filter(a => a.extra.centerProposalResultOf === card.id);
    return { card, results, sent, logs: h.logs, decided: h.decided, result: String(getAsk(db, card.id)!.extra.centerProposalResult ?? ""),
      eventIds: events.map(e => (e.data as { askId?: string }).askId) };
  }
  const published = (r: ProposalRecord): ProposalRecord => ({ ...r, operation: { ...r.operation, state: "published", featureId: "feat-9", version: 1 } });

  test("[PROPRES1 验收 1] 批准后中心回 published：不开结果卡，原卡 extra 有结果并发 SSE，控制频道照发", async () => {
    const o = await live(APPROVE_BUTTON, published);
    expect(o.decided.length).toBe(1);
    expect(o.results).toEqual([]);
    expect(o.result).toContain("已批准并发布");
    expect(o.result).toContain("feat-9");
    expect(o.eventIds).toContain(o.card.id);
    expect(o.sent.length).toBe(1);
    expect(o.sent[0]).toContain("已批准并发布");
  });

  test("[PROPRES1 验收 1] 驳回后中心回 rejected：同样不开结果卡，原卡有结果，控制频道照发", async () => {
    const o = await live(REJECT_BUTTON, r => ({ ...r, operation: { ...r.operation, state: "rejected" } }));
    expect(o.decided[0]!.decision.decision).toBe("reject");
    expect(o.results).toEqual([]);
    expect(o.result).toContain("已驳回");
    expect(o.sent[0]).toContain("已驳回");
  });

  test("[PROPRES1 验收 1] 中心报错 / conflict / invalid：照旧开结果卡（PROPRESULT1 起带「知道了」「交给大总管」、发 SSE），原卡有结果，控制频道照发", async () => {
    const cases: [string, Parameters<typeof live>[1], boolean][] = [
      ["错误码 forbidden", () => new FeatureProposalRejected(403, featureProposalError("forbidden")), false],
      ["中心回 conflict", () => new FeatureProposalRejected(409, featureProposalError("conflict")), false],
      ["未执行", published, true],
    ];
    for (const [words, decide, tamper] of cases) {
      const o = await live(APPROVE_BUTTON, decide, tamper);
      expect(o.results.length).toBe(1);
      expect(o.results[0]!.state).toBe("open");
      expect(o.results[0]!.kind).toBe("owner_action");
      expect(o.results[0]!.context).toContain(words);
      expect(JSON.stringify(o.results[0]!.options)).toContain(RESULT_ACK_BUTTON);
      expect(JSON.stringify(o.results[0]!.options)).toContain(RESULT_MASTER_BUTTON);
      expect(o.result).toContain(words);
      expect(o.eventIds).toContain(o.card.id);
      expect(o.eventIds).toContain(o.results[0]!.id);
      expect(o.sent[0]).toContain(words);
      expect(o.decided.length).toBe(tamper ? 0 : 1);
      setAsksForTest(undefined); closeLedger(path); path = "";
    }
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
