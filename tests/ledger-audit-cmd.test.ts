/** 台账巡检的取数（lib/ledger-audit-snapshot.ts）、CLI（ledger audit）与 bridge 定时器（bridge/ledger-audit-service.ts） */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerAuditTicker, type LedgerAuditDeps } from "../src/bridge/ledger-audit-service.js";
import type { Envelope } from "../src/bridge/router.js";
import { projectsSlug } from "../src/lib/jsonl-cost.js";
import { collectAuditSnapshots, runningReviewers, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const PM = "agent-claudestra";
const EXE = "agent-task-t1";
const P = "claude-orchestrator";

let dir: string;
let db: Database;
let path: string;

function sources(over: Partial<SnapshotSources> = {}): SnapshotSources {
  const reg: RegistryAgent[] = [
    { name: PM, channelId: "c-pm", projectId: P },
    { name: EXE, channelId: "c-exe", projectId: P },
  ];
  return {
    registry: async () => reg,
    windows: async () => ["master", PM, EXE],
    turn: async () => "idle",
    lastWrite: async () => NOW - 60 * MIN,
    reviewers: () => [],
    heldPath: join(dir, "held-messages.json"),
    ...over,
  };
}

/** T1 在 review（进阶段 30 分钟前），PM 名单 = [PM]，docsDir = <dir>/ledger/docs */
function seed(): void {
  const owner = { actor: "owner", now: 0 };
  createTask(db, owner, { project: P, id: "T1", title: "巡检", kind: "code", agent: EXE, pm: PM, stage: "build" });
  moveStage(db, { actor: "owner", now: NOW - 30 * MIN }, { taskId: "T1", from: "build", to: "review" });
  setMeta(db, owner, { project: P, key: "pms", value: [PM] });
  mkdirSync(join(dir, "ledger", "docs"), { recursive: true });
  setMeta(db, owner, { project: P, key: "docsDir", value: join(dir, "ledger", "docs") });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-cmd-"));
  path = tempLedgerPath("ledger-audit-cmd-db-");
  db = openLedger(path);
  seed();
});
afterEach(() => closeLedger(path));

