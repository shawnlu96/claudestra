/**
 * agents-MAPSWEEP1：常驻进程里按卡 / agent / ask / 组合累积的内存表，在已有的 tick 或调用点按「当前还要用」清扫，或按条数 / 字节封顶。
 * 每处造 1 万个键，让它们进入终态 / 退场 / 关闭，跑一次 tick 后表回到 0 或不超过上限；清扫后同一张终态卡、同一个已退场 agent
 * 再进来一次，不重复发通知。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { setAskReminderPorts, askReminderLogMemory, sweepExpired } from "../src/bridge/ask-expire.js";
import { ownerPresence, setAsksForTest, type AsksDeps } from "../src/bridge/asks.js";
import { ledgerFeedAskSeenSize, setLedgerFeedForTest } from "../src/bridge/ledger-feed.js";
import { modelDriftAlertedSize, modelDriftTick, type ModelDriftDeps } from "../src/bridge/model-drift.js";
import { pickSwitchOverride, rememberSwitchOverride, setSwitchOverrideRegistryForTest, switchOverrideSize } from "../src/bridge/switch-override.js";
import { closeAsk, openAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { NOTICE_FAILURE_CAP, remoteNoticeRetrySize, remoteReviewStep } from "../src/lib/remote-review-tick.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { ARCHIVE_CACHE_BYTES, ARCHIVE_MAX_BYTES, ciProofArchiveMemory, ghCiProofPort, resetCiProofPortCache } from "../src/lib/scheduler-ci-proof-port.js";
import { freezeReviewMaterials, WIRING_SWEEP_MS, wiringToldSize, type ModelWiringCard } from "../src/lib/scheduler-model-wiring.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import type { OrderPlan } from "../src/lib/scheduler-review-swap.js";
import type { PlannerDecision, PlannerSnapshot } from "../src/lib/scheduler-plan.js";
import { REBASE_CACHE_MAX, rebaseCacheSize, rebaseDiff, rebaseFixDiff } from "../src/lib/scheduler-review-rebase.js";
import { START_GAP_MS, START_GAP_SWEEP_MS, startGapMemory, trackStartGap, type StartGapCard } from "../src/lib/scheduler-start-gap.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const N = 10_000;
const ids = (n = N) => Array.from({ length: n }, (_, i) => `T${i}`);

function ledger(prefix: string) {
  const path = tempLedgerPath(prefix), db = openLedger(path);
  return { path, db, close: () => closeLedger(path) };
}
/** n 张卡（同一项目）直接落表：清扫只看 stage / specRev */
function seedTasks(db: Database, n: number, stage = "build"): void {
  const q = db.prepare("INSERT INTO tasks (id, project, title, kind, stage, specRev, createdAt, updatedAt) VALUES (?, 'p', 't', 'code', ?, 1, 1, 1)");
  db.transaction(() => { for (const id of ids(n)) q.run(id, stage); })();
}

describe("start-gap：inBuild / told", () => {
  test("[验收线 1][验收线 2] 1 万张卡在 build 留了 inBuild 与 told；全部结束后跑一次 tick 回到 0；终态卡再来一轮不再通知", async () => {
    const l = ledger("mapsweep-gap-");
    try {
      seedTasks(l.db, N);
      let now = 1_000_000, told = 0;
      const deps: StartGapCard["deps"] = { now: () => now, manager: async () => ({ code: "v2_unmapped" }), notifyPm: async () => void told++,
        recoveryPolicy: () => ({ mode: "observe", manualAfterMs: null, source: "config" }) };
      const plan: PlannerDecision = { kind: "wait", code: "queue_frozen", reason: "冻结" };
      const pass = async (id: string) => {
        const task = getTask(l.db, id)!;
        const snap = { task, workflow: { mode: "auto" }, events: [], intents: [] } as unknown as PlannerSnapshot;
        await trackStartGap({ db: l.db, task, deps }, snap, plan);
      };
      for (const id of ids()) await pass(id); // 记下首见时刻
      now += START_GAP_MS;
      for (const id of ids()) await pass(id); // 过阈值：中心副本按通知记一次（told）
      expect(told).toBe(N);
      expect(startGapMemory(l.db)).toEqual({ told: 2 * N, inBuild: N });
      l.db.run("UPDATE tasks SET stage = 'done'");
      now += START_GAP_SWEEP_MS;
      await pass("T0");
      expect(startGapMemory(l.db)).toEqual({ told: 0, inBuild: 0 });
      await pass("T0");
      await pass("T1");
      expect(told).toBe(N); // 终态卡不再进 build：清掉的去重不会被用到
    } finally { l.close(); }
  }, 60_000);

  test("还在 build 的卡不清：清扫后同一张卡再过一轮不重复通知", async () => {
    const l = ledger("mapsweep-gap2-");
    try {
      seedTasks(l.db, 2);
      let now = 1_000_000, told = 0;
      const deps: StartGapCard["deps"] = { now: () => now, manager: async () => ({ code: "v2_unmapped" }), notifyPm: async () => void told++,
        recoveryPolicy: () => ({ mode: "observe", manualAfterMs: null, source: "config" }) };
      const pass = async (id: string) => {
        const task = getTask(l.db, id)!;
        await trackStartGap({ db: l.db, task, deps }, { task, workflow: { mode: "auto" }, events: [], intents: [] } as unknown as PlannerSnapshot,
          { kind: "wait", code: "queue_frozen", reason: "冻结" });
      };
      await pass("T0");
      now += START_GAP_MS;
      await pass("T0");
      l.db.run("UPDATE tasks SET stage = 'cancelled' WHERE id = 'T1'");
      now += START_GAP_SWEEP_MS;
      await pass("T1");
      await pass("T0");
      expect(told).toBe(1);
      expect(startGapMemory(l.db)).toEqual({ told: 2, inBuild: 1 });
    } finally { l.close(); }
  }, 60_000);
});

