/** PROPRESULT1：开卡前核审批权、结果卡两个按钮能收口、执行日志按真实结果写。中心、成员表、开卡、给 master 的通知全是 fake。 */
import { describe, expect, test } from "bun:test";
import type { Ask } from "../src/lib/ledger-asks.js";
import type { CreateAskInput } from "../src/bridge/asks.js";
import { SharedLedgerRemoteError, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client-transport.js";
import { FeatureProposalRejected, type ProposalList, type ProposalRecord } from "../src/lib/shared-ledger-feature-proposals.js";
import { featureProposalError } from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import {
  APPROVE_BUTTON, handoffText, NOT_APPROVER_REASON, PROPOSAL_INBOX_CREATOR, REJECT_BUTTON, RESULT_ACK_BUTTON, RESULT_MASTER_BUTTON, resultCard,
  type InboxMember,
} from "../src/lib/center-proposal-inbox.js";
import { onCenterProposalAnswered, pollCenterProposals, type InformCard, type ProposalInboxDeps } from "../src/bridge/center-proposal-inbox.js";

const NOW = 1_790_000_000_000;
const SELF = "person-self";
const SECRET = "sk-SECRETSECRETSECRETSECRET123";
const scopeOf = (projectId: string) => ({ centerId: "c1", teamId: "t1", projectId });

function rec(id: string, projectId: string, title = `标题 ${id}`): ProposalRecord {
  const scope = scopeOf(projectId);
  const proposal = { schemaVersion: 1, ...scope, operationId: `op-${id}`, kind: "new", title, description: "", ownerWords: null,
    nodes: [{ key: "n1", oneLine: "节点一", deps: [], fileGlobs: [], estimate: "" }], homeInstanceId: "inst-a", expiresAt: NOW + 3_600_000 };
  return { proposal: proposal as ProposalRecord["proposal"], proposalId: id, proposalRev: 1,
    proposer: { type: "person", personId: "person-he", instanceId: "inst-b" } as ProposalRecord["proposer"],
    operation: { schemaVersion: 1, ...scope, operationId: `op-${id}`, proposalDigest: `${id}-digest`.padEnd(64, "0"), state: "pending_approval",
      proposalId: id, featureId: null, version: null, updatedAt: NOW } };
}
const member = (personId: string, role: string, status = "active"): InboxMember => ({ personId, role, status });

/** 两个绑定项目：team（成员表可换）和 mine（本人是 owner）；各有一条待批提案 */
function harness() {
  const members = new Map<string, InboxMember[] | Error>([["team", [member("person-he", "owner"), member(SELF, "member")]], ["mine", [member(SELF, "owner")]]]);
  const asks: Ask[] = [], closed: { id: string; reason: string }[] = [], logs: string[] = [], handoffs: { text: string; askId: string }[] = [], cards: InformCard[] = [];
  let memberCalls = 0;
  let decide: () => ProposalRecord | Error = () => new FeatureProposalRejected(403, featureProposalError("forbidden"));
  const deps: ProposalInboxDeps = {
    now: () => NOW,
    projects: () => [...members.keys()].map(id => ({ localProjectId: id, scope: scopeOf(id) })),
    list: async scope => ({ policy: { schemaVersion: 1, ...scope, approvers: "project_owner", setBy: null, rev: 0, updatedAt: 0 },
      proposals: [rec(`prop-${scope.projectId}`, scope.projectId)], selfPersonId: SELF } as ProposalList & { selfPersonId: string }),
    members: async scope => {
      memberCalls++;
      const m = members.get(scope.projectId)!;
      if (m instanceof Error) throw m;
      return m;
    },
    decide: async () => { const out = decide(); if (out instanceof Error) throw out; return out; },
    openAsk: (input: CreateAskInput) => {
      const hit = asks.find(a => a.dedupKey === input.dedupKey);
      if (hit) return hit;
      const a = { id: `ask_${crypto.randomUUID()}`, state: "open", answer: null, extra: {}, ...input } as unknown as Ask;
      asks.push(a);
      return a;
    },
    openCards: () => asks.filter(a => a.state === "open" && a.createdBy === PROPOSAL_INBOX_CREATOR),
    closeAsk: (id, reason) => { asks.find(a => a.id === id)!.state = "cancelled"; closed.push({ id, reason }); },
    inform: async (_t, card) => { cards.push(card); },
    handoff: async (text, askId) => { handoffs.push({ text, askId }); },
    log: l => { logs.push(l); },
  };
  return { deps, asks, closed, logs, handoffs, cards, members, memberCalls: () => memberCalls, setDecide: (f: typeof decide) => { decide = f; },
    openIn: (project: string) => asks.filter(a => a.state === "open" && (a.bind?.params as { localProjectId?: string }).localProjectId === project) };
}
function answered(a: Ask, button: string, who: { owner?: boolean; external?: boolean } = { owner: true }): Ask {
  a.state = "answered";
  a.answer = { choices: [`[button:${button}]`], labels: [button], text: "", principal: "owner", via: "web_card", at: NOW, final: true, ...who } as Ask["answer"];
  return a;
}

describe("PROPRESULT1 开卡前核审批权", () => {
  test("[验收线 1] role=member 的项目不开卡、原有的卡被撤且原因正确；role=owner 的项目照旧开卡；日志每次状态变化只一行", async () => {
    const h = harness();
    h.members.set("team", [member(SELF, "owner")]);
    await pollCenterProposals(h.deps);
    expect(h.openIn("team").length).toBe(1);
    expect(h.openIn("mine").length).toBe(1);
    const old = h.openIn("team")[0]!;
    h.members.set("team", [member("person-he", "owner"), member(SELF, "member")]);
    await pollCenterProposals(h.deps);
    await pollCenterProposals(h.deps);
    expect(h.openIn("team")).toEqual([]);
    expect(h.closed).toEqual([{ id: old.id, reason: NOT_APPROVER_REASON }]);
    expect(NOT_APPROVER_REASON).toBe("本人在该项目不是 owner，无审批权");
    expect(h.openIn("mine").length).toBe(1);
    expect(h.logs.filter(l => l.includes("team")).length).toBe(1);
    expect(h.logs.filter(l => l.includes("mine"))).toEqual([]);
  });

  test("[验收线 1] 成员表里没有本人、本人是 owner 但已被移除：都不开卡；每轮每项目只读一次成员表", async () => {
    const h = harness();
    h.members.set("team", [member("person-he", "owner")]);
    h.members.set("mine", [member(SELF, "owner", "removed")]);
    await pollCenterProposals(h.deps);
    expect(h.asks).toEqual([]);
    expect(h.memberCalls()).toBe(2);
  });

  test("[验收线 2] 成员表读失败：不开新卡、不撤旧卡、记一行错误名（不带原文）；下一轮读成功后按角色处理", async () => {
    const h = harness();
    h.members.set("team", [member(SELF, "owner")]);
    await pollCenterProposals(h.deps);
    const kept = h.openIn("team")[0]!;
    const down = new SharedLedgerUnavailable();
    down.message = `connect failed Bearer ${SECRET}`;
    h.members.set("team", down);
    h.members.set("mine", new SharedLedgerRemoteError(401, { error: SECRET }));
    h.asks.splice(h.asks.findIndex(a => a !== kept), 1); // mine 的卡当作还没开过：读失败时不许开
    await pollCenterProposals(h.deps);
    await pollCenterProposals(h.deps);
    expect(h.openIn("team")).toEqual([kept]);
    expect(h.openIn("mine")).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.logs.filter(l => l.includes("team"))).toEqual([expect.stringContaining("center_unavailable")]);
    expect(h.logs.filter(l => l.includes("mine"))).toEqual([expect.stringContaining("http_401")]);
    expect(h.logs.join("\n")).not.toContain(SECRET);
    h.members.set("team", [member(SELF, "member")]);
    h.members.set("mine", [member(SELF, "owner")]);
    await pollCenterProposals(h.deps);
    expect(h.openIn("team")).toEqual([]);
    expect(h.closed).toEqual([{ id: kept.id, reason: NOT_APPROVER_REASON }]);
    expect(h.openIn("mine").length).toBe(1);
  });
});

