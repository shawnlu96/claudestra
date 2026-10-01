/**
 * i28-N4 start_node template. TEMPLATE_GOLDEN was recorded before the template parameter existed (origin/main 98b5909e):
 * with no template (or template "code"), every manager / git call, the ledger workflow and the receipt must stay exactly that.
 * A temporary ledger and fake git / manager stand in for the bridge's real IO (same harness as tests/dag-tools-placement.test.ts);
 * nothing touches the production ~/.claude-orchestrator.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import type { StartPlacement } from "../src/lib/scheduler-placement-start.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM: VerifiedCall = { agent: "agent-pm", sessionId: "s-pm", family: "claude-code", channelId: "ch-pm" };
const PEER: StartPlacement = { where: "peer", peer: "mate", repo: "o/r", reason: "在跑：mate 0 / 本机 2；选最少" };

let dir: string, repo: string, db: Database, now: number, calls: string[][], branches: Set<string>;
let agents: Record<string, { channelId: string; projectId?: string }>;
let failOn: (args: string[]) => boolean;

async function managerRun(args: string[], channelId: string): Promise<any> {
  if (args[0] === "ledger") {
    const who = resolveActor({ channelId, controlChannelId: "ch-ctl" }, agents);
    if (!who.ok) return { ok: false, code: "forbidden", error: who.error };
    return runLedger(args.slice(1), { db, actor: who.actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents }) as never,
      saveRegistry: async () => {}, now: () => now++, autoDispatch: () => true, autoProjects: () => [P] });
  }
  if (args[0] === "create") agents[`agent-${args[1]}`] = { channelId: `ch-${args[1]}`, projectId: P };
  else if (args[0] === "kill") delete agents[args[1]];
  return { ok: true };
}

/** A fake git that only knows the subcommands start_node runs; worktree add makes the directory so later steps see it. */
async function fakeGit(args: string[]): Promise<{ ok: boolean; out: string }> {
  const [cmd, sub] = args;
  if (cmd === "worktree" && sub === "add") {
    mkdirSync(args.at(-2) as string, { recursive: true });
    branches.add(args[args.indexOf("-b") + 1]);
  } else if (cmd === "worktree" && sub === "remove") rmSync(args.at(-1) as string, { recursive: true, force: true });
  else if (cmd === "worktree" && sub === "list") return { ok: true, out: "" };
  else if (cmd === "rev-parse") {
    const ok = args[3].endsWith("^{commit}") || branches.has(args[3].replace("refs/heads/", ""));
    return { ok, out: ok ? "base0" : "" };
  } else if (cmd === "branch") branches.delete(args[2]);
  return { ok: true, out: "" };
}

function deps(over: Partial<ReturnType<DagToolDeps["startEnv"]>> = {}): DagToolDeps {
  return {
    db: () => db,
    manager: async (args, channelId) => {
      calls.push(args);
      return failOn(args) ? { ok: false, error: `注入失败：${args[0]} ${args[1]}` } : managerRun(args, channelId);
    },
    callerProject: (a) => agents[a]?.projectId ?? null,
    startEnv: () => ({
      ledgerDir: join(dir, "ledger"), worktreeRoot: join(dir, "wt"), projectDirs: async () => [repo], agentNames: () => Object.keys(agents),
      exists: existsSync, branchExists: async (_r, b) => branches.has(b), autoReady: () => null, template: () => null, ...over,
    }),
    stepIO: () => ({
      git: async (_cwd, args) => {
        calls.push(["git", ...args]);
        return failOn(["git", ...args]) ? { ok: false, out: "注入失败" } : fakeGit(args);
      },
      exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
      write: (p, t) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); },
      remove: (p) => rmSync(p, { force: true }), symlink: (t, p) => writeFileSync(p, `-> ${t}`), agentExists: (a) => !!agents[a],
    }),
  };
}

