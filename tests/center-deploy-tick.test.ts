import { describe, expect, test } from "bun:test";
import { centerDeployTick, type CenterTickPorts } from "../src/lib/center-deploy-tick.js";
import { openCenterDeployAsk } from "../src/lib/center-deploy-asks.js";
import { centerConfigVersion } from "../src/lib/center-deploy-proof.js";
import { answerAsk, getAsk } from "../src/lib/ledger-asks.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { recordObserved } from "../src/lib/recovery-policy.js";
import { recordPmTodo } from "../src/lib/pm-todo-note.js";
import type { CenterState } from "../src/lib/center-deploy-state.js";
import type { CenterResult } from "../src/lib/center-deploy-worker.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { DEFAULT_REMOTE } from "../src/lib/scheduler-config.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { mergedCard } from "./deploy-test-kit.js";

const cfg = { repo: "example/repo", script: "deploy.sh", dryRunArgs: ["--dry-run"], timeoutMinutes: 20 };
const config: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true, projects: { p: { repoDir: "/fake", maxActiveWorkers: 2, requiredChecks: [] } } };
function world(mode: "on" | "observe" | "off" = "on") {
  const f = mergedCard(); let s: CenterState = {}, cards = ["T9"], currentCfg = { ...cfg }, digest = "b".repeat(64);
  let probes = 0, sha = "a".repeat(40), time = 1000, submits = 0, notice = 0, result: CenterResult | null = null;
  const calls: string[][] = [];
  const proof = () => ({ project: "p", repo: cfg.repo, sha, scriptDigest: digest, cards: [...cards] });
  const jobs: DeployJobs = { label: () => `com.claudestra.scheduler.deploy.${"c".repeat(32)}`,
    submit: async () => { submits++; return "label"; }, observe: async () => ({ label: "label", liveness: result ? "dead" : "alive", result: null, deadline: Infinity }),
    remove: async () => true };
  const ports: CenterTickPorts = { config: () => ({ p: currentCfg }), policy: () => ({ mode, source: "config", manualAfterMs: null }),
    read: () => structuredClone(s), write: (_, v) => { s = structuredClone(v); }, proof: async () => { probes++; return proof(); }, cards: () => [...cards],
    jobs: () => jobs, repoDir: () => "/fake", result: () => result };
  const d = { center: ports, now: () => time, assertActive: () => {}, notifyPm: async (_: string, text: string) => {
    notice++; expect(text).not.toContain("secret"); expect(text).not.toContain("/fake");
  }, manager: async (...a: string[]) => {
    calls.push(a);
    if (a[1] === "scheduler-pm-todo") {
      const val = (flag: string) => a[a.indexOf(flag) + 1];
      recordPmTodo(f.db, { actor: "scheduler", now: time }, { project: "p", target: "T9", kind: val("--kind"), text: val("--text"), dedupKey: val("--dedup") });
      return { ok: true };
    }
    const op = a[a.indexOf("--op") + 1];
    if (op === "observe") { recordObserved(f.db, { project: "p", target: "T9", mechanism: "centerDeployAuto", actionKey: sha, action: `为 ${sha.slice(0, 12)} 开授权卡` }, time); }
    if (op === "open") return { ok: true, ask: openCenterDeployAsk(f.db, proof(), centerConfigVersion(currentCfg), time), proof: proof() };
    return { ok: true };
  } };
  const approve = (choice = "scheduler_center_deploy_approve") => answerAsk(f.db, s.askId!, { principal: "owner", via: "web_card", owner: true,
    choices: [`[button:${choice}]`], labels: [choice], text: "", at: time });
  return { ...f, d, tick: () => centerDeployTick(f.db, config, d), state: () => s, calls, approve,
    cards: (v: string[]) => { cards = v; }, cfg: (v?: typeof cfg) => { currentCfg = v ?? { ...currentCfg, timeoutMinutes: currentCfg.timeoutMinutes + 1 }; },
    digest: (v: string) => { digest = v; time += 60_001; }, probes: () => probes,
    sha: (v: string) => { sha = v; time += 60_001; }, time: (v: number) => { time = v; }, submits: () => submits, notices: () => notice,
    result: (v: CenterResult) => { result = v; } };
}

