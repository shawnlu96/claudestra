/** PROPAUTO1：中心待批提案非安全类由系统直接批，安全类照旧出 owner 卡。中心、凭据、openAsk、forwardDecision 都是 fake，台账是临时真库。 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { type Ask } from "../src/lib/ledger-asks.js";
import { listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { CreateAskInput } from "../src/bridge/asks.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import { SharedLedgerUnavailable } from "../src/lib/shared-ledger-client-transport.js";
import { FeatureProposalRejected, type ProposalList, type ProposalRecord } from "../src/lib/shared-ledger-feature-proposals.js";
import { featureProposalError, type ProposalDecision } from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { APPROVE_BUTTON, inboxCard, PROPOSAL_INBOX_CREATOR } from "../src/lib/center-proposal-inbox.js";
import { classifyProposal, globHits, PATTERN_PROBES, reasonText } from "../src/lib/center-proposal-auto.js";
import { autoApproveMode, claimExec, execKey, execState, RESULT_OP, RETRY_AFTER_MS } from "../src/lib/center-proposal-auto-exec.js";
import { FILE_PATTERNS } from "../src/lib/peer-pr-surface.js";
import { scopeWireProtected } from "../src/lib/ask-scope-registry.js";
import { onCenterProposalAnswered, pollCenterProposals, type ProposalInboxDeps } from "../src/bridge/center-proposal-inbox.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";

const NOW = 1_790_000_000_000;
const SCOPE = { centerId: "c1", teamId: "t1", projectId: "p1" };
const SELF = "person-owner";
const LOCAL = "claudestra";
const SECRET = "sk-SECRETSECRETSECRETSECRET123";

type Node = { key: string; oneLine: string; deps: string[]; fileGlobs: string[]; estimate: string };
const node = (key: string, fileGlobs: string[], oneLine = `节点 ${key}`): Node => ({ key, oneLine, deps: [], fileGlobs, estimate: "" });

function rec(id: string, o: { rev?: number; nodes?: Node[]; state?: ProposalRecord["operation"]["state"]; title?: string; description?: string;
  ownerWords?: string; kind?: "new" | "revise"; by?: string; via?: "service" } = {}): ProposalRecord {
  const rev = o.rev ?? 1, digest = `${id}-digest-r${rev}`.padEnd(64, "0");
  const base = { schemaVersion: 1, ...SCOPE, operationId: `op-${id}`, title: o.title ?? `协作页改版 ${id}`, description: o.description ?? "调一下列表样式",
    ownerWords: o.ownerWords ?? null, nodes: o.nodes ?? [node("ui", ["web/features/collab/list.tsx"]), node("doc", ["docs/**"])],
    homeInstanceId: "inst-a", expiresAt: NOW + 3_600_000 };
  const revise = { ...base, kind: "revise", featureId: "F1", baseVersion: 2, expectedRev: 3, baseDigest: "b".repeat(64) };
  const proposal = (o.kind === "revise" ? revise : { ...base, kind: "new" }) as ProposalRecord["proposal"];
  return { proposal, proposalId: id, proposalRev: rev, proposer: { type: o.via ?? "person", personId: o.by ?? "person-he", instanceId: "inst-b" } as ProposalRecord["proposer"],
    operation: { schemaVersion: 1, ...SCOPE, operationId: `op-${id}`, proposalDigest: digest, state: o.state ?? "pending_approval", proposalId: id, featureId: null, version: null, updatedAt: NOW } };
}
const listOf = (proposals: ProposalRecord[]): ProposalList & { selfPersonId: string } =>
  ({ policy: { schemaVersion: 1, ...SCOPE, approvers: "project_owner", setBy: null, rev: 0, updatedAt: 0 }, proposals, selfPersonId: SELF });
const approved = (r: ProposalRecord): ProposalRecord => ({ ...r, operation: { ...r.operation, state: "approved" } });

/** shared：同一台账 / 卡表跨「重启」共用（handled 是进程内的，换一个 deps 对象就等于新进程看同一份持久状态） */
function harness(initial: ProposalRecord[], o: { mode?: RecoveryMode | null; db?: Database; asks?: Ask[] } = {}) {
  let center: ProposalRecord[] = initial, now = NOW, mode: RecoveryMode | null = o.mode === undefined ? "on" : o.mode;
  const db = o.db ?? openLedger(tempLedgerPath("propauto-"));
  const asks: Ask[] = o.asks ?? [], decided: { proposalId: string; decision: ProposalDecision }[] = [], informed: string[] = [], logs: string[] = [];
  let decideImpl: (proposalId: string, d: ProposalDecision) => Promise<ProposalRecord> = async (proposalId) =>
    approved(center.find(r => r.proposalId === proposalId) ?? rec(proposalId));
  let hasCardOverride: boolean | null = null;
  const deps: ProposalInboxDeps = {
    now: () => now,
    projects: () => [{ localProjectId: LOCAL, scope: SCOPE }],
    list: async () => listOf(center),
    members: async () => [{ personId: SELF, role: "owner", status: "active" }],
    decide: async (_s, proposalId, d) => { decided.push({ proposalId, decision: d }); return decideImpl(proposalId, d); },
    openAsk: (input: CreateAskInput) => {
      const hit = asks.find(a => a.dedupKey === input.dedupKey);
      if (hit) return hit;
      const a = { id: `ask_${crypto.randomUUID()}`, fromAgent: null, fromChannelId: null, itemId: null, taskId: null, urgency: "normal", body: "", kindHint: null,
        chatId: "", threadId: null, discordMessageIds: [], state: "open", answer: null, outboxMessageId: null, createdAt: now, updatedAt: now, assignee: null,
        askKey: null, bind: null, supersedes: null, dedupKey: null, context: "", options: [], allowText: true, blocking: null, expiresAt: now, extra: {},
        ...input } as Ask;
      asks.push(a);
      return a;
    },
    openCards: () => asks.filter(a => a.state === "open" && a.createdBy === PROPOSAL_INBOX_CREATOR),
    closeAsk: (id) => { const a = asks.find(x => x.id === id)!; a.state = "cancelled"; },
    inform: async (t) => { informed.push(t); }, // 推送桩：自动批准不许调
    handoff: async () => {},
    log: l => { logs.push(l); },
    ...(mode === null ? {} : {
      auto: {
        mode: () => mode!,
        db: () => db,
        files: () => REPO,
        hasCard: (key: string) => hasCardOverride ?? asks.some(a => a.dedupKey === key && a.createdBy === PROPOSAL_INBOX_CREATOR),
      },
    }),
  };
  const answer = (a: Ask, button = APPROVE_BUTTON): Ask => {
    a.state = "answered";
    a.answer = { choices: [`[button:${button}]`], labels: [button], text: "", principal: "owner", via: "web_card", at: now, final: true, owner: true } as Ask["answer"];
    return a;
  };
  const results = () => listEvents(db, { project: LOCAL }).filter(e => e.kind === "note" && e.data.op === RESULT_OP);
  return { deps, db, asks, decided, informed, logs, answer, results,
    setCenter: (c: ProposalRecord[]) => { center = c; }, setDecide: (f: typeof decideImpl) => { decideImpl = f; },
    advance: (ms: number) => { now += ms; }, setMode: (m: RecoveryMode) => { mode = m; }, setHasCard: (v: boolean | null) => { hasCardOverride = v; } };
}
/** 分类用的仓库文件清单（固定，不随本仓增删文件漂）：普通文件 + 名字被通配遮住也要认出来的保护文件 */
const REPO = [
  "web/features/collab/board.tsx", "web/features/collab/list.tsx", "docs/architecture/scheduler-ui-gate.md", "docs/migrations/floka.md",
  "tests/center-proposal-auto.test.ts", "tests/preload.ts", "src/lib/center-proposal-auto.ts", "src/lib/scheduler-wip-gate.ts",
  "src/lib/recovery-keys.ts", "src/lib/ledger-store.ts", "src/lib/sqlite-migrate.ts", "src/lib/plain-util.ts", "src/bridge/api-auth.ts",
];
const keyOf = (r: ProposalRecord) =>
  execKey(SCOPE.projectId, { localProjectId: LOCAL, proposalId: r.proposalId, proposalRev: r.proposalRev, proposalDigest: r.operation.proposalDigest });

