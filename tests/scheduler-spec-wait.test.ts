/**
 * team-project-PMWAKE 验收线 3–6（缺规格提醒、边界、重启不重发、私仓）与线 2 的发送端：真实临时台账 + 进程内 ledger CLI 跑完整自动开卡 tick，
 * git / create / kill 用记账的假实现，发送函数换成记录器（specWaitSend）。时钟统一走 clock（env.now、规格卡 mtime）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import type { StepIO } from "../src/lib/dag-tools-steps.js";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { currentViews, isStop, nodeCandidate } from "../src/lib/scheduler-autostart.js";
import { featureLanes } from "../src/lib/dag-tools-lanes.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { SPEC_WAIT_REPEAT_MS } from "../src/lib/scheduler-spec-wait-ledger.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", PM = "agent-pm", X = "agent-claudestra", FID = "ab12-i28";
let dir: string, repo: string, db: Database, clock: number, seq: number;
let agents: Record<string, { channelId: string; projectId?: string }>;
let branches: Set<string>, worktrees: Map<string, string | null>;
let sent: { project: string; to: string; text: string }[], notes: string[];
const quota: InventoryQuota = { status: "known", source: "live", observedAt: 1, plan: null, reason: null, windows: [] };

const ledgerDeps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents }) as never, saveRegistry: async () => {}, now: () => clock + seq++,
  autoDispatch: () => true, autoProjects: () => [P],
});
// 调度子进程的时钟与 env.now 对齐（30 分钟窗口的边界按毫秒断言）
const schedLedger = async (...args: string[]) => runLedger(args.slice(1), { ...ledgerDeps("scheduler"), now: () => clock });

async function plain(args: string[]): Promise<any> {
  if (args[0] === "create") agents[`agent-${args[1]}`] = { channelId: `ch-${args[1]}`, projectId: P };
  if (args[0] === "kill") delete agents[args[1]];
  return { ok: true };
}

async function git(_cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const [cmd, sub] = args;
  if (cmd === "worktree" && sub === "add") {
    const path = args.at(-2) as string;
    mkdirSync(path, { recursive: true });
    branches.add(args[args.indexOf("-b") + 1]);
    worktrees.set(path, args[args.indexOf("--reason") + 1] ?? null);
  } else if (cmd === "worktree" && sub === "unlock") worktrees.set(args[2], null);
  else if (cmd === "worktree" && sub === "list") {
    return { ok: true, out: [...worktrees].map(([w, lock]) => `worktree ${w}\nHEAD base0${lock ? `\nlocked ${lock}` : ""}`).join("\n\n") };
  } else if (cmd === "rev-parse") {
    const ok = args[3].endsWith("^{commit}") || branches.has(args[3].replace("refs/heads/", ""));
    return { ok, out: ok ? "base0" : "" };
  }
  return { ok: true, out: "" };
}

const startEnv = () => ({
  ledgerDir: join(dir, "ledger"), worktreeRoot: join(dir, "wt"), projectDirs: async () => [repo], agentNames: () => Object.keys(agents),
  exists: existsSync, branchExists: async (_r: string, b: string) => branches.has(b), autoReady: () => null, template: () => null,
});
const stepIO = (): Omit<StepIO, "db" | "manager" | "attempt"> => ({
  git, exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  write: (p, t) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); },
  remove: (p) => rmSync(p, { force: true }), symlink: (t, p) => writeFileSync(p, `-> ${t}`), agentExists: (a) => !!agents[a],
});

const specPath = (id: string) => join(dir, "ledger", "docs", "tasks", `${id}.md`);
function spec(id: string, ageMs = 120_000): void {
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  writeFileSync(specPath(id), "# 规格\n\n## 目标\n");
  const t = new Date(clock - ageMs);
  utimesSync(specPath(id), t, t);
}

function env(over: Partial<StartTickEnv> = {}): StartTickEnv {
  const e: StartTickEnv = {
    db, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 3 }, ledger: schedLedger, plain, startEnv, stepIO,
    readSpec: (id) => (existsSync(specPath(id)) ? { mtimeMs: statSync(specPath(id)).mtimeMs, text: readFileSync(specPath(id), "utf8") } : null),
    quota: async () => quota, notifyPm: async (_p, text) => void notes.push(text), memo: new Set(), now: () => clock,
    attempt: () => Math.random().toString(16).slice(2, 10), ...over,
  };
  return Object.assign(e, { specWaitSend: async (_db: Database, project: string, to: string, text: string) => void sent.push({ project, to, text }) });
}

const sw = (input: { on?: boolean; featureId?: string; pm?: string; specWait?: string }) =>
  setAutostartSwitch(db, { actor: PM, now: clock + seq++ }, { project: P, on: input.on ?? true, featureId: input.featureId, pm: input.pm, specWait: input.specWait, reason: "测试" });
const records = () => listEvents(db, { target: FID }).filter((e) => e.data.op === "spec_wait");
const tick = () => autostartTick(env());

beforeEach(() => {
  clock = Date.now();
  seq = 0;
  sent = [];
  notes = [];
  branches = new Set(["main"]);
  worktrees = new Map();
  dir = mkdtempSync(join(tmpdir(), "pmwake-spec-wait-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM, X] });
  agents = { [PM]: { channelId: "ch-pm", projectId: P }, [X]: { channelId: "ch-x", projectId: P } };
  createFeature(db, { actor: PM, now: clock + seq++ }, { project: P, slug: "i28", title: "协作底座" });
  initDag(db, { actor: PM, now: clock + seq++ }, { id: FID, rev: 1, nodes: [
    { key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a*.ts"] },
    { key: "b", oneLine: "节点 b", fileGlobs: ["src/lib/b.ts"], deps: ["a"] },
  ] });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("线 3：缺规格提醒", () => {
  test("spec-wait=on，就绪节点缺规格卡：一轮恰好 1 条给 featurePm（含节点与卡号）；同一时刻再跑 0 条；30 分钟后仍缺再 1 条；放好规格卡 → 自动开卡、之后 0 条", async () => {
    sw({ specWait: "on" });
    sw({ featureId: FID, pm: X });
    expect(await tick()).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(X);
    expect(sent[0].text).toBe("[待写规格] 协作底座 的节点 a（节点 a）依赖已满足，可以开工，缺规格卡 i28-a.md；放好后调度器自动开卡。");
    await tick();
    expect(sent).toHaveLength(1);
    clock += SPEC_WAIT_REPEAT_MS - 1_000;
    await tick();
    expect(sent).toHaveLength(1);
    clock += 1_000;
    await tick();
    expect(sent).toHaveLength(2);
    expect(sent[1].to).toBe(X);
    spec("i28-a");
    expect(await tick()).toEqual([]);
    expect(getTask(db, "i28-a")).toMatchObject({ pm: X });
    clock += SPEC_WAIT_REPEAT_MS;
    await tick();
    expect(sent).toHaveLength(2);
    expect(records().map((e) => e.data.mode)).toEqual(["on", "on"]);
  });

  test("没设 feature PM → 发给项目 PM（与 main 的 PM 解析一致）", async () => {
    sw({ specWait: "on" });
    await tick();
    expect(sent.map((s) => s.to)).toEqual([PM]);
  });
});

describe("线 4：边界", () => {
  test("容量满：不开卡，但提醒照发", async () => {
    sw({ specWait: "on" });
    await autostartTick(Object.assign(env({ svc: { autoDispatch: true, projects: [P], maxWorkers: () => 0 } })));
    expect(sent).toHaveLength(1);
  });

  test("feature 开关关着：0 条、0 记录", async () => {
    sw({ specWait: "on" });
    sw({ on: false, featureId: FID });
    await tick();
    expect(sent).toEqual([]);
    expect(records()).toEqual([]);
  });

  test("规格卡刚改过（未满 60 秒）：不算缺，0 条", async () => {
    sw({ specWait: "on" });
    spec("i28-a", 10_000);
    await tick();
    expect(sent).toEqual([]);
    expect(getTask(db, "i28-a")).toBeNull();
  });

  test("依赖没满足的节点（b 等 a）：0 条；只提醒就绪的 a", async () => {
    sw({ specWait: "on" });
    await tick();
    expect(sent.map((s) => s.text).join()).not.toContain("节点 b");
    const f = getFeature(db, FID)!;
    const r = nodeCandidate(db, f, "b", featureLanes(db, f), currentViews(db, f), () => null, clock);
    expect(isStop(r) && r.gate).toBe("lanes");
  });

  test("缺省 observe：只写记录、0 条消息；切 on 立即发第一条", async () => {
    await tick();
    expect(sent).toEqual([]);
    expect(records()).toHaveLength(1);
    expect(records()[0].data).toMatchObject({ op: "spec_wait", key: "a", version: 1, mode: "observe", pm: PM });
    await tick();
    expect(records()).toHaveLength(1);
    sw({ specWait: "on" });
    await tick();
    expect(sent).toHaveLength(1);
  });

  test("off：0 记录 0 消息", async () => {
    sw({ specWait: "off" });
    await tick();
    expect(sent).toEqual([]);
    expect(records()).toEqual([]);
  });

  test("发送失败不拖垮自动开卡：进 failed，下一窗口再试", async () => {
    sw({ specWait: "on" });
    const e = env();
    Object.assign(e, { specWaitSend: async () => { throw new Error("bridge 不在"); } });
    const failed = await autostartTick(e);
    expect(failed.map((f) => f.error).join()).toContain("bridge 不在");
  });
});

describe("线 5：重启不重发", () => {
  test("清空进程内状态（新 env、新 memo）后 30 分钟窗口内 0 条：去重靠台账记录", async () => {
    sw({ specWait: "on" });
    await tick();
    expect(sent).toHaveLength(1);
    closeLedger(join(dir, "ledger.sqlite"));
    db = openLedger(join(dir, "ledger.sqlite"));
    clock += SPEC_WAIT_REPEAT_MS - 1;
    await autostartTick(env({ memo: new Set() }));
    expect(sent).toHaveLength(1);
    clock += 1;
    await autostartTick(env({ memo: new Set() }));
    expect(sent).toHaveLength(2);
  });
});

describe("线 6：私仓节点", () => {
  test("fileGlobs 含 repo: 的就绪节点：缺规格时提醒带私仓说明；规格到位也不自动开卡（停因 private）", async () => {
    initDag(db, { actor: PM, now: clock + seq++ }, { id: createFeature(db, { actor: PM, now: clock + seq++ }, { project: P, slug: "cloud", title: "云端" }).row.id,
      rev: 1, nodes: [{ key: "c", oneLine: "私仓节点", fileGlobs: ["repo:floka-ai/cloud/**"] }] });
    sw({ specWait: "on" });
    await tick();
    const priv = sent.find((s) => s.text.includes("cloud-c.md"));
    expect(priv?.text).toEndWith("（私仓节点：规格放好后手动开卡）");
    expect(sent.find((s) => s.text.includes("i28-a.md"))?.text).not.toContain("私仓");
    spec("cloud-c");
    await tick();
    expect(getTask(db, "cloud-c")).toBeNull();
    const f = getFeature(db, "ab12-cloud")!;
    const r = nodeCandidate(db, f, "c", featureLanes(db, f), currentViews(db, f), env().readSpec, clock);
    expect(isStop(r) && r).toMatchObject({ gate: "private", why: "私仓节点由 PM 用私仓开卡流程手动开" });
  });
});

describe("生产接线：env.db 是只读 LedgerReader（query_only），记录走调度 ledger CLI", () => {
  test("observe 落记录、on 发 1 条，failed 为空；某节点记账被拒只记这一条，其余节点照常", async () => {
    const reader = new LedgerReader(join(dir, "ledger.sqlite"));
    const ro = reader.get() as Database;
    expect((ro.query("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(1);
    try {
      expect(await autostartTick(env({ db: ro }))).toEqual([]);
      expect(records().map((e) => e.data.mode)).toEqual(["observe"]);
      expect(sent).toEqual([]);
      sw({ specWait: "on" });
      expect(await autostartTick(env({ db: ro }))).toEqual([]);
      expect(sent.map((x) => x.to)).toEqual([PM]);
      expect(records().map((e) => e.data.mode)).toEqual(["observe", "on"]);
      initDag(db, { actor: PM, now: clock + seq++ }, { id: createFeature(db, { actor: PM, now: clock + seq++ }, { project: P, slug: "z", title: "另一个" }).row.id,
        rev: 1, nodes: [{ key: "z", oneLine: "节点 z", fileGlobs: ["src/lib/z.ts"] }] });
      clock += SPEC_WAIT_REPEAT_MS;
      const ledger = async (...args: string[]) => (args.includes("ab12-i28") ? { ok: false, code: "invalid", error: "拒" } : schedLedger(...args));
      const failed = await autostartTick(env({ db: ro, ledger }));
      expect(failed).toEqual([{ taskId: "ab12-i28/a", error: "缺规格提醒记账失败：拒" }]);
      expect(sent.map((x) => x.text).filter((t) => t.includes("z-z.md"))).toHaveLength(1);
    } finally {
      reader.close();
    }
  });
});

describe("写前重算：spec-wait 写只给调度身份，条件变了就不记", () => {
  test("模式不符 / feature 关了 / 节点不在 startNow / 版本不对 → conflict 0 记录；非调度身份 → 拒", async () => {
    const w = (mode: string, key = "a", version = "1") =>
      schedLedger("ledger", "scheduler-autostart", "spec-wait", FID, key, "--version", version, "--mode", mode, "--pm", PM, "--text", "t");
    expect(await w("on")).toMatchObject({ ok: false, code: "conflict" });
    expect(await w("observe", "b")).toMatchObject({ ok: false, code: "conflict" });
    expect(await w("observe", "a", "2")).toMatchObject({ ok: false, code: "conflict" });
    sw({ on: false, featureId: FID });
    expect(await w("observe")).toMatchObject({ ok: false, code: "conflict" });
    sw({ on: true, featureId: FID });
    expect(await runLedger(["scheduler-autostart", "spec-wait", FID, "a", "--version", "1", "--mode", "observe", "--pm", PM, "--text", "t"], ledgerDeps(PM)))
      .toMatchObject({ ok: false });
    expect(records()).toEqual([]);
    expect(await w("observe")).toMatchObject({ ok: true, due: true });
    expect(records()).toHaveLength(1);
  });
});
