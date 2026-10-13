import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFailureResponsePortsForTest } from "../src/lib/ci-main-failure-response-runtime.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { getTask } from "../src/lib/ledger-store.js";
import { decide, mainCiTrainPaused } from "../src/lib/scheduler-main-ci-wiring-gate.js";
import { mainCiWorld, writePolicy } from "./scheduler-main-ci-wiring-world.test.ts";
import { correlationInput } from "./ci-main-failure-response.test.ts";

const saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH, "utf8") : null;
afterEach(() => {
  setFailureResponsePortsForTest(null);
  if (saved === null) rmSync(RECOVERY_POLICY_PATH, { force: true }); else writeFileSync(RECOVERY_POLICY_PATH, saved);
});
const writes = (calls: string[]) => calls.filter((c) => /^(update|serial-merge|match-head|rerun):/.test(c));

function inject(w: ReturnType<typeof mainCiWorld>) {
  w.ci.extraMainRuns.push({ id: 2, name: "ci scope full", head_sha: w.hub.main, status: "completed", conclusion: "success" });
  setFailureResponsePortsForTest({ read: async (i) => {
    const x = correlationInput(), head = x.related.head, base = x.related.base, sha = i.currentMainSha!;
    return { ...x, repo: w.repo, mainSha: sha, now: i.now, requiredChecks: i.health.target.requiredChecks,
      related: { ...x.related, repo: w.repo, completedAt: i.now - 200, checks: i.health.target.requiredChecks.filter((n) => n !== "ci scope full").map((name) => ({ name, conclusion: "success" })) },
      full: { ...x.full, repo: w.repo, checkout: sha, completedAt: i.now - 100,
        checks: i.health.target.requiredChecks.map((name) => ({ name, conclusion: name === "check" ? "failure" : "success" })) },
      integration: { ...x.integration, sha, head, base } };
  } });
}

function responses(w: ReturnType<typeof mainCiWorld>) {
  return w.db.query("SELECT data FROM events WHERE json_extract(data,'$.op')='main_ci_failure_response'").all() as { data: string }[];
}

test("[验收线 1、3、4] real scheduler pass uses existing MAINCIW serial/train gate; one PM receipt/notice, zero fake git writes", async () => {
  const w = mainCiWorld();
  try {
    writePolicy({ mainCiPause: "on" }); inject(w);
    const c = w.card("C"); w.card("D"); w.ci.bySha.set(w.hub.main, "failure");
    expect(writes([...await w.pass(), ...await w.pass()])).toEqual([]);
    expect(w.gate!.modes.get("p")).toBe("on");
    expect(mainCiTrainPaused(w.gate!, "p")).toBe(true);
    expect(w.intentOf("C")?.status ?? w.intentOf("D")?.status).toBe("pending");
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toContain("关联（非因果）");
    expect(responses(w)).toHaveLength(1);
    const receipt = JSON.parse(responses(w)[0]!.data);
    expect(receipt.receipt).toMatchObject({ owner: "agent-pm", choice: "pending", resume: "current-main-full-green" });
    expect(w.frozen()).toBe(false);
    w.restart();
    expect(writes(await w.pass())).toEqual([]); expect(w.notices).toHaveLength(1); expect(responses(w)).toHaveLength(1);
    const bind = await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", "repair"]);
    expect(bind.ok).toBe(true);
    expect(decide(w.gate!, "p", "C", c.head)).toBe("go");
    expect(mainCiTrainPaused(w.gate!, "p")).toBe(true);
    const ack = await w.ledger("agent-pm", ["main-ci", "ack", "--project", "p", "--key", receipt.evidence.key,
      "--deadline", String(Date.now() + 60_000), "--choice", "repair", "--task", "C", "--head", c.head, "--reason", "repair main"]);
    expect(ack.ok).toBe(true);
    const ackArgs = ["main-ci", "ack", "--project", "p", "--key", receipt.evidence.key, "--deadline", String(Date.now() + 60_000),
      "--choice", "revert", "--head", w.hub.main, "--reason", "ordinary revert"];
    expect(await w.ledger("agent-author", ackArgs)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await w.ledger("agent-pm", ackArgs)).toMatchObject({ ok: true });
    const status = await w.ledger("agent-pm", ["main-ci", "status", "--project", "p"]);
    expect((status.response as any).acknowledgement).toMatchObject({ owner: "agent-pm", choice: "revert", automaticGitWrite: false });
    const calls: string[] = [];
    for (let n = 0; n < 10 && !calls.includes("serial-merge:C"); n++) calls.push(...await w.pass());
    expect(calls).toContain("serial-merge:C");
    w.hub.main = w.newSha(); w.ci.extraMainRuns[0]!.head_sha = w.hub.main; await w.pass();
    expect(decide(w.gate!, "p", "D", getTask(w.db, "D")!.headSHA!)).toBe("go");
  } finally { w.close(); }
});