const call = (d: DagToolDeps, tool: string, args: unknown) => dagToolHandlers(d)[tool](PM, args) as Promise<Record<string, any>>;
const plan = () => call(deps(), "plan_feature", { slug: "i28", title: "协作底座", ownerWords: "原话",
  nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a*.ts"] }] });
const start = (more: Record<string, unknown> = {}, d = deps()) => call(d, "start_node", { featureId: "i28", key: "a", ...more });
const peerEnv = () => deps({ placement: async () => PEER });
const workflowEvents = () => listEvents(db, { project: P, target: "i28-a" }).filter((e) => e.kind === "scheduler" && e.data.op === "workflow");

/** Everything start_node produced, with the per-call random attempt and the temp dir masked so two runs compare equal. */
function product(out: Record<string, any>): string {
  const mask = (s: string) => s.replaceAll(dir, "<dir>").replace(/dag-start:([\w.-]+):[0-9a-f]{8}/g, "dag-start:$1:<attempt>");
  const t = getTask(db, "i28-a");
  const events = listEvents(db, { project: P, target: "i28-a" }).map((e) => ({ kind: e.kind, text: e.text, data: e.data, dedupKey: e.dedupKey }));
  const wf = getWorkflow(db, "i28-a");
  return mask(JSON.stringify({
    out, calls, agents: Object.keys(agents).sort(), branches: [...branches].sort(),
    task: t && { stage: t.stage, agent: t.agent, pm: t.pm, branch: t.branch, spec: t.spec, extra: t.extra, featureId: (t as any).featureId },
    workflow: wf && { mode: wf.mode, template: wf.template, templateVersion: wf.templateVersion, authorFamily: wf.authorFamily, fallback: wf.fallback },
    events, worktree: existsSync(join(dir, "wt", "i28-a")), prompt: existsSync(join(dir, "ledger", "reviews", "i28-a-exec-prompt.md")),
  }));
}

beforeEach(() => {
  now = 1_000;
  calls = [];
  failOn = () => false;
  branches = new Set(["main"]);
  dir = mkdtempSync(join(tmpdir(), "i28-n4-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM.agent] });
  agents = { [PM.agent]: { channelId: "ch-pm", projectId: P } };
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  writeFileSync(join(dir, "ledger", "docs", "tasks", "i28-a.md"), "# 规格\n");
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

/** sha256 of product() for each path, recorded before N4 (no template parameter yet). */
const TEMPLATE_GOLDEN: Record<string, string> = {
  normal: "6336300117b3cecaa845ca31e601abc5683d610792304c632d7bd905b7f398d5",
  rollback: "cdd9cfaf8bdb84c8f92df5d6ee12677781528d0e094f4e3f1954d7c90425ef41",
  peer: "152d8aa531ca1226910f022cbebec91435f2a55220c90715bfa75f98b76dcdf8",
};

const digest = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const runs: [keyof typeof TEMPLATE_GOLDEN, () => Promise<Record<string, any>>][] = [
  ["normal", () => start()],
  ["rollback", () => { failOn = (a) => a[0] === "ledger" && a[1] === "workflow-set"; return start(); }],
  ["peer", () => start({ placement: "peer:mate" }, peerEnv())],
];

describe("start_node without template: calls, workflow and receipt are the pre-N4 ones", () => {
  for (const [name, run] of runs) {
    test(name, async () => {
      expect((await plan()).ok).toBe(true);
      calls = [];
      expect(digest(product(await run()))).toBe(TEMPLATE_GOLDEN[name]);
    });
  }

  test("the default workflow is code v3 / auto / claude / the standing fallback, written once", async () => {
    expect((await plan()).ok).toBe(true);
    expect(await start()).toMatchObject({ ok: true, taskId: "i28-a" });
    expect(getWorkflow(db, "i28-a")).toMatchObject({
      template: "code", templateVersion: 3, mode: "auto", authorFamily: "claude", fallback: "PM 接管，按手动流程推进（派审 + 合并队列）",
    });
    expect(workflowEvents().map((e) => [e.data.template, e.data.templateVersion])).toEqual([["code", 3]]);
  });
});