describe("PROPRESULT1 结果卡能收口", () => {
  const card = (title = "标题 prop-a", text = "结果正文") => ({ id: "ask_result_1", state: "open", answer: null,
    ...resultCard("ask_auth_1", title, text, { proposalId: "prop-a", proposalRev: 2, code: "forbidden" }) }) as unknown as Ask;

  test("[验收线 3] 结果卡带「知道了」「交给大总管」两个按钮", () => {
    const buttons = (card().options as { buttons: { id: string; label: string }[] }[])[0]!.buttons;
    expect(buttons.map(b => [b.id, b.label])).toEqual([[RESULT_ACK_BUTTON, "知道了"], [RESULT_MASTER_BUTTON, "交给大总管"]]);
  });

  test("[验收线 3] owner 点「知道了」：不发给 master；点「交给大总管」：发一段固定格式文字（标题、错误码、提案号、rev）", async () => {
    const h = harness();
    await onCenterProposalAnswered(answered(card(), RESULT_ACK_BUTTON), h.deps);
    expect(h.handoffs).toEqual([]);
    const c = { ...answered(card(), RESULT_MASTER_BUTTON), id: "ask_result_2" };
    await onCenterProposalAnswered(c, h.deps);
    await onCenterProposalAnswered(c, h.deps); // 同一张卡重复触发只发一次
    expect(h.handoffs).toEqual([{ askId: "ask_result_2", text:
      "[owner 把一张成员提案处理结果卡交给你处理（ask_result_2）]\n标题：标题 prop-a\n错误码：forbidden\n提案号：prop-a\nrev：2" }]);
  });

  test("[验收线 3] 非 owner 本人（guest / 外部）点「交给大总管」不生效", async () => {
    const h = harness();
    await onCenterProposalAnswered({ ...answered(card(), RESULT_MASTER_BUTTON, {}), id: "ask_result_3" }, h.deps);
    await onCenterProposalAnswered({ ...answered(card(), RESULT_MASTER_BUTTON, { owner: true, external: true }), id: "ask_result_4" }, h.deps);
    expect(h.handoffs).toEqual([]);
    expect(h.logs.length).toBe(2);
  });

  test("[验收线 3] 「交给大总管」的文字里没有中心原文和凭据：结果正文不带，标题里的凭据脱敏，卡上被改坏的字段不照抄", () => {
    const raw = `center said: Bearer ${SECRET}`;
    const c = { ...card(`泄露 ${SECRET}`, raw), id: "ask_result_5" };
    expect(handoffText(c)).not.toContain(SECRET);
    expect(handoffText(c)).not.toContain("center said");
    c.extra = { centerProposalResultMeta: { proposalId: `x ${SECRET}`, proposalRev: SECRET, code: `Bearer ${SECRET}` } };
    const text = handoffText(c);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("错误码：unknown");
  });
});

