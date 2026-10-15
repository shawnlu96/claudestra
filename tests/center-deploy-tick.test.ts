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
  const f = mergedCard(); let s: CenterState = {}, sha = "a".repeat(40), time = 1000, submits = 0, notice = 0, result: CenterResult | null = null;
  const calls: string[][] = [];
  const proof = () => ({ project: "p", repo: cfg.repo, sha, scriptDigest: "b".repeat(64), cards: ["T9"] });
  const jobs: DeployJobs = { label: () => `com.claudestra.scheduler.deploy.${"c".repeat(32)}`,
    submit: async () => { submits++; return "label"; }, observe: async () => ({ label: "label", liveness: result ? "dead" : "alive", result: null, deadline: Infinity }),
    remove: async () => true };
  const ports: CenterTickPorts = { config: () => ({ p: cfg }), policy: () => ({ mode, source: "config", manualAfterMs: null }),
    read: () => structuredClone(s), write: (_, v) => { s = structuredClone(v); }, proof: async () => proof(), cards: () => ["T9"],
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
    if (op === "open") return { ok: true, ask: openCenterDeployAsk(f.db, proof(), centerConfigVersion(cfg), time), proof: proof() };
    return { ok: true };
  } };
  const approve = (choice = "scheduler_center_deploy_approve") => answerAsk(f.db, s.askId!, { principal: "owner", via: "web_card", owner: true,
    choices: [`[button:${choice}]`], labels: [choice], text: "", at: time });
  return { ...f, d, tick: () => centerDeployTick(f.db, config, d), state: () => s, calls, approve,
    sha: (v: string) => { sha = v; }, time: (v: number) => { time = v; }, submits: () => submits, notices: () => notice,
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
