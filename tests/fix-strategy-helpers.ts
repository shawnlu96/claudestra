/** Convergence probes use only the existing isolated auto fixture and an in-memory lifecycle facade. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import type { ConvergenceLifecycle } from "../src/lib/fix-strategy-lifecycle.js";
import { normalizeRegistryAgents } from "../src/lib/registry.js";
import { autoFixture, H1, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

/** `heads` default to the fixture's placeholder SHAs; real-git tests pass real commits of the card branch, oldest first. */
export async function repeatedFix(heads: readonly string[] = [H1, H2]) {
  const f = autoFixture();
  await toBuild(f); await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", heads[0]);
  await f.tick(); await f.tick();
  await f.review("changes", heads[0], [P1]); await f.tick(); await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", heads[1]);
  await f.tick(); await f.review("changes", heads[1], [P1]); await f.tick();
  return f;
}

export async function fourRoundFix(heads: readonly string[] = [H1, H2, "3".repeat(40), "4".repeat(40)]) {
  const f = await repeatedFix(heads);
  for (const head of heads.slice(2, 4)) {
    await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", head);
    await f.tick(); await f.review("changes", head, [P1]); await f.tick();
  }
  return f;
}

export function convergenceProbe(f: ReturnType<typeof autoFixture>) {
  const raw = () => JSON.parse(readFileSync(f.registryPath, "utf8"));
  const edit = (fn: (r: ReturnType<typeof raw>) => void) => { const value = raw(); fn(value); writeFileSync(f.registryPath, JSON.stringify(value)); };
  const effects: string[] = [], trees: { source: string; dir: string; branch: string | null; head: string | null }[] = [];
  const deps: ConvergenceLifecycle = {
    active: () => {}, registryPath: f.registryPath, slotLockPath: join(f.dir, "slot.lock"), materialRoot: f.dir, worktreeRoot: f.dir,
    registry: () => normalizeRegistryAgents(raw()),
    readReport: async (p) => `original report ${p}`, diffSummary: async (_source, a, b) => `repair diff ${a}..${b}`,
    open: async (_source, dir) => ({ dir }),
    authorTree: async (source, t) => {
      const dir = join(t.root, t.taskId.toLowerCase());
      effects.push(`tree:${dir}`); trees.push({ source, dir, branch: t.branch, head: t.head }); return { dir };
    },
    agents: async () => normalizeRegistryAgents(raw()).map((r) => ({ ...r, pending: false, window: r.status !== "stopped" })),
    manager: async (cmd, name, dir, ...args) => {
      effects.push(`${cmd}:${name}`);
      if (cmd === "archive") return { ok: true, archived: ["old-session.jsonl"] };
      edit((r) => {
        if (cmd === "kill") r.agents[name].status = "stopped";
        if (cmd === "create") r.agents[name] = { cwd: dir, sessionId: `session:${name}`, status: "active",
          runtime: args.includes("codex") ? "codex" : "claude-code", transport: args.includes("codex") ? "acp" : "tmux" };
      });
      return { ok: true };
    },
  };
  const plan = () => {
    const snapshot = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }), next = planScheduler(snapshot);
    if (next.kind !== "intent") throw new Error(JSON.stringify(next));
    const causalSeq = (f.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
    return planIntent(f.db, f.at("scheduler"), { ...next, recipient: next.recipient ?? undefined, taskId: "T1", taskRev: f.task().rev,
      workflowRev: getWorkflow(f.db, "T1")!.rev, causalSeq }).intent;
  };
  return { deps, effects, trees, raw, edit, plan };
}