describe("center authorization pass", () => {
  test("[验收线 4] one card per SHA; a newer SHA supersedes the unanswered ask", async () => {
    const w = world(); try {
      await w.tick(); const first = w.state().askId!;
      expect(getAsk(w.db, first)?.bind?.params).toMatchObject({ sha: "a".repeat(40), scriptDigest: "b".repeat(64), cards: ["T9"] });
      await w.tick(); expect(w.state().askId).toBe(first); expect(w.submits()).toBe(0);
      w.sha("d".repeat(40)); await w.tick(); expect(w.state().askId).not.toBe(first);
      expect(getAsk(w.db, first)?.state).toBe("superseded");
      expect(w.calls.filter((a) => a.includes("open"))).toHaveLength(2);
    } finally { w.close(); }
  });
  test("[验收线 5] approval starts one independent job and repeated ticks only observe it", async () => {
    const w = world(); try { await w.tick(); w.approve(); await w.tick(); await w.tick(); expect(w.submits()).toBe(1); }
    finally { w.close(); }
  });
  test("[验收线 5] a new remote head after approval opens a new ask without executing", async () => {
    const w = world(); try { await w.tick(); w.approve(); w.sha("d".repeat(40)); await w.tick(); expect(w.submits()).toBe(0); }
    finally { w.close(); }
  });
  for (const mode of ["reject", "expire", "hash"] as const) test(`[验收线 5] ${mode} never executes and records a pull-only todo`, async () => {
    const w = world(); try {
      await w.tick();
      if (mode === "reject") w.approve("scheduler_center_deploy_reject");
      if (mode === "expire") w.time(20_000_000);
      if (mode === "hash") { w.approve(); w.db.query("UPDATE asks SET bind=json_set(bind,'$.paramsHash',?) WHERE id=?").run("bad", w.state().askId!); }
      await w.tick(); await w.tick(); expect(w.submits()).toBe(0); expect(w.notices()).toBe(0);
      expect(listEvents(w.db, { project: "p" }).filter((e) => e.data.op === "pm_todo")).toHaveLength(1);
    } finally { w.close(); }
  });
  test("[验收线 6] failure notifies once and never retries the same SHA", async () => {
    const w = world(); try {
      await w.tick(); w.approve(); await w.tick();
      w.result({ status: "failed", code: 7, ms: 42, dryRun: true, timedOut: false });
      await w.tick(); await w.tick(); expect(w.submits()).toBe(1); expect(w.notices()).toBe(1);
      expect(listEvents(w.db, { project: "p" }).filter((e) => e.data.op === "pm_todo")).toHaveLength(1);
    } finally { w.close(); }
  });
  test("[验收线 7] observe records the would-be ask only; off does not even read configuration", async () => {
    for (const mode of ["observe", "off"] as const) {
      const w = world(mode); try {
        if (mode === "off") w.d.center.config = () => { throw new Error("off read config"); };
        await w.tick(); await w.tick(); expect(w.state().askId).toBeUndefined(); expect(w.submits()).toBe(0);
        expect(listEvents(w.db, { project: "p" }).filter((e) => e.data.mechanism === "centerDeployAuto")).toHaveLength(mode === "observe" ? 1 : 0);
      } finally { w.close(); }
    }
  });
});

test("[验收线 7] missing configuration and invalid script configuration each produce a PM todo", async () => {
  for (const invalid of [false, true]) {
    const w = world();
    try {
      const project = { ...config.projects.p, remote: { ...DEFAULT_REMOTE, repo: "example/public" } };
      w.d.center.config = () => { if (invalid) throw new Error("../private-path"); return null; };
      await centerDeployTick(w.db, { ...config, projects: { p: project } }, w.d);
      const todos = listEvents(w.db, { project: "p" }).filter((e) => e.data.op === "pm_todo");
      expect(todos).toHaveLength(1); expect(JSON.stringify(todos)).not.toContain("private-path"); expect(w.submits()).toBe(0);
    } finally { w.close(); }
  }
});

test("[验收线 6] successful center result updates the last successful SHA and is not submitted twice", async () => {
  const w = world();
  try {
    await w.tick(); w.approve(); await w.tick(); w.result({ status: "success", code: 0, ms: 10, dryRun: false, timedOut: false });
    await w.tick(); await w.tick(); expect(w.state().successSha).toBe("a".repeat(40)); expect(w.submits()).toBe(1); expect(w.notices()).toBe(0);
  } finally { w.close(); }
});


test("[验收线 5] stage drift after opening never invalidates approval for the same SHA", async () => {
  const w = world();
  try {
    await w.tick(); const first = w.state().askId;
    w.cards([]); w.approve(); await w.tick();
    expect(w.submits()).toBe(1); expect(w.state().terminalSha).toBeUndefined(); expect(w.state().askId).toBe(first);
  } finally { w.close(); }
});

