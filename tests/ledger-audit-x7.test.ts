/**
 * 巡检正确性（AUDX7）：确认核代次、审查员按轮次认、快照在一个读事务里取、确认 id 不靠逗号拼。
 * 只用合成台账和临时目录；bridge 一侧走真的 ledgerAuditTicker，runManager 接到真的 `ledger audit`。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ackArgs, ledgerAuditTicker, type LedgerAuditDeps } from "../src/bridge/ledger-audit-service.js";
import type { Envelope } from "../src/bridge/router.js";
import { auditLedger, type AuditFinding, type AuditRule, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { ackFindingRefs, ackRefArg, openFindings, parseAckRef, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { baselineAudit, tempLedgerPath } from "./ledger-test-helpers.js";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const PM = "agent-claudestra";
const EXE = "agent-task-t1";
const P = "claude-orchestrator";
const RULES: AuditRule[] = ["review_no_reviewer"];

let dir: string;
let db: Database;
let path: string;
let clock: number;

function sources(): SnapshotSources {
  const reg = [{ name: PM, channelId: "c-pm", projectId: P, cwd: dir, sessionId: "s-pm" }, { name: EXE, channelId: "c-exe", projectId: P, cwd: dir, sessionId: "s-exe" }];
  return { registry: async () => reg, windows: async () => ["master", PM, EXE], turn: async () => "idle",
    fileTimes: async () => ({ lastWriteAt: NOW - 60 * MIN, startedAt: 0 }), reviewers: () => [], heldPath: join(dir, "held-messages.json") };
}

/** 项目 P（PM 名单 = [PM]）里一张卡，建在 build；规则基线已建，发现照常进 pending */
function seed(id: string, builtAt: number): void {
  createTask(db, { actor: "owner", now: builtAt }, { project: P, id, title: "巡检", kind: "code", agent: EXE, pm: PM, stage: "build" });
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: [PM] });
  mkdirSync(join(dir, "ledger", "docs"), { recursive: true });
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "docsDir", value: join(dir, "ledger", "docs") });
  baselineAudit(db, P);
}

async function cli(...args: string[]) {
  return runLedger(["audit", ...args], {
    db, actor: "owner", actorProject: P, projectIds: [P], now: () => clock, auditSources: sources(),
    loadRegistry: async () => ({ agents: {} }) as unknown as Registry, saveRegistry: async () => {},
  }) as Promise<Record<string, any>>;
}

/** bridge 定时器接到真 CLI；onDeliver 在「取到待推、还没确认」之间跑 */
function bridge(onDeliver: () => void = () => {}) {
  const sent: Envelope[] = [];
  const calls: string[][] = [];
  const acks: Record<string, any>[] = [];
  const d: LedgerAuditDeps = {
    clients: new Map([["c-pm", { ws: {} as never, channelId: "c-pm" }]]),
    deliver: async (env) => (sent.push(env), onDeliver(), { outcome: { kind: "sent" } }),
    hold: (env) => void sent.push(env),
    lastMessageSource: { set: () => {} },
    runManager: async (...args: string[]) => {
      calls.push(args);
      const r = await cli(...args.slice(2));
      if (args.includes("--ack")) acks.push(r);
      return r;
    },
    busy: async () => false,
    channelOf: (a) => (a === PM ? "c-pm" : undefined),
    failureTargets: () => [],
  };
  return { tick: ledgerAuditTicker(d), sent, calls, acks };
}

const finding = (key: string): AuditFinding => ({ key, project: P, taskId: "T1", rule: "review_no_reviewer", since: 1, detail: "d", suggestion: "派审查员", notify: PM });
const noReviewer = (s: AuditSnapshot, now = NOW) => auditLedger(s, now).findings.filter((f) => f.rule === "review_no_reviewer");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-x7-"));
  path = tempLedgerPath("ledger-audit-x7-db-");
  db = openLedger(path);
  clock = NOW;
});
afterEach(() => closeLedger(path));