test("[验收线 2] observe records proposed response without an additional pause/notice; read failure/unknown SHA has no blame", async () => {
  const w = mainCiWorld();
  try {
    writePolicy({ mainCiPause: "off" }); inject(w); w.card("C");
    w.ci.bySha.set(w.hub.main, "failure"); await w.pass();
    expect(w.notices).toEqual([]);
    expect(responses(w)).toHaveLength(0); // The response shares mainCiPause: off performs no read or proposed receipt.
    writePolicy({ mainCiPause: "observe" }); await w.pass();
    expect(JSON.parse(responses(w)[0]!.data)).toMatchObject({ mode: "observe", reuseMainCi: false, notify: false });
    w.ci.fail = true; const count = responses(w).length; await w.pass();
    expect(responses(w)).toHaveLength(count);
  } finally { w.close(); }
});

test("[验收线 5] ordinary human revert preserves subsequent commits in a disposable repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "main-ci-revert-drill-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString().trim();
  };
  try {
    git("init", "-b", "main"); git("config", "user.name", "drill"); git("config", "user.email", "drill@example.invalid");
    const commit = (file: string, value: string) => { writeFileSync(join(dir, file), value); git("add", file); git("commit", "-m", file); return git("rev-parse", "HEAD"); };
    commit("baseline", "available"); const bad = commit("fault", "bad"), later = commit("later", "keep");
    // The human inspected the exact failed SHA and the intervening commit before choosing ordinary revert.
    expect(git("log", "--format=%H", `${bad}..HEAD`)).toBe(later);
    git("revert", "--no-edit", bad);
    expect(readFileSync(join(dir, "later"), "utf8")).toBe("keep"); expect(existsSync(join(dir, "fault"))).toBe(false);
    expect(git("merge-base", "--is-ancestor", later, "HEAD")).toBe("");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("[验收线 4] sent merge is only reconciled; an existing train keeps its CI and never blames a member", async () => {
  const w = mainCiWorld();
  try {
    writePolicy({ mainCiPause: "on" }); inject(w); w.card("C");
    const intent = await w.begin("C"); await w.step(intent, "ready", "await_ci"); await w.step(intent, "await_ci", "merging");
    w.ci.bySha.set(w.hub.main, "failure"); expect(writes(await w.pass())).toEqual([]);
    expect(w.phase("C")).toBe("unknown");
    expect(w.taskEvents("C").filter((e) => e.data.op === "merge_unsent_cancel")).toEqual([]);
  } finally { w.close(); }
  const t = mainCiWorld();
  try {
    writePolicy({ mainCiPause: "off" }); t.card("A"); t.card("B"); t.hub.pending = true;
    await t.pass(); expect(t.store.load("p")?.phase).toBe("testing");
    writePolicy({ mainCiPause: "on" }); inject(t); t.ci.bySha.set(t.hub.main, "failure");
    const calls = await t.pass();
    expect(calls.some((c) => /cancel|rerun|bounce/.test(c))).toBe(false);
    expect(t.events.some((e) => e.kind === "void")).toBe(true);
    expect(t.frozen()).toBe(false);
  } finally { t.close(); }
});


test("[验收线 3] bound repair still fails its own PR CI and returns to fix instead of merging", async () => {
  const w = mainCiWorld();
  try {
    writePolicy({ mainCiPause: "on" }); inject(w);
    const c = w.card("C"); w.card("D"); w.ci.bySha.set(w.hub.main, "failure"); await w.pass();
    expect(await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", "repair main"]))
      .toMatchObject({ ok: true });
    w.ci.prChecks.set("C", "fail");
    const calls: string[] = []; for (let n = 0; n < 5; n++) calls.push(...await w.pass());
    expect(calls.filter((c) => /^(serial-merge|match-head):/.test(c))).toEqual([]);
    expect(getTask(w.db, "C")!.stage).toBe("fix");
    expect(getTask(w.db, "D")!.stage).toBe("merge");
    expect(w.frozen()).toBe(false);
  } finally { w.close(); }
});
