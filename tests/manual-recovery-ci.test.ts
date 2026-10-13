/**
 * CIRES1 · a card the bounce limit parked at merge for a ci_fail goes back to auto once the one re-run the ledger had authorized
 * (CIF1 / CIF8's merge_ci_rerun) went green on the same head; `ciManualResume` on hands it back exactly once through RECBASE1's
 * writer and sends no re-run of its own. Fixture and the real path: tests/manual-recovery-ci-kit.test.ts. Coexistence with the
 * planner, the merge driver, the train and PM: tests/manual-recovery-ci-coexist.test.ts.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { revokeKnownFlaky } from "../src/lib/ci-known-flaky.js";
import { CI_MANUAL_RESUME } from "../src/lib/manual-recovery-ci.js";
import { CI_SNAPSHOT_LEASE_MS, ciSnapshotGap, readCiEvidence, setCiEvidenceGh } from "../src/lib/manual-recovery-ci-read.js";
import { extensionMode } from "../src/lib/manual-recovery-policy.js";
import { proveRecovery } from "../src/lib/manual-recovery-release.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-policy.js";
import { H2 } from "./scheduler-auto-helpers.js";
import { assertLog, ci, ev, FLAKY, H3, isolate, observed, policy, prove, PR, reads, recover, reruns, RUN, run, SLOW, state, turnOn, wf, type Ci } from "./manual-recovery-ci-kit.test.js";

isolate();
const resumes = (f: Ci) => ev(f, "workflow_resume");
const autoAgain = (before: ReturnType<typeof state>) => ({ ...before, workflow: { ...(before.workflow as object), mode: "auto", rev: (before.workflow as { rev: number }).rev + 1 } });

describe("[验收线 1] authorized known-flaky re-run green on the same head, journal settled, card at merge", () => {
  test("the real path is what the kit says: 4th bounce is a settled ci_fail with one formal claim, the card is manual at merge", () => run({}, async (f) => {
    expect(ev(f, "merge_ci_rerun")).toEqual([expect.objectContaining({ actor: "scheduler", data: expect.objectContaining({ intentId: f.merge, prHead: H2, run: RUN,
      checks: ["ci"], knownFlaky: [expect.objectContaining({ file: FLAKY })] }) })]);
    expect(ev(f, "merge_conflict").at(-1)!.data).toMatchObject({ intentId: f.merge, cause: "ci_fail", count: 4, escalated: true, prHead: H2 });
    expect(ev(f, "fallback_manual").at(-1)).toMatchObject({ actor: "scheduler", data: { from: "auto", manualReason: { code: "merge_unknown" } } });
    expect(state(f)).toMatchObject({ stage: "merge", workflow: { mode: "manual" }, merges: [{ intentId: f.merge, phase: "resolved", mergeSha: null }] });
    expect(reruns(f)).toBe(1); // CIF8's own, before the card ever went manual
  }));

  test("red baseline: with the mechanism off the card stays manual tick after tick, whatever GitHub shows now", () => run({}, async (f) => {
    await policy(f, "on", "manualStall");
    await policy(f, "off", "ciManualResume");
    const before = state(f);
    for (let i = 0; i < 3; i++) expect(await ci(f)).toEqual([]);
    expect(state(f)).toEqual(before);
    expect(resumes(f)).toHaveLength(0);
    expect(reads(f)).toBe(0);
  }));

  test("on: exactly one hand-back, bound to the episode, the bounce count, the cancelled intent, the claim and the run's attempt; no new re-run", () => run({}, async (f) => {
    await turnOn(f);
    const entry = ev(f, "fallback_manual").at(-1)!, claim = ev(f, "merge_ci_rerun")[0], before = state(f), notices = f.notices.length;
    expect(await ci(f)).toEqual([expect.objectContaining({ mode: "on", action: "resumed" })]);
    expect(resumes(f)).toHaveLength(1);
    expect(resumes(f)[0]).toMatchObject({ actor: "scheduler", data: { auto: true, from: "manual", stage: "merge", recoveryProof: { mechanism: CI_MANUAL_RESUME,
      taskId: "T1", episodeId: `e${entry.seq}.b4`, reason: "merge_unknown", subreason: "merge_bounce_limit", cancelIntentId: f.merge, evidenceSeq: claim.seq,
      head: H2, specRev: 1, next: "merge", external: { source: `gh:${PR}`, facts: { pr: { state: "OPEN", head: H2 }, checks: [{ name: "ci", bucket: "pass", run: RUN }],
        runs: [{ link: RUN, attempt: 2, status: "completed", conclusion: "success", first: { kind: "known_flaky", files: [FLAKY] } }] } } } } });
    // the hand-back did not escalate again: the planner, with the sealed proof in view, plans the merge
    expect(ev(f, "manual_recovery_proof")).toEqual([expect.objectContaining({ seq: resumes(f)[0].seq + 1,
      data: expect.objectContaining({ episodeId: `e${entry.seq}.b4`, next: { kind: "intent", node: "merge_deploy", action: "merge" } }) })]);
    // nothing but the mode moved: no stage, no review, no slot, no run, and the bounce history is as it was
    expect(state(f)).toEqual(autoAgain(before));
    expect(reruns(f)).toBe(1);
    expect(f.notices.slice(notices).filter((n) => n.includes("manual 扩展恢复"))).toHaveLength(1);
    expect(await ci(f)).toEqual([]);
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    expect(wf(f).mode).toBe("auto");
    expect(resumes(f)).toHaveLength(1);
  }));

  test("CIF1's claim (untouched test timeouts) is the same formal authorization", () => run({ claim: "timeout" }, async (f) => {
    await turnOn(f);
    expect(ev(f, "merge_ci_rerun")[0].data).toMatchObject({ cases: [expect.stringContaining(SLOW)] });
    expect(ev(f, "merge_ci_rerun")[0].data.knownFlaky).toBeUndefined();
    expect(await ci(f)).toEqual([expect.objectContaining({ mode: "on", action: "resumed" })]);
    expect(resumes(f)[0].data).toMatchObject({ recoveryProof: { external: { facts: { runs: [{ first: { kind: "timeout", files: [SLOW] } }] } } } });
    expect(reruns(f)).toBe(1);
  }));
});

describe("[验收线 2] anything short of the full evidence → zero recovery", () => {
  const cases: [string, Parameters<typeof run>[0], (f: Ci) => unknown, string][] = [
    ["只有 attempt>1、现在绿，没有正式授权", { claim: "none" }, () => {}, "没有 CIF1 / CIF8 的正式重跑授权"],
    ["首次失败解析不出（未分类）", {}, (f) => { f.gh.firstLog = "ci\tRun tests\t2026-10-10T11:02:03.1Z something broke"; }, "首次失败现在归类为 unknown"],
    ["首次失败多出一个清单外的文件", {}, (f) => { f.gh.firstLog = assertLog(FLAKY, "tests/other.test.ts"); }, "和授权重跑时登记的不一致"],
    ["已知偶发条目已撤销", {}, (f) => revokeKnownFlaky(f.db, f.at("owner"), { project: "p", file: FLAKY, reason: "已修好" }), "已失效或被替换"],
    ["失败文件被本 PR 修改", {}, (f) => { f.gh.files = ["src/lib/x.ts", FLAKY]; }, "首次失败现在归类为 code"],
    ["必过检查缺失", {}, (f) => { f.gh.checks = [{ name: "lint", bucket: "pass", link: `${RUN}/job/11` }]; }, "必过检查 ci 缺失"],
    ["必过检查 pending", {}, (f) => { f.gh.checks = [{ name: "ci", bucket: "pending", link: `${RUN}/job/10` }]; }, "没有完成 success"],
    ["必过检查又红了", {}, (f) => { f.gh.checks = [{ name: "ci", bucket: "fail", link: `${RUN}/job/10` }]; }, "没有完成 success"],
    ["别的检查红", {}, (f) => { f.gh.checks.push({ name: "e2e", bucket: "fail", link: `${RUN}/job/12` }); }, "检查 e2e 是 fail"],
    ["head 漂移", {}, (f) => { f.gh.head = H3; }, "PR head 已漂移"],
    ["PR 已关闭", {}, (f) => { f.gh.state = "CLOSED"; }, "PR 不是 main 上打开的本仓 PR"],
    ["重跑其实没发生", {}, (f) => { f.gh.attempt = 1; }, "授权的重跑没有发生"],
    ["run 被重跑了不止一次", {}, (f) => { f.gh.attempt = 3; }, "超出一次正式授权"],
    ["重跑还没结束", {}, (f) => { f.gh.status = "in_progress"; f.gh.conclusion = ""; }, "重跑没有成功完成"],
    ["通过的检查不在授权的那个 run 上", {},
      (f) => { f.gh.checks = [{ name: "ci", bucket: "pass", link: "https://github.com/example/repo/actions/runs/78/job/1" }]; }, "不在那个 run 上"],
    ["外部读取失败", {}, (f) => { f.gh.broken = new Error("gh: HTTP 502"); }, "读外部证据失败"],
  ];
  for (const [what, over, twist, why] of cases) test(`${what} → refused, card stays manual, no re-run`, () => run(over, async (f) => {
    await turnOn(f);
    await twist(f);
    const before = state(f), sent = reruns(f);
    expect(await prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining(why) });
    const rows = await ci(f);
    expect(rows).toHaveLength(1);
    expect(["none", "refused"]).toContain(rows[0].action);
    expect(rows[0].why).toContain("责任人 PM"); // the gap keeps its owner, deadline and next step
    expect(await recover(f, "on")).toMatchObject({ ok: false });
    expect(state(f)).toEqual(before);
    expect(resumes(f)).toHaveLength(0);
    expect(observed(f)).toHaveLength(0);
    expect(reruns(f)).toBe(sent);
  }));

  const finalChanges = [
    ["loses required ci on the same OPEN/head", { checks: [{ name: "lint", bucket: "pass", link: `${RUN}/job/11` }] }],
    ["changes base", { base: "release" }], ["changes branch", { branch: "other" }], ["changes draft", { draft: true }],
    ["changes crossRepository", { crossRepository: true }],
    ["changes bucket", { checks: [{ name: "ci", bucket: "pending", link: `${RUN}/job/10` }] }],
    ["changes job link", { checks: [{ name: "ci", bucket: "pass", link: `${RUN}/job/12` }] }],
  ] as const;
  for (const [field, change] of finalChanges) test(`final inspect ${field} → zero hand-back`, () => run({}, async (f) => {
    await turnOn(f);
    let inspections = 0;
    setCiEvidenceGh({ ...f.evidence, inspect: async (ref) => {
      const pr = await f.evidence.inspect(ref);
      return ++inspections === 1 ? pr : { ...pr, ...change };
    } });
    const before = state(f);
    expect(await recover(f, "on")).toMatchObject({ ok: false });
    expect(inspections).toBe(2);
    expect(resumes(f)).toHaveLength(0);
    expect(state(f)).toEqual(before);
  }));

  test("a card the ledger rules out costs no GitHub read at all", () => run({ claim: "none" }, async (f) => {
    await turnOn(f);
    expect(await ci(f)).toEqual([expect.objectContaining({ action: "none", why: expect.stringContaining("attempt>1 或现在绿不能说明原失败是偶发") })]);
    expect(reads(f)).toBe(0);
  }));

  test("the snapshot is evidence only as this process read it, within its lease, for this PR", () => run({}, async (f) => {
    const want = { pr: PR, head: H2, required: ["ci"], claimed: ["ci"], run: RUN, kind: "known_flaky" as const, files: [FLAKY], now: Date.now() };
    const snap = await readCiEvidence(f.task());
    expect(ciSnapshotGap(snap, want)).toBeNull();
    expect(JSON.parse(JSON.stringify(snap)).readAt).toBeUndefined(); // off the JSON: the same facts give the same fingerprint on every read
    expect(ciSnapshotGap(JSON.parse(JSON.stringify(snap)), want)).toContain("缺本进程带租约读出的外部快照");
    expect(ciSnapshotGap(snap, { ...want, now: want.now + CI_SNAPSHOT_LEASE_MS + 60_000 })).toContain("租约已过期");
    snap.facts.checks[0]!.bucket = "pass ";
    expect(ciSnapshotGap(snap, want)).toContain("内容与摘要不符");
    expect(proveRecovery(f.db, f.task(), wf(f), CI_MANUAL_RESUME, null)).toMatchObject({ kind: "refused", why: "缺外部证据快照" });
  }));
});

describe("[验收线 4] observe records the candidate only; off does nothing; the default is observe; nothing recovers twice", () => {
  test("the key is registered exactly once and reads observe unless configured on explicitly", () => run({}, async (f) => {
    expect(RECOVERY_KEYS.filter((k) => k === "ciManualResume")).toHaveLength(1);
    expect(extensionMode("p", "ciManualResume")).toMatchObject({ mode: "observe" });
    await policy(f, "on"); // a project-wide on never opens a new mechanism
    expect(extensionMode("p", "ciManualResume")).toMatchObject({ mode: "observe" });
    await policy(f, "on", "manualRecovery"); // nor does the umbrella alone
    expect(extensionMode("p", "ciManualResume")).toMatchObject({ mode: "observe" });
    expect(await recover(f, "on")).toMatchObject({ ok: false, code: "forbidden" });
    await policy(f, "on", "ciManualResume");
    expect(extensionMode("p", "ciManualResume")).toMatchObject({ mode: "on" });
  }));

  test("observe (the default): one would-resume note with the evidence, repeated ticks add nothing; no resume, no notice, no re-run", () => run({}, async (f) => {
    const before = state(f), notices = f.notices.length, claim = ev(f, "merge_ci_rerun")[0];
    expect(await ci(f)).toEqual([expect.objectContaining({ mode: "observe", action: "would_resume" })]);
    expect(await ci(f)).toEqual([expect.objectContaining({ mode: "observe", action: "observed_before" })]);
    expect(observed(f)).toHaveLength(1);
    expect(observed(f)[0].data).toMatchObject({ next: { kind: "intent", action: "merge" }, recoveryProof: { mechanism: CI_MANUAL_RESUME, evidenceSeq: claim.seq,
      cancelIntentId: f.merge, subreason: "merge_bounce_limit" } });
    expect(state(f)).toEqual(before);
    expect(resumes(f)).toHaveLength(0);
    expect(f.notices).toHaveLength(notices);
    expect(reruns(f)).toBe(1);
  }));

  test("observe records the gap as the tick's row and writes nothing for it", () => run({}, async (f) => {
    f.gh.attempt = 3;
    const before = state(f);
    expect(await ci(f)).toEqual([expect.objectContaining({ mode: "observe", action: "refused", why: expect.stringContaining("超出一次正式授权") })]);
    expect(observed(f)).toHaveLength(0);
    expect(state(f)).toEqual(before);
  }));

  test("off: not judged, nothing read, nothing recorded; the writer refuses both modes", () => run({}, async (f) => {
    await policy(f, "on", "manualRecovery");
    await policy(f, "off", "ciManualResume");
    const before = state(f), seq = f.db.query("SELECT MAX(seq) AS n FROM events").get();
    expect(await ci(f)).toEqual([]);
    for (const mode of ["observe", "on"] as const) expect(await recover(f, mode)).toMatchObject({ ok: false, code: "forbidden" });
    expect(f.db.query("SELECT MAX(seq) AS n FROM events").get()).toEqual(seq);
    expect(state(f)).toEqual(before);
    expect(reads(f)).toBe(0);
  }));

  test("two ticks and a restart after the hand-back: still one workflow_resume; the spent episode never hands back again", () => run({}, async (f) => {
    await turnOn(f);
    await ci(f); await ci(f);
    const fresh = new Database(join(f.dir, "ledger.sqlite"), { readonly: true }); // what a restarted scheduler reads
    try { expect(fresh.query("SELECT COUNT(*) AS n FROM events WHERE json_extract(data, '$.op') = 'workflow_resume'").get()).toEqual({ n: 1 }); }
    finally { fresh.close(); }
    expect(await recover(f, "on")).toMatchObject({ ok: false });
    f.db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'").run(); // forced back without a new formal entry
    expect(await recover(f, "on")).toMatchObject({ ok: false });
    expect(await ci(f)).not.toContainEqual(expect.objectContaining({ action: "resumed" }));
    expect(resumes(f)).toHaveLength(1);
    expect(reruns(f)).toBe(1);
  }));

  test("the switch turned off between the read and the write: nothing is handed back", () => run({}, async (f) => {
    await turnOn(f);
    const offFirst = async (...a: string[]) => { await policy(f, "off", "ciManualResume"); return f.manager(...a); };
    expect(await ci(f, offFirst)).toEqual([expect.objectContaining({ action: "refused" })]);
    expect(await ci(f)).toEqual([]);
    expect(resumes(f)).toHaveLength(0);
    expect(wf(f).mode).toBe("manual");
  }));

  test("PM's own workflow-resume lands first: one resume, PM's, and no proof is sealed", () => run({}, async (f) => {
    await turnOn(f);
    const pmFirst = async (...a: string[]) => {
      expect(await f.cli("pm", "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf(f).rev), "--reason", "PM 自己交回")).toMatchObject({ ok: true });
      return f.manager(...a);
    };
    expect(await ci(f, pmFirst)).toEqual([expect.objectContaining({ action: "refused" })]);
    expect(resumes(f).map((e) => [e.actor, e.data.manual])).toEqual([["pm", true]]);
    expect(ev(f, "manual_recovery_proof")).toHaveLength(0);
  }));
});