describe("model-wiring：「拒审接续不可用」的内存去重", () => {
  test("[验收线 1][验收线 2] 1 万张卡各报一次不可用；卡终态后下一次报不可用时清掉；终态卡不再通知", async () => {
    const l = ledger("mapsweep-wiring-");
    try {
      seedTasks(l.db, N + 1);
      let now = 1_000_000, told = 0;
      const deps: ModelWiringCard["deps"] = { now: () => now, manager: async () => ({ ok: false, code: "down", error: "写口坏了" }), notifyPm: async () => void told++ };
      const fail = (id: string) => freezeReviewMaterials({ db: l.db, task: getTask(l.db, id)!, opts: {}, deps }, { id: `i-${id}` } as SchedulerIntent, {} as OrderPlan);
      const err = console.error;
      console.error = () => {};
      try {
        for (const id of ids()) await fail(id);
        expect(told).toBe(N);
        expect(wiringToldSize(l.db.filename)).toBe(N);
        await fail("T0");
        expect(told).toBe(N); // 同卡同种类：内存去重照旧
        l.db.run(`UPDATE tasks SET stage = 'done' WHERE id != 'T${N}'`);
        now += WIRING_SWEEP_MS;
        await fail(`T${N}`); // 另一张还活着的卡报不可用：顺带清扫
        expect(wiringToldSize(l.db.filename)).toBe(1);
        expect(told).toBe(N + 1);
        await fail(`T${N}`);
        expect(told).toBe(N + 1);
      } finally { console.error = err; }
    } finally { l.close(); }
  }, 60_000);
});

describe("remote-review-tick：failedAt", () => {
  test("[验收线 1][验收线 2] 1 万条通知发失败留了重试时刻；被外部结算后下一轮清掉，不再重发", async () => {
    const l = ledger("mapsweep-rr-");
    try {
      const ins = l.db.prepare(`INSERT INTO events (ts, actor, project, target, kind, data, dedupKey) VALUES (1, 'scheduler', 'p', ?, 'scheduler', ?, ?)`);
      l.db.transaction(() => {
        for (const id of ids()) ins.run(id, JSON.stringify({ op: "remote_review", notice: `n ${id}` }), `scheduler:remote_review:${id}:r:abc`);
      })();
      let now = 1_000_000, sent = 0, fail = true;
      const config = { projects: { p: { handoffPeer: "peer-x" } } } as unknown as SchedulerConfig;
      const deps = { manager: async () => ({ ok: true }), active: () => {}, dir: "/nonexistent-mapsweep", now: () => now,
        notify: async () => { sent++; if (fail) throw new Error("PM 不在"); } };
      await remoteReviewStep(l.db, config, deps);
      expect(sent).toBe(N);
      expect(remoteNoticeRetrySize(l.db)).toBe(NOTICE_FAILURE_CAP); // RRL-4 caps retry memory even while all 10k notices remain pending.
      // 外部结算：每条都有了 notified 事件
      const done = l.db.prepare(`INSERT INTO events (ts, actor, project, target, kind, data, dedupKey) VALUES (1, 'scheduler', 'p', 'T0', 'scheduler', '{}', ?)`);
      const seqs = (l.db.query("SELECT seq FROM events").all() as { seq: number }[]).map((r) => r.seq);
      l.db.transaction(() => { for (const s of seqs) done.run(`scheduler:remote_review_notified:${s}`); })();
      now += 60_000;
      fail = false;
      await remoteReviewStep(l.db, config, deps);
      expect(remoteNoticeRetrySize(l.db)).toBe(0);
      expect(sent).toBe(N);
    } finally { l.close(); }
  }, 60_000);
});