describe("[验收线 1] 确认带代次", () => {
  const K = `${P}|review_no_reviewer|T1|r1|0`;

  test("K 以 firstSeen=100 取出，解决后以 300 重开：100 那一代的确认不写、过期计数 1，新一代仍在待推", () => {
    baselineAudit(db, P);
    const [taken] = reconcileFindings(db, P, [finding(K)], RULES, 100).pending;
    expect(taken).toMatchObject({ key: K, firstSeen: 100 });
    expect(reconcileFindings(db, P, [], RULES, 200).resolved).toEqual([K]);
    expect(reconcileFindings(db, P, [finding(K)], RULES, 300).opened).toEqual([K]);

    expect(ackFindingRefs(db, [{ key: K, firstSeen: taken!.firstSeen }], 350)).toEqual({ acked: 0, stale: 1 }); // 改动前：acked 1，新一代被标成已推
    expect(openFindings(db, P)[0]).toMatchObject({ firstSeen: 300, notifiedAt: null, queuedAs: null });
    const next = reconcileFindings(db, P, [finding(K)], RULES, 400).pending;
    expect(next.map((f) => [f.key, f.firstSeen])).toEqual([[K, 300]]);

    expect(ackFindingRefs(db, [{ key: K, firstSeen: 300 }], 450)).toEqual({ acked: 1, stale: 0 }); // 同一代照常确认
    expect(reconcileFindings(db, P, [finding(K)], RULES, 500).pending).toEqual([]);
  });

  test("押后的旧确认同理：不同代不写 queuedAs；同一代重复确认不算过期", () => {
    baselineAudit(db, P);
    reconcileFindings(db, P, [finding(K)], RULES, 100);
    reconcileFindings(db, P, [], RULES, 200);
    reconcileFindings(db, P, [finding(K)], RULES, 300);
    expect(ackFindingRefs(db, [{ key: K, firstSeen: 100 }], 350, "m-old")).toEqual({ acked: 0, stale: 1 });
    expect(openFindings(db, P)[0]!.queuedAs).toBeNull();
    expect(ackFindingRefs(db, [{ key: K, firstSeen: 300 }], 360)).toEqual({ acked: 1, stale: 0 });
    expect(ackFindingRefs(db, [{ key: K, firstSeen: 300 }], 370)).toEqual({ acked: 0, stale: 0 });
    expect(ackFindingRefs(db, [{ key: "没有这条", firstSeen: 1 }], 380)).toEqual({ acked: 0, stale: 0 });
  });

  test("bridge 一轮：投递期间这条被解决又重开 → 回传的是取到时的代次，CLI 报 stale 1、不报错，下一轮按新一代再推", async () => {
    seed("T1", NOW - 90 * MIN);
    moveStage(db, { actor: "owner", now: NOW - 61 * MIN }, { taskId: "T1", from: "build", to: "review" });
    let key = "";
    const b = bridge(() => {
      if (key) return;
      key = openFindings(db, P)[0]!.key;
      reconcileFindings(db, P, [], RULES, NOW + 1);
      reconcileFindings(db, P, [finding(key)], RULES, NOW + 2);
    });
    await b.tick();
    expect(b.calls[1]).toEqual(["ledger", "audit", "--ack", `${key}@${NOW}`]);
    expect(b.acks).toEqual([{ ok: true, acked: 0, stale: 1 }]);
    expect(openFindings(db, P)[0]).toMatchObject({ key, firstSeen: NOW + 2, notifiedAt: null });

    clock = NOW + 3;
    await b.tick();
    expect(b.sent).toHaveLength(2); // 新一代推出去了
    expect(b.acks[1]).toEqual({ ok: true, acked: 1, stale: 0 });
    await b.tick();
    expect(b.sent).toHaveLength(2);
  });
});

describe("[验收线 2] 审查员按轮次认", () => {
  let seq = 0;
  const ev = (ts: number, kind: LedgerEvent["kind"], data: Record<string, unknown>): LedgerEvent =>
    ({ seq: ++seq, ts, actor: "x", project: "p", target: "T1", kind, text: "", data, dedupKey: null });
  const task: LedgerTask = {
    id: "T1", project: "p", itemId: null, title: "T1", kind: "code", stage: "review", stageBefore: null, round: 2, agent: EXE, pm: PM, branch: null,
    pr: null, headSHA: null, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 0, updatedAt: 0, assigneeKind: "agent", assignee: EXE,
  };
  const idle = (name: string) => ({ name, projectId: "p", windowAlive: true, turn: "idle" as const, lastWriteAt: null, startedAt: 0 });
  const snap = (reviewers: AuditSnapshot["reviewers"]): AuditSnapshot => ({
    project: "p", pms: [PM], agents: [idle(PM), idle(EXE)], reviewers, held: [], ownerInbox: [],
    tasks: [{ task, events: [ev(0, "task", { op: "new", patch: { stage: "spec" } }), ev(NOW - 61 * MIN, "stage", { from: "fix", to: "review" })] }],
  });

  test("r2 review 已 61 分钟、没派 r2 审查员、r1 的审查会话还在写 → 照报", () => {
    const f = noReviewer(snap([{ taskId: "t1", round: 1 }])); // 改动前：只按 taskId 认，这里是空的
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ taskId: "T1", suggestion: "派审查员", detail: expect.stringContaining("第 2 轮") });
  });

  test("r2 审查员在跑 → 不报；r1、r2 都在也不报；认不出轮次的旧记录按当前轮算", () => {
    expect(noReviewer(snap([{ taskId: "t1", round: 2 }]))).toEqual([]);
    expect(noReviewer(snap([{ taskId: "t1", round: 1 }, { taskId: "T1", round: 2 }]))).toEqual([]);
    expect(noReviewer(snap([{ taskId: "t1", round: null }]))).toEqual([]);
    expect(noReviewer(snap([{ taskId: "t9", round: 2 }]))).toHaveLength(1);
  });
});