describe("取数", () => {
  test("押后队列：按频道认出收件 PM；bridge 自己的通知不算；领走的带 leaseAt", async () => {
    writeFileSync(join(dir, "held-messages.json"), JSON.stringify({
      "c-pm": [
        { env: { from: { kind: "local", agentName: "agent-task-t9" }, meta: { messageId: "m1" } }, heldAt: 5, lease: { batchId: "b", at: 7 } },
        { env: { from: { kind: "bridge", label: "ledger-audit" }, meta: { messageId: "m2" } }, heldAt: 6 },
      ],
      "c-unknown": [{ env: { from: { kind: "local", agentName: "x" }, meta: { messageId: "m3" } }, heldAt: 1 }],
    }));
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources());
    expect(s.held).toEqual([{ to: PM, from: "agent-task-t9", messageId: "m1", heldAt: 5, leaseAt: 7 }]);
  });

  test("押后文件不存在 = 空；坏了 = null（规则不跑）", async () => {
    expect((await collectAuditSnapshots(db, [P], NOW, sources()))[0].held).toEqual([]);
    writeFileSync(join(dir, "held-messages.json"), "{坏");
    expect((await collectAuditSnapshots(db, [P], NOW, sources()))[0].held).toBeNull();
  });

  test("ownerInbox 从 docsDir 旁边的 ledger.json 读，带时区的时间照解析", async () => {
    writeFileSync(join(dir, "ledger", "ledger.json"), JSON.stringify({ ownerInbox: [{ ts: "2026-09-28T17:00:32+0900", text: "t", status: "doing", to: "T8" }] }));
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources());
    expect(s.ownerInbox).toEqual([{ ts: Date.parse("2026-09-28T08:00:32Z"), text: "t", status: "doing", to: "T8" }]);
  });

  test("registry 读不到 → agents / reviewers / held 都是 null", async () => {
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources({ registry: async () => { throw new Error("坏了"); } }));
    expect([s.agents, s.reviewers, s.held]).toEqual([null, null, null]);
  });

  test("tmux 没列出窗口 → windowAlive 为 null；只给 build/fix 执行者和 PM 抓屏", async () => {
    const asked: string[] = [];
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources({ windows: async () => null, turn: async (a) => (asked.push(a.name), "busy") }));
    expect(s.agents?.every((a) => a.windowAlive === null)).toBe(true);
    expect(asked).toEqual([PM]); // T1 在 review，执行者不用抓屏
  });

  describe("审查员（PM 会话的 subagents）", () => {
    const home = process.env.HOME;
    const sid = "sess-1";
    let sub: string;
    beforeEach(() => {
      process.env.HOME = dir;
      const proj = join(dir, ".claude", "projects", projectsSlug(dir));
      sub = join(proj, sid, "subagents");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(proj, `${sid}.jsonl`), "");
    });
    afterEach(() => {
      process.env.HOME = home;
    });
    function subagent(id: string, description: string, msg: Record<string, unknown>, mtime = Date.now()) {
      const f = join(sub, `agent-${id}.jsonl`);
      writeFileSync(f, `${JSON.stringify({ type: "assistant", message: { id: `m-${id}`, ...msg } })}\n`);
      writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ description, agentType: "general-purpose" }));
      utimesSync(f, mtime / 1000, mtime / 1000);
    }
    const running = { content: [{ type: "tool_use", name: "Bash" }], stop_reason: null };
    test("按 07c 的 description 约定认任务 id；已答完 / 30 分钟没动静 / 不是审查的都不算", () => {
      subagent("a", "Review T29 r1", running);
      subagent("b", "Adversarial review T13a r3", running);
      subagent("c", "Review T30 r1", { content: [{ type: "text", text: "结论" }], stop_reason: "end_turn" });
      subagent("d", "Review T31 r2", running, Date.now() - 31 * MIN);
      subagent("e", "Explore the repo", running);
      const got = runningReviewers({ name: PM, cwd: dir, sessionId: sid }, Date.now());
      expect(got.sort((x, y) => x.taskId.localeCompare(y.taskId))).toEqual([{ taskId: "T13a", round: 3 }, { taskId: "T29", round: 1 }]);
    });
    test("没派过 subagent / registry 缺会话信息 → 空", () => {
      expect(runningReviewers({ name: PM, cwd: dir, sessionId: "other" }, Date.now())).toEqual([]);
      expect(runningReviewers({ name: PM }, Date.now())).toEqual([]);
    });
  });
});

async function cli(actor: string, ...args: string[]) {
  return runLedger(["audit", ...args], {
    db, actor, actorProject: P, projectIds: [P], now: () => NOW, auditSources: sources(),
    loadRegistry: async () => ({ agents: {} }) as unknown as Registry, saveRegistry: async () => {},
  }) as Promise<Record<string, any>>;
}

describe("ledger audit", () => {
  test("第一次跑：落库并给出 pending；再跑一次仍开着但不再算新开", async () => {
    const a = await cli("owner", "--json");
    expect(a.ok).toBe(true);
    expect(a.projects[0]).toMatchObject({ project: P, opened: 1, resolved: 0 });
    expect(a.pending.map((f: any) => [f.rule, f.taskId, f.notify])).toEqual([["review_no_reviewer", "T1", PM]]);
    const b = await cli("owner", "--json");
    expect(b.projects[0]).toMatchObject({ opened: 0, resolved: 0 });
  });

  test("--ack 之后 pending 清空；执行者不能 ack", async () => {
    const a = await cli("owner", "--json");
    const key = a.pending[0].key as string;
    expect((await cli(EXE, "--ack", key)).ok).toBe(false);
    expect(await cli(PM, "--ack", key)).toEqual({ ok: true, acked: 1 });
    expect((await cli("owner", "--json")).pending).toEqual([]);
  });

  test("--dry-run 只算不写；不带 --json 只给摘要", async () => {
    const d = await cli("owner", "--dry-run");
    expect(d.projects[0].open).toEqual([{ project: P, rule: "review_no_reviewer", taskId: "T1", detail: expect.stringContaining("T1"), suggestion: "派审查员" }]);
    expect(db.query("SELECT COUNT(*) AS n FROM audit_findings").get()).toEqual({ n: 0 });
    expect(isWriteInvocation("ledger", ["audit", "--dry-run"])).toBe(false);
    expect(isWriteInvocation("ledger", ["audit"])).toBe(true);
  });

  test("没有 PM 名单的项目不巡检；--project 指定照跑", async () => {
    createTask(db, { actor: "owner", now: 0 }, { project: "other", id: "T9", title: "x", kind: "code", stage: "build" });
    expect((await cli("owner")).projects.map((p: any) => p.project)).toEqual([P]);
  });
});

