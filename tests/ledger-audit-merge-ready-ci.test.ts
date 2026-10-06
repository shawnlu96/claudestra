/** MAINP2 验收线 7（审查 r1 audit-unwired）：audit 的 CI 来源按当前 head 现查必需检查；fake gh 记调用，读失败整项目 null。 */
import { describe, expect, test } from "bun:test";
import type { AuditSnapshot } from "../src/lib/ledger-audit.js";
import { collectMergeCi, type MergeCiDeps } from "../src/lib/ledger-audit-merge-ready.js";
import type { EventKind, LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import type { Run } from "../src/lib/review-main-carry-manual-ci.js";

const H = "a".repeat(40), H2 = "b".repeat(40), NOW = 1_000_000, CHECKS = ["typecheck", "test", "build"];
let seq = 0;
const ev = (kind: EventKind, data: Record<string, unknown>, id: string): LedgerEvent =>
  ({ seq: ++seq, ts: ++seq, actor: "x", project: "p", target: id, kind, text: "", data, dedupKey: null });
const card = (id: string, over: Partial<LedgerTask> = {}, verdict = "pass"): AuditSnapshot["tasks"][number] => {
  const task = { id, project: "p", itemId: null, title: id, kind: "code", stage: "merge", stageBefore: null, round: 1, agent: "a", pm: "pm", branch: "b",
    pr: "https://github.com/o/r/pull/1", headSHA: H, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 0, updatedAt: 0,
    assigneeKind: "agent", assignee: "a", ...over } as LedgerTask;
  return { task, events: [ev("review", { round: 1, head: task.headSHA, verdict, reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", path: "r.md",
    findings: verdict === "pass" ? [] : [{ findingId: "f", family: "x", severity: "P1", probe: "a:1" }], p0: 0, p1: verdict === "pass" ? 0 : 1, p2: 0 }, id)] };
};
function gh(runs: (head: string) => { name: string; status: string; conclusion: string | null }[] | "fail") {
  const calls: string[][] = [];
  const run: Run = async (argv) => {
    calls.push(argv);
    const head = /commits\/([a-f0-9]{40})\/check-runs/.exec(argv[2] ?? "")?.[1]!;
    const r = runs(head);
    if (r === "fail") return { code: 1, stdout: "", stderr: "network", timedOut: false };
    const list = r.map((x, i) => ({ id: i + 1, head_sha: head, ...x }));
    return { code: 0, stdout: JSON.stringify({ total_count: list.length, check_runs: list }), stderr: "", timedOut: false };
  };
  return { run, calls };
}
const ok = (names = CHECKS) => names.map((name) => ({ name, status: "completed", conclusion: "success" }));
const deps = (run: Run, checks: unknown = CHECKS): MergeCiDeps => ({ run, checksOf: () => checks });

describe("collectMergeCi: the audit's live current-head CI source", () => {
  test("green / missing / red / pending per card, on exactly the card's current head; cards without a PASS cost no call", async () => {
    const g = gh((h) => (h === H ? ok() : [...ok(["typecheck"]), { name: "test", status: "completed", conclusion: "failure" }]));
    const out = await collectMergeCi("p", [card("T1"), card("T2", { headSHA: H2 }), card("T3", {}, "changes"), card("T4", { stage: "review" })], NOW, deps(g.run));
    expect(out).toEqual({
      T1: { head: H, state: "green", source: "live", checkedAt: NOW, missing: [] },
      T2: { head: H2, state: "red", source: "live", checkedAt: NOW, missing: ["test", "build"] },
    });
    expect(g.calls.map((c) => c[2])).toEqual([`repos/o/r/commits/${H}/check-runs?per_page=100`, `repos/o/r/commits/${H2}/check-runs?per_page=100`]);
    const pending = await collectMergeCi("p", [card("T1")], NOW, deps(gh(() => [...ok(["typecheck", "test"]), { name: "build", status: "in_progress", conclusion: null }]).run));
    expect(pending?.T1).toMatchObject({ state: "pending", missing: ["build"] });
  });
  test("network failure, truncated list or no project checks → null for the project (rule skips), never green", async () => {
    expect(await collectMergeCi("p", [card("T1")], NOW, deps(gh(() => "fail").run))).toBeNull();
    expect(await collectMergeCi("p", [card("T1")], NOW, deps(gh(() => ok()).run, null))).toBeNull();
    expect(await collectMergeCi("p", [card("T1")], NOW, deps(gh(() => ok()).run, []))).toBeNull();
    expect(await collectMergeCi("p", [card("T3", {}, "changes")], NOW, deps(gh(() => "fail").run))).toEqual({});
  });
});
