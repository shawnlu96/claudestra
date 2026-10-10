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
  // i28-N8：卡上 spec 改记绝对路径，归一回录 golden 时的相对写法，其余产物仍须逐字节一致
  const mask = (s: string) => s.replaceAll(`${join(dir, "ledger", "docs", "tasks")}/`, "docs/tasks/").replaceAll(dir, "<dir>").replace(/dag-start:([\w.-]+):[0-9a-f]{8}/g, "dag-start:$1:<attempt>");
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

/** sha256 of product() for each path, recorded before N4 (no template parameter yet); local paths re-recorded when create gained --card (LIFE1). */
const TEMPLATE_GOLDEN: Record<string, string> = {
  normal: "81d33e668bbeea36008dc1061db14e61ada2441eacd36c8e0da2a9d8468ccce2",
  rollback: "0e1dd43ed558bc8237924410a328334c9bed3f048655894e23813571751adb3b",
  peer: "af265a9224d8e5232700af3223d7844dbbe60a4fcd61131123c128c6e8dc2409",
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

describe("template code is the default, byte for byte", () => {
  for (const [name, run] of runs) {
    test(name, async () => {
      expect((await plan()).ok).toBe(true);
      calls = [];
      const viaCode = name === "peer" ? () => start({ placement: "peer:mate", template: "code" }, peerEnv()) : () => {
        if (name === "rollback") failOn = (a) => a[0] === "ledger" && a[1] === "workflow-set";
        return start({ template: "code" });
      };
      expect(digest(product(await viaCode()))).toBe(TEMPLATE_GOLDEN[name]);
    });
  }
});

const NOTE = { ui: "ui 卡：合并前 PM 验收前后截图", security: "security 卡：只在本机跨模型审查" } as const;
const firstRow = () => db.query("SELECT template, templateVersion FROM task_workflows WHERE taskId = 'i28-a'").all();

describe("ui / security land right from the first write", () => {
  for (const t of ["ui", "security"] as const) {
    test(`${t}, local card: workflow row is ${t} v3, no code workflow event ever, receipt notes the gate`, async () => {
      expect((await plan()).ok).toBe(true);
      calls = [];
      const out = await start({ template: t });
      expect(out).toMatchObject({ ok: true, taskId: "i28-a", agent: "agent-task-i28-a" });
      expect(out.next).toBe(`调度器会给 agent-task-i28-a 派复述单；不用给它发消息；${NOTE[t]}${t === "ui" ? "（extra.screenshots ≥ 2 + screenshotsDigest；改整体观感的用 ledger ui-owner-visual <卡> on 交 owner 看）" : "，不进借算力池"}`);
      expect(firstRow()).toEqual([{ template: t, templateVersion: 3 }]);
      expect(workflowEvents().map((e) => [e.data.template, e.data.templateVersion, e.data.mode])).toEqual([[t, 3, "auto"]]);
      const set = calls.filter((c) => c[1] === "workflow-set");
      expect(set).toHaveLength(1);
      expect(set[0]).toContain(`--template=${t}`);
      expect(set[0]).toContain("--version=3");
      const brief = readFileSync(join(dir, "ledger", "reviews", "i28-a-exec-prompt.md"), "utf8");
      expect(brief.includes("## ui 卡：合并前要过前后截图验收")).toBe(t === "ui");
    });

    test(`${t}, peer card (fake placement): same workflow, restate skipped after it, receipt notes the gate`, async () => {
      expect((await plan()).ok).toBe(true);
      const out = await start({ placement: "peer:mate", template: t }, peerEnv());
      expect(out).toMatchObject({ ok: true, placement: "peer:mate", steps: ["task-new", "spec", "workflow", "restate", "bind"] });
      expect(out.next).toContain(`；${NOTE[t]}`);
      expect(firstRow()).toEqual([{ template: t, templateVersion: 3 }]);
      expect(workflowEvents().map((e) => [e.data.template, e.data.templateVersion])).toEqual([[t, 3]]);
      expect(getTask(db, "i28-a")?.stage).toBe("restate");
    });
  }
});

describe("a bad template is refused before anything is written", () => {
  test("wrong case, unknown, empty, padded, number, object, null: invalid, no manager / git call, no card, worktree or agent", async () => {
    expect((await plan()).ok).toBe(true);
    calls = [];
    for (const bad of ["UI", "design", "", " ui", 3, { t: "ui" }, null]) {
      const out = await start({ template: bad });
      expect(out).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("template 只能是 code / ui / security") });
    }
    expect(calls).toEqual([]);
    expect(getTask(db, "i28-a")).toBeNull();
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
    expect(Object.keys(agents)).toEqual([PM.agent]);
  });

  test("workflow-set refused on a ui card: card cancelled, agent killed, worktree removed, node left unbound", async () => {
    expect((await plan()).ok).toBe(true);
    failOn = (a) => a[0] === "ledger" && a[1] === "workflow-set";
    const out = await start({ template: "ui" });
    expect(out).toMatchObject({ ok: false, failedStep: "workflow", leftovers: [] });
    expect(out.rolledBack).toEqual(expect.arrayContaining(["task-new", "worktree", "agent"]));
    expect(getTask(db, "i28-a")?.stage).toBe("cancelled");
    expect(Object.keys(agents)).toEqual([PM.agent]);
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
    expect(branches.has("feat/i28-a")).toBe(false);
    expect(workflowEvents()).toEqual([]);
    expect((await call(deps(), "show_dag", { featureId: "i28" })).version.nodes[0].taskId ?? null).toBeNull();
  });
});
