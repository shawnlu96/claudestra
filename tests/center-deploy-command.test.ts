import { expect, test } from "bun:test";
import { runLedger } from "../src/manager/ledger.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { mergedCard } from "./deploy-test-kit.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";

test("[验收线 4] authorization writer refuses PM, worker, missing lease and lost lease", async () => {
  const f = mergedCard();
  try {
    const deps = (actor: string, assertLease?: () => void): LedgerDeps => ({ db: f.db, actor, assertLease, now: () => 1000, projectIds: ["p"],
      loadRegistry: async () => ({ socket: "s", agents: {} }), saveRegistry: async () => {} });
    const args = ["scheduler-center-deploy", "T9", "--op", "open"];
    for (const actor of ["owner", "agent-pm", "agent-author", "scheduler"]) {
      expect(await runLedger(args, deps(actor))).toMatchObject({ ok: false, code: "forbidden" });
      if (actor !== "scheduler") expect(await runLedger(args, deps(actor, () => {}))).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(await runLedger(args, deps("scheduler", () => { throw new SchedulerLeaseLost("lost"); }))).toMatchObject({ ok: false, code: "lease-lost" });
    expect(listEvents(f.db, { project: "p" }).filter((e) => e.kind === "ask")).toHaveLength(0);
  } finally { f.close(); }
});

test("[验收线 6] result writer selects phase metadata and excludes stdout, stderr and local paths", async () => {
  const { writeCenterState } = await import("../src/lib/center-deploy-state.js");
  const { writeJsonAtomicSync } = await import("../src/lib/state-file.js");
  const { deployJobDir } = await import("../src/lib/scheduler-deploy-lock-jobs.js");
  const { statePath } = await import("../src/lib/paths.js");
  const { join } = await import("node:path");
  const { rmSync } = await import("node:fs");
  const { beginDeployRun } = await import("../src/lib/scheduler-deploy.js");
  const f = mergedCard(), sha = "a".repeat(40);
  const run = { ...beginDeployRun(f.db, { actor: "scheduler" }, f.intent).run, intentId: "center-result-test", mergeSha: sha };
  const dir = deployJobDir(run);
  try {
    writeCenterState("p", { proof: { project: "p", repo: "a/b", sha, scriptDigest: "b".repeat(64), cards: ["T9"] }, run,
      result: { status: "success", code: 0, ms: 40, dryRun: false, timedOut: false } });
    writeJsonAtomicSync(join(dir, "result.json"), { phases: [true, false].map((dryRun) => ({ code: 0, ms: 20, dryRun,
      stdout: "private-output-secret", stderr: "/private/local/path", status: "success" })) });
    const r = await runLedger(["scheduler-center-deploy", "T9", "--op", "result"], { db: f.db, actor: "scheduler", projectIds: ["p"],
      now: () => 1000, assertLease() {}, loadRegistry: async () => ({ socket: "s", agents: {} }), saveRegistry: async () => {} });
    expect(r).toMatchObject({ ok: true });
    const events = listEvents(f.db, { project: "p" }).filter((e) => e.data.op === "center_deploy" || e.data.op === "center_deploy_attempt");
    expect(events).toHaveLength(2); expect(events.map((e) => e.data.dryRun)).toEqual([true, false]);
    expect(JSON.stringify(events)).not.toContain("private-output-secret"); expect(JSON.stringify(events)).not.toContain("/private/local/path");
    expect(events[1].data).toEqual({ op: "center_deploy", sha, code: 0, ms: 20, dryRun: false });
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); rmSync(statePath("center-deploy", "p.json"), { force: true }); }
});

test("[验收线 3] machine op turns observe samples into deployMachineLock recovery samples, once per request and action", async () => {
  const { writeJsonAtomicSync } = await import("../src/lib/state-file.js");
  const { deployJobDir } = await import("../src/lib/scheduler-deploy-lock-jobs.js");
  const { rmSync } = await import("node:fs");
  const { beginDeployRun } = await import("../src/lib/scheduler-deploy.js");
  const f = mergedCard(), run = beginDeployRun(f.db, { actor: "scheduler" }, f.intent).run, file = `${deployJobDir(run)}.machine-events.json`;
  const deps = { db: f.db, actor: "scheduler", projectIds: ["p"], now: () => 1000, assertLease() {},
    loadRegistry: async () => ({ socket: "s", agents: {} }), saveRegistry: async () => {} };
  const observed = () => listEvents(f.db, { project: "p" }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "deployMachineLock");
  try {
    writeJsonAtomicSync(file, [{ status: "observed", would: "defer", label: "deploy-full", at: 1 }, { status: "observed", would: "defer", label: "deploy-full", at: 2 }]);
    const args = ["scheduler-center-deploy", "T9", "--op", "machine", "--intent", f.intent];
    expect(await runLedger(args, deps)).toMatchObject({ ok: true });
    expect(observed()).toHaveLength(1); expect(observed()[0]).toMatchObject({ target: "T9", data: { label: "deploy-full" } });
    writeJsonAtomicSync(file, [{ status: "observed", would: "defer", label: "deploy-full", at: 1 }, { status: "observed", would: "acquire", label: "scheduler-deploy", at: 3 }]);
    expect(await runLedger(args, deps)).toMatchObject({ ok: true }); expect(await runLedger(args, deps)).toMatchObject({ ok: true });
    expect(observed().map((e) => String(e.data.actionKey).split(":")[0]).sort()).toEqual(["acquire", "defer"]);
    expect(listEvents(f.db, { project: "p" }).filter((e) => e.data.op === "deploy_machine_lock")).toHaveLength(0);
  } finally { f.close(); rmSync(file, { force: true }); }
});