describe("[验收线 3] 快照在一个读事务里取", () => {
  /** 读过 events 之后、第一次读 tasks 之前调一次 between（同一个 db，其余原样转给它） */
  function tapped(real: Database, between: () => void): { db: Database; fired: () => boolean } {
    let events = false, fired = false;
    const tap = (name: "prepare" | "query") => (sql: string, ...rest: unknown[]) => {
      if (/\bFROM events\b/i.test(sql)) events = true;
      else if (events && !fired && /\bFROM tasks\b/i.test(sql)) {
        fired = true;
        between();
      }
      return (real[name] as (...a: unknown[]) => unknown)(sql, ...rest);
    };
    const proxy = new Proxy(real, {
      get(t, k) {
        if (k === "prepare" || k === "query") return tap(k);
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { db: proxy, fired: () => fired };
  }

  test("读事件和读 tasks 之间另一个连接原子提交「build→review + stage 事件」：这一轮不报 review_no_reviewer，下一轮按真实进入时间算", async () => {
    seed("T1", NOW - 61 * MIN);
    const other = new Database(path);
    other.exec("PRAGMA busy_timeout = 2000");
    try {
      const t = tapped(db, () => void moveStage(other, { actor: "owner", now: NOW - 1000 }, { taskId: "T1", from: "build", to: "review" }));
      const [s] = await collectAuditSnapshots(t.db, [P], NOW, sources());
      expect(t.fired()).toBe(true);
      // 这一轮看到的是提交前的整套事实（或提交后的整套），不是新阶段配旧事件
      const card = s!.tasks.find((x) => x.task.id === "T1")!;
      expect(card.task.stage === "review").toBe(card.events.some((e) => e.kind === "stage" && e.data.to === "review"));
      expect(noReviewer(s!)).toEqual([]); // 改动前：拿旧 build 起点当 review 开始，报「已 61 分钟」
    } finally {
      other.close();
    }
    const [again] = await collectAuditSnapshots(db, [P], NOW, sources());
    expect(again!.tasks.find((x) => x.task.id === "T1")!.task.stage).toBe("review");
    expect(noReviewer(again!)).toEqual([]);
  });
});

describe("[验收线 4] 确认 id 不靠逗号拼", () => {
  test("id 的写法：带代次按最后一个 @ 切，key 里的逗号、@ 原样；多条时其余放在 -- 之后，--queued 在 -- 前", () => {
    const k = `${P}|review_no_reviewer|T1,part@x|r1|5`;
    expect(parseAckRef(ackRefArg({ key: k, firstSeen: 100 }))).toEqual({ key: k, firstSeen: 100 });
    expect(parseAckRef(k)).toEqual({ key: k });
    expect(ackArgs([{ key: "a,b", firstSeen: 1 }])).toEqual(["ledger", "audit", "--ack", "a,b@1"]);
    expect(ackArgs([{ key: "a,b", firstSeen: 1 }, { key: "--c", firstSeen: 2 }], "m1")).toEqual(["ledger", "audit", "--ack", "a,b@1", "--queued", "m1", "--", "--c@2"]);
  });

  test("任务 id `T1,part` 的发现经 bridge 的确认路径确认成功，下一轮不重推", async () => {
    seed("T1,part", NOW - 90 * MIN);
    createTask(db, { actor: "owner", now: NOW - 90 * MIN }, { project: P, id: "T2", title: "另一张", kind: "code", agent: EXE, pm: PM, stage: "build" });
    for (const taskId of ["T1,part", "T2"]) moveStage(db, { actor: "owner", now: NOW - 61 * MIN }, { taskId, from: "build", to: "review" });
    const b = bridge();
    await b.tick();
    expect(b.sent).toHaveLength(1);
    const ack = b.calls[1]!;
    expect(ack.slice(0, 3)).toEqual(["ledger", "audit", "--ack"]);
    expect(ack.filter((a) => a.includes("T1,part"))).toHaveLength(1); // 一条一个参数，整条 key 没被拆开
    expect(b.acks).toEqual([{ ok: true, acked: 2, stale: 0 }]); // 改动前：逗号拼了再拆，acked 0
    const rows = openFindings(db, P).filter((f) => f.rule === "review_no_reviewer");
    expect(rows.map((f) => [f.taskId, f.notifiedAt])).toEqual([["T1,part", NOW], ["T2", NOW]]);

    clock = NOW + 15 * MIN;
    await b.tick();
    expect(b.sent).toHaveLength(1);
    expect((await cli("--json")).pending).toEqual([]);
  });

  test("手动确认：不带代次的整条 key（带逗号）照样认；整串对不上任何一条时才按旧写法拆逗号", async () => {
    seed("T1,part", NOW - 90 * MIN);
    createTask(db, { actor: "owner", now: NOW - 90 * MIN }, { project: P, id: "T2", title: "另一张", kind: "code", agent: EXE, pm: PM, stage: "build" });
    for (const taskId of ["T1,part", "T2"]) moveStage(db, { actor: "owner", now: NOW - 61 * MIN }, { taskId, from: "build", to: "review" });
    const pending = (await cli("--json")).pending as { key: string; taskId: string }[];
    const comma = pending.find((f) => f.taskId === "T1,part")!.key;
    expect(await cli("--ack", comma)).toEqual({ ok: true, acked: 1 });
    expect(((await cli("--json")).pending as { taskId: string }[]).map((f) => f.taskId)).toEqual(["T2"]);
    expect((await cli("--ack", "")).code).toBe("invalid");
  });
});