describe("bridge 定时器", () => {
  type Sent = { kind: "deliver" | "hold"; env: Envelope };
  function deps(over: Partial<LedgerAuditDeps> = {}) {
    const sent: Sent[] = [];
    const acks: string[][] = [];
    const store = new Map<string, boolean>(); // key → 已 ack
    const pending = [
      { key: "k1", project: P, taskId: "T1", rule: "review_no_reviewer", detail: "d1", suggestion: "派审查员", notify: "agent-pm-dispatch" },
      { key: "k2", project: P, taskId: null, rule: "pm_held", detail: "d2", suggestion: "check_inbox 领回并处理", notify: PM },
    ];
    const d: LedgerAuditDeps = {
      clients: new Map([["c-pm", { ws: {} as never, channelId: "c-pm" }], ["c-dis", { ws: {} as never, channelId: "c-dis" }]]),
      deliver: async (env) => (sent.push({ kind: "deliver", env }), { outcome: { kind: "sent" } }),
      hold: (env) => void sent.push({ kind: "hold", env }),
      lastMessageSource: { set: () => {} },
      runManager: async (...args: string[]) => {
        if (args.includes("--ack")) {
          const keys = args[args.indexOf("--ack") + 1].split(",");
          acks.push(keys);
          for (const k of keys) store.set(k, true);
          return { ok: true, acked: keys.length };
        }
        return { ok: true, pending: pending.filter((f) => !store.get(f.key)) };
      },
      busy: async () => false,
      channelOf: (a) => ({ [PM]: "c-pm", "agent-pm-dispatch": "c-dis" })[a],
      ...over,
    };
    return { d, sent, acks };
  }

  test("按收件人各合成一条；推出后 ack；再跑一轮不重复推", async () => {
    const { d, sent, acks } = deps();
    const tick = ledgerAuditTicker(d);
    await tick();
    expect(sent.map((s) => [s.kind, (s.env.to as { agentName?: string }).agentName])).toEqual([["deliver", "agent-pm-dispatch"], ["deliver", PM]]);
    expect(sent[0].env).toMatchObject({ from: { kind: "bridge", label: "ledger-audit" }, intent: "notification", meta: { triggerKind: "bridge_synth" } });
    expect(String(sent[1].env.content)).toContain("check_inbox");
    expect(acks).toEqual([["k1", "k2"]]);
    await tick();
    expect(sent).toHaveLength(2);
  });

  test("收件人在忙 → 放进押后队列（不抢占），也算推出", async () => {
    const { d, sent, acks } = deps({ busy: async (ch) => ch === "c-pm" });
    await ledgerAuditTicker(d)();
    expect(sent.map((s) => s.kind)).toEqual(["deliver", "hold"]);
    expect(acks).toEqual([["k1", "k2"]]);
  });

  test("收件人不在线 / 投递失败 → 不 ack，下一轮再推", async () => {
    const { d, sent, acks } = deps({ channelOf: (a) => (a === PM ? "c-pm" : undefined), deliver: async (env) => (sent.push({ kind: "deliver", env }), { outcome: { kind: "error" } }) });
    const tick = ledgerAuditTicker(d);
    await tick();
    expect(acks).toEqual([]);
    await tick();
    expect(sent).toHaveLength(2);
  });

  test("manager 报错 → 只记日志，不推", async () => {
    const { d, sent } = deps({ runManager: async () => ({ ok: false, error: "认主守卫" }) });
    await ledgerAuditTicker(d)();
    expect(sent).toEqual([]);
  });
});
