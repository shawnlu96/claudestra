/** PRL-1：新建提案提交前先过本机副本限制（centerReplicaLimitReason）；过不了当场拒、拒因是 REPLICA_REASONS 那一项，不入 journal、不发中心。 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { REPLICA_REASONS } from "../src/lib/shared-ledger-center-replica.js";
import { PROPOSAL_TEXT } from "../src/bridge/local-api/shared-feature-proposals.js";
import { api, center, fx, journalPath, ledgerWrites, planFeature, submitBody, useProposalHarness, ZERO } from "./shared-feature-proposals-kit.js";

useProposalHarness();

const [n1, n2] = fx.newProposal.nodes;
const CASES = [
  { label: "节点一句话 61 字", patch: { nodes: [{ ...n1, oneLine: "一".repeat(61) }, n2] }, reason: REPLICA_REASONS.oneLine },
  { label: "节点一句话两行", patch: { nodes: [{ ...n1, oneLine: "第一行\n第二行" }, n2] }, reason: REPLICA_REASONS.oneLine },
  { label: "标题 61 字", patch: { title: "题".repeat(61) }, reason: REPLICA_REASONS.title },
  { label: "estimate 21 字", patch: { nodes: [{ ...n1, estimate: "估".repeat(21) }, n2] }, reason: REPLICA_REASONS.estimate },
  { label: "key 带冒号", patch: { nodes: [{ ...n1, key: "n:1" }, { ...n2, deps: ["n:1"] }] }, reason: REPLICA_REASONS.key },
];
const AT_LIMIT = { title: "题".repeat(60), nodes: [{ ...n1, oneLine: "一".repeat(60), estimate: "估".repeat(20) }, n2] };

const untouched = () => {
  expect(center.seen).toEqual([]);
  expect(existsSync(journalPath())).toBe(false);
  expect(ledgerWrites()).toEqual(ZERO);
};

describe("plan_feature（绑定团队项目）新建提案", () => {
  for (const c of CASES) {
    test(`${c.label} → 拒，拒因对上本机限制；不入 journal、中心 0 次`, async () => {
      expect(await planFeature({ project: "proj-bound", ...c.patch })).toMatchObject({ ok: false, code: "invalid", error: c.reason });
      untouched();
    });
  }
  test("刚好 60 字标题 / 一句话、20 字 estimate 照常提交", async () => {
    expect(await planFeature({ project: "proj-bound", ...AT_LIMIT })).toMatchObject({ ok: true, state: "pending_approval", message: PROPOSAL_TEXT.pending_approval });
    expect(center.received).toHaveLength(1);
  });
});

describe("本地 API POST 新建提案", () => {
  for (const c of CASES) {
    test(`${c.label} → 400 invalid_proposal，error 是本机限制拒因；不入 journal、中心 0 次`, async () => {
      const res = await api("POST", "/api/v1/shared-feature-proposals", { ...submitBody, ...c.patch });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, code: "invalid_proposal", error: c.reason });
      untouched();
    });
  }
  test("刚好 60 字照常提交", async () => {
    const res = await api("POST", "/api/v1/shared-feature-proposals", { ...submitBody, ...AT_LIMIT });
    expect(res.status).toBe(200);
    expect(center.received).toHaveLength(1);
  });
});