describe("model-drift：已退场 agent 的告警去重", () => {
  test("[验收线 1][验收线 2] 1 万个 agent 各告警一次；退场后一次 tick 回到 0；仍在册的漂移不重复告警", async () => {
    let agents: RegistryAgent[] = ids().map((i) => ({ name: `agent-${i}`, status: "active", runtime: "claude-code", cwd: "/tmp/x", sessionId: `s-${i}`,
      channelId: `c-${i}`, model: "claude-opus-5-5" }) as RegistryAgent);
    const now = 5_000_000;
    const deps: ModelDriftDeps = { agents: async () => agents, tail: async () => ({ model: "claude-sonnet-5-5", modelTs: now }) as never, globalModel: async () => null, now: () => now };
    let notes = 0;
    const log = console.log;
    console.log = () => {};
    try {
      await modelDriftTick(() => void notes++, deps);
      expect(notes).toBe(N);
      expect(modelDriftAlertedSize()).toBe(N);
      await modelDriftTick(() => void notes++, deps);
      expect(notes).toBe(N);
      agents = agents.slice(0, 1); // 其余退场
      await modelDriftTick(() => void notes++, deps);
      expect(modelDriftAlertedSize()).toBe(1);
      expect(notes).toBe(N); // 留下的那个还在漂：不重复告警
      agents = [];
      await modelDriftTick(() => void notes++, deps);
      expect(modelDriftAlertedSize()).toBe(0);
      expect(notes).toBe(N);
    } finally { console.log = log; }
  }, 60_000);
});

describe("switch-override：已退场 agent 的乐观值", () => {
  afterEach(() => setSwitchOverrideRegistryForTest(undefined));
  test("[验收线 1] 1 万个 agent 切过模型、没等到实测就退场；下一次切换时清到只剩在册的", () => {
    pickSwitchOverride("master", { modelTs: Infinity, effortTs: Infinity } as never); // 别的测试留下的 master 乐观值（常留）先清掉
    let names = ids().map((i) => `agent-${i}`);
    setSwitchOverrideRegistryForTest(() => null); // 灌数时不清（每次切换都扫一遍会是 n²，生产里切换是人手动作）
    for (const n of names) rememberSwitchOverride(n, { model: "m" });
    setSwitchOverrideRegistryForTest(() => names);
    expect(switchOverrideSize()).toBeGreaterThanOrEqual(N);
    names = ["agent-keep"];
    rememberSwitchOverride("agent-keep", { effort: "high" });
    expect(switchOverrideSize()).toBe(1);
    expect(pickSwitchOverride("agent-keep", null)).toEqual({ model: null, effort: "high" });
    setSwitchOverrideRegistryForTest(() => null); // 读不出登记表：不清
    rememberSwitchOverride("agent-other", { model: "m" });
    expect(switchOverrideSize()).toBe(2);
  }, 60_000);

  test("[验收线 1] 1 万个 agent 全员退场（登记表读出空表）；master 切换时清到只剩 master", () => {
    pickSwitchOverride("master", { modelTs: Infinity, effortTs: Infinity } as never);
    const names = ids().map((i) => `agent-${i}`);
    setSwitchOverrideRegistryForTest(() => null);
    for (const n of names) rememberSwitchOverride(n, { model: "m" });
    expect(switchOverrideSize()).toBeGreaterThanOrEqual(N);
    setSwitchOverrideRegistryForTest(() => []);
    rememberSwitchOverride("master", { model: "m" });
    expect(switchOverrideSize()).toBe(1);
    expect(pickSwitchOverride(names[0], null)).toEqual({ model: null, effort: null });
    expect(pickSwitchOverride("master", null)).toEqual({ model: "m", effort: null });
  }, 60_000);
});

