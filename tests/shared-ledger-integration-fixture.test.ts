import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import type { StepIO } from "../src/lib/dag-tools-steps.js";
import type { StartEnv } from "../src/lib/dag-tools-start.js";

export function integrationFixture() {
  const dir = mkdtempSync(join(tmpdir(), "c5-gate-")), path = join(dir, "ledger.sqlite");
  const db = openLedger(path), actor = "agent-c5-pm", project = "c5-project", id = "c5a0-gate";
  db.run("INSERT INTO ledger_instance VALUES ('origin', 'c5a0')");
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [actor] });
  createTask(db, { actor }, { project, id: "c5-existing", title: "Existing card", kind: "code" });
  createFeature(db, { actor }, { project, slug: "gate", title: "Gate integration" });
  initDag(db, { actor }, { id, rev: 1, nodes: [
    { key: "existing", taskId: "c5-existing" }, { key: "next", oneLine: "New work", fileGlobs: ["src/lib/c5.ts"] },
  ] });
  const calls: string[][] = [];
  const ledger = (args: string[], who = actor) => runLedger(args, { db, actor: who, actorProject: project, projectIds: [project],
    loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => Date.now(),
    autoDispatch: () => true, autoProjects: () => [project] });
  const manager = async (args: string[]) => { calls.push(args); return args[0] === "ledger" ? ledger(args.slice(1)) : { ok: true }; };
  const startEnv: StartEnv = { db, caller: actor, ledgerDir: dir, worktreeRoot: join(dir, "worktrees"),
    projectDirs: async () => [dir], agentNames: () => [], exists: p => p === join(dir, ".git"),
    branchExists: async () => false, autoReady: () => null, template: () => null };
  const io: StepIO = { manager, db: () => db, attempt: "c5-attempt", agentExists: () => false,
    git: async (_cwd, args) => ({ ok: true, out: args.some(a => a.endsWith("^{commit}")) ? "base0" : "" }),
    exists: () => false, read: () => null, write: () => {}, remove: () => {}, symlink: () => {} };
  const deps: DagToolDeps = { db: () => db, manager, callerProject: () => project, startEnv: () => startEnv, stepIO: () => io };
  return { db, id, actor, project, calls, ledger, io, startEnv, tools: dagToolHandlers(deps),
    call: { agent: actor, channelId: "c5-channel", sessionId: "c5-session", family: "claude-code" as const },
    feature: () => getFeature(db, id)!, mode: (planning: boolean) => writeSharedLedgerMode(id,
      { authorityMode: planning ? "planning" : "source", sharedPlanning: planning }),
    async close() { await writeSharedLedgerMode(id, { authorityMode: "source", sharedPlanning: false }); closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}
