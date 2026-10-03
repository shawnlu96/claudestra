/**
 * i28-W5 start_node placement. START_GOLDEN was recorded before the placement parameter existed (origin/main b16efddb):
 * with no placement, `local` or an `auto` that lands local, every step, git / manager call, rollback and ledger product
 * must stay exactly that. A temporary ledger and fake git / manager stand in for the bridge's real IO; nothing touches
 * the production ~/.claude-orchestrator.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import type { StartPlacement } from "../src/lib/scheduler-placement-start.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM: VerifiedCall = { agent: "agent-pm", sessionId: "s-pm", family: "claude-code", channelId: "ch-pm" };

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
  dir = mkdtempSync(join(tmpdir(), "i28-w5-"));
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

/** sha256 of product() for each path, recorded before W5. */
const START_GOLDEN: Record<string, string> = {
  normal: "378f7dcc875b5dad31a726ada137990f12634e12681addfe31c03856bebd3ff6",
  rollback: "5875590e587fea208408d63360a6a9f98d8de330c3ef05ca68a042ae590911cf",
};

const digest = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

describe("start_node without placement: steps, rollback and products are the pre-W5 ones", () => {
  test("normal path", async () => {
    expect((await plan()).ok).toBe(true);
    calls = [];
    const p = product(await start());
    expect(digest(p)).toBe(START_GOLDEN.normal);
  });

  test("workflow-set refused: rolled back exactly as before", async () => {
    expect((await plan()).ok).toBe(true);
    calls = [];
    failOn = (a) => a[0] === "ledger" && a[1] === "workflow-set";
    const p = product(await start());
    expect(digest(p)).toBe(START_GOLDEN.rollback);
  });
});

describe("placement local / auto that lands local: byte-for-byte the pre-W5 start", () => {
  const PEER: StartPlacement = { where: "peer", peer: "mate", repo: "o/r", reason: "在跑：mate 0 / 本机 2；选最少" };
  const localEnv = () => deps({ placement: async () => ({ where: "local", reason: "没有可用的 peer，放本机" }) });
  const cases: [string, Record<string, unknown>, () => DagToolDeps][] = [
    ["local", { placement: "local" }, () => deps({ placement: async () => PEER })],
    ["auto (default) with no placement wired", {}, () => deps()],
    ["explicit auto that lands local", { placement: "auto" }, localEnv],
    ["auto whose placement read throws", { placement: "auto" }, () => deps({ placement: async () => { throw new Error("lend.json 坏了"); } })],
  ];
  for (const [name, args, d] of cases) {
    test(`${name}: normal path`, async () => {
      expect((await plan()).ok).toBe(true);
      calls = [];
      expect(digest(product(await start(args, d())))).toBe(START_GOLDEN.normal);
    });
    test(`${name}: rollback`, async () => {
      expect((await plan()).ok).toBe(true);
      calls = [];
      failOn = (a) => a[0] === "ledger" && a[1] === "workflow-set";
      expect(digest(product(await start(args, d())))).toBe(START_GOLDEN.rollback);
    });
  }
});