describe("PROPAUTO1 分类（纯函数）", () => {
  test("[验收线 2] 宽 glob 只要能盖到保护路径就判 owner；具体的普通路径判 auto", () => {
    for (const g of ["**", "*", "src/**", "src/lib/**", "src/bridge/**", "web/**", "src/*/local-api/*.ts"]) expect(globHits(g, REPO)).not.toEqual([]);
    for (const g of ["src/**", "src/lib/**", "src/bridge/**", "**"]) expect(globHits(g, REPO)).toContain("glob_wide");
    for (const g of ["web/features/collab/list.tsx", "docs/**", "src/lib/plain-util.ts", "tests/center-*.test.ts"]) expect(globHits(g, REPO)).toEqual([]);
    expect(globHits("src/bridge/api-auth.ts", REPO)).toContain("glob_permission_gate");
    expect(globHits("src/lib/*-gate.ts", REPO)).toContain("glob_permission_gate");
    expect(globHits("src/hooks/**", REPO)).toContain("glob_security_surface");
    expect(globHits("src/lib/*.ts", REPO)).toContain("glob_data_schema"); // 能匹配 ledger-store.ts
    expect(globHits("src/lib/ledger-schema*.ts", REPO)).toContain("glob_data_schema");
    expect(globHits("db/001_init.sql", REPO)).toContain("glob_outside_roots");
    expect(globHits("src/lib/floka-migration/**", REPO)).toContain("glob_data_schema");
    expect(globHits("../etc/passwd", REPO)).toEqual(["glob_invalid"]);
    expect(globHits("", REPO)).toEqual(["glob_empty"]);
  });

  test("[验收线 2] 通配遮住文件名也认得出：能匹配到的现有文件逐个套保护规则；? / [ ] 遮名字或读不到文件清单交 owner", () => {
    expect(globHits("src/lib/scheduler-wip-?ate.ts", REPO)).toEqual(["glob_unresolved", "glob_permission_gate"]);
    expect(globHits("src/lib/scheduler-wip-*ate.ts", REPO)).toEqual(["glob_unresolved", "glob_permission_gate"]);
    expect(globHits("src/lib/recovery-?eys.ts", REPO)).toEqual(["glob_unresolved", "glob_security_surface"]);
    expect(globHits("src/lib/recovery-*eys.ts", REPO)).toEqual(["glob_unresolved", "glob_security_surface"]);
    expect(globHits("src/lib/sqlite-mig*.ts", REPO)).toEqual(["glob_unresolved", "glob_data_schema"]);
    expect(globHits("src/lib/[p]lain-util.ts", REPO)).toEqual(["glob_unresolved"]);
    expect(globHits("src/lib/plain-*.ts", REPO)).toEqual(["glob_unresolved"]);
    expect(globHits("src/lib/plain-*.ts", null)).toEqual(["glob_unresolved"]);
    expect(globHits("src/lib/plain-util.ts", null)).toEqual([]); // 字面路径不靠文件清单
    // 默认核本仓 git ls-files：审查探针里的两条在真仓库上同样判 owner
    expect(globHits("src/lib/scheduler-wip-*ate.ts")).toContain("glob_permission_gate");
    expect(globHits("src/lib/recovery-*eys.ts")).toContain("glob_security_surface");
  });

  test("代表路径真的命中复用的规则（规则改了这里先红）", () => {
    for (const p of PATTERN_PROBES) expect(FILE_PATTERNS.some(([, re]) => re.test(p))).toBe(true);
    for (const p of ["src/lib/peer-scope-gate.ts", "src/bridge/api-auth.ts", "src/lib/caller-identity.ts", "src/lib/order-ask.ts", "src/lib/recovery-key-class.ts"])
      expect(scopeWireProtected(p)).toBe(true);
  });

  test("[验收线 2][验收线 6] 词表补判 owner；空 globs / 没有节点判 owner；修订按新的全量节点判", () => {
    expect(classifyProposal(rec("a"), REPO)).toEqual({ route: "auto", reasons: [] });
    expect(classifyProposal(rec("a", { description: "把凭据存到别处" }), REPO).reasons).toEqual(["text_sensitive_word"]);
    expect(classifyProposal(rec("a", { ownerWords: "drop table x" }), REPO).route).toBe("owner");
    expect(classifyProposal(rec("a", { nodes: [node("x", ["docs/**"], "加 Token 校验")] }), REPO).reasons).toEqual(["text_sensitive_word"]);
    expect(classifyProposal(rec("a", { nodes: [node("x", [])] }), REPO).reasons).toEqual(["glob_empty"]);
    expect(classifyProposal(rec("a", { nodes: [] }), REPO).reasons).toEqual(["nodes_empty"]);
    expect(classifyProposal(rec("a", { kind: "revise", nodes: [node("x", ["docs/**"]), node("y", ["src/lib/ledger-store.ts"])] }), REPO).reasons).toEqual(["glob_data_schema"]);
    expect(classifyProposal(rec("a", { kind: "revise", nodes: [node("x", ["docs/**"])] }), REPO).route).toBe("auto");
    // 提案人不限
    expect(classifyProposal(rec("a", { by: SELF, via: "service" }), REPO).route).toBe("auto");
  });
});

