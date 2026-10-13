/**
 * RECBASE1 · the evidence-recovery contract on a real temp ledger through the formal entries: MAN1's `workflow-set --reason-code`,
 * CFG's `scheduler-recovery`, the leased `scheduler-manual-resume --mechanism` and the scheduler's manual-resume tick wiring.
 * Fixture mechanisms only: production registers none, so MAN2 (tests/manual-resume*.test.ts, unchanged) stays the only live path.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { extensionMode, filePolicyPort, type ExplicitPolicyPort } from "../src/lib/manual-recovery-policy.js";
import { registerManualRecovery, type ManualRecoveryMechanism } from "../src/lib/manual-recovery-release.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { manualResumeManagerTick, recoveryArgs, recoveryFence, type RecoveryManager } from "../src/lib/scheduler-recovery-ports.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;

let saved: Buffer | null = null;
const fx = { cancel: null as string | null, refuse: null as string | null, episode: null as string | null, onRead: null as (() => unknown) | null, readFail: null as string | null };
let judged = 0;
const judge: ManualRecoveryMechanism["judge"] = ({ entrySeq }) => ++judged && fx.refuse ? { ok: false, why: fx.refuse }
  : { ok: true, episodeId: fx.episode ?? `ep-${entrySeq}`, subreason: "fixture", cancelIntentId: fx.cancel, evidenceSeq: entrySeq, next: "plan" };
const CODES = ["runtime_unavailable", "merge_unknown"] as const;
let off: (() => void)[] = [];
beforeEach(() => {
  expect(RECOVERY_POLICY_PATH.startsWith(join(homedir(), ".claude-orchestrator"))).toBe(false);
  saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
  rmSync(RECOVERY_POLICY_PATH, { force: true });
  Object.assign(fx, { cancel: null, refuse: null, episode: null, onRead: null, readFail: null });
  judged = 0;
  off = [registerManualRecovery({ id: "fixture", key: "manualRecovery", codes: CODES, releasesCancel: true, judge }),
    registerManualRecovery({ id: "fixture-ext", key: "manualRecovery", codes: ["materials_gate"], judge, readEvidence: async () => {
      await fx.onRead?.();
      if (fx.readFail) throw new Error(fx.readFail);
      return { source: "ci", digest: "c1", readAt: 1 };
    } })];
});
afterEach(() => {
  for (const o of off) o();
  if (saved) writeFileSync(RECOVERY_POLICY_PATH, saved);
  else rmSync(RECOVERY_POLICY_PATH, { force: true });
});

const wf = (f: F) => getWorkflow(f.db, "T1")!;
const ev = (db: Database, op: string) => listEvents(db, { project: "p", target: "T1" }).filter((e) => e.data.op === op);
const projectSeq = (db: Database) => (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
const state = (f: F) => ({
  intents: f.db.query("SELECT id, status FROM scheduler_intents ORDER BY id").all(),
  resources: f.db.query("SELECT resource, intentId FROM scheduler_resources ORDER BY resource").all(),
  workflow: f.db.query("SELECT mode, rev, specRev FROM task_workflows WHERE taskId = 'T1'").get(),
  stage: f.task().stage, resumes: ev(f.db, "workflow_resume").length,
});
const policy = async (f: F, mode: RecoveryMode | "inherit", key?: string) => expect(await f.cli("pm", "scheduler-recovery", "p", mode,
  ...(key ? ["--key", key] : []), "--reason", `RECBASE1 测试：${key ?? "项目"} ${mode}`)).toMatchObject({ ok: true });
const manual = (f: F, code = "runtime_unavailable", text = "执行会话挂了") => f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev),
  "--workflow-rev", String(wf(f).rev), "--template", wf(f).template, "--version", "2", "--mode", "manual", "--author-family", "claude",
  "--fallback", "只报错不修", "--reason-code", code, "--reason", text);
const recover = (f: F, mode: "on" | "observe", mechanism = "fixture", extra: string[] = []) => f.cli("scheduler", "scheduler-manual-resume", "T1",
  ...recoveryArgs(recoveryFence(f.db, f.task())), "--mode", mode, "--mechanism", mechanism, "--max-workers", "2", ...extra);
const realManager = (f: F): RecoveryManager => (...a: string[]) => f.cli("scheduler", ...a.slice(1)) as Promise<Record<string, unknown>>;
const tick = (f: F, manager = realManager(f), extensionPolicy?: ExplicitPolicyPort) =>
  manualResumeManagerTick(f.db, { p: { maxActiveWorkers: 2 } }, { manager, notifyPm: f.tickDeps.notifyPm, now: f.tickDeps.now, extensionPolicy });
const ext = async (f: F, manager?: RecoveryManager) => (await tick(f, manager)).filter((o) => "mechanism" in o);
const run = async (f: F, body: (f: F) => Promise<void>) => { try { await body(f); } finally { f.close(); } };
const ready = async (f: F) => expect(await manual(f)).toMatchObject({ ok: true });

describe("[验收线 1] observe records would_resume and changes nothing; off adds nothing", () => {
  test("default (no file) is observe: one would_resume per proof, workflow / intents / resources / stage untouched", () => run(autoFixture(), async (f) => {
    await ready(f);
    await policy(f, "off", "manualCaseOwnership"); // OWN1 夹具：本例只测别的机制
    const before = state(f);
    expect(await ext(f)).toEqual([expect.objectContaining({ mechanism: "fixture", mode: "observe", action: "would_resume" })]);
    expect(state(f)).toEqual(before);
    const note = ev(f.db, "recovery_observe");
    expect(note).toHaveLength(1);
    expect(note[0].data).toMatchObject({ mechanism: "manualRecovery", recoveryProof: { mechanism: "fixture", taskId: "T1", reason: "runtime_unavailable",
      cancelIntentId: null, external: null, next: "plan" } });
    expect(await ext(f)).toEqual([expect.objectContaining({ action: "observed_before" })]);
    expect(ev(f.db, "recovery_observe")).toHaveLength(1);
  }));

  test("a 120-character mechanism id (the registry's limit) still observes: the observe key is fixed-length", () => run(autoFixture(), async (f) => {
    const id = "m".repeat(120);
    const drop = registerManualRecovery({ id, key: "manualRecovery", codes: ["runtime_unavailable"], judge });
    try {
      await ready(f);
      const before = state(f);
      expect(await recover(f, "observe", id)).toMatchObject({ ok: true, recorded: true });
      expect(state(f)).toEqual(before);
      expect(ev(f.db, "recovery_observe").at(-1)!.data).toMatchObject({ recoveryProof: { mechanism: id } });
      expect(await recover(f, "observe", id)).toMatchObject({ ok: true, recorded: false });
    } finally { drop(); }
  }));

  test("off on the umbrella or the mechanism key: not judged, not recorded, the CLI refuses", () => run(autoFixture(), async (f) => {
    await ready(f);
    await policy(f, "off", "manualCaseOwnership"); // OWN1 夹具：本例只测别的机制
    await policy(f, "off", "manualRecovery");
    const seq = projectSeq(f.db), before = state(f);
    expect(await ext(f)).toEqual([]);
    expect(await recover(f, "observe")).toMatchObject({ ok: false, code: "forbidden" });
    expect(projectSeq(f.db)).toBe(seq);
    expect(state(f)).toEqual(before);
  }));

  test("off or a mode mismatch refuses before the external read: no evidence read, no judge", () => run(autoFixture(), async (f) => {
    expect(await manual(f, "materials_gate", "材料闸挂了")).toMatchObject({ ok: true });
    let reads = 0;
    fx.onRead = () => { reads++; };
    await policy(f, "off", "manualRecovery");
    let seq = projectSeq(f.db);
    for (const mode of ["observe", "on"] as const) expect(await recover(f, mode, "fixture-ext")).toMatchObject({ ok: false, code: "forbidden" });
    expect(projectSeq(f.db)).toBe(seq);
    await policy(f, "observe", "manualRecovery");
    seq = projectSeq(f.db);
    expect(await recover(f, "on", "fixture-ext")).toMatchObject({ ok: false, code: "forbidden" });
    expect({ reads, judged, seq: projectSeq(f.db) }).toEqual({ reads: 0, judged: 0, seq });
  }));

  test("MAN2 itself is unchanged: a non-deps code stays with MAN2's refusal while the fixture handles it", () => run(autoFixture(), async (f) => {
    await ready(f);
    await policy(f, "on", "manualStall");
    const out = await tick(f);
    expect(out.find((o) => !("mechanism" in o))).toMatchObject({ mode: "on", action: "none", why: expect.stringContaining("不由自动恢复解除") });
    expect(state(f).resumes).toBe(0);
  }));
});

describe("[验收线 2] a new mechanism needs its own explicit on; bad policy refuses", () => {
  test("project-wide on reads observe; only keys.manualRecovery = on acts, through resumeCore once", () => run(autoFixture(), async (f) => {
    await ready(f);
    await policy(f, "on");
    expect(extensionMode("p", "manualRecovery")).toMatchObject({ mode: "observe", why: expect.stringContaining("项目总档 on 不开新机制") });
    expect(await ext(f)).toEqual([expect.objectContaining({ mode: "observe", action: "would_resume" })]);
    expect(await recover(f, "on")).toMatchObject({ ok: false, code: "forbidden" });
    expect(wf(f).mode).toBe("manual");
    await policy(f, "on", "manualRecovery");
    expect(await ext(f)).toEqual([expect.objectContaining({ mode: "on", action: "resumed" })]);
    const resumes = ev(f.db, "workflow_resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ actor: "scheduler", data: { auto: true, from: "manual", recoveryProof: { mechanism: "fixture", fingerprint: expect.any(String) } } });
    expect(resumes[0].data.manual).toBeUndefined();
    expect(ev(f.db, "manual_recovery_proof")).toEqual([expect.objectContaining({ seq: resumes[0].seq + 1, data: expect.objectContaining({ resumeSeq: resumes[0].seq }) })]);
    expect(wf(f).mode).toBe("auto");
    expect(f.notices.filter((n) => n.includes("manual 扩展恢复"))).toHaveLength(1);
  }));

  test("umbrella vs mechanism key: the most conservative wins; error beats off beats observe", () => {
    const port = (modes: Record<string, { mode: RecoveryMode; explicit: RecoveryMode | null; error?: boolean }>): ExplicitPolicyPort => () => (key) => {
      const m = modes[key] ?? { mode: "observe", explicit: null };
      return { policy: { mode: m.error ? "off" : m.mode, manualAfterMs: null, source: m.error ? "error" : "config", diagnostic: m.error ? "坏文件" : undefined }, explicit: m.explicit };
    };
    const on = { mode: "on" as const, explicit: "on" as const };
    expect(extensionMode("p", "uiCarry", port({ manualRecovery: on, uiCarry: on }))).toMatchObject({ mode: "on" });
    expect(extensionMode("p", "uiCarry", port({ manualRecovery: on, uiCarry: { mode: "on", explicit: null } }))).toMatchObject({ mode: "observe" });
    expect(extensionMode("p", "uiCarry", port({ manualRecovery: { mode: "off", explicit: "off" }, uiCarry: on }))).toMatchObject({ mode: "off" });
    expect(extensionMode("p", "uiCarry", port({ manualRecovery: on, uiCarry: { mode: "off", explicit: null, error: true } }))).toMatchObject({ mode: "error" });
    expect(extensionMode("p", "uiCarry", () => { throw new Error("读炸了"); })).toMatchObject({ mode: "error", why: expect.stringContaining("读炸了") });
  });

  test("an invalid policy file is an error: the tick reports refused, the CLI refuses, nothing is written", () => run(autoFixture(), async (f) => {
    await ready(f);
    writeFileSync(RECOVERY_POLICY_PATH, "{ not json");
    const seq = projectSeq(f.db);
    expect(await ext(f)).toEqual([expect.objectContaining({ action: "refused", why: expect.stringContaining("读不了") })]);
    for (const mode of ["on", "observe"] as const) expect(await recover(f, mode)).toMatchObject({ ok: false, code: "forbidden" });
    expect(projectSeq(f.db)).toBe(seq);
    expect(filePolicyPort("/nonexistent/recovery-policy.json")("p")("manualRecovery")).toMatchObject({ policy: { source: "default" }, explicit: null });
  }));

  test("one decision reads the policy once: a file swapped mid-decision never mixes a valid mode with an unvalidated explicit key", () => {
    const valid = { projects: { p: { mode: "on" } } };
    const invalid = { projects: { p: { mode: "on", keys: { manualRecovery: "on", uiCarry: "on" }, unknown: true } } };
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify(invalid));
    expect(extensionMode("p", "uiCarry")).toMatchObject({ mode: "error" });
    let snapshots = 0;
    const swapping: ExplicitPolicyPort = (project) => {
      snapshots++;
      writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify(valid));
      const read = filePolicyPort()(project);
      writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify(invalid));
      return read;
    };
    for (const key of ["manualRecovery", "uiCarry"] as const) expect(extensionMode("p", key, swapping)).toMatchObject({ mode: "observe" });
    expect(snapshots).toBe(2);
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { mode: "on", keys: { manualRecovery: "on" }, unknown: true } } }));
    expect(filePolicyPort()("p")("manualRecovery")).toMatchObject({ policy: { source: "error", mode: "off" }, explicit: null });
  });
});

describe("[验收线 3] re-checked in the transaction after the evidence read; one proof resumes once", () => {
  const drifts: [string, (f: F) => Promise<unknown> | unknown][] = [
    ["PM 新增 hold", (f) => manual(f, "pm_hold", "PM 先压住")],
    ["head 变了", (f) => f.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run("a".repeat(40))],
    ["spec 变了", (f) => f.db.query("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'").run()],
    ["round 变了", (f) => f.db.query("UPDATE tasks SET round = round + 1 WHERE id = 'T1'").run()],
    ["开了 ask", (f) => f.db.query(`INSERT INTO asks (id, project, taskId, source, kind, title, expiresAt, state, createdAt, updatedAt)
      VALUES ('A1', 'p', 'T1', 'human', 'decide', '要不要', 9e12, 'open', 1, 1)`).run()],
    ["PM 留了一条备注", (f) => f.cli("pm", "note", "T1", "撤回人工请求前先看一眼")],
  ];
  for (const [what, drift] of drifts) test(`${what} during the read → refused, card stays manual`, () => run(autoFixture(), async (f) => {
    expect(await manual(f, "materials_gate", "材料闸挂了")).toMatchObject({ ok: true });
    await policy(f, "on", "manualRecovery");
    fx.onRead = () => { fx.onRead = null; return drift(f); };
    const r = await recover(f, "on", "fixture-ext");
    expect(r).toMatchObject({ ok: false });
    expect(["conflict", "forbidden"]).toContain(r.code as string);
    expect(ev(f.db, "workflow_resume").filter((e) => e.actor === "scheduler")).toHaveLength(0);
    expect(wf(f).mode).toBe("manual");
  }));

  test("losing the lease during the read, or a failed read, refuses before any write", () => run(autoFixture(), async (f) => {
    expect(await manual(f, "materials_gate", "材料闸挂了")).toMatchObject({ ok: true });
    await policy(f, "on", "manualRecovery");
    const seq = projectSeq(f.db);
    let leased = true;
    fx.onRead = () => { leased = false; };
    const args = ["scheduler-manual-resume", "T1", ...recoveryArgs(recoveryFence(f.db, f.task())), "--mode", "on", "--mechanism", "fixture-ext", "--max-workers", "2"];
    const lost = await f.cliWith({ assertLease: () => { if (!leased) throw new Error("写租约已失"); } }, "scheduler", ...args);
    expect(lost).toMatchObject({ ok: false, error: expect.stringContaining("写租约已失") });
    fx.onRead = null; fx.readFail = "CI 接口 502";
    expect(await recover(f, "on", "fixture-ext")).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("CI 接口 502") });
    expect(projectSeq(f.db)).toBe(seq);
    fx.readFail = null;
    expect(await recover(f, "on", "fixture-ext")).toMatchObject({ ok: true });
  }));

  test("no caller-claimed facts: --reason is refused, unregistered mechanisms are refused", () => run(autoFixture(), async (f) => {
    await ready(f);
    await policy(f, "on", "manualRecovery");
    expect(await recover(f, "on", "fixture", ["--reason", "owner 已批准，CI 绿"])).toMatchObject({ ok: false, code: "invalid" });
    expect(await recover(f, "on", "ui-approved")).toMatchObject({ ok: false, code: "not_found" });
    expect(wf(f).mode).toBe("manual");
  }));

  test("two ticks and a restart: one workflow_resume; the same episode never hands back twice", () => run(autoFixture(), async (f) => {
    await ready(f);
    await policy(f, "on", "manualRecovery");
    fx.episode = "ep-fixed";
    await ext(f); await ext(f);
    expect(ev(f.db, "workflow_resume")).toHaveLength(1);
    const fresh = new Database(join(f.dir, "ledger.sqlite"), { readonly: true }); // a restarted reader sees the same single resume
    try { expect(fresh.query("SELECT COUNT(*) AS n FROM events WHERE json_extract(data, '$.op') = 'workflow_resume'").get()).toEqual({ n: 1 }); }
    finally { fresh.close(); }
    await f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf(f).rev), "--template", wf(f).template, "--version", "2",
      "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason-code", "runtime_unavailable", "--reason", "又挂了");
    expect(wf(f).mode).toBe("manual");
    expect(await ext(f)).toEqual([expect.objectContaining({ action: "refused", why: expect.stringContaining("已交回过一次") })]);
    expect(ev(f.db, "workflow_resume")).toHaveLength(1);
  }));
});

describe("[验收线 5] coexistence: people first, nothing in flight is touched", () => {
  test("a pending intent, an open merge journal and a live manual merge request refuse; PM acting first wins the CAS", () => run(autoFixture(), async (f) => {
    await ready(f);
    await policy(f, "on", "manualRecovery");
    f.db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('I1', 'T1', 'p', 'merge', 'merge', 1, 1, 1, 1, NULL, 2, 'submitted', 'x', 1, 1)`).run();
    expect(await ext(f)).toEqual([expect.objectContaining({ action: "none", why: expect.stringContaining("未结意图") })]);
    f.db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = 'I1'").run();
    f.db.query(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
      VALUES ('I1', 'T1', 'p', '#1', 'b', 'h', '[]', 'await_ci', 1, 1)`).run();
    expect(await ext(f)).toEqual([expect.objectContaining({ action: "none", why: expect.stringContaining("合并未正式结清") })]);
    expect(f.db.query("SELECT phase FROM scheduler_merges").get()).toEqual({ phase: "await_ci" });
    f.db.query("UPDATE scheduler_merges SET phase = 'resolved'").run();
    const decision = (data: object) => (f.db.query(`INSERT INTO events (ts, actor, project, target, kind, text, data)
      VALUES (1, 'pm', 'p', 'T1', 'decision', '人工合并', ?) RETURNING seq`).get(JSON.stringify(data)) as { seq: number }).seq;
    const request = decision({ op: "manual_merge_request", head: "h", specRev: 1, round: 0, review: { seq: 1 } });
    expect(await ext(f)).toEqual([expect.objectContaining({ action: "none", why: expect.stringContaining("活的人工合并请求") })]);
    decision({ op: "manual_merge_revoke", request });
    const pmFirst: RecoveryManager = async (...a) => {
      expect(await f.cli("pm", "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf(f).rev), "--reason", "PM 自己交回")).toMatchObject({ ok: true });
      return realManager(f)(...a);
    };
    expect(await ext(f, pmFirst)).toEqual([expect.objectContaining({ action: "refused" })]);
    expect(ev(f.db, "workflow_resume").map((e) => e.data.manual)).toEqual([true]);
  }));

  test("the auto tick (planner, inspect, mergeCandidates, deploy) runs after a resume and the candidate never loops", () => run(autoFixture(), async (f) => {
    await ready(f);
    await policy(f, "on", "manualRecovery");
    await f.tick();
    expect(wf(f).mode).toBe("auto");
    expect(ev(f.db, "workflow_resume")).toHaveLength(1);
    await f.tick();
    expect(ev(f.db, "workflow_resume")).toHaveLength(1);
    expect(ev(f.db, "fallback_manual")).toHaveLength(0);
  }));

  test("a hand-back the planner would only escalate again is refused in observe and on alike", () => run(autoFixture(), async (f) => {
    await ready(f);
    f.db.query("UPDATE task_workflows SET fallback = ' ' WHERE taskId = 'T1'").run(); // planner: spec_missing
    for (const mode of ["observe", "on"] as const) {
      if (mode === "on") await policy(f, "on", "manualRecovery");
      const before = state(f), seq = projectSeq(f.db);
      expect(await recover(f, mode)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("不制造 auto/manual 循环") });
      expect(state(f)).toEqual(before);
      expect(projectSeq(f.db)).toBe(seq);
    }
  }));
});

describe("[验收线 6] central mapping / V2 skip keep their refusal; the key is registered once", () => {
  test("a v2_unmapped answer is that card's refusal; nothing escapes the tick", () => run(autoFixture(), async (f) => {
    await ready(f);
    const v2: RecoveryManager = async () => ({ ok: false, code: "v2_unmapped", error: "中心映射卡" });
    expect(await ext(f, v2)).toEqual([expect.objectContaining({ action: "refused", why: expect.stringContaining("v2_unmapped") })]);
    expect(wf(f).mode).toBe("manual");
  }));

  test("RECOVERY_KEYS carries manualRecovery exactly once", () => {
    expect(RECOVERY_KEYS.filter((k) => k === "manualRecovery")).toHaveLength(1);
  });
});