describe("ledger-feed：结清关问的 seen", () => {
  let path = "";
  let db: Database;
  beforeEach(() => { path = tempLedgerPath("mapsweep-feed-"); db = openLedger(path); });
  afterEach(() => { setLedgerFeedForTest(undefined); closeLedger(path); });

  test("[验收线 1][验收线 2] 1 万条随单结清的关闭进了 seen；下一拍清掉；换库后照旧不补发历史", async () => {
    db.transaction(() => {
      for (const i of ids()) {
        const id = openAsk(db, { project: "p", taskId: "T1", source: "reply", kind: "decide", title: "q", fromAgent: "agent-l", extra: { via: "mcp_ask", orderId: `lend:${i}` } }).id;
        closeAsk(db, id, "cancelled", "出借单已结清", Date.now(), { settledOrder: { orderId: `lend:${i}`, status: "done", by: "lend", at: Date.now() } });
      }
    })();
    await Bun.sleep(5);
    const got: string[] = [];
    const tick = setLedgerFeedForTest({ path, emit: () => {}, emitAsk: (c) => void got.push(c.askId) })!;
    tick(); // 基线：全记进 seen，不发
    expect(got).toEqual([]);
    await Bun.sleep(5);
    tick();
    expect(ledgerFeedAskSeenSize()).toBe(0);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const alt = tempLedgerPath("mapsweep-feed-alt-");
    copyFileSync(path, alt);
    closeLedger(path);
    for (const x of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(x)) renameSync(x, `${x}.old`);
    renameSync(alt, path);
    db = openLedger(path);
    tick();
    expect(got).toEqual([]); // 清掉的历史在换上来的库里照样不发
  }, 60_000);
});

describe("ask-expire：observed / held 日志去重", () => {
  const s = { path: "", mode: "observe" as "observe" | "off" };
  beforeEach(() => {
    s.path = tempLedgerPath("mapsweep-ask-");
    openLedger(s.path);
    const deps: AsksDeps = { clients: new Map(), controlChannelId: "999", hold: () => {}, deliver: async (env) => ({ envelope: env, outcome: { kind: "sent" } }) };
    setAsksForTest({ path: s.path, deps, registry: [], ownerChats: [] });
    s.mode = "observe";
    setAskReminderPorts({ policy: () => ({ mode: s.mode, manualAfterMs: null }), ownerActive: () => ({ active: true, evidence: "t" }), askerLive: () => true });
  });
  afterEach(() => { setAskReminderPorts(undefined); setAsksForTest(undefined); closeLedger(s.path); });

  test("[验收线 1][验收线 2] 1 万条过期 ask 记了 observe、1 万条待办记了 held；不再是候选 / 待办后一轮回到 0；仍在的不重复记日志", async () => {
    const db = openLedger(s.path);
    const n = N / 2;
    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const a = openAsk(db, { project: "p", source: "reply", kind: "authorize", title: "q", fromAgent: `agent-a${i}`, blocking: true });
        closeAsk(db, a.id, "expired", "", Date.now());
        openAsk(db, { project: "p", source: "reply", kind: "authorize", title: "r", fromAgent: `agent-b${i}`, extra: { recoveryOf: `x${i}`, remindNotice: "pending" } });
      }
    })();
    const logs: string[] = [];
    const log = console.log;
    console.log = (m: unknown) => void logs.push(String(m));
    try {
      await sweepExpired();
      expect(askReminderLogMemory()).toEqual({ observed: n, held: n });
      await sweepExpired();
      const count = () => [logs.filter((m) => m.startsWith("[askReminder observe]")).length, logs.filter((m) => m.startsWith("[askReminder] ")).length];
      expect(count()).toEqual([n, n]); // 第二轮不重复
      s.mode = "off"; // 不再是 observe 候选
      db.run("UPDATE asks SET state = 'cancelled' WHERE state = 'open'"); // 待办卡已结
      await sweepExpired();
      expect(askReminderLogMemory()).toEqual({ observed: 0, held: 0 });
      expect(count()).toEqual([n, n]);
    } finally { console.log = log; }
  }, 60_000);
});