describe("PROPAUTO1 接线", () => {
  test("[验收线 1] on 档普通提案：decide 一次（approve + 同一 rev / 摘要），不建卡，一条结果事件，不推送", async () => {
    const r = rec("prop-a");
    const h = harness([r]);
    await pollCenterProposals(h.deps);
    expect(h.decided).toEqual([{ proposalId: "prop-a", decision: { schemaVersion: 1, proposalId: "prop-a", decision: "approve",
      proposalDigest: r.operation.proposalDigest, proposalRev: 1, reason: "" } }]);
    expect(h.asks).toEqual([]);
    expect(h.informed.length).toBe(0);
    const res = h.results();
    expect(res.length).toBe(1);
    expect(res[0]!.data).toMatchObject({ outcome: "approved", centerState: "approved", proposalId: "prop-a", proposalRev: 1,
      proposalDigest: r.operation.proposalDigest, centerProject: "p1", key: keyOf(r), reasons: [] });
    await pollCenterProposals(h.deps); // 中心还没翻状态：不重发、不出卡
    expect(h.decided.length).toBe(1);
    expect(h.asks).toEqual([]);
    expect(JSON.stringify(listEvents(h.db, { project: LOCAL }))).not.toContain(SECRET);
  });

  test("[验收线 2] 安全类各一例：只建 owner 卡、不 decide，卡正文带原因", async () => {
    const cases: [ProposalRecord, string][] = [
      [rec("p-auth", { nodes: [node("x", ["src/bridge/api-auth.ts"])] }), "改动权限闸文件"],
      [rec("p-dir", { nodes: [node("x", ["src/hooks/**"])] }), "改动安全敏感目录或文件"],
      [rec("p-wide", { nodes: [node("x", ["src/**"])] }), "文件范围太宽"],
      [rec("p-empty", { nodes: [node("x", ["docs/**"]), node("y", [])] }), "有节点没写文件范围"],
      [rec("p-cred", { description: "改一下凭据的存放" }), "安全、权限或数据相关的词"],
      [rec("p-schema", { nodes: [node("x", ["src/lib/ledger-schema*.ts"])] }), "涉及删数据、迁移或 schema"],
    ];
    const h = harness(cases.map(([r]) => r));
    await pollCenterProposals(h.deps);
    expect(h.decided).toEqual([]);
    expect(h.asks.length).toBe(cases.length);
    for (const [r, why] of cases) {
      const card = h.asks.find(a => a.title.includes(r.proposalId))!;
      expect(card.context).toContain("需要你批的原因：");
      expect(card.context).toContain(why);
    }
    expect(h.results()).toEqual([]);
  });

  test("[验收线 2] 通配遮住的权限闸 / 关键词文件：标题说明都无害，也只出卡、从不 decide", async () => {
    const cases = ["src/lib/scheduler-wip-?ate.ts", "src/lib/scheduler-wip-*ate.ts", "src/lib/recovery-?eys.ts", "src/lib/recovery-*eys.ts"]
      .map((g, i) => rec(`p-obscured-${i}`, { nodes: [node("x", [g])] }));
    const h = harness(cases);
    await pollCenterProposals(h.deps);
    h.advance(RETRY_AFTER_MS + 1);
    await pollCenterProposals(h.deps);
    expect(h.decided).toEqual([]);
    expect(h.asks.length).toBe(cases.length);
    for (const a of h.asks) expect(a.context).toContain("需要你批的原因：");
    expect(h.results()).toEqual([]);
  });

  test("[验收线 3] 同一版本已有 answered 的人工卡：自动路径不发 decide", async () => {
    const r = rec("prop-a");
    const asks: Ask[] = [];
    const old = harness([r], { mode: "observe", asks });
    await pollCenterProposals(old.deps); // observe 时开出的人工卡
    old.answer(asks[0]!);
    const h = harness([r], { asks, db: old.db });
    await pollCenterProposals(h.deps);
    expect(h.decided).toEqual([]);
    expect(asks.length).toBe(1);
  });

  test("[验收线 3] 人工 hook 和自动路径并发：decide 只发一次；重启后同一版本不重发", async () => {
    const r = rec("prop-a");
    const asks: Ask[] = [];
    const h = harness([r], { asks });
    const card = h.deps.openAsk(inboxCard(LOCAL, r, SELF) as CreateAskInput); // 同一版本的人工卡
    h.answer(card);
    h.setHasCard(false); // 让自动路径看不到这张卡（并发窗口），只靠执行占位挡
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    h.setDecide(async (id) => { await gate; return approved(rec(id)); });
    const both = Promise.all([pollCenterProposals(h.deps), onCenterProposalAnswered(card, h.deps)]);
    await Bun.sleep(10);
    release();
    await both;
    expect(h.decided.length).toBe(1);
    // 重启：新进程（新 deps，handled 清空）看同一台账，同一版本不再发
    const again = harness([r], { asks, db: h.db });
    again.setHasCard(false);
    await pollCenterProposals(again.deps);
    await onCenterProposalAnswered({ ...card, id: `${card.id}-2` }, again.deps);
    expect(again.decided).toEqual([]);
    expect(again.informed.some(t => t.includes("已在执行"))).toBe(true);
  });

  test("[验收线 4] 超时后中心已不是待批：补记结果、不重发", async () => {
    const r = rec("prop-a");
    const h = harness([r]);
    h.setDecide(async () => { throw new SharedLedgerUnavailable(); });
    await pollCenterProposals(h.deps);
    expect(h.decided.length).toBe(1);
    expect(h.asks).toEqual([]);
    expect(h.results()).toEqual([]);
    h.setCenter([approved(r)]);
    h.advance(RETRY_AFTER_MS + 1);
    await pollCenterProposals(h.deps);
    expect(h.decided.length).toBe(1);
    expect(h.results().map(e => e.data.outcome)).toEqual(["settled"]);
    expect(h.results()[0]!.data.centerState).toBe("approved");
  });

  test("[验收线 4] 仍待批：未满 10 分钟不重发，满了重发，第 3 次仍不明改出 owner 卡", async () => {
    const h = harness([rec("prop-a")]);
    h.setDecide(async () => { throw new SharedLedgerUnavailable(); });
    await pollCenterProposals(h.deps);
    h.advance(RETRY_AFTER_MS - 1);
    await pollCenterProposals(h.deps);
    expect(h.decided.length).toBe(1);
    h.advance(2);
    await pollCenterProposals(h.deps);
    expect(h.decided.length).toBe(2);
    expect(h.asks).toEqual([]);
    h.advance(RETRY_AFTER_MS);
    await pollCenterProposals(h.deps);
    expect(h.decided.length).toBe(3);
    expect(h.asks.length).toBe(1);
    expect(h.asks[0]!.context).toContain("需要你批的原因：自动批准没有确认结果");
    h.advance(RETRY_AFTER_MS * 3);
    await pollCenterProposals(h.deps);
    expect(h.decided.length).toBe(3);
    expect(h.asks.length).toBe(1);
    // owner 批这张卡：自动已交还，人工占位能抢到，照常 decide
    h.setDecide(async (id) => approved(rec(id)));
    await onCenterProposalAnswered(h.answer(h.asks[0]!), h.deps);
    expect(h.decided.length).toBe(4);
  });

  test("[验收线 4] 中心明确拒绝：改出 owner 卡带错误码，不再自动发", async () => {
    const h = harness([rec("prop-a")]);
    h.setDecide(async () => { throw new FeatureProposalRejected(403, featureProposalError("forbidden")); });
    await pollCenterProposals(h.deps);
    expect(h.decided.length).toBe(1);
    expect(h.asks[0]!.context).toContain("中心拒绝了自动批准（错误码 forbidden）");
    h.advance(RETRY_AFTER_MS * 2);
    await pollCenterProposals(h.deps);
    expect(h.decided.length).toBe(1);
  });

  test("[验收线 4][验收线 6] 409 后按新版本重新分类：新版本是安全类就出卡，普通就自动批", async () => {
    const h = harness([rec("prop-a")]);
    h.setDecide(async () => { throw new FeatureProposalRejected(409, featureProposalError("conflict")); });
    await pollCenterProposals(h.deps);
    expect(h.asks).toEqual([]);
    expect(h.results().map(e => e.data.outcome)).toEqual(["conflict"]);
    h.setDecide(async (id) => approved(rec(id)));
    h.setCenter([rec("prop-a", { rev: 2, kind: "revise", nodes: [node("x", ["docs/**"]), node("y", ["src/bridge/**"])] })]);
    await pollCenterProposals(h.deps);
    expect(h.decided.length).toBe(1);
    expect(h.asks.length).toBe(1);
    expect(h.asks[0]!.context).toContain("需要你批的原因");
    h.setCenter([rec("prop-a", { rev: 3, kind: "revise", nodes: [node("x", ["docs/**"])] })]);
    await pollCenterProposals(h.deps);
    expect(h.decided.length).toBe(2);
    expect(h.decided[1]!.decision.proposalRev).toBe(3);
  });

  test("[验收线 5] 未配置时是 observe：只记样本、照旧出卡（卡和旧路径逐字相同）", async () => {
    expect(autoApproveMode("propauto-unconfigured")).toBe("observe");
    const r = rec("prop-a");
    const h = harness([r], { mode: "observe" });
    await pollCenterProposals(h.deps);
    await pollCenterProposals(h.deps);
    expect(h.decided).toEqual([]);
    const legacy = harness([r], { mode: null });
    await pollCenterProposals(legacy.deps);
    expect(h.asks.map(a => [a.title, a.context, a.dedupKey])).toEqual(legacy.asks.map(a => [a.title, a.context, a.dedupKey]));
    const samples = listEvents(h.db, { project: LOCAL }).filter(e => e.data.op === "recovery_observe");
    expect(samples.length).toBe(1);
    expect(samples[0]!.data).toMatchObject({ mechanism: "centerProposalAutoApprove", actionKey: "prop-a:1" });
  });

  test("[验收线 5] off：逐字回到旧路径（不分类、不写台账、卡无原因行）", async () => {
    const recs = [rec("prop-a"), rec("prop-b", { nodes: [node("x", ["src/**"])] })];
    const h = harness(recs, { mode: "off" }), legacy = harness(recs, { mode: null });
    await pollCenterProposals(h.deps);
    await pollCenterProposals(legacy.deps);
    expect(h.decided).toEqual([]);
    expect(h.asks.map(a => [a.title, a.context, a.dedupKey, a.bind])).toEqual(legacy.asks.map(a => [a.title, a.context, a.dedupKey, a.bind]));
    expect(h.asks.some(a => a.context.includes("需要你批的原因"))).toBe(false);
    expect(listEvents(h.db, { project: LOCAL })).toEqual([]);
    await onCenterProposalAnswered(h.answer(h.asks[0]!), h.deps);
    expect(h.decided.length).toBe(1);
    expect(listEvents(h.db, { project: LOCAL })).toEqual([]);
  });

  test("执行占位：人工先占，自动抢不到；自动占了且没交还，人工抢不到", () => {
    const db = openLedger(tempLedgerPath("propauto-claim-"));
    const id = (pid: string) => ({ localProjectId: LOCAL, centerProject: "p1", params: { localProjectId: LOCAL, proposalId: pid, proposalRev: 1, proposalDigest: "d".repeat(64) } });
    expect(claimExec(db, id("x"), "owner", NOW)).toBe(true);
    expect(claimExec(db, id("x"), "auto", NOW, 1)).toBe(false);
    expect(claimExec(db, id("x"), "owner", NOW)).toBe(false);
    expect(claimExec(db, id("y"), "auto", NOW, 1)).toBe(true);
    expect(claimExec(db, id("y"), "owner", NOW)).toBe(false);
    expect(execState(db, execKey("p1", id("y").params)).claims.map(c => c.lane)).toEqual(["auto"]);
    expect(reasonText(["auto_center_refused"], "forbidden")).toBe("中心拒绝了自动批准（错误码 forbidden）");
  });
});


test("[验收线 2] protected-glob-name-intersection: new protected files never auto approve", async () => {
  const cases = [
    ["src/lib/new-*ate.ts", "src/lib/new-gate.ts"],
    ["src/lib/new-*eys.ts", "src/lib/new-keys.ts"],
    ["web/features/new/**", "web/features/new/new-auth.ts"],
    ["src/new-*/plain.ts", "src/new-migration/plain.ts"],
  ];
  for (const [g, concrete] of cases) {
    expect(new Bun.Glob(g!).match(concrete!)).toBe(true);
    expect(globHits(g!, [])).not.toEqual([]);
  }
 });

test("[验收线 2] protected-glob-name-intersection: new-file polling creates owner cards only", async () => {
  const cases = ["src/lib/new-*ate.ts", "src/lib/new-*eys.ts", "web/features/new/**", "src/new-*/plain.ts"];
  const h = harness(cases.map((g, i) => rec(`new-file-${i}`, { nodes: [node("x", [g])] })));
  await pollCenterProposals(h.deps);
  expect(h.decided).toEqual([]);
  expect(h.asks.length).toBe(cases.length);
  for (const a of h.asks) expect(a.context).toContain("需要你批的原因：");
});
