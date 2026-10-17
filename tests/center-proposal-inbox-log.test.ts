/** PROPLOG1：中心提案收件的 catch 日志带阶段 + 仓库内相对路径帧（不带 message / 绝对路径）；补记逐条做，一条失败不拖累别的。 */
import { describe, expect, test } from "bun:test";
import { type Ask } from "../src/lib/ledger-asks.js";
import { listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { CreateAskInput } from "../src/bridge/asks.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import type { ProposalList, ProposalRecord } from "../src/lib/shared-ledger-feature-proposals.js";
import { claimExec, RESULT_OP } from "../src/lib/center-proposal-auto-exec.js";
import { paramsOf } from "../src/lib/center-proposal-inbox.js";
import { pollCenterProposals, type ProposalInboxDeps } from "../src/bridge/center-proposal-inbox.js";

const NOW = 1_790_000_000_000;
const SCOPE = { centerId: "c1", teamId: "t1", projectId: "p1" };
const SELF = "person-owner";
const LOCAL = "claudestra";
const SECRET = "sk-SECRETSECRETSECRETSECRET123";

function rec(id: string, state: ProposalRecord["operation"]["state"] = "pending_approval"): ProposalRecord {
  const digest = `${id}-digest-r1`.padEnd(64, "0");
  const proposal = { schemaVersion: 1, ...SCOPE, operationId: `op-${id}`, title: `标题 ${id}`, description: `说明 ${id}`, ownerWords: null,
    nodes: [{ key: "n1", oneLine: `节点 ${id}`, deps: [], fileGlobs: ["src/lib/recovery-keys.ts"], estimate: "" }],
    homeInstanceId: "inst-a", expiresAt: NOW + 3_600_000, kind: "new" } as ProposalRecord["proposal"];
  return { proposal, proposalId: id, proposalRev: 1, proposer: { type: "person", personId: "person-he", instanceId: "inst-b" } as ProposalRecord["proposer"],
    operation: { schemaVersion: 1, ...SCOPE, operationId: `op-${id}`, proposalDigest: digest, state, proposalId: id, featureId: null, version: null, updatedAt: NOW } };
}
const listOf = (proposals: ProposalRecord[]): ProposalList & { selfPersonId: string } =>
  ({ policy: { schemaVersion: 1, ...SCOPE, approvers: "project_owner", setBy: null, rev: 0, updatedAt: 0 }, proposals, selfPersonId: SELF });

function harness(center: ProposalRecord[], o: { auto?: boolean; openAsk?: ProposalInboxDeps["openAsk"] } = {}) {
  const db = openLedger(tempLedgerPath("proplog-")), logs: string[] = [];
  const deps: ProposalInboxDeps = {
    now: () => NOW,
    projects: () => [{ localProjectId: LOCAL, scope: SCOPE }],
    list: async () => listOf(center),
    members: async () => [{ personId: SELF, role: "owner", status: "active" }],
    decide: async () => { throw new Error("不该 decide"); },
    openAsk: o.openAsk ?? ((input: CreateAskInput) => ({ id: `ask_${input.dedupKey}`, state: "open", ...input }) as unknown as Ask),
    openCards: () => [],
    closeAsk: () => {},
    inform: async () => {},
    handoff: async () => {},
    log: l => { logs.push(l); },
    ...(o.auto ? { auto: { mode: () => "on" as const, db: () => db, files: () => ["src/lib/recovery-keys.ts"], hasCard: () => false } } : {}),
  };
  const results = () => listEvents(db, { project: LOCAL }).filter(e => e.kind === "note" && e.data.op === RESULT_OP);
  return { deps, db, logs, results };
}
const absPath = /(?:^|[\s(（])\/(?:Users|home|private|var|tmp)\//;

describe("PROPLOG1 中心提案收件日志", () => {
  test("[验收线 1] 开卡抛 RangeError：日志带阶段和仓库内相对路径帧，不含 message 原文和绝对路径", async () => {
    const h = harness([rec("prop-a")], { openAsk: () => { throw new RangeError(`Invalid time value ${SECRET} https://center.example/x`); } });
    await pollCenterProposals(h.deps);
    const line = h.logs.find(l => l.includes("开卡失败"));
    expect(line).toBeDefined();
    expect(line).toContain("RangeError");
    expect(line).toContain("阶段 开卡");
    expect(line).toMatch(/(?:tests\/center-proposal-inbox-log\.test\.ts|src\/bridge\/center-proposal-inbox\.ts):\d+:\d+/);
    for (const bad of [SECRET, "Invalid time value", "center.example", process.cwd()]) expect(line).not.toContain(bad);
    expect(line).not.toMatch(absPath);
  });

  test("[验收线 2] pending.all 三条，第二条补记时抛错：第一、三条照样补记，日志只有一行失败", async () => {
    const [a, b, c] = [rec("prop-a", "approved"), rec("prop-b", "approved"), rec("prop-c", "approved")];
    const h = harness([a!, b!, c!], { auto: true });
    for (const r of [a!, b!, c!]) expect(claimExec(h.db, { localProjectId: LOCAL, centerProject: SCOPE.projectId, params: paramsOf(LOCAL, r) }, "auto", NOW - 1)).toBe(true);
    // 第二条补记时读提案摘要抛错（模拟线上的 RangeError）
    Object.defineProperty(b!.operation, "proposalDigest", { get: () => { throw new RangeError(`bad ${SECRET}`); } });
    await pollCenterProposals(h.deps);
    expect(h.results().map(e => /prop-[abc]/.exec(e.text)?.[0])).toEqual(["prop-a", "prop-c"]);
    const failed = h.logs.filter(l => l.includes("失败"));
    expect(failed.length).toBe(1);
    expect(failed[0]).toContain("prop-b");
    expect(failed[0]).toContain("阶段 补记");
    expect(failed[0]).toMatch(/RangeError（阶段 补记；帧 [\w./-]+\.ts:\d+:\d+/);
    expect(failed[0]).not.toContain(SECRET);
    expect(failed[0]).not.toMatch(absPath);
  });
});
