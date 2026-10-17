/** PROPEVID1：自动批准结果事件带提案摘要；scripts/guard 不再报 schema 原因；卡上命中按 (reason, path) 去重。中心 / decide 是 fake，台账是临时真库。 */
import { describe, expect, test } from "bun:test";
import { listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { ProposalList, ProposalRecord } from "../src/lib/shared-ledger-feature-proposals.js";
import { classifyProposal, hitEvidence, reasonText, type AutoHit } from "../src/lib/center-proposal-auto.js";
import { RESULT_OP } from "../src/lib/center-proposal-auto-exec.js";
import { proposalSummary, type ProposalSummary } from "../src/lib/center-proposal-auto-summary.js";
import { pollCenterProposals, type ProposalInboxDeps } from "../src/bridge/center-proposal-inbox.js";
import { FeatureProposalRejected } from "../src/lib/shared-ledger-feature-proposals.js";
import { featureProposalError } from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import type { Ask } from "../src/lib/ledger-asks.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const NOW = 1_790_000_000_000;
const SCOPE = { centerId: "c1", teamId: "t1", projectId: "p1" };
const SELF = "person-owner";
const LOCAL = "claudestra";
const REPO = ["web/features/collab/list.tsx", "web/features/collab/board.tsx", "scripts/guard/rules.ts", "src/lib/ledger-schema.ts", "src/bridge.ts"];

type Node = { key: string; oneLine: string; deps: string[]; fileGlobs: string[]; estimate: string };
const node = (key: string, fileGlobs: string[]): Node => ({ key, oneLine: `节点 ${key}`, deps: [], fileGlobs, estimate: "" });
function rec(id: string, nodes: Node[], o: { title?: string; kind?: "new" | "revise" } = {}): ProposalRecord {
  const digest = `${id}-digest`.padEnd(64, "0");
  const base = { schemaVersion: 1, ...SCOPE, operationId: `op-${id}`, title: o.title ?? `协作页改版 ${id}`, description: "调一下列表样式",
    ownerWords: null, nodes, homeInstanceId: "inst-a", expiresAt: NOW + 3_600_000 };
  const proposal = (o.kind === "revise" ? { ...base, kind: "revise", featureId: "F1", baseVersion: 2, expectedRev: 3, baseDigest: "b".repeat(64) }
    : { ...base, kind: "new" }) as ProposalRecord["proposal"];
  return { proposal, proposalId: id, proposalRev: 1, proposer: { type: "person", personId: "person-he", instanceId: "inst-b" },
    operation: { schemaVersion: 1, ...SCOPE, operationId: `op-${id}`, proposalDigest: digest, state: "pending_approval", proposalId: id, featureId: null, version: null, updatedAt: NOW } };
}

/** 跑一轮自动批准（on 档），返回结果事件；refuse：中心拒批，走交还人工（handover） */
async function autoApproveOnce(r: ProposalRecord, refuse = false) {
  const db = openLedger(tempLedgerPath("propevid-")), informed: string[] = [];
  const deps: ProposalInboxDeps = {
    now: () => NOW,
    projects: () => [{ localProjectId: LOCAL, scope: SCOPE }],
    list: async () => ({
      policy: { schemaVersion: 1, ...SCOPE, approvers: "project_owner", setBy: null, rev: 0, updatedAt: 0 }, proposals: [r], selfPersonId: SELF,
    }) as ProposalList & { selfPersonId: string },
    members: async () => [{ personId: SELF, role: "owner", status: "active" }],
    decide: async () => {
      if (refuse) throw new FeatureProposalRejected(403, featureProposalError("forbidden"));
      return { ...r, operation: { ...r.operation, state: "approved" } };
    },
    openAsk: input => { if (!refuse) throw new Error("不该开卡"); return { ...input, id: "ask_x" } as Ask; },
    openCards: () => [],
    closeAsk: () => {},
    inform: async t => { informed.push(t); },
    handoff: async () => {},
    log: () => {},
    auto: { mode: () => "on", db: () => db, files: () => REPO, hasCard: () => false },
  };
  await pollCenterProposals(deps);
  if (!refuse) expect(informed).toEqual([]);
  return listEvents(db, { project: LOCAL }).filter(e => e.kind === "note" && e.data.op === RESULT_OP);
}

describe("PROPEVID1 结果事件带提案摘要", () => {
  test("[验收线 1] 自动批准 2 节点提案：data 有标题、类型、节点数和两个节点的 fileGlobs；正文末尾带标题与节点数", async () => {
    const r = rec("p-two", [node("ui", ["web/features/collab/list.tsx"]), node("ui2", ["web/features/collab/board.tsx"])], { kind: "revise" });
    const [e, ...rest] = await autoApproveOnce(r);
    expect(rest).toEqual([]);
    expect(e!.data.outcome).toBe("approved");
    const s = e!.data.proposal as ProposalSummary;
    expect(s).toEqual({ title: "协作页改版 p-two", kind: "revise", featureId: "F1", fromVersion: 2, toVersion: 3, nodeCount: 2, globsOmitted: 0,
      nodes: [{ key: "ui", fileGlobs: ["web/features/collab/list.tsx"], globsOmitted: 0 }, { key: "ui2", fileGlobs: ["web/features/collab/board.tsx"], globsOmitted: 0 }] });
    expect(e!.text.endsWith(" · 协作页改版 p-two · 2 个节点")).toBe(true);
  });

  test("[验收线 1] 单节点 15 条 glob 只留 10 条并记省略数；总量 60 封顶", () => {
    const globs = (n: number, p: string) => Array.from({ length: n }, (_, i) => `docs/${p}-${i}.md`);
    const one = proposalSummary(rec("p-15", [node("doc", globs(15, "a"))]));
    expect(one.kind).toBe("new");
    expect(one.nodes[0]!.fileGlobs).toEqual(globs(10, "a"));
    expect(one.nodes[0]!.globsOmitted).toBe(5);
    expect(one.globsOmitted).toBe(5);
    const many = proposalSummary(rec("p-many", Array.from({ length: 8 }, (_, i) => node(`n${i}`, globs(12, `n${i}`)))));
    expect(many.nodes.reduce((n, x) => n + x.fileGlobs.length, 0)).toBe(60);
    expect(many.globsOmitted).toBe(8 * 12 - 60);
    expect(many.nodes[6]!.fileGlobs).toEqual([]);
    expect(many.nodes[6]!.globsOmitted).toBe(12);
  });

  test("r2 node-summary-cap：61 节点全部留 key，glob 超总量只记省略数", () => {
    const s = proposalSummary(rec("p-61", Array.from({ length: 61 }, (_, i) => node(`n${i}`, [`web/features/collab/f${i}.tsx`]))));
    expect(s.nodeCount).toBe(61);
    expect(s.nodes.map(n => n.key)).toEqual(Array.from({ length: 61 }, (_, i) => `n${i}`));
    expect(s.nodes[60]!).toEqual({ key: "n60", fileGlobs: [], globsOmitted: 1 });
    expect(s.globsOmitted).toBe(1);
  });

  test("摘要过清洗：凭据、URL、本机绝对路径不进事件", () => {
    const s = proposalSummary(rec("p-dirty", [node("x", ["/Users/he/repos/a.ts", "docs/a.md"])],
      { title: "看 https://example.com/x?t=1 用 sk-SECRETSECRETSECRETSECRET123" }));
    const json = JSON.stringify(s);
    for (const bad of ["https://", "sk-SECRET", "/Users/he"]) expect(json).not.toContain(bad);
    expect(s.nodes[0]!.fileGlobs[1]).toBe("docs/a.md");
  });
});

describe("PROPEVID1 r1 摘要遮本机绝对路径（中英文标点、等号、其他根）", () => {
  const ABS = ["/tmp/probe-x/a.ts", "/srv/app/data.db", "/Users/someone/repos/x", "/home/u/.env", "/opt/x/y", "~/notes/a.md", "~someone/x/y",
    "C:\\Users\\x\\a.ts", "\\\\host\\share\\a", "/etc", "/data/x"];
  const LEADS = ["", " ", "位置:", "位置：", "（", "「", "=", "，", ",", ";", "：\"", "看"];

  test("各种前导 × 各种根：摘要 JSON 不含原路径", () => {
    for (const lead of LEADS) for (const abs of ABS) {
      const s = proposalSummary(rec("p-abs", [node("x", ["docs/a.md"])], { title: `标题${lead}${abs} 收尾` }));
      expect(s.title).toContain("[本机路径]");
      expect(JSON.stringify(s)).not.toContain(abs.replace(/\\/g, "\\\\"));
    }
  });

  test("相对 glob、括号 glob、中文斜杠不误遮", () => {
    const keep = ["src/lib/a.ts", "web/{a,b}/c/d.tsx", "src/[ab]/c/d.ts", "src/**/x/y.ts", "scripts/guard/rules.ts", "docs/a-/b/c.md"];
    const s = proposalSummary(rec("p-rel", [node("x", keep)], { title: "新建/修订 3/4 a/b/c" }));
    expect(s.nodes[0]!.fileGlobs).toEqual(keep);
    expect(s.title).toBe("新建/修订 3/4 a/b/c");
  });

  test("真实结果事件：approved 路径的 data.proposal.title 与 text 都不留绝对路径", async () => {
    const r = rec("p-abs-evt", [node("ui", ["web/features/collab/list.tsx"])], { title: "核对 位置：/tmp/probe-x/a.ts 与 /srv/app/data.db" });
    const [e] = await autoApproveOnce(r);
    expect(e!.data.outcome).toBe("approved");
    const blob = JSON.stringify(e!.data) + e!.text;
    for (const bad of ["/tmp/probe-x", "/srv/app"]) expect(blob).not.toContain(bad);
    expect(e!.text).toContain("[本机路径]");
  });

  const R2 = ["/用户/文档/a.md", "/数据/x", "/foo.db", "/secret.env", "/x"];
  test("r2 summary-path：中文首段、未列举根目录的单文件也遮", () => {
    for (const lead of ["", " ", "位置：", "看", "=", "（"]) for (const abs of R2) {
      const s = proposalSummary(rec("p-abs2", [node("x", ["docs/a.md"])], { title: `标题${lead}${abs} 收尾` }));
      if (lead === "看" && abs === "/x") continue; // 汉字后单个非点短段与「新建/修订」同形，不遮
      expect(s.title).toContain("[本机路径]");
      expect(s.title).not.toContain(abs);
    }
    const keep = proposalSummary(rec("p-keep", [node("x", ["web/(group)/page.tsx", "src/a.ts"])], { title: "新建 / 修订 和/或" }));
    expect(keep.title).toBe("新建 / 修订 和/或");
    expect(keep.nodes[0]!.fileGlobs).toEqual(["web/(group)/page.tsx", "src/a.ts"]);
  });

  for (const refuse of [false, true]) test(`r2 summary-path 真实结果事件（${refuse ? "handover" : "approved"}）：data 与 text 不留路径`, async () => {
    const r = rec(`p-abs-r2-${refuse}`, [node("ui", ["web/features/collab/list.tsx"])], { title: "核对 /用户/文档/a.md 与 /foo.db 和 看/数据/x" });
    const [e] = await autoApproveOnce(r, refuse);
    expect(e!.data.outcome).toBe(refuse ? "handover" : "approved");
    const blob = JSON.stringify(e!.data) + e!.text;
    for (const bad of ["/用户", "/foo.db", "/数据"]) expect(blob).not.toContain(bad);
  });
});

describe("PROPEVID1 guard 文件不报 schema", () => {
  test("r1 嵌套 scripts/guard 路径路由仍 owner，原因改报安全敏感；tests/ docs/ 下照旧豁免", () => {
    for (const g of ["src/scripts/guard/rules.ts", "web/scripts/guard/rules.ts", "scripts/fixture/scripts/guard/rules.ts", "src/x/Scripts/Guard/a.ts"]) {
      const v = classifyProposal(rec("p-nested", [node("g", [g])]), REPO);
      expect(v.route).toBe("owner");
      expect(v.reasons).toContain("glob_security_surface");
      expect(v.reasons).not.toContain("glob_data_schema");
    }
    const t = classifyProposal(rec("p-tests", [node("t", ["tests/scripts/guard/x.test.ts"])]), REPO);
    expect(t.reasons).not.toContain("glob_data_schema");
  });


  test("[验收线 2] 只改 scripts/guard/rules.ts：仍 owner、报安全敏感，不报 schema；ledger-schema 仍报 schema", () => {
    const g = classifyProposal(rec("p-guard", [node("g", ["scripts/guard/rules.ts"])]), REPO);
    expect(g.route).toBe("owner");
    expect(reasonText(g.reasons)).toContain("改动安全敏感目录或文件");
    expect(reasonText(g.reasons)).not.toContain("涉及删数据、迁移或 schema");
    const s = classifyProposal(rec("p-schema", [node("s", ["src/lib/ledger-schema.ts"])]), REPO);
    expect(s.route).toBe("owner");
    expect(reasonText(s.reasons)).toContain("涉及删数据、迁移或 schema");
  });
});

describe("PROPEVID1 卡上命中去重", () => {
  test("[验收线 3] 同一路径被两个节点命中，卡上只出现一次", () => {
    const v = classifyProposal(rec("p-dup", [node("a", ["src/bridge.ts"]), node("b", ["src/bridge.ts"])]), REPO);
    expect(v.hits.filter(h => h.path === "src/bridge.ts").length).toBeGreaterThan(1);
    const text = reasonText(v.reasons, undefined, v.hits);
    expect(text.split("改到 src/bridge.ts").length - 1).toBe(1);
    expect(hitEvidence(v.hits).hitsOmitted).toBe(0);
  });

  test("[验收线 3] 去重后超过 10 条：截前 10，省略数按去重后计", () => {
    const hits: AutoHit[] = [];
    for (let i = 0; i < 13; i++) for (const source of ["n1", "n2", "n3"]) hits.push({ reason: "glob_security_surface", source, path: `scripts/guard/f${i}.ts` });
    const e = hitEvidence(hits);
    expect(e.hits.map(h => h.path)).toEqual(Array.from({ length: 10 }, (_, i) => `scripts/guard/f${i}.ts`));
    expect(e.hitsOmitted).toBe(3);
    expect(reasonText(["glob_security_surface"], undefined, hits)).toContain("另 3 条");
  });
});