test("[验收线 5] configuration changes replace approval at the same SHA and require a new answer", async () => {
  const w = world();
  try {
    await w.tick(); w.approve(); const first = w.state().askId;
    w.cfg(); await w.tick();
    expect(w.state().askId).not.toBe(first); expect(w.submits()).toBe(0); expect(w.state().terminalSha).toBeUndefined();
    w.approve(); await w.tick(); expect(w.submits()).toBe(1);
  } finally { w.close(); }
});

test("[验收线 4] waiting and observe passes throttle fetch, but approval always refreshes proof", async () => {
  for (const mode of ["on", "observe"] as const) {
    const w = world(mode);
    try {
      await w.tick(); await w.tick(); await w.tick(); expect(w.probes()).toBe(1);
      if (mode === "on") { w.approve(); await w.tick(); expect(w.probes()).toBe(2); expect(w.submits()).toBe(1); }
      else { w.time(61_001); await w.tick(); expect(w.probes()).toBe(2); }
    } finally { w.close(); }
  }
});

test("[验收线 7] a failed error todo does not abort the deployment pass", async () => {
  const w = world();
  try {
    w.d.center.config = () => { throw new Error("private config"); };
    w.d.manager = async () => { throw new Error("private ledger failure"); };
    await expect(w.tick()).resolves.toBeUndefined();
  } finally { w.close(); }
});

test("[验收线 7] runtime and configuration errors have separate redacted todos", async () => {
  const w = world();
  try {
    const proof = w.d.center.proof!;
    w.d.center.proof = async () => { throw new Error("secret network"); };
    await w.tick(); w.d.center.proof = proof;
    w.d.center.config = () => { throw new Error("secret configuration"); };
    await w.tick();
    const todos = listEvents(w.db, { project: "p" }).filter((e) => e.data.op === "pm_todo");
    expect(todos).toHaveLength(2); expect(JSON.stringify(todos)).not.toContain("secret");
  } finally { w.close(); }
});


test("[验收线 5] partial card drift keeps the original inclusion list while waiting and after approval", async () => {
  const w = world();
  try {
    w.cards(["T9", "T10"]); await w.tick(); const first = w.state().askId;
    w.cards(["T9"]); await w.tick(); expect(w.state().askId).toBe(first);
    w.approve(); await w.tick(); expect(w.submits()).toBe(1);
    expect(w.state().proof?.cards).toEqual(["T9", "T10"]);
  } finally { w.close(); }
});

test("[验收线 5] a changed script proof reopens authorization at the same SHA", async () => {
  const w = world();
  try {
    await w.tick(); const first = w.state().askId;
    w.approve(); w.digest("e".repeat(64)); await w.tick();
    expect(w.state().askId).not.toBe(first); expect(w.state().terminalSha).toBeUndefined(); expect(w.submits()).toBe(0);
    w.approve(); await w.tick(); expect(w.submits()).toBe(1);
  } finally { w.close(); }
});

test("[验收线 5] restoring an earlier configuration requires a fresh approval", async () => {
  const w = world();
  try {
    await w.tick(); w.approve(); const first = w.state().askId;
    w.cfg(); await w.tick(); const second = w.state().askId;
    expect(getAsk(w.db, second!)?.state).toBe("open");
    w.cfg(cfg); await w.tick();
    expect(w.state().askId).not.toBe(first); expect(w.state().askId).not.toBe(second);
    expect(getAsk(w.db, second!)?.state).toBe("superseded"); expect(w.submits()).toBe(0);
  } finally { w.close(); }
});

test("[验收线 4] after success historical cards cannot authorize an unrelated main commit", async () => {
  const w = world();
  try {
    delete w.d.center.cards;
    await w.tick(); w.approve(); await w.tick();
    w.result({ status: "success", code: 0, ms: 10, dryRun: false, timedOut: false }); await w.tick();
    const probes = w.probes(); w.sha("e".repeat(40)); await w.tick();
    expect(w.probes()).toBe(probes); expect(w.submits()).toBe(1);
    expect(w.calls.filter((a) => a.includes("open"))).toHaveLength(1);
  } finally { w.close(); }
});

test("[验收线 6] terminal failures throttle proof refresh and never retry without a new SHA", async () => {
  const w = world();
  try {
    await w.tick(); w.approve(); await w.tick();
    w.result({ status: "failed", code: 7, ms: 10, dryRun: false, timedOut: false }); await w.tick();
    const probes = w.probes(); await w.tick(); await w.tick();
    expect(w.probes()).toBe(probes); expect(w.submits()).toBe(1);
    w.sha("e".repeat(40)); await w.tick();
    expect(w.calls.filter((a) => a.includes("open"))).toHaveLength(2);
  } finally { w.close(); }
});