describe("placement peer:<name>", () => {
  const PEER: StartPlacement = { where: "peer", peer: "mate", repo: "o/r", reason: "在跑：mate 0 / 本机 2；选最少，平手按 peer 先于本机 > 借入顺序" };
  const peerEnv = () => deps({ placement: async () => PEER });

  test("card only: no worktree, no agent, no git; pinned with its repo, restate skipped with an auditable decision, auto, node bound", async () => {
    expect((await plan()).ok).toBe(true);
    calls = [];
    const out = await start({ placement: "peer:mate" }, peerEnv());
    expect(out).toMatchObject({ ok: true, taskId: "i28-a", placement: "peer:mate", steps: ["task-new", "spec", "workflow", "restate", "bind"] });
    expect(calls.filter((c) => c[0] !== "ledger")).toEqual([]);
    expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
    expect(existsSync(join(dir, "ledger", "reviews", "i28-a-exec-prompt.md"))).toBe(false);
    expect(Object.keys(agents)).toEqual([PM.agent]);
    const t = getTask(db, "i28-a")!;
    expect(t).toMatchObject({ stage: "restate", agent: null, extra: { fileGlobs: ["src/lib/a*.ts"], placement: "peer:mate", repo: "o/r" } });
    const events = listEvents(db, { project: P, target: "i28-a" });
    const decision = events.find((e) => e.kind === "decision");
    expect(decision?.text).toContain("start_node 放到 peer:mate（在跑：mate 0 / 本机 2；选最少，平手按 peer 先于本机 > 借入顺序）");
    expect(decision?.text).toContain("复述环节跳过");
    const restate = events.find((e) => e.kind === "stage");
    expect(restate).toMatchObject({ data: { from: "spec", to: "restate" } });
    expect(restate!.seq).toBeGreaterThan(decision!.seq);
    expect(restate!.seq).toBeGreaterThan(events.find((e) => e.kind === "scheduler" && e.data.op === "workflow")!.seq);
    expect(getWorkflow(db, "i28-a")).toMatchObject({ mode: "auto", templateVersion: 3 });
    expect((await call(deps(), "show_dag", { featureId: "i28" })).version.nodes[0]).toMatchObject({ key: "a", taskId: "i28-a" });
    // The scheduler takes it from there: the skipped restate releases build, and build waits on the pin instead of a local author.
    const snap = autoSnapshot(db, t, { registry: [], maxWorkers: 2, now });
    expect(planScheduler(snap)).toMatchObject({ kind: "intent", action: "stage", targetStage: "build" });
    expect(planScheduler({ ...snap, task: { ...t, stage: "build" } })).toMatchObject({ kind: "wait", code: "placement_pinned" });
  });

  test("auto that the pool sends to a peer takes the same peer path", async () => {
    expect((await plan()).ok).toBe(true);
    expect(await start({}, peerEnv())).toMatchObject({ ok: true, placement: "peer:mate" });
  });

  test("a later step failing rolls the peer card back: back to manual, cancelled, spec it wrote removed, nothing local made", async () => {
    expect((await plan()).ok).toBe(true);
    rmSync(join(dir, "ledger", "docs", "tasks", "i28-a.md"));
    calls = [];
    failOn = (a) => a[0] === "ledger" && a[1] === "stage" && a.includes("--to=restate");
    const out = await start({ placement: "peer:mate", spec: "# 规格\n" }, peerEnv());
    expect(out).toMatchObject({ ok: false, failedStep: "restate", rolledBack: ["workflow", "spec", "task-new"], leftovers: [] });
    expect(getWorkflow(db, "i28-a")?.mode).toBe("manual");
    expect(getTask(db, "i28-a")?.stage).toBe("cancelled");
    expect(existsSync(join(dir, "ledger", "docs", "tasks", "i28-a.md"))).toBe(false);
    expect(calls.filter((c) => c[0] !== "ledger")).toEqual([]);
  });

  test("refused before anything is written: placement not wired, the peer fails a constraint, or a bad value", async () => {
    expect((await plan()).ok).toBe(true);
    calls = [];
    expect(await start({ placement: "peer:mate" })).toMatchObject({ ok: false, code: "placement", error: expect.stringContaining("没接槽池放置") });
    const refuse = deps({ placement: async () => ({ where: "refused", reason: "固定放在 peer:mate，它现在不能接：对方的授权已到期" }) });
    expect(await start({ placement: "peer:mate" }, refuse)).toMatchObject({ ok: false, code: "placement", error: expect.stringContaining("授权已到期") });
    for (const bad of ["peer:", "peer:a b", "remote", 3]) expect(await start({ placement: bad })).toMatchObject({ ok: false, code: "invalid" });
    expect(calls).toEqual([]);
    expect(getTask(db, "i28-a")).toBeNull();
  });
});

describe("startPlacement against the real rules (before W8)", () => {
  const io = (roles: string[] = ["review"]) => ({
    policy: () => ({ remote: { mode: "balance" as const, roles: roles as ["review"], poolTimeoutMin: 15 }, maxWorkers: 2 }),
    borrow: async () => [{ peer: "mate", projects: [P], roles: ["review" as const, "write" as const], maxOpen: 2 }],
    originRepo: async () => "o/r", now: () => now,
  });
  const helloMate = () => recordHello(db, "mate", null, { v: 1, proto: 2, boot: "b1", seq: 1, paused: null,
    slots: { codex: { total: 2, busy: 0 }, claude: { total: 2, busy: 0 } },
    grant: { until: now + 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 9, ordersLeftToday: 9 } }, now);
  const q = (want: "auto" | `peer:${string}`) => ({ project: P, repoDir: repo, fileGlobs: ["src/lib/a*.ts"], want });

  test("even an idle peer granting write: auto lands local, a peer pin is refused (remote.roles never holds write before W8)", async () => {
    helloMate();
    expect(await startPlacement(db, io(), q("auto"))).toMatchObject({ where: "local" });
    expect(await startPlacement(db, io(), q("peer:mate"))).toEqual({ where: "refused", reason: "固定放在 peer:mate，它现在不能接：scheduler.json remote.roles 不含 write" });
  });

  test("once write is allowed (W8) the same rules place it, and a revoked grant refuses the pin", async () => {
    helloMate();
    expect(await startPlacement(db, io(["review", "write"]), q("auto"))).toMatchObject({ where: "peer", peer: "mate", repo: "o/r" });
    recordHello(db, "mate", null, { v: 1, proto: 2, boot: "b1", seq: 2, paused: null, grant: null,
      slots: { codex: { total: 2, busy: 0 }, claude: { total: 2, busy: 0 } } }, now);
    expect(await startPlacement(db, io(["review", "write"]), q("peer:mate"))).toMatchObject({ where: "refused", reason: expect.stringContaining("收回") });
    expect(await startPlacement(db, io(["review", "write"]), q("auto"))).toMatchObject({ where: "local" });
  });
});