describe("review-rebase：缓存按条数 LRU", () => {
  const SHA = (n: number, c = "a") => n.toString(16).padStart(40, c).slice(-40);
  const events = (mainParent: string, newHead: string): LedgerEvent[] => [
    { seq: 1, ts: 1, actor: "scheduler", project: "p", target: "T1", kind: "stage", text: "", data: { from: "merge", to: "review", head: newHead, round: 2 } },
    { seq: 2, ts: 1, actor: "scheduler", project: "p", target: "T1", kind: "scheduler", text: "",
      data: { op: "merge_phase", from: "updating", to: "await_review",
        receipt: `update-branch 改了 head：原 head ${SHA(0, "f")} → 新 head ${newHead}，main 父提交 ${mainParent}，x，旧审查失效` } },
  ] as unknown as LedgerEvent[];
  const real = { ...rebaseDiff };
  afterEach(() => Object.assign(rebaseDiff, real));

  test("[验收线 1][验收线 3] 1 万个组合只留 512 条；超了淘汰最久未用的，命中的不被淘汰", () => {
    let runs = 0;
    Object.assign(rebaseDiff, { dirs: () => ["/d"], run: () => (runs++, ["f.ts"]) });
    const ask = (i: number) => { const h = SHA(i, "b"); return rebaseFixDiff(2, events(SHA(i, "c"), h), "x", h); };
    for (let i = 1; i <= N; i++) expect(ask(i)).toMatchObject({ files: ["f.ts"] });
    expect(rebaseCacheSize()).toBe(REBASE_CACHE_MAX);
    expect(runs).toBe(N);
    const first = N - REBASE_CACHE_MAX + 1; // 留下的最旧那条
    ask(first); // 命中：挪到最新
    expect(runs).toBe(N);
    ask(N + 1); // 新的一条挤掉最久未用的（first + 1），不是刚命中的 first
    expect(rebaseCacheSize()).toBe(REBASE_CACHE_MAX);
    ask(first);
    expect(runs).toBe(N + 1);
    ask(first + 1);
    expect(runs).toBe(N + 2);
  }, 60_000);
});

describe("ci-proof-port：archive 总字节与单个下载上限", () => {
  beforeEach(() => resetCiProofPortCache());
  /** run i 的 ci-proof 工件 id = i；archive 字节数由 size(i) 定；摘要对不上让 read 在下载后抛（缓存已发生） */
  function port(size: (id: number) => number) {
    const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
    const command = async (argv: string[]): Promise<BoundedResult> => {
      if (argv.join(" ") === "gh auth token") return ok("tok\n");
      const path = argv.at(-1)!;
      let m = /^repos\/o\/r\/actions\/runs\/(\d+)$/.exec(path);
      if (m) {
        return ok(JSON.stringify({ id: +m[1]!, run_attempt: 1, event: "push", head_sha: "a".repeat(40), path: ".github/workflows/ci.yml", status: "in_progress",
          repository: { full_name: "o/r" } }));
      }
      if (/\/attempts\/1\/jobs/.test(path)) return ok(JSON.stringify({ total_count: 0, jobs: [] }));
      m = /^repos\/o\/r\/actions\/runs\/(\d+)\/artifacts\?name=ci-proof&/.exec(path);
      if (m) return ok(JSON.stringify({ artifacts: [{ id: +m[1]!, name: "ci-proof", expired: false, digest: `sha256:${"0".repeat(64)}`, workflow_run: { id: +m[1]! }, archive_download_url: "x" }] }));
      return { code: 1, stdout: "", stderr: `no route ${path}`, timedOut: false };
    };
    const fetch = async (url: string): Promise<Response> => new Response(new Uint8Array(size(Number(/artifacts\/(\d+)\/zip/.exec(url)![1]))));
    return ghCiProofPort(command, { fetch });
  }
  const readQuiet = (p: ReturnType<typeof port>, id: number) => p.read("o/r", id).then(() => "ok", (e: Error) => e.message);

  test("[验收线 1][验收线 3] 1 万份 archive 只留到 300 份；总字节不超过上限，按最久未用淘汰", async () => {
    const small = port(() => 10);
    for (let i = 1; i <= N; i++) await readQuiet(small, i);
    expect(ciProofArchiveMemory()).toEqual({ count: 300, bytes: 3000 });
    resetCiProofPortCache();
    const big = 8 * 1024 * 1024, p = port(() => big);
    for (let i = 1; i <= 20; i++) await readQuiet(p, i);
    const mem = ciProofArchiveMemory();
    expect(mem.bytes).toBeLessThanOrEqual(ARCHIVE_CACHE_BYTES);
    expect(mem.count).toBe(ARCHIVE_CACHE_BYTES / big);
  }, 60_000);

  test("[验收线 3] 超过单个上限的下载按失败处理、不进缓存", async () => {
    const p = port((id) => (id === 2 ? ARCHIVE_MAX_BYTES + 1 : 10));
    await readQuiet(p, 1);
    expect(await readQuiet(p, 2)).toMatch(/工件 2 下载失败：超过/);
    expect(ciProofArchiveMemory()).toEqual({ count: 1, bytes: 10 });
  });
});