describe("PROPRESULT1 执行日志按真实结果写", () => {
  async function run(button: string, decide: () => ProposalRecord | Error) {
    const h = harness();
    await pollCenterProposals(h.deps);
    h.setDecide(decide);
    await onCenterProposalAnswered(answered(h.openIn("mine")[0]!, button), h.deps);
    return { line: h.logs.find(l => l.includes("prop-mine rev 1"))!, card: h.cards[0]! };
  }
  const settled = (state: "published" | "rejected") => { const r = rec("prop-mine", "mine"); return { ...r, operation: { ...r.operation, state } }; };

  test("[验收线 4] 中心报错：日志是「执行 approve 失败：<错误码>」，不出现「已执行」，不带中心原文；结果卡记下错误码", async () => {
    const e = new FeatureProposalRejected(403, featureProposalError("forbidden"));
    e.message = `forbidden for Bearer ${SECRET}`;
    const o = await run(APPROVE_BUTTON, () => e);
    expect(o.line).toContain("执行 approve 失败：forbidden");
    expect(o.line).not.toContain("已执行");
    expect(o.line).not.toContain(SECRET);
    expect(o.card).toMatchObject({ resultCard: true, meta: { proposalId: "prop-mine", proposalRev: 1, code: "forbidden" } });
  });

  test("[验收线 4] conflict：日志是「conflict，已重拉」，不出现「已执行」", async () => {
    const o = await run(REJECT_BUTTON, () => new FeatureProposalRejected(409, featureProposalError("conflict")));
    expect(o.line).toContain("conflict，已重拉");
    expect(o.line).not.toContain("已执行");
    expect(o.card.meta?.code).toBe("conflict");
  });

  test("[验收线 4] 中心办成：仍是「已执行 approve」「已执行 reject」", async () => {
    expect((await run(APPROVE_BUTTON, () => settled("published"))).line).toContain("已执行 approve");
    expect((await run(REJECT_BUTTON, () => settled("rejected"))).line).toContain("已执行 reject");
  });
});
